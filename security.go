package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha1" // #nosec G505 -- RFC 6238 HMAC-SHA1 for existing authenticator enrollments.
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
		if step < 0 {
			continue
		}
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
	writeSessionCookie(w, r, "", -1)
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
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var candidate, alias string
	var revision int64
	token, completing := strings.CutPrefix(r.Header.Get("Authorization"), "Bonfire-Challenge ")
	identifier, _, _ := r.BasicAuth()
	var lookup pgx.Row
	if completing {
		lookup = tx.QueryRow(ctx, "SELECT u.name,u.account_revision,coalesce(u.login_alias,u.name) FROM users u JOIN login_challenges c ON c.username=u.name WHERE c.token=$1", hash(token))
	} else {
		lookup = tx.QueryRow(ctx, "SELECT name,account_revision,coalesce(login_alias,name) FROM users WHERE coalesce(login_alias,name)=$1", loginName(identifier))
	}
	if err := lookup.Scan(&candidate, &revision, &alias); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if completing {
		_, _, err = completeLogin(ctx, tx, token, r.Header.Get("X-Bonfire-OTP"))
	} else {
		_, _, err = a.authenticate(ctx, tx, r)
	}
	pendingFactor := errors.Is(err, factorRequired) && r.Header.Get("X-Bonfire-Login") == "staged"
	if err != nil && !pendingFactor {
		var p problem
		if errors.As(err, &p) && p.code == 401 && !errors.Is(err, factorRequired) {
			if logErr := logDeniedLogin(ctx, tx, r); logErr != nil {
				return nil, logErr
			}
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return nil, commitErr
			}
		}
		return nil, err
	}
	var role string
	var change bool
	err = tx.QueryRow(ctx, "SELECT role,password_change_required FROM users WHERE name=$1 AND account_revision=$2 AND active FOR UPDATE", candidate, revision).Scan(&role, &change)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, problem{401, "Zugang inzwischen geändert. Bitte erneut anmelden."}
	}
	if err != nil {
		return nil, err
	}
	if pendingFactor {
		token = secret()
		if _, err = tx.Exec(ctx, "DELETE FROM login_challenges WHERE expires<=now()"); err != nil {
			return nil, err
		}
		_, err = tx.Exec(ctx, "INSERT INTO login_challenges(token,username) VALUES ($1,$2)", hash(token), candidate)
		if err != nil {
			return nil, err
		}
		return map[string]string{"challenge": token}, tx.Commit(ctx)
	}
	if completing {
		pair, source, accountKey := loginIdentities(loginSource(r), candidate)
		if _, err := a.loginLimits.Exec(ctx, "SELECT clear_login_attempt(date_trunc('minute',clock_timestamp()),$1,$2,$3)", pair, source, accountKey); err != nil {
			return nil, err
		}
	}
	if change {
		token = secret()
		if _, err = tx.Exec(ctx, "DELETE FROM password_changes WHERE expires<=now()"); err != nil {
			return nil, err
		}
		_, err = tx.Exec(ctx, "INSERT INTO password_changes(token,username) VALUES ($1,$2)", hash(token), candidate)
		if err != nil {
			return nil, err
		}
		return map[string]string{"passwordChange": token}, tx.Commit(ctx)
	}
	token, err = createAccountSession(ctx, tx, r, candidate)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	setAccountSessionCookie(w, r, token)
	return role, nil
}

func completeLogin(ctx context.Context, tx pgx.Tx, token, code string) (string, string, error) {
	expired := problem{410, "Anmeldung abgelaufen. Bitte erneut anmelden."}
	var name, role, otpSecret string
	err := tx.QueryRow(ctx, `SELECT u.name,u.role,u.otp_secret FROM login_challenges c JOIN users u ON c.username=u.name
		WHERE c.token=$1 AND c.expires>now() AND c.remaining>0 AND u.active AND u.otp_secret IS NOT NULL
		FOR UPDATE OF u`, hash(token)).Scan(&name, &role, &otpSecret)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", expired
	}
	if err != nil {
		return "", "", err
	}
	tag, err := tx.Exec(ctx, "UPDATE login_challenges SET remaining=remaining-1 WHERE token=$1 AND expires>clock_timestamp() AND remaining>0", hash(token))
	if err != nil {
		return "", "", err
	}
	if tag.RowsAffected() != 1 {
		return "", "", expired
	}
	if err = verifyCode(ctx, tx, name, otpSecret, code); err != nil {
		return "", "", err
	}
	if _, err = tx.Exec(ctx, "DELETE FROM login_challenges WHERE token=$1", hash(token)); err != nil {
		return "", "", err
	}
	return name, role, nil
}

