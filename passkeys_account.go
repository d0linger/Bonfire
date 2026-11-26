package main

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type passkeyItem struct {
	ID       string     `json:"id"`
	Name     string     `json:"name"`
	Created  time.Time  `json:"created"`
	LastUsed *time.Time `json:"lastUsed"`
}

func (a *app) accountPasskeys(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	user, err := lockSelfAccount(ctx, tx, r)
	if err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `SELECT id::text,name,created_at,last_used_at FROM passkeys
		WHERE username=$1 ORDER BY created_at,id`, user.ID)
	if err != nil {
		return nil, err
	}
	items, err := pgx.CollectRows(rows, pgx.RowToStructByPos[passkeyItem])
	if err != nil {
		return nil, err
	}
	origin := ""
	p, policyErr := passkeyPolicy()
	if policyErr == nil {
		origin = p.Config.RPOrigins[0]
	}
	return map[string]any{"items": items, "available": policyErr == nil, "origin": origin}, tx.Commit(ctx)
}

func (a *app) beginPasskeyRegistration(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	p, err := passkeyRequest(r)
	if err != nil {
		return nil, err
	}
	var q struct{ Name, Password, Code string }
	if err = read(r, &q); err != nil {
		return nil, err
	}
	q.Name = strings.TrimSpace(q.Name)
	if q.Name == "" || utf8.RuneCountInString(q.Name) > 80 {
		return nil, fail("Enter a passkey name of up to 80 characters.")
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	user, err := lockSelfAccount(ctx, tx, r)
	if err != nil {
		return nil, err
	}
	if err = a.verifySelfPassword(ctx, tx, user, q.Password, q.Code); err != nil {
		return nil, err
	}
	u, err := registrationUser(ctx, tx, user.ID, p.Config.RPID)
	if err != nil {
		return nil, err
	}
	if len(u.credentials) >= 20 {
		return nil, problem{409, "This account already has 20 passkeys."}
	}
	excluded := make([]protocol.CredentialDescriptor, 0, len(u.credentials))
	for _, c := range u.credentials {
		excluded = append(excluded, c.Descriptor())
	}
	options, sd, err := p.BeginRegistration(u, webauthn.WithExclusions(excluded),
		webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired))
	if err != nil {
		return nil, err
	}
	c := passkeyCeremony{Session: *sd, Owner: user.ID, SessionID: user.SessionID, Revision: user.Revision, Label: q.Name}
	return options, issuePasskeyChallenge(ctx, tx, w, r, "register", p.Config.RPOrigins[0], c)
}

func (a *app) finishPasskeyRegistration(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	p, err := passkeyRequest(r)
	if err != nil {
		return nil, err
	}
	c, err := a.takePasskeyChallenge(ctx, w, r, "register", p.Config.RPOrigins[0])
	if err != nil {
		return nil, err
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	user, err := lockSelfAccount(ctx, tx, r)
	if err != nil {
		return nil, err
	}
	if c.Owner != user.ID || c.SessionID != user.SessionID || c.Revision != user.Revision {
		return nil, expiredPasskey
	}
	u, err := registrationUser(ctx, tx, user.ID, p.Config.RPID)
	if err != nil {
		return nil, err
	}
	r.Body = http.MaxBytesReader(w, r.Body, 128<<10)
	credential, err := p.FinishRegistration(u, c.Session, r)
	if err != nil {
		return nil, fail("Could not verify this passkey. Set it up again.")
	}
	_, err = tx.Exec(ctx, `INSERT INTO passkeys(username,rp_id,name,credential_id,credential)
		VALUES($1,$2,$3,$4,$5)`, user.ID, p.Config.RPID, c.Label, credential.ID, credential)
	var dbErr *pgconn.PgError
	if errors.As(err, &dbErr) && dbErr.Code == "23505" {
		return nil, problem{409, "This passkey is already registered."}
	}
	if err != nil {
		return nil, err
	}
	return true, commitPasskeyChange(ctx, tx, user.ID, "Passkey eingerichtet")
}

func (a *app) removePasskey(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	// Removal remains available through ordinary authenticated account access
	// even if an installation changes its WebAuthn origin.
	var q struct{ ID, Password, Code string }
	if err := read(r, &q); err != nil {
		return nil, err
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	user, err := lockSelfAccount(ctx, tx, r)
	if err != nil {
		return nil, err
	}
	if err = a.verifySelfPassword(ctx, tx, user, q.Password, q.Code); err != nil {
		return nil, err
	}
	tag, err := tx.Exec(ctx, "DELETE FROM passkeys WHERE username=$1 AND id::text=$2", user.ID, q.ID)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() != 1 {
		return nil, problem{404, "Passkey not found."}
	}
	return true, commitPasskeyChange(ctx, tx, user.ID, "Passkey entfernt")
}

func commitPasskeyChange(ctx context.Context, tx pgx.Tx, username, action string) error {
	if _, err := tx.Exec(ctx, "UPDATE users SET account_revision=account_revision+1 WHERE name=$1", username); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "INSERT INTO audit(username,action,subject) VALUES($1,$2,'Konto')", username, action); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
