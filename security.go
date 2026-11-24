package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"errors"
	"fmt"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func otpMatch(secret, code string, at time.Time) (int64, bool) {
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
	if err != nil || len(key) < 20 || len(code) != 6 {
		return 0, false
	}
	for step := at.Unix()/30 - 1; step <= at.Unix()/30+1; step++ {
		var msg [8]byte
		binary.BigEndian.PutUint64(msg[:], uint64(step))
		h := hmac.New(sha1.New, key)
		h.Write(msg[:])
		b := h.Sum(nil)
		off := b[len(b)-1] & 15
		n := binary.BigEndian.Uint32(b[off:off+4]) & 0x7fffffff
		if subtle.ConstantTimeCompare([]byte(fmt.Sprintf("%06d", n%1000000)), []byte(code)) == 1 {
			return step, true
		}
	}
	return 0, false
}
func (a *app) logout(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	if c, err := r.Cookie("bonfire_session"); err == nil {
		_, err = a.db.Exec(ctx, `WITH ended AS (DELETE FROM sessions WHERE token=$1 RETURNING username)
			INSERT INTO audit(username,action,subject) SELECT username,'Abmeldung','Sitzung' FROM ended`, hash(c.Value))
		if err != nil {
			return nil, err
		}
	}
	http.SetCookie(w, &http.Cookie{Name: "bonfire_session", Path: "/api", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode})
	return true, nil
}
func loginName(value string) string {
	value = strings.TrimSpace(value)
	if strings.Contains(value, "@") {
		return strings.ToLower(value)
	}
	return value
}

func validLoginName(name string) bool {
	if !strings.Contains(name, "@") {
		return key.MatchString(name)
	}
	address, err := mail.ParseAddress(name)
	return len(name) <= 254 && !strings.Contains(name, ":") && err == nil && address.Address == name
}

var factorRequired = problem{401, "Zweiter Faktor erforderlich."}

func (a *app) login(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	// Bind the entire password/MFA exchange to the version checked before verification.
	// A concurrent reset or session revocation cannot mint a fresh session afterwards.
	var candidate string
	var revision int64
	token, completing := strings.CutPrefix(r.Header.Get("Authorization"), "Bonfire-Challenge ")
	identifier, _, _ := r.BasicAuth()
	var lookup pgx.Row
	if completing {
		lookup = a.db.QueryRow(ctx, "SELECT u.name,u.account_revision FROM users u JOIN login_challenges c ON c.username=u.name WHERE c.token=$1", hash(token))
	} else {
		lookup = a.db.QueryRow(ctx, "SELECT name,account_revision FROM users WHERE coalesce(login_alias,name)=$1", loginName(identifier))
	}
	if err := lookup.Scan(&candidate, &revision); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	var err error
	if completing {
		_, _, err = a.completeLogin(ctx, token, r.Header.Get("X-Bonfire-OTP"))
	} else {
		_, _, err = a.auth(ctx, r)
	}
	pendingFactor := errors.Is(err, factorRequired) && r.Header.Get("X-Bonfire-Login") == "staged"
	if err != nil && !pendingFactor {
		var p problem
		if errors.As(err, &p) && p.code == 401 && !errors.Is(err, factorRequired) {
			if logErr := a.logDeniedLogin(ctx, r); logErr != nil {
				return nil, logErr
			}
		}
		return nil, err
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var role string
	var change bool
	err = tx.QueryRow(ctx, "SELECT role,password_change_required FROM users WHERE name=$1 AND account_revision=$2 AND active FOR UPDATE", candidate, revision).Scan(&role, &change)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, problem{401, "Zugang inzwischen geändert. Bitte erneut anmelden."}
	}
	if err != nil {
		return nil, err
	}
	token = secret()
	if pendingFactor {
		if _, err = tx.Exec(ctx, "DELETE FROM login_challenges WHERE expires<=now()"); err != nil {
			return nil, err
		}
		_, err = tx.Exec(ctx, "INSERT INTO login_challenges(token,username) VALUES ($1,$2)", hash(token), candidate)
		if err != nil {
			return nil, err
		}
		return map[string]string{"challenge": token}, tx.Commit(ctx)
	}
	if change {
		if _, err = tx.Exec(ctx, "DELETE FROM password_changes WHERE expires<=now()"); err != nil {
			return nil, err
		}
		_, err = tx.Exec(ctx, "INSERT INTO password_changes(token,username) VALUES ($1,$2)", hash(token), candidate)
		if err != nil {
			return nil, err
		}
		return map[string]string{"passwordChange": token}, tx.Commit(ctx)
	}
	if _, err = tx.Exec(ctx, "INSERT INTO sessions(token,username,expires) VALUES($1,$2,now()+interval '30 minutes')", hash(token), candidate); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, "UPDATE users SET last_login_at=now() WHERE name=$1", candidate); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	http.SetCookie(w, &http.Cookie{Name: "bonfire_session", Value: token, Path: "/api", MaxAge: 1800, HttpOnly: true, Secure: r.TLS != nil || strings.HasPrefix(r.Header.Get("Origin"), "https://"), SameSite: http.SameSiteStrictMode})
	return role, nil
}

