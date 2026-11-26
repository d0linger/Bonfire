package main

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"net/http"
	"strings"
)

func (a *app) access(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	var q struct{ Name, Event, Action, Reason string }
	if err := read(r, &q); err != nil {
		return nil, err
	}
	q.Name = loginName(q.Name)
	if !validLoginName(q.Name) || !idPattern.MatchString(q.Event) || len(strings.TrimSpace(q.Reason)) < 3 {
		return nil, fail("Enter a name, event and reason.")
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(751025)"); err != nil {
		return nil, err
	}
	var actor string
	if _, _, basic := r.BasicAuth(); !basic {
		actor, err = accountManager(ctx, tx, r, true)
		if err != nil {
			return nil, err
		}
	} else {
		var role string
		actor, role, err = a.authenticate(ctx, tx, r)
		if err != nil {
			return nil, err
		}
		if role != roleAdmin {
			return nil, problem{403, "Administrator access required."}
		}
	}
	var target string
	err = tx.QueryRow(ctx, "SELECT name FROM users WHERE coalesce(login_alias,name)=$1 OR name=$1 FOR UPDATE", q.Name).Scan(&target)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, problem{404, "Account not found."}
	}
	if err != nil {
		return nil, err
	}
	tag, err := tx.Exec(ctx, "SELECT id FROM events WHERE id=$1 FOR UPDATE", q.Event)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, problem{404, "This workspace is unavailable."}
	}
	switch q.Action {
	case "grant":
		_, err = tx.Exec(ctx, "INSERT INTO grants_event VALUES($1,$2) ON CONFLICT DO NOTHING", target, q.Event)
	case "revoke":
		_, err = tx.Exec(ctx, "DELETE FROM grants_event WHERE username=$1 AND event=$2", target, q.Event)
	default:
		return nil, fail("Unknown access action.")
	}
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, "UPDATE users SET account_revision=account_revision+1 WHERE name=$1", target); err != nil {
		return nil, err
	}
	if err = audit(ctx, tx, q.Event, actor, q.Action+" "+q.Reason, target); err != nil {
		return nil, err
	}
	return true, tx.Commit(ctx)
}
