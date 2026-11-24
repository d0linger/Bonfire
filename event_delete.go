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
		return nil, fail("Veranstaltung auswählen.")
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
		return nil, problem{404, "Veranstaltung unbekannt."}
	}
	if err != nil {
		return nil, err
	}
	if deleted {
		return true, tx.Commit(ctx)
	}
	if general {
		return nil, problem{409, "Das allgemeine Kassenbuch gehört zum Geschäftsjahr und kann nicht gelöscht werden."}
	}
	if closed {
		return nil, problem{409, "Die Veranstaltung ist abgeschlossen."}
	}
	var blocker string
	err = tx.QueryRow(ctx, `SELECT CASE
		WHEN EXISTS(SELECT FROM originals WHERE event=e.id) THEN 'Die Veranstaltung enthält ausgestellte Originalbelege.'
		WHEN EXISTS(SELECT FROM donation_reports WHERE event=e.id) THEN 'Zur Veranstaltung sind Spendenprüfläufe gespeichert.'
		WHEN EXISTS(SELECT FROM event_closures WHERE event=e.id) THEN 'Für die Veranstaltung besteht ein dokumentierter Abschluss.'
		WHEN EXISTS(SELECT FROM period_closures p WHERE p.reopened_at IS NULL
			AND (p.fiscal_year IS NULL OR p.fiscal_year=e.fiscal_year)
			AND p.ends>=e.starts AND p.starts<=e.ends) THEN 'Die Veranstaltung gehört zu einer abgeschlossenen Periode.'
		WHEN EXISTS(SELECT FROM devices WHERE event=e.id AND NOT online_actor AND NOT sealed) THEN 'Für die Veranstaltung sind Geräte mit offener Offline-Erfassung vorbereitet.'
		WHEN EXISTS(SELECT FROM operations WHERE event=e.id AND outcome='Konflikt') THEN 'Zuerst die offenen Erfassungskonflikte klären.'
		WHEN EXISTS(SELECT FROM entries WHERE event=e.id) THEN 'Die Veranstaltung enthält noch Einträge. Entfernbare Einträge zuerst entfernen oder umbuchen.'
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
