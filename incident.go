package main

import (
	"context"
	"github.com/jackc/pgx/v5"
	"strings"
)

// The partial assessment records a known gap. Only the device can seal its own sequence.
func incidentAction(ctx context.Context, tx pgx.Tx, d device, action, target, reason string) (any, error) {
	reason = strings.TrimSpace(reason)
	if !idPattern.MatchString(target) || target == d.ID || len(reason) < 5 || len(reason) > 1000 {
		return nil, fail("Anderes Gerät und begründete Entscheidung angeben.")
	}
	var state, label, previous string
	switch action {
	case "incident":
		state = "missing"
		label = "Gerät vermisst"
		previous = ""
	case "incomplete":
		state = "incomplete"
		label = "Ausnahmeentscheid – Abschluss unvollständig"
		previous = "missing"
	case "return":
		state = "returning"
		label = "Gerät zurück – ausstehende Vorgänge einzeln prüfen"
	default:
		return nil, fail("Unbekannte Vorfallentscheidung.")
	}
	required := "Leitung"
	if state == "incomplete" {
		required = "Prüfung"
	}
	if d.Role != required {
		return nil, problem{403, "Zuständige Rolle erforderlich."}
	}
	var seq int64
	err := tx.QueryRow(ctx, `UPDATE devices SET incident_state=$1,incident=CASE WHEN $1='missing' THEN $2 ELSE incident END,
 expires=CASE WHEN $1='missing' THEN now() ELSE expires END WHERE id=$3 AND event=$4 AND NOT sealed
 AND (incident_state=$5 AND $1<>'returning' OR $1='returning' AND incident_state IN ('missing','incomplete'))
 RETURNING last_seq`, state, reason, target, d.Event, previous).Scan(&seq)
	if err == pgx.ErrNoRows {
		return nil, fail("Entscheidung passt nicht zum aktuellen Gerätestand.")
	}
	if err != nil {
		return nil, err
	}
	if err = audit(ctx, tx, d.Event, d.User, label+" · "+reason, target); err != nil {
		return nil, err
	}
	return seq, tx.Commit(ctx)
}
