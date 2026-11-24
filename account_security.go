package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base32"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

type selfAccount struct {
	ID, Login, Password, SessionID string
	OTP                            *string
	Revision                       int64
}

type accountCommand struct {
	Action, Password, Code, NewPassword, SessionID string
}

func (a *app) registerAccountSecurity(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/account/security", route(a.accountSecurity))
	mux.HandleFunc("POST /api/account/security", route(a.changeAccountSecurity))
}

// Serialize changes to the user before checking the session again. A request
// that was waiting behind a session revocation must observe the deletion.
func lockSelfAccount(ctx context.Context, tx pgx.Tx, r *http.Request) (selfAccount, error) {
	var u selfAccount
	denied := problem{401, "Bitte erneut anmelden."}
	cookie, err := r.Cookie("bonfire_session")
	if err != nil || cookie.Value == "" {
		return u, denied
	}
	digest := hash(cookie.Value)
	err = tx.QueryRow(ctx, `SELECT u.name,coalesce(u.login_alias,u.name),u.password,u.otp_secret,u.account_revision
		FROM users u JOIN sessions s ON s.username=u.name WHERE s.token=$1 AND s.expires>clock_timestamp()
		AND u.active AND NOT u.password_change_required FOR UPDATE OF u`, digest).Scan(&u.ID, &u.Login, &u.Password, &u.OTP, &u.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return u, denied
	}
	if err != nil {
		return u, err
	}
	err = tx.QueryRow(ctx, "SELECT public_id::text FROM sessions WHERE token=$1 AND username=$2 AND expires>clock_timestamp() FOR UPDATE", digest, u.ID).Scan(&u.SessionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return u, denied
	}
	return u, err
}

func browserLabel(agent string) string {
	name := ""
	switch {
	case strings.Contains(agent, "Edg/") || strings.Contains(agent, "EdgiOS/") || strings.Contains(agent, "EdgA/"):
		name = "Microsoft Edge"
	case strings.Contains(agent, "OPR/"):
		name = "Opera"
	case strings.Contains(agent, "Firefox/") || strings.Contains(agent, "FxiOS/"):
		name = "Firefox"
	case strings.Contains(agent, "Chrome/") || strings.Contains(agent, "CriOS/"):
		name = "Chrome"
	case strings.Contains(agent, "Safari/"):
		name = "Safari"
	default:
		name = "Anderer Browser"
	}
	for _, pair := range [][2]string{{"iPad", "iPadOS"}, {"iPhone", "iOS"}, {"Android", "Android"}, {"Windows", "Windows"}, {"Macintosh", "macOS"}, {"Linux", "Linux"}} {
		if strings.Contains(agent, pair[0]) {
			return name + " · " + pair[1]
		}
	}
	return name
}

func createAccountSession(ctx context.Context, tx pgx.Tx, r *http.Request, username string) (string, error) {
	token := secret()
	if _, err := tx.Exec(ctx, "INSERT INTO sessions(token,username,expires,browser) VALUES($1,$2,now()+interval '30 minutes',$3)", hash(token), username, browserLabel(r.UserAgent())); err != nil {
		return "", err
	}
	_, err := tx.Exec(ctx, "UPDATE users SET last_login_at=now() WHERE name=$1", username)
	return token, err
}

func setAccountSessionCookie(w http.ResponseWriter, r *http.Request, token string) {
	writeSessionCookie(w, r, token, 1800)
}

func writeSessionCookie(w http.ResponseWriter, r *http.Request, token string, age int) {
	// #nosec G124 -- Secure is disabled only for the explicitly supported loopback HTTP development origin.
	cookie := &http.Cookie{Name: "bonfire_session", Value: token, Path: "/api", MaxAge: age, HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode}
	// Plain HTTP is supported only for local development on loopback.
	host := r.URL.Hostname()
	if host == "" {
		host = (&url.URL{Host: r.Host}).Hostname()
	}
	if r.TLS == nil && !strings.HasPrefix(r.Header.Get("Origin"), "https://") && (host == "localhost" || net.ParseIP(host).IsLoopback()) {
		cookie.Secure = false
	}
	http.SetCookie(w, cookie)
}

type personalSession struct {
	ID      string    `json:"id"`
	Current bool      `json:"current"`
	Agent   string    `json:"agent"`
	Created time.Time `json:"created"`
	Expires time.Time `json:"expires"`
}

