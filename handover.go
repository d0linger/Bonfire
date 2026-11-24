package main

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
)

type deviceInfo struct {
	ID, Name      string
	Sealed        bool
	IncidentState string
	Last          int64
	IncidentNote  string
}

// A handover records physical receipt. It never changes booking permissions.
func validHandover(ctx context.Context, tx pgx.Tx, d device, o op) (bool, error) {
	v := o.Data
	if v.Wallet == "" {
		return false, fail("Geldtasche fehlt.")
	}
	var current data
	err := tx.QueryRow(ctx, "SELECT data FROM entries WHERE event=$1 AND id=$2 AND kind='handover'", d.Event, "handover:"+v.Wallet).Scan(&current)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	if o.Target != "handover:"+v.Wallet {
		return false, fail("Übergabe benötigt die stabile Geldtaschenkennung.")
	}
	switch v.Status {
	case "Angeboten":
		var permitted bool
		err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM devices WHERE event=$1 AND id=$2 AND NOT sealed AND expires>now())", d.Event, v.To).Scan(&permitted)
		return v.To != d.ID && permitted && current.Status != "Angeboten", err
	case "Bestätigt":
		return current.Status == "Angeboten" && current.To == d.ID && v.To == d.ID, nil
	default:
		return false, fail("Übergabestatus ungültig.")
	}
}