func (a *app) completeLogin(ctx context.Context, token, code string) (string, string, error) {
	expired := problem{410, "Anmeldung abgelaufen. Bitte erneut anmelden."}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return "", "", err
	}
	defer tx.Rollback(ctx)
	var name, role, otpSecret string
	err = tx.QueryRow(ctx, `UPDATE login_challenges c SET remaining=c.remaining-1 FROM users u
		WHERE c.username=u.name AND c.token=$1 AND c.expires>now() AND c.remaining>0
		AND u.active AND u.otp_secret IS NOT NULL RETURNING u.name,u.role,u.otp_secret`, hash(token)).Scan(&name, &role, &otpSecret)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", expired
	}
	if err != nil {
		return "", "", err
	}
	if err = verifyCode(ctx, tx, name, otpSecret, code); err != nil {
		var denied problem
		if errors.As(err, &denied) {
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return "", "", commitErr
			}
		}
		return "", "", err
	}
	if _, err = tx.Exec(ctx, "DELETE FROM login_challenges WHERE token=$1", hash(token)); err != nil {
		return "", "", err
	}
	if err = tx.Commit(ctx); err != nil {
		return "", "", err
	}
	a.mu.Lock()
	delete(a.attempts, name)
	a.mu.Unlock()
	return name, role, nil
}
func (a *app) mfa(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	name, _, err := a.auth(ctx, r)
	if err != nil {
		return nil, err
	}
	var q struct{ Secret, Code string }
	if err = read(r, &q); err != nil {
		return nil, err
	}
	if q.Secret == "" {
		var b [20]byte
		rand.Read(b[:])
		return map[string]string{"secret": base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b[:])}, nil
	}
	step, ok := otpMatch(q.Secret, q.Code, time.Now())
	if !ok {
		return nil, fail("Bestätigungscode ungültig.")
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, "UPDATE users SET otp_secret=$1,otp_last=$2 WHERE name=$3 AND otp_secret IS NULL", q.Secret, step, name)
	if err != nil || tag.RowsAffected() != 1 {
		return nil, fail("Zweiter Faktor bereits eingerichtet.")
	}
	codes := []string{}
	for range 8 {
		code := secret()[:16]
		if _, err = tx.Exec(ctx, "INSERT INTO recovery_codes VALUES($1,$2)", name, hash(code)); err != nil {
			return nil, err
		}
		codes = append(codes, code)
	}
	if _, err = tx.Exec(ctx, "INSERT INTO audit(username,action,subject) VALUES($1,'TOTP eingerichtet','Konto')", name); err != nil {
		return nil, err
	}
	return codes, tx.Commit(ctx)
}
func (a *app) factor(ctx context.Context, name, code string) error {
	var secret *string
	if err := a.db.QueryRow(ctx, "SELECT otp_secret FROM users WHERE name=$1", name).Scan(&secret); err != nil {
		return err
	}
	if secret == nil {
		return nil
	}
	if code == "" {
		return factorRequired
	}
	return verifyCode(ctx, a.db, name, *secret, code)
}

