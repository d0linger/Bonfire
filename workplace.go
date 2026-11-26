package main

import (
	"context"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
)

// The online workplace has no device authority. Only display fields are returned.
func (a *app) workplace(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	user, role, err := a.auth(ctx, r)
	if err != nil {
		return nil, err
	}
	id := r.URL.Query().Get("event")
	if id == "" {
		return map[string]string{"user": user, "role": role}, nil
	}
	if !idPattern.MatchString(id) {
		return nil, fail("Arbeitsbereich ungültig.")
	}
	tx, err := a.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var e event
	err = tx.QueryRow(ctx, `SELECT id::text,name,starts::text,ends::text,closed,accounts,general_ledger,coalesce(fiscal_year::text,'') FROM events
 WHERE id=$1 AND ($2='Admin' OR EXISTS(SELECT 1 FROM grants_event WHERE event=$1 AND username=$3))`, id, role, user).Scan(&e.ID, &e.Name, &e.Starts, &e.Ends, &e.Closed, &e.Accounts, &e.General, &e.Year)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, problem{403, "Arbeitsbereich nicht zugewiesen."}
	}
	if err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `SELECT j.id,j.kind,jsonb_strip_nulls(jsonb_build_object('Label',j.data->'Label','Date',j.data->'Date','Amount',j.data->'Amount','PostingOrder',j.data->'PostingOrder','Method',j.data->'Method','Fields',jsonb_build_object('countScope',j.data->'Fields'->'countScope'),'Wallet',j.data->'Wallet','Phase',j.data->'Phase','Status',j.data->'Status','Account',j.data->'Account','To',j.data->'To','Bar',j.data->'Bar','Number',j.data->'Number','Reference',j.data->'Reference','Retired',j.data->'Retired','Category',j.data->'Category','Unit',j.data->'Unit','Logo',CASE WHEN j.kind='organization' THEN j.data->'File' END)) FROM settlement_entries j WHERE j.event=$1 AND j.kind NOT IN ('import-source','attachment-file','contact')
 UNION ALL SELECT c.id,'contact',jsonb_build_object('Label',c.data->'Label','Address',c.data->'Address','Retired',c.data->'Retired') FROM directory c WHERE EXISTS(SELECT 1 FROM devices d WHERE d.id=c.device AND d.event=$1) OR EXISTS(SELECT 1 FROM entries j WHERE j.event=$1 AND j.data->>'Contact'=c.id)
 ORDER BY 1`, id)
	if err != nil {
		return nil, err
	}
	type item struct {
		ID, Kind string
		Data     map[string]any
	}
	entries, err := pgx.CollectRows(rows, pgx.RowToStructByPos[item])
	if err != nil {
		return nil, err
	}
	var pending, conflicts int
	err = tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM devices WHERE event=$1 AND NOT online_actor AND NOT sealed),(SELECT count(*) FROM operations WHERE event=$1 AND outcome='Konflikt')`, id).Scan(&pending, &conflicts)
	if err != nil {
		return nil, err
	}
	return map[string]any{"user": user, "role": role, "event": e, "entries": entries, "pending": pending, "conflicts": conflicts}, tx.Commit(ctx)
}
