package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/jackc/pgx/v5"
)

func (a *app) registerPasskeys(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/account/passkeys", route(a.accountPasskeys))
	mux.HandleFunc("POST /api/account/passkeys/register/begin", route(a.beginPasskeyRegistration))
	mux.HandleFunc("POST /api/account/passkeys/register/finish", route(a.finishPasskeyRegistration))
	mux.HandleFunc("POST /api/account/passkeys/remove", route(a.removePasskey))
	mux.HandleFunc("POST /api/passkey/login/begin", route(a.beginPasskeyLogin))
	mux.HandleFunc("POST /api/passkey/login/finish", route(a.finishPasskeyLogin))
}

// Configure one canonical origin from installation settings, never from the request.
func passkeyPolicy() (*webauthn.WebAuthn, error) {
	raw := strings.TrimSpace(os.Getenv("BONFIRE_PASSKEY_ORIGIN"))
	if raw == "" {
		raw = "http://localhost:8137"
	}
	u, err := url.Parse(raw)
	bad := problem{503, "Die Passkey-Adresse ist ungültig konfiguriert."}
	if err != nil || u.User != nil || u.Hostname() == "" || u.RawQuery != "" || u.ForceQuery ||
		u.Fragment != "" || (u.EscapedPath() != "" && u.EscapedPath() != "/") {
		return nil, bad
	}
	host := strings.ToLower(u.Hostname())
	if net.ParseIP(host) != nil || (u.Scheme != "https" && !(u.Scheme == "http" && host == "localhost")) {
		return nil, bad
	}
	origin := u.Scheme + "://" + strings.ToLower(u.Host)
	if (u.Scheme == "http" && u.Port() == "80") || (u.Scheme == "https" && u.Port() == "443") {
		origin = u.Scheme + "://" + host
	}
	p, err := webauthn.New(&webauthn.Config{
		RPID: host, RPDisplayName: "BONFIRE", RPOrigins: []string{origin},
		AuthenticatorSelection: protocol.AuthenticatorSelection{UserVerification: protocol.VerificationRequired},
	})
	if err != nil {
		return nil, bad
	}
	return p, nil
}

func passkeyRequest(r *http.Request) (*webauthn.WebAuthn, error) {
	p, err := passkeyPolicy()
	if err != nil {
		return nil, err
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != p.Config.RPOrigins[0] {
		return nil, problem{403, "Für Passkeys bitte BONFIRE unter " + p.Config.RPOrigins[0] + " öffnen."}
	}
	return p, nil
}

type passkeyUser struct {
	id, login, display string
	handle             []byte
	credentials        []webauthn.Credential
}

func (u *passkeyUser) WebAuthnID() []byte                         { return u.handle }
func (u *passkeyUser) WebAuthnName() string                       { return u.login }
func (u *passkeyUser) WebAuthnDisplayName() string                { return u.display }
func (u *passkeyUser) WebAuthnCredentials() []webauthn.Credential { return u.credentials }

func registrationUser(ctx context.Context, tx pgx.Tx, user, rp string) (*passkeyUser, error) {
	u := &passkeyUser{id: user}
	err := tx.QueryRow(ctx, `SELECT uuid_send(passkey_handle),coalesce(login_alias,name),
		coalesce(nullif(display_name,''),login_alias,name) FROM users WHERE name=$1`, user).
		Scan(&u.handle, &u.login, &u.display)
	if err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, "SELECT credential FROM passkeys WHERE username=$1 AND rp_id=$2", user, rp)
	if err != nil {
		return nil, err
	}
	u.credentials, err = pgx.CollectRows(rows, pgx.RowTo[webauthn.Credential])
	return u, err
}

type passkeyCeremony struct {
	Session                 webauthn.SessionData
	Owner, SessionID, Label string
	Revision                int64
	Created                 time.Time
}

func challengeCookie(kind, token, origin string, age int) *http.Cookie {
	path := "/api/passkey/login"
	if kind == "register" {
		path = "/api/account/passkeys/register"
	}
	// #nosec G124 -- the validated relying-party origin permits HTTP only on loopback.
	cookie := &http.Cookie{Name: "bonfire_passkey_" + kind, Path: path, Value: token, MaxAge: age,
		Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode}
	// The validated relying-party origin permits plain HTTP only on loopback.
	if strings.HasPrefix(origin, "http://") {
		cookie.Secure = false
	}
	return cookie
}

// Store only a digest of the browser's ceremony token. Serialize issuance to bound the
// number of outstanding anonymous challenges even when multiple app replicas are running.
func issuePasskeyChallenge(ctx context.Context, tx pgx.Tx, w http.ResponseWriter, r *http.Request,
	kind, origin string, c passkeyCeremony) error {
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(546820015)"); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "DELETE FROM passkey_challenges WHERE expires<=clock_timestamp()"); err != nil {
		return err
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	source := hash(host)
	var total, fromHost int
	err = tx.QueryRow(ctx, "SELECT count(*),count(*) FILTER (WHERE source=$1) FROM passkey_challenges WHERE kind=$2", source, kind).Scan(&total, &fromHost)
	if err != nil {
		return err
	}
	if total >= 512 || fromHost >= 32 {
		return problem{429, "Zu viele offene Passkey-Anfragen. Bitte später erneut versuchen."}
	}
	token := secret()
	_, err = tx.Exec(ctx, `INSERT INTO passkey_challenges(token,kind,origin,source,username,session_id,revision,label,session_data)
		VALUES ($1,$2,$3,$4,nullif($5,''),nullif($6,'')::uuid,nullif($7::bigint,0),$8,$9)`,
		hash(token), kind, origin, source, c.Owner, c.SessionID, c.Revision, c.Label, c.Session)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	http.SetCookie(w, challengeCookie(kind, token, origin, 300))
	return nil
}

var expiredPasskey = problem{410, "Der Passkey-Vorgang ist abgelaufen. Bitte erneut starten."}

// Consume independently of the later verification transaction, including failed responses.
func (a *app) takePasskeyChallenge(ctx context.Context, w http.ResponseWriter, r *http.Request, kind, origin string) (passkeyCeremony, error) {
	var c passkeyCeremony
	cookie := challengeCookie(kind, "", origin, -1)
	http.SetCookie(w, cookie)
	token, err := r.Cookie(cookie.Name)
	if err != nil {
		return c, expiredPasskey
	}
	err = a.db.QueryRow(ctx, `DELETE FROM passkey_challenges WHERE token=$1 AND kind=$2 AND origin=$3 AND expires>clock_timestamp()
		RETURNING session_data,coalesce(username,''),coalesce(session_id::text,''),coalesce(revision,0),label,created_at`,
		hash(token.Value), kind, origin).Scan(&c.Session, &c.Owner, &c.SessionID, &c.Revision, &c.Label, &c.Created)
	if errors.Is(err, pgx.ErrNoRows) {
		return c, expiredPasskey
	}
	return c, err
}
