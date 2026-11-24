package main

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"strings"
)

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
