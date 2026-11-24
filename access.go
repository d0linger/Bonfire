package main

import (
	"context"
	"net/http"
	"strings"
)

func (a *app) access(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	actor, role, err := a.auth(ctx, r)
	if err != nil {
		return nil, err
	}
	if role != "Leitung" {
		return nil, problem{403, "Leitung erforderlich."}
	}
	var q struct{ Name, Event, Action, Reason string }
	if err = read(r, &q); err != nil {
		return nil, err
	}
	q.Name = loginName(q.Name)
	if !validLoginName(q.Name) || !idPattern.MatchString(q.Event) || len(strings.TrimSpace(q.Reason)) < 3 {
		return nil, fail("Name, Veranstaltung und Begründung angeben.")
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock_shared(751025)"); err != nil {
		return nil, err
	}
	tag, err := tx.Exec(ctx, "SELECT id FROM events WHERE id=$1 FOR UPDATE", q.Event)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, problem{404, "Arbeitsbereich nicht verfügbar."}
	}
	switch q.Action {
	case "grant":
		_, err = tx.Exec(ctx, "INSERT INTO grants_event VALUES($1,$2) ON CONFLICT DO NOTHING", q.Name, q.Event)
	case "revoke":
		_, err = tx.Exec(ctx, "DELETE FROM grants_event WHERE username=$1 AND event=$2", q.Name, q.Event)
	default:
		return nil, fail("Unbekannte Rechteaktion.")
	}
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, "UPDATE users SET account_revision=account_revision+1 WHERE name=$1", q.Name); err != nil {
		return nil, err
	}
	if err = audit(ctx, tx, q.Event, actor, q.Action+" "+q.Reason, q.Name); err != nil {
		return nil, err
	}
	return true, tx.Commit(ctx)
}
