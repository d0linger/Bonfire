package main

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
)

type deviceInfo struct {
	ID, Name string
	Sealed   bool
}

func walletAuthority(ctx context.Context, tx pgx.Tx, d device, o op) (bool, error) {
	v := o.Data
	if o.Kind != "handover" && o.Kind != "supply" && o.Kind != "skim" && o.Kind != "return" {
		return true, nil
	}
	if v.Wallet == "" {
		return false, fail("Geldtasche fehlt.")
	}
	var owner string
	err := tx.QueryRow(ctx, "SELECT coalesce(nullif(data->'Fields'->>'owner',''),device::text) FROM entries WHERE event=$1 AND id=$2 AND kind='wallet'", d.Event, v.Wallet).Scan(&owner)
	if err != nil {
		return false, err
	}
	var current data
	err = tx.QueryRow(ctx, "SELECT data FROM entries WHERE event=$1 AND id=$2 AND kind='handover'", d.Event, "handover:"+v.Wallet).Scan(&current)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	if o.Kind != "handover" {
		return owner == d.ID && current.Status != "Angeboten", nil
	}
	if o.Target != "handover:"+v.Wallet {
		return false, fail("Übergabe benötigt die stabile Geldtaschenkennung.")
	}
	switch v.Status {
	case "Angeboten":
		var permitted bool
		err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM devices WHERE event=$1 AND id=$2 AND NOT sealed AND expires>now())", d.Event, v.To).Scan(&permitted)
		return owner == d.ID && v.To != d.ID && permitted && current.Status != "Angeboten", err
	case "Bestätigt":
		if current.Status != "Angeboten" || current.To != d.ID || v.To != d.ID {
			return false, nil
		}
		_, err = tx.Exec(ctx, "UPDATE entries SET revision=revision+1,data=jsonb_set(data,'{Fields}',coalesce(data->'Fields','{}'::jsonb)||jsonb_build_object('owner',$3::text)) WHERE event=$1 AND id=$2", d.Event, v.Wallet, d.ID)
		return err == nil, err
	default:
		return false, fail("Übergabestatus ungültig.")
	}
}
