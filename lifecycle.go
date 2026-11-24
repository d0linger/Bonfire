package main

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"strings"
)

// Serialize independent offline creations even when the devices generated different IDs.
func contactNameAvailable(ctx context.Context, tx pgx.Tx, o op) (bool, error) {
	if o.Base != 0 || len(strings.TrimSpace(o.Data.Fields["distinct"])) >= 3 {
		return true, nil
	}
	name := strings.ToLower(strings.Join(strings.Fields(o.Data.Label), " "))
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,1))", name); err != nil {
		return false, err
	}
	var available bool
	err := tx.QueryRow(ctx, `SELECT NOT EXISTS(SELECT 1 FROM directory WHERE id<>$1 AND lower(regexp_replace(trim(data->>'Label'),'[[:space:]]+',' ','g'))=$2)`, o.Target, name).Scan(&available)
	return available, err
}

func lifecycle(ctx context.Context, tx pgx.Tx, d device, o op) (bool, error) {
	var revision int64
	var archived bool
	var err error
	if o.Kind == "contact" {
		err = tx.QueryRow(ctx, "SELECT revision,coalesce((data->>'Retired')::boolean,false) FROM directory WHERE id=$1", o.Target).Scan(&revision, &archived)
	} else {
		err = tx.QueryRow(ctx, "SELECT revision,coalesce((data->>'Retired')::boolean,false) FROM entries WHERE event=$1 AND id=$2", d.Event, o.Target).Scan(&revision, &archived)
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	if revision != o.Base {
		return false, nil
	}
	if !archived && !o.Data.Retired {
		return true, nil
	}
	if revision == 0 || archived == o.Data.Retired {
		return false, nil
	}
	action := "Archiviert"
	if archived {
		action = "Wiederhergestellt"
	}
	if d.Role != "Leitung" || o.Data.Fields["lifecycle"] != action || len(strings.TrimSpace(o.Data.Fields["lifecycleReason"])) < 3 {
		return false, nil
	}
	return true, nil
}
