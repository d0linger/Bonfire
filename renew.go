package main

import (
	"context"
	"crypto/subtle"
	"net/http"
	"time"
)

func (a *app) renew(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	if _, _, ok := r.BasicAuth(); !ok {
		return nil, problem{401, "Erneute persönliche Anmeldung erforderlich."}
	}
	name, role, err := a.auth(ctx, r)
	if err != nil {
		return nil, err
	}
	var q struct{ Device, Proof, Next string }
	if err = read(r, &q); err != nil {
		return nil, err
	}
	if !idPattern.MatchString(q.Device) || len(q.Proof) > 128 {
		return nil, fail("Ungültiger Gerätenachweis.")
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock_shared(751025)"); err != nil {
		return nil, err
	}
	var event, state string
	var digest []byte
	err = tx.QueryRow(ctx, `SELECT e.id::text,d.secret,d.incident_state FROM devices d JOIN events e ON e.id=d.event WHERE d.id=$1 AND d.username=$2 AND NOT e.closed AND NOT d.sealed AND d.incident_state IN ('','returning') AND ($3='Leitung' OR EXISTS(SELECT 1 FROM grants_event g WHERE g.event=e.id AND g.username=d.username)) FOR UPDATE OF e,d`, q.Device, name, role).Scan(&event, &digest, &state)
	rotate := idPattern.MatchString(q.Next) && q.Next != q.Proof
	if err != nil || (subtle.ConstantTimeCompare(digest, hash(q.Proof)) != 1 && !(rotate && subtle.ConstantTimeCompare(digest, hash(q.Next)) == 1)) || state == "returning" && !rotate {
		return nil, problem{403, "Gerät, Person oder Freigabe nicht bestätigt."}
	}
	if rotate {
		digest = hash(q.Next)
	}
	var expiry time.Time
	if err = tx.QueryRow(ctx, "UPDATE devices SET secret=$2,expires=now()+interval '72 hours' WHERE id=$1 RETURNING expires", q.Device, digest).Scan(&expiry); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, "SELECT set_config('bonfire.device',$1,true)", q.Device); err != nil {
		return nil, err
	}
	if err = audit(ctx, tx, event, name, "Gerätefreigabe erneuert", q.Device); err != nil {
		return nil, err
	}
	return expiry, tx.Commit(ctx)
}
