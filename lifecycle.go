package main

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
)

// A contact's originating workspace may edit it. A reference from another
// workspace makes it visible there without transferring edit authority.
const contactOrigin = "EXISTS(SELECT 1 FROM devices d WHERE d.id=c.device AND d.event=$1)"
const contactVisible = "($2='Admin' OR " + contactOrigin + " OR EXISTS(SELECT 1 FROM entries j WHERE j.event=$1 AND j.data->>'Contact'=c.id))"
const sharedSponsorDirectory = "EXISTS(SELECT FROM events WHERE id=$1 AND NOT general_ledger)"

func authorizeContactWrite(ctx context.Context, tx pgx.Tx, d device, id string) error {
	if d.Role == roleAdmin {
		return nil
	}
	var allowed bool
	err := tx.QueryRow(ctx, "SELECT NOT EXISTS(SELECT FROM directory c WHERE c.id=$2 AND NOT "+contactOrigin+")", d.Event, id).Scan(&allowed)
	if err != nil {
		return err
	}
	if !allowed {
		return problem{403, "You cannot edit this contact in the selected workspace."}
	}
	return nil
}

// Serialize independent offline creations even when the devices generated different IDs.
func contactNameAvailable(ctx context.Context, tx pgx.Tx, o op) (bool, error) {
	if o.Base != 0 || len(strings.TrimSpace(o.Data.Fields["distinct"])) >= 3 {
		return true, nil
	}
	var name string
	if err := tx.QueryRow(ctx, `SELECT lower(trim(regexp_replace($1,'[[:space:]]+',' ','g')))`, o.Data.Label).Scan(&name); err != nil {
		return false, err
	}
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,1))", name); err != nil {
		return false, err
	}
	var available bool
	err := tx.QueryRow(ctx, `SELECT NOT EXISTS(SELECT 1 FROM directory WHERE id<>$1 AND lower(trim(regexp_replace(data->>'Label','[[:space:]]+',' ','g')))=$2)`, o.Target, name).Scan(&available)
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
		return o.Data.Fields["lifecycle"] == "", nil
	}
	if revision == 0 || archived == o.Data.Retired {
		return false, nil
	}
	action := "Archiviert"
	if archived {
		action = "Wiederhergestellt"
	}
	if d.Role != roleAdmin || o.Data.Fields["lifecycle"] != action || len(strings.TrimSpace(o.Data.Fields["lifecycleReason"])) < 3 {
		return false, nil
	}
	return true, nil
}