// Older clients receive the recovery list directly. Both entry points use
// the same server-issued setup and require a fresh password before enrollment.
func (a *app) mfa(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	var q struct{ Secret, Code, Password string }
	if err := read(r, &q); err != nil {
		return nil, err
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var u selfAccount
	if login, password, ok := r.BasicAuth(); ok {
		err = tx.QueryRow(ctx, `SELECT name,coalesce(login_alias,name),password,otp_secret,account_revision
			FROM users WHERE coalesce(login_alias,name)=$1 AND active AND NOT password_change_required FOR UPDATE`,
			loginName(login)).Scan(&u.ID, &u.Login, &u.Password, &u.OTP, &u.Revision)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, problem{401, "Sign-in failed."}
		}
		if err != nil {
			return nil, err
		}
		u.SessionID = "basic"
		if err = a.verifySelfPassword(ctx, tx, u, password, r.Header.Get("X-Bonfire-OTP")); err != nil {
			var denied problem
			if errors.As(err, &denied) && denied.code == 403 {
				return nil, problem{401, "Sign-in failed."}
			}
			return nil, err
		}
	} else {
		u, err = lockSelfAccount(ctx, tx, r)
		if err != nil {
			return nil, err
		}
		if q.Secret == "" {
			if err = a.verifySelfPassword(ctx, tx, u, q.Password, ""); err != nil {
				return nil, err
			}
		}
	}
	if q.Secret == "" {
		setup, err := beginAuthenticator(ctx, tx, u)
		if err != nil {
			return nil, err
		}
		return setup, tx.Commit(ctx)
	}
	codes, err := a.confirmAuthenticator(ctx, tx, u, q.Code, q.Secret)
	if err != nil {
		return nil, err
	}
	return codes, tx.Commit(ctx)
}
func factor(ctx context.Context, db authDB, name, code string) error {
	var secret *string
	if err := db.QueryRow(ctx, "SELECT otp_secret FROM users WHERE name=$1", name).Scan(&secret); err != nil {
		return err
	}
	if secret == nil {
		return nil
	}
	if code == "" {
		return factorRequired
	}
	return verifyCode(ctx, db, name, *secret, code)
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
	return problem{401, "The code is invalid or has already been used."}
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
		Action, Target, Reason, Start, End, Year string
		CopyKinds                                []string
		Accounts                                 bool
		Stamp                                    string
		AccountMap                               map[string]string
	}
	if err = read(r, &q); err != nil {
		return nil, err
	}
	switch q.Action {
	case "sponsor-contacts":
		if !d.Online || d.Closed || (d.Role != roleAdmin && d.Role != roleWrite) {
			return nil, problem{403, "Schreibrecht für ein offenes Fest erforderlich."}
		}
		rows, err := tx.Query(ctx, `SELECT id,concat_ws(' · ',data->>'Label',nullif(data->>'Address',''),nullif(data->'Fields'->>'distinct','')) AS caption
			FROM directory WHERE NOT coalesce((data->>'Retired')::boolean,false)
			AND EXISTS(SELECT FROM events WHERE id=$1 AND NOT general_ledger)
			ORDER BY lower(data->>'Label'),id`, d.Event)
		if err != nil {
			return nil, err
		}
		return pgx.CollectRows(rows, pgx.RowToMap)
	case "year-carry":
		return carryYear(ctx, tx, d, q.Target, q.Stamp, q.AccountMap)
	case "period-close", "period-open":
		if d.Closed {
			return nil, problem{409, "Der Arbeitsbereich ist abgeschlossen."}
		}
		return periodAction(ctx, tx, d, q.Action, q.Target, q.Reason)
	case "prior":
		if d.Role != roleAdmin {
			return nil, problem{403, "Adminrecht erforderlich."}
		}
		return prior(ctx, tx, q.Target)
	case "conflict-originals", "conflict-file":
		return conflictOriginals(ctx, tx, d, q.Action, q.Target)
	case "numbers":
		return numberReport(ctx, tx, d)
	case "incident", "incomplete", "return":
		if d.Closed {
			return nil, problem{409, "Der Arbeitsbereich ist abgeschlossen."}
		}
		return incidentAction(ctx, tx, d, q.Action, q.Target, q.Reason)
	case "period", "journal-period":
		return a.globalPeriod(ctx, tx, d, q.Target, q.Reason, q.Action == "journal-period")
	case "copy":
		id, err := a.copyEvent(ctx, tx, d, q.Target, q.Start, q.End, q.Year, q.CopyKinds)
		if err != nil {
			return nil, err
		}
		return id, tx.Commit(ctx)
	case "journal":
		rows, err := tx.Query(ctx, "SELECT recorded_at::text AS at,actor AS username,concat(CASE direction WHEN -1 THEN 'Storno' ELSE 'Buchung' END,' · ',data->>'Label',' · ',(data->>'Amount'),' Cent') AS action FROM journal_history WHERE event=$1 ORDER BY id", d.Event)
		if err != nil {
			return nil, err
		}
		return pgx.CollectRows(rows, pgx.RowToMap)
	case "audit":
		rows, err := tx.Query(ctx, "SELECT a.at::text,a.username,a.action,a.subject,a.actor_device::text AS device,o.local_time::text AS local_time,o.device::text AS source_device,o.base AS base_revision FROM audit a LEFT JOIN operations o ON o.id::text=a.subject AND o.event=a.event WHERE a.event=$1 ORDER BY a.id", d.Event)
		if err != nil {
			return nil, err
		}
		return pgx.CollectRows(rows, pgx.RowToMap)
	case "accounts":
		if d.Role != roleAdmin || d.Closed {
			return nil, problem{403, "Nur für Admins bei offener Veranstaltung."}
		}
		_, err = tx.Exec(ctx, "UPDATE events SET accounts=$1 WHERE id=$2", q.Accounts, d.Event)
		if q.Accounts {
			q.Action = "Kontozuordnung aktiviert"
		} else {
			q.Action = "Kontozuordnung deaktiviert"
		}
	case "reopen", "year-reopen":
		if d.Role != roleAdmin {
			return nil, problem{403, "Nur Admins können einen Abschluss wieder öffnen."}
		}
		q.Reason = strings.TrimSpace(q.Reason)
		if !d.Closed || len(q.Reason) < 5 || len(q.Reason) > 1000 {
			return nil, fail("Abgeschlossenen Arbeitsbereich und Wiederöffnungsgrund angeben (5–1000 Zeichen).")
		}
		var downstream bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT FROM entries j JOIN events e ON e.id=j.event
			WHERE e.closed AND j.kind='opening' AND j.data->'Fields'->>'yearSource'=$1 AND coalesce(j.data->'Fields'->>'yearPeriod','')='')
			OR EXISTS(SELECT FROM period_closures p CROSS JOIN LATERAL jsonb_array_elements(p.snapshot) j
			WHERE p.reopened_at IS NULL AND j->>'Kind'='opening' AND j->'Data'->'Fields'->>'yearSource'=$1 AND coalesce(j->'Data'->'Fields'->>'yearPeriod','')='')`, d.Event).Scan(&downstream); err != nil {
			return nil, err
		}
		if downstream {
			return nil, problem{409, "Zuerst den abhängigen Folgeabschluss wieder öffnen."}
		}
		if q.Action == "year-reopen" {
			y, err := yearForClosure(ctx, tx, d)
			if err != nil {
				return nil, err
			}
			if !y.Closed {
				return nil, fail("Das Geschäftsjahr ist bereits offen.")
			}
			if _, err = tx.Exec(ctx, "UPDATE fiscal_years SET closed=false WHERE id=$1", y.ID); err != nil {
				return nil, err
			}
			q.Action, q.Target = "Geschäftsjahr wieder geöffnet", y.ID
		} else {
			if err = requireOpenYear(ctx, tx, d.Event); err != nil {
				return nil, err
			}
			q.Action, q.Target = "Arbeitsbereich wieder geöffnet", d.Event
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
