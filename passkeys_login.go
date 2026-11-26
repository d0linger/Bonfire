package main

import (
	"context"
	"errors"
	"net/http"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/jackc/pgx/v5"
)

func (a *app) beginPasskeyLogin(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	p, err := passkeyRequest(r)
	if err != nil {
		return nil, err
	}
	options, sd, err := p.BeginDiscoverableLogin(webauthn.WithUserVerification(protocol.VerificationRequired))
	if err != nil {
		return nil, err
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	return options, issuePasskeyChallenge(ctx, tx, w, r, "login", p.Config.RPOrigins[0], passkeyCeremony{Session: *sd})
}

func (a *app) finishPasskeyLogin(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	p, err := passkeyRequest(r)
	if err != nil {
		return nil, err
	}
	c, err := a.takePasskeyChallenge(ctx, w, r, "login", p.Config.RPOrigins[0])
	if err != nil {
		return nil, err
	}
	r.Body = http.MaxBytesReader(w, r.Body, 128<<10)
	response, err := protocol.ParseCredentialRequestResponse(r)
	denied := problem{401, "Sign-in with this passkey failed."}
	if err != nil {
		return nil, denied
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	u := &passkeyUser{}
	var role string
	var change bool
	// Serialize assertion counters and revocation with every other security change.
	err = tx.QueryRow(ctx, `SELECT u.name,uuid_send(u.passkey_handle),u.role,u.password_change_required
		FROM users u WHERE u.name=(SELECT username FROM passkeys WHERE credential_id=$1 AND rp_id=$2)
		AND uuid_send(u.passkey_handle)=$3 AND u.active AND u.passkey_revision_at<=$4 FOR UPDATE OF u`,
		[]byte(response.RawID), p.Config.RPID, []byte(response.Response.UserHandle), c.Created).
		Scan(&u.id, &u.handle, &role, &change)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, denied
	}
	if err != nil {
		return nil, err
	}
	var stored webauthn.Credential
	err = tx.QueryRow(ctx, `SELECT credential FROM passkeys WHERE credential_id=$1 AND rp_id=$2 AND username=$3 FOR UPDATE`,
		[]byte(response.RawID), p.Config.RPID, u.id).Scan(&stored)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, denied
	}
	if err != nil {
		return nil, err
	}
	u.credentials = []webauthn.Credential{stored}
	_, verified, err := p.ValidatePasskeyLogin(func(_, _ []byte) (webauthn.User, error) { return u, nil }, c.Session, response)
	if err != nil || verified.Authenticator.CloneWarning {
		if _, err = tx.Exec(ctx, "INSERT INTO audit(username,action,subject) VALUES($1,'Anmeldung abgewiesen','Passkey')", u.id); err != nil {
			return nil, err
		}
		if err = tx.Commit(ctx); err != nil {
			return nil, err
		}
		return nil, denied
	}
	_, err = tx.Exec(ctx, `UPDATE passkeys SET credential=$2,last_used_at=clock_timestamp() WHERE credential_id=$1`, verified.ID, verified)
	if err != nil {
		return nil, err
	}
	if change {
		token := secret()
		if _, err = tx.Exec(ctx, "DELETE FROM password_changes WHERE expires<=now()"); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, "INSERT INTO password_changes(token,username) VALUES($1,$2)", hash(token), u.id); err != nil {
			return nil, err
		}
		return map[string]string{"passwordChange": token}, tx.Commit(ctx)
	}
	token, err := createAccountSession(ctx, tx, r, u.id)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	setAccountSessionCookie(w, r, token)
	return role, nil
}