func (a *app) accountSecurity(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	u, err := lockSelfAccount(ctx, tx, r)
	if err != nil {
		return nil, err
	}
	var remaining int
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM recovery_codes WHERE username=$1", u.ID).Scan(&remaining); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `SELECT public_id::text,public_id=$2,coalesce(nullif(browser,''),'Unbekannter Browser'),started_at,expires
		FROM sessions WHERE username=$1 AND expires>now() ORDER BY (public_id=$2) DESC,started_at DESC`, u.ID, u.SessionID)
	if err != nil {
		return nil, err
	}
	sessions, err := pgx.CollectRows(rows, pgx.RowToStructByPos[personalSession])
	if err != nil {
		return nil, err
	}
	return map[string]any{"login": u.Login, "mfa": u.OTP != nil, "recoveryRemaining": remaining, "sessions": sessions}, tx.Commit(ctx)
}

// Step-up attempts have a separate bounded namespace from login attempts.
func (a *app) reserveSecurityAttempt(key string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if time.Now().After(a.reset) {
		clear(a.attempts)
		a.reset = time.Now().Add(time.Minute)
	}
	if a.attempts[key] >= 8 {
		return problem{429, "Zu viele Versuche. Bitte in einer Minute erneut versuchen."}
	}
	a.attempts[key]++
	return nil
}
func (a *app) clearSecurityAttempts(key string) {
	a.mu.Lock()
	delete(a.attempts, key)
	a.mu.Unlock()
}

func (a *app) verifySelfPassword(ctx context.Context, tx pgx.Tx, u selfAccount, password, code string) error {
	k := "\x00password:" + u.ID
	if err := a.reserveSecurityAttempt(k); err != nil {
		return err
	}
	if len(password) > 72 || bcrypt.CompareHashAndPassword([]byte(u.Password), []byte(password)) != nil {
		return problem{403, "Aktuelles Passwort prüfen."}
	}
	if u.OTP != nil {
		if err := verifyCode(ctx, tx, u.ID, *u.OTP, strings.TrimSpace(code)); err != nil {
			var p problem
			if errors.As(err, &p) {
				return problem{403, "Zweiter Faktor ungültig oder bereits verwendet."}
			}
			return err
		}
	}
	a.clearSecurityAttempts(k)
	return nil
}

func invalidateOtherSessions(ctx context.Context, tx pgx.Tx, u selfAccount) error {
	if _, err := tx.Exec(ctx, "DELETE FROM sessions WHERE username=$1 AND public_id::text<>$2", u.ID, u.SessionID); err != nil {
		return err
	}
	for _, sql := range []string{
		"DELETE FROM login_challenges WHERE username=$1",
		"DELETE FROM password_changes WHERE username=$1",
		"DELETE FROM mfa_enrollments WHERE username=$1",
		"UPDATE users SET account_revision=account_revision+1 WHERE name=$1",
	} {
		if _, err := tx.Exec(ctx, sql, u.ID); err != nil {
			return err
		}
	}
	return nil
}

func newRecoveryCodes(ctx context.Context, tx pgx.Tx, username string) ([]string, error) {
	if _, err := tx.Exec(ctx, "DELETE FROM recovery_codes WHERE username=$1", username); err != nil {
		return nil, err
	}
	codes := make([]string, 8)
	for i := range codes {
		codes[i] = secret()[:16]
		if _, err := tx.Exec(ctx, "INSERT INTO recovery_codes(username,digest) VALUES($1,$2)", username, hash(codes[i])); err != nil {
			return nil, err
		}
	}
	return codes, nil
}

func beginAuthenticator(ctx context.Context, tx pgx.Tx, u selfAccount) (map[string]string, error) {
	if u.OTP != nil {
		return nil, problem{409, "Ein Authenticator ist bereits eingerichtet."}
	}
	if _, err := tx.Exec(ctx, "DELETE FROM mfa_enrollments WHERE expires<=now() OR (username=$1 AND binding=$2)", u.ID, u.SessionID); err != nil {
		return nil, err
	}
	var random [20]byte
	rand.Read(random[:])
	value := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(random[:])
	if _, err := tx.Exec(ctx, "INSERT INTO mfa_enrollments(username,binding,revision,secret) VALUES($1,$2,$3,$4)", u.ID, u.SessionID, u.Revision, value); err != nil {
		return nil, err
	}
	uri := "otpauth://totp/BONFIRE:" + url.PathEscape(u.Login) + "?" + url.Values{"issuer": {"BONFIRE"}, "secret": {value}, "digits": {"6"}, "period": {"30"}, "algorithm": {"SHA1"}}.Encode()
	return map[string]string{"secret": value, "uri": uri}, nil
}

func (a *app) confirmAuthenticator(ctx context.Context, tx pgx.Tx, u selfAccount, code, givenSecret string) ([]string, error) {
	if u.OTP != nil {
		return nil, problem{409, "Ein Authenticator ist bereits eingerichtet."}
	}
	var seed string
	err := tx.QueryRow(ctx, `SELECT secret FROM mfa_enrollments WHERE username=$1 AND binding=$2 AND revision=$3 AND expires>clock_timestamp()`, u.ID, u.SessionID, u.Revision).Scan(&seed)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, problem{410, "Einrichtung abgelaufen. Bitte neu beginnen."}
	}
	if err != nil {
		return nil, err
	}
	k := "\x00enroll:" + u.ID
	if err = a.reserveSecurityAttempt(k); err != nil {
		return nil, err
	}
	step, ok := otpMatch(seed, strings.TrimSpace(code), time.Now())
	if !ok || (givenSecret != "" && subtle.ConstantTimeCompare([]byte(seed), []byte(givenSecret)) != 1) {
		return nil, fail("Bestätigungscode ungültig.")
	}
	a.clearSecurityAttempts(k)
	if _, err = tx.Exec(ctx, "UPDATE users SET otp_secret=$1,otp_last=$2 WHERE name=$3", seed, step, u.ID); err != nil {
		return nil, err
	}
	if err = invalidateOtherSessions(ctx, tx, u); err != nil {
		return nil, err
	}
	codes, err := newRecoveryCodes(ctx, tx, u.ID)
	if err != nil {
		return nil, err
	}
	return codes, accountSecurityAudit(ctx, tx, u, "TOTP eingerichtet")
}

func accountSecurityAudit(ctx context.Context, tx pgx.Tx, u selfAccount, action string) error {
	_, err := tx.Exec(ctx, "INSERT INTO audit(username,action,subject) VALUES($1,$2,$1)", u.ID, action)
	return err
}

func (a *app) changeAccountSecurity(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	var q accountCommand
	if err := read(r, &q); err != nil {
		return nil, err
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	u, err := lockSelfAccount(ctx, tx, r)
	if err != nil {
		return nil, err
	}
	switch q.Action {
	case "mfa-confirm":
		codes, err := a.confirmAuthenticator(ctx, tx, u, q.Code, "")
		if err != nil {
			return nil, err
		}
		return map[string]any{"codes": codes}, tx.Commit(ctx)
	case "revoke", "revoke-others":
		if q.Action == "revoke" {
			if !idPattern.MatchString(q.SessionID) || q.SessionID == u.SessionID {
				return nil, fail("Eine andere Sitzung dieses Kontos auswählen.")
			}
			tag, err := tx.Exec(ctx, "DELETE FROM sessions WHERE username=$1 AND public_id=$2 AND expires>now()", u.ID, q.SessionID)
			if err != nil {
				return nil, err
			}
			if tag.RowsAffected() != 1 {
				return nil, problem{404, "Sitzung nicht mehr aktiv."}
			}
			err = accountSecurityAudit(ctx, tx, u, "Eigene Sitzung widerrufen")
			if err != nil {
				return nil, err
			}
		} else {
			if err = invalidateOtherSessions(ctx, tx, u); err != nil {
				return nil, err
			}
			if err = accountSecurityAudit(ctx, tx, u, "Andere eigene Sitzungen widerrufen"); err != nil {
				return nil, err
			}
		}
		return true, tx.Commit(ctx)
	case "mfa-begin", "password", "mfa-disable", "recovery":
		if err = a.verifySelfPassword(ctx, tx, u, q.Password, q.Code); err != nil {
			return nil, err
		}
	default:
		return nil, fail("Unbekannte Kontoaktion.")
	}
	if q.Action == "mfa-begin" {
		setup, err := beginAuthenticator(ctx, tx, u)
		if err != nil {
			return nil, err
		}
		return setup, tx.Commit(ctx)
	}
	var rotated string
	var out any = true
	var action string
	switch q.Action {
	case "password":
		if q.Password == q.NewPassword {
			return nil, fail("Ein anderes neues Passwort wählen.")
		}
		digest, err := accountPassword(q.NewPassword)
		if err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, "UPDATE users SET password=$1 WHERE name=$2", string(digest), u.ID); err != nil {
			return nil, err
		}
		rotated = secret()
		if _, err = tx.Exec(ctx, "UPDATE sessions SET token=$1 WHERE public_id=$2", hash(rotated), u.SessionID); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, "UPDATE devices SET expires=least(now(),expires) WHERE username=$1 AND NOT online_actor", u.ID); err != nil {
			return nil, err
		}
		action = "Eigenes Passwort geändert"
	case "mfa-disable":
		if u.OTP == nil {
			return nil, fail("Kein Authenticator eingerichtet.")
		}
		if _, err = tx.Exec(ctx, "UPDATE users SET otp_secret=NULL,otp_last=-1 WHERE name=$1", u.ID); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, "DELETE FROM recovery_codes WHERE username=$1", u.ID); err != nil {
			return nil, err
		}
		action = "Eigener Authenticator deaktiviert"
	case "recovery":
		if u.OTP == nil {
			return nil, fail("Zuerst einen Authenticator einrichten.")
		}
		codes, err := newRecoveryCodes(ctx, tx, u.ID)
		if err != nil {
			return nil, err
		}
		out = map[string]any{"codes": codes}
		action = "Eigene Recoverycodes erneuert"
	}
	if err = invalidateOtherSessions(ctx, tx, u); err != nil {
		return nil, err
	}
	if err = accountSecurityAudit(ctx, tx, u, action); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	if rotated != "" {
		setAccountSessionCookie(w, r, rotated)
	}
	return out, nil
}
