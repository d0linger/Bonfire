package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
)

type eventDetails struct{ Name, Starts, Ends string }

func validEventDetails(name, starts, ends string) bool {
	return name != "" && len(name) <= 160 && date(starts) && date(ends) && starts <= ends
}

func (a *app) editEvent(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	var in struct {
		Event             string
		Previous, Updated eventDetails
	}
	if err := read(r, &in); err != nil {
		return nil, err
	}
	next := in.Updated
	next.Name = strings.TrimSpace(next.Name)
	if !idPattern.MatchString(in.Event) || !validEventDetails(next.Name, next.Starts, next.Ends) {
		return nil, fail("Check the event, name and dates.")
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(751025)"); err != nil {
		return nil, err
	}
	user, err := accountManager(ctx, tx, r, true)
	if err != nil {
		return nil, err
	}
	var current eventDetails
	var general, closed bool
	err = tx.QueryRow(ctx, "SELECT name,starts::text,ends::text,general_ledger,closed FROM events WHERE id=$1 FOR UPDATE", in.Event).
		Scan(&current.Name, &current.Starts, &current.Ends, &general, &closed)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, problem{404, "Event not found."}
	}
	if err != nil {
		return nil, err
	}
	if general || closed {
		return nil, problem{409, "Only open events can be edited."}
	}
	if err = checkYearSetup(ctx, tx, in.Event); err != nil {
		return nil, err
	}
	if current == next {
		return true, tx.Commit(ctx)
	}
	if current != in.Previous {
		return nil, problem{409, "This event has changed. Reopen the event list and check the details."}
	}
	tag, err := tx.Exec(ctx, `UPDATE events e SET name=$2,starts=$3,ends=$4 WHERE e.id=$1
		AND (e.fiscal_year IS NULL OR EXISTS(SELECT FROM fiscal_years y WHERE y.id=e.fiscal_year AND y.starts<=$3 AND y.ends>=$4))`,
		in.Event, next.Name, next.Starts, next.Ends)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, fail("The period must fall entirely within the event's fiscal year.")
	}
	if err = checkYearSetup(ctx, tx, in.Event); err != nil {
		return nil, err
	}
	change := fmt.Sprintf("%s (%s – %s) → %s (%s – %s)", current.Name, current.Starts, current.Ends, next.Name, next.Starts, next.Ends)
	if err = audit(ctx, tx, in.Event, user, "Veranstaltung bearbeitet", change); err != nil {
		return nil, err
	}
	return true, tx.Commit(ctx)
}
