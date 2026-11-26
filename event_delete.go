package main

import (
	"context"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
)

func (a *app) deleteEvent(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	var in struct{ Event string }
	if err := read(r, &in); err != nil {
		return nil, err
	}
	if !idPattern.MatchString(in.Event) {
		return nil, fail("Select an event.")
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	// Coordinate the removal of access grants with account changes, snapshot
	// creation and financial writes (including postponed device submissions).
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(751025)"); err != nil {
		return nil, err
	}
	user, err := accountManager(ctx, tx, r, true)
	if err != nil {
		return nil, err
	}
	var general, closed, deleted bool
	err = tx.QueryRow(ctx, `SELECT general_ledger,closed,deleted_at IS NOT NULL
		FROM event_records WHERE id=$1 FOR UPDATE`, in.Event).Scan(&general, &closed, &deleted)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, problem{404, "Unknown event."}
	}
	if err != nil {
		return nil, err
	}
	if deleted {
		return true, tx.Commit(ctx)
	}
	if general {
		return nil, problem{409, "The general cashbook belongs to the fiscal year and cannot be deleted."}
	}
	if closed {
		return nil, problem{409, "This event is closed."}
	}
	var blocker string
	err = tx.QueryRow(ctx, `SELECT CASE
		WHEN EXISTS(SELECT FROM originals WHERE event=e.id) THEN 'This event has issued original documents.'
		WHEN EXISTS(SELECT FROM donation_reports WHERE event=e.id) THEN 'This event has saved donation reviews.'
		WHEN EXISTS(SELECT FROM event_closures WHERE event=e.id) THEN 'A documented closing record exists for this event.'
		WHEN EXISTS(SELECT FROM period_closures p WHERE p.reopened_at IS NULL
			AND (p.fiscal_year IS NULL OR p.fiscal_year=e.fiscal_year)
			AND p.ends>=e.starts AND p.starts<=e.ends) THEN 'This event belongs to a closed period.'
		WHEN EXISTS(SELECT FROM devices WHERE event=e.id AND NOT online_actor AND NOT sealed) THEN 'Prepared devices still have open offline entry for this event.'
		WHEN EXISTS(SELECT FROM operations WHERE event=e.id AND outcome='Konflikt') THEN 'Resolve the open entry conflicts first.'
		WHEN EXISTS(SELECT FROM entries WHERE event=e.id) THEN 'This event still has entries. Remove or transfer eligible entries first.'
		ELSE '' END FROM events e WHERE e.id=$1`, in.Event).Scan(&blocker)
	if err != nil {
		return nil, err
	}
	if blocker != "" {
		return nil, problem{409, blocker}
	}
	if _, err = tx.Exec(ctx, `UPDATE users SET account_revision=account_revision+1
		WHERE name IN (SELECT username FROM grants_event WHERE event=$1)`, in.Event); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, "DELETE FROM grants_event WHERE event=$1", in.Event); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, "UPDATE event_records SET deleted_at=now() WHERE id=$1", in.Event); err != nil {
		return nil, err
	}
	if err = audit(ctx, tx, in.Event, user, "Leere Veranstaltung gelöscht", in.Event); err != nil {
		return nil, err
	}
	return true, tx.Commit(ctx)
}