type factorExecutor interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func verifyCode(ctx context.Context, db factorExecutor, name, secret, code string) error {
	if step, ok := otpMatch(secret, code, time.Now()); ok {
		tag, err := db.Exec(ctx, "UPDATE users SET otp_last=$1 WHERE name=$2 AND otp_last<$1", step, name)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 1 {
			return nil
		}
	}
	tag, err := db.Exec(ctx, "DELETE FROM recovery_codes WHERE username=$1 AND digest=$2", name, hash(code))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 1 {
		return nil
	}
	return problem{401, "Zweiter Faktor ungültig oder bereits verwendet."}
}
func (a *app) manage(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(751025)"); err != nil {
		return nil, err
	}
	d, err := lock(ctx, tx, r)
	if err != nil {
		return nil, err
	}
	var q struct {
		Action, Target, Reason, Start, End string
		Accounts                           bool
	}
	if err = read(r, &q); err != nil {
		return nil, err
	}
	switch q.Action {
	case "period-close", "period-open":
		return periodAction(ctx, tx, d, q.Action, q.Target, q.Reason)
	case "prior":
		if d.Role != "Leitung" {
			return nil, problem{403, "Leitungsrecht erforderlich."}
		}
		return prior(ctx, tx, q.Target)
	case "conflict-originals", "conflict-file":
		return conflictOriginals(ctx, tx, d, q.Action, q.Target)
	case "numbers":
		return numberReport(ctx, tx, d)
	case "incident", "incomplete", "return":
		return incidentAction(ctx, tx, d, q.Action, q.Target, q.Reason)
	case "period", "journal-period":
		return a.globalPeriod(ctx, tx, d, q.Target, q.Reason, q.Action == "journal-period")
	case "copy":
		id, err := a.copyEvent(ctx, tx, d, q.Target, q.Start, q.End)
		if err != nil {
			return nil, err
		}
		return id, tx.Commit(ctx)
	case "journal":
		if d.Role == "Kassa" {
			return nil, problem{403, "Prüfrecht erforderlich."}
		}
		rows, err := tx.Query(ctx, "SELECT recorded_at::text AS at,actor AS username,concat(CASE direction WHEN -1 THEN 'Storno' ELSE 'Buchung' END,' · ',data->>'Label',' · ',(data->>'Amount'),' Cent') AS action FROM journal_history WHERE event=$1 ORDER BY id", d.Event)
		if err != nil {
			return nil, err
		}
		return pgx.CollectRows(rows, pgx.RowToMap)
	case "audit":
		if d.Role == "Kassa" {
			return nil, problem{403, "Prüfrecht erforderlich."}
		}
		rows, err := tx.Query(ctx, "SELECT a.at::text,a.username,a.action,a.subject,a.actor_device::text AS device,o.local_time::text AS local_time,o.device::text AS source_device,o.base AS base_revision FROM audit a LEFT JOIN operations o ON o.id::text=a.subject AND o.event=a.event WHERE a.event=$1 ORDER BY a.id", d.Event)
		if err != nil {
			return nil, err
		}
		return pgx.CollectRows(rows, pgx.RowToMap)
	case "accounts":
		if d.Role != "Leitung" || d.Closed {
			return nil, problem{403, "Nur Leitung bei offener Veranstaltung."}
		}
		_, err = tx.Exec(ctx, "UPDATE events SET accounts=$1 WHERE id=$2", q.Accounts, d.Event)
		if q.Accounts {
			q.Action = "Kontozuordnung aktiviert"
		} else {
			q.Action = "Kontozuordnung deaktiviert"
		}
	case "reopen":
		if d.Role != "Leitung" || !d.Closed || len(strings.TrimSpace(q.Reason)) < 5 {
			return nil, fail("Leitung und Wiederöffnungsgrund erforderlich.")
		}
		_, err = tx.Exec(ctx, "UPDATE events SET closed=false WHERE id=$1", d.Event)
	case "reprint":
		var exists bool
		err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM originals WHERE event=$1 AND subject=$2)", d.Event, q.Target).Scan(&exists)
		if err == nil && !exists {
			return nil, fail("Original nicht vorhanden.")
		}
	default:
		return nil, fail("Unbekannte Aktion.")
	}
	if err != nil {
		return nil, err
	}
	if err = audit(ctx, tx, d.Event, d.User, q.Action+" "+q.Reason, q.Target); err != nil {
		return nil, err
	}
	return true, tx.Commit(ctx)
}
