package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type fiscalYear struct {
	ID, Name, Starts, Ends string
	Closed                 bool
}

func validYearDetails(name, starts, ends string) bool {
	return name != "" && len(name) <= 100 && date(starts) && date(ends) && starts <= ends
}

func yearWriteError(err error) error {
	var dbErr *pgconn.PgError
	if errors.As(err, &dbErr) {
		switch dbErr.Code {
		case "23P01":
			return problem{409, "This period overlaps an existing fiscal year."}
		case "23505":
			return problem{409, "This fiscal year name is already in use."}
		}
	}
	return err
}

func (a *app) years(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	user, role, err := a.auth(ctx, r)
	if err != nil {
		return nil, err
	}
	if r.Method == http.MethodGet {
		rows, err := a.db.Query(ctx, `SELECT y.id::text,y.name,y.starts::text,y.ends::text,y.closed FROM fiscal_years y
			WHERE $1='Admin' OR EXISTS(SELECT 1 FROM events e JOIN grants_event g ON g.event=e.id
				WHERE e.fiscal_year=y.id AND g.username=$2) ORDER BY y.starts DESC`, role, user)
		if err != nil {
			return nil, err
		}
		return pgx.CollectRows(rows, pgx.RowToStructByPos[fiscalYear])
	}
	if role != roleAdmin {
		return nil, problem{403, "Only administrators can create fiscal years."}
	}
	var y fiscalYear
	if err = read(r, &y); err != nil {
		return nil, err
	}
	y.Name = strings.TrimSpace(y.Name)
	y.Closed = false
	if !validYearDetails(y.Name, y.Starts, y.Ends) {
		return nil, fail("Check the fiscal year name and dates.")
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	y.ID = uuid()
	if _, err = tx.Exec(ctx, "INSERT INTO fiscal_years(id,name,starts,ends) VALUES($1,$2,$3,$4)", y.ID, y.Name, y.Starts, y.Ends); err != nil {
		return nil, yearWriteError(err)
	}
	ledger := uuid()
	_, err = tx.Exec(ctx, `INSERT INTO events(id,name,starts,ends,general_ledger,fiscal_year)
		VALUES($1,'General cashbook',$2,$3,true,$4)`, ledger, y.Starts, y.Ends, y.ID)
	if err != nil {
		return nil, err
	}
	if err = audit(ctx, tx, ledger, user, "Geschäftsjahr angelegt", y.ID); err != nil {
		return nil, err
	}
	return y, tx.Commit(ctx)
}

func (a *app) editYear(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	var in struct {
		Year              string
		Previous, Updated eventDetails
	}
	if err := read(r, &in); err != nil {
		return nil, err
	}
	next := in.Updated
	next.Name = strings.TrimSpace(next.Name)
	if !idPattern.MatchString(in.Year) || !validYearDetails(next.Name, next.Starts, next.Ends) {
		return nil, fail("Check the fiscal year name, start date and end date.")
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
	var closed bool
	var ledger string
	err = tx.QueryRow(ctx, `SELECT y.name,y.starts::text,y.ends::text,y.closed OR e.closed,e.id::text
		FROM fiscal_years y JOIN events e ON e.fiscal_year=y.id AND e.general_ledger
		WHERE y.id=$1 ORDER BY EXISTS(SELECT FROM audit a WHERE a.event=e.id AND a.action='Geschäftsjahr angelegt' AND a.subject=y.id::text) DESC,e.id
		LIMIT 1 FOR UPDATE OF y,e`, in.Year).Scan(&current.Name, &current.Starts, &current.Ends, &closed, &ledger)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, problem{404, "Fiscal year not found."}
	}
	if err != nil {
		return nil, err
	}
	if closed {
		return nil, problem{409, "The fiscal year or cashbook is closed. Reopen it before editing."}
	}
	if current == next {
		return true, tx.Commit(ctx)
	}
	if current != in.Previous {
		return nil, problem{409, "The fiscal year has changed. Reopen the edit dialog."}
	}
	if current.Starts != next.Starts || current.Ends != next.Ends {
		var blocker string
		err = tx.QueryRow(ctx, `SELECT CASE
 WHEN EXISTS(SELECT FROM period_closures p JOIN fiscal_years y ON y.id=p.fiscal_year WHERE y.id=$1 AND p.reopened_at IS NULL AND p.starts=y.starts AND p.ends=y.ends) THEN 'Reopen the full-year closure before changing its dates.'
			WHEN EXISTS(SELECT FROM events WHERE fiscal_year=$1 AND id<>$5 AND (starts<$2 OR ends>$3))
				THEN 'The new date range must include all assigned events and other workspaces.'
			WHEN EXISTS(SELECT FROM entries j JOIN events e ON e.id=j.event WHERE e.fiscal_year=$1 AND j.kind=ANY($4::text[])
				AND ((j.data->>'Date')::date NOT BETWEEN $2 AND $3 OR (CASE WHEN j.kind='period' THEN j.data->>'To' END)::date NOT BETWEEN $2 AND $3))
				THEN 'The new date range must include all existing entries, counts and accounting periods.'
			WHEN EXISTS(SELECT FROM period_closures WHERE fiscal_year=$1 AND reopened_at IS NULL AND (starts<$2 OR ends>$3))
				THEN 'A closed accounting period falls outside the new date range.'
			ELSE '' END`, in.Year, next.Starts, next.Ends, fiscalDatedKinds, ledger).Scan(&blocker)
		if err != nil {
			return nil, err
		}
		if blocker != "" {
			return nil, problem{409, blocker}
		}
	}
	if _, err = tx.Exec(ctx, "UPDATE fiscal_years SET name=$2,starts=$3,ends=$4 WHERE id=$1", in.Year, next.Name, next.Starts, next.Ends); err != nil {
		return nil, yearWriteError(err)
	}
	if _, err = tx.Exec(ctx, "UPDATE events SET starts=$2,ends=$3 WHERE id=$1", ledger, next.Starts, next.Ends); err != nil {
		return nil, err
	}
	change := fmt.Sprintf("%s (%s – %s) → %s (%s – %s)", current.Name, current.Starts, current.Ends, next.Name, next.Starts, next.Ends)
	if err = audit(ctx, tx, ledger, user, "Geschäftsjahr bearbeitet", change); err != nil {
		return nil, err
	}
	return true, tx.Commit(ctx)
}

func (a *app) createEvent(ctx context.Context, user string, e event) (event, error) {
	e.ID, e.Closed = uuid(), false
	if e.Year == "" && offlineEnabled() {
		// Compatibility for the explicitly enabled legacy device workflow.
		_, err := a.db.Exec(ctx, "INSERT INTO events(id,name,starts,ends,accounts,general_ledger) VALUES($1,$2,$3,$4,$5,$6)", e.ID, e.Name, e.Starts, e.Ends, e.Accounts, e.General)
		return e, err
	}
	if !idPattern.MatchString(e.Year) {
		return e, fail("Select a fiscal year.")
	}
	if e.General {
		return e, fail("The general cashbook is created with the fiscal year.")
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return e, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock_shared(751025)"); err != nil {
		return e, err
	}
	tag, err := tx.Exec(ctx, `INSERT INTO events(id,name,starts,ends,accounts,fiscal_year)
		SELECT $1,$2,$3,$4,$5,id FROM fiscal_years WHERE id=$6 AND starts<=$3 AND ends>=$4`,
		e.ID, e.Name, e.Starts, e.Ends, e.Accounts, e.Year)
	if err != nil {
		return e, err
	}
	if tag.RowsAffected() == 0 {
		return e, fail("The event must fall entirely within the selected fiscal year.")
	}
	if err = checkYearSetup(ctx, tx, e.ID); err != nil {
		return e, err
	}
	if err = audit(ctx, tx, e.ID, user, "Veranstaltung im Geschäftsjahr angelegt", e.Year); err != nil {
		return e, err
	}
	return e, tx.Commit(ctx)
}

var fiscalDatedKinds = strings.Fields("income expense refund deposit deposit-return transfer outlay reimbursement card fee payout donation sponsorship payment presale supply skim return cashback opening actual count period")

// Membership must remain stable for an approved fiscal snapshot, including
// existing entries recorded outside the event dates.
func checkYearSetup(ctx context.Context, tx pgx.Tx, eventID string) error {
	if err := requireOpenYear(ctx, tx, eventID); err != nil {
		return err
	}
	var frozen bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM events e JOIN period_closures p ON (p.fiscal_year IS NULL OR p.fiscal_year=e.fiscal_year)
		WHERE e.id=$1 AND p.reopened_at IS NULL AND ((e.starts<=p.ends AND e.ends>=p.starts)
			OR EXISTS(SELECT 1 FROM entries j WHERE j.event=e.id AND (j.data->>'Date')::date BETWEEN p.starts AND p.ends)))`, eventID).Scan(&frozen)
	if err != nil {
		return err
	}
	if frozen {
		return problem{409, "This workspace falls within a closed period in this fiscal year."}
	}
	return nil
}

func fiscalDateAllowed(ctx context.Context, tx pgx.Tx, eventID string, o op) error {
	if !slices.Contains(fiscalDatedKinds, o.Kind) {
		return nil
	}
	end := o.Data.Date
	if o.Kind == "period" {
		end = o.Data.To
	}
	var outside bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM events e JOIN fiscal_years y ON y.id=e.fiscal_year
		WHERE e.id=$1 AND (y.starts>$2::date OR y.ends<$3::date))`, eventID, o.Data.Date, end).Scan(&outside)
	if err != nil {
		return err
	}
	if outside {
		return fail("The posting date or period end falls outside the fiscal year.")
	}
	return nil
}

func (a *app) assignYear(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	user, role, err := a.auth(ctx, r)
	if err != nil {
		return nil, err
	}
	if role != roleAdmin {
		return nil, problem{403, "Only administrators can assign existing workspaces."}
	}
	var in struct{ Year, Event string }
	if err = read(r, &in); err != nil {
		return nil, err
	}
	if !idPattern.MatchString(in.Year) || !idPattern.MatchString(in.Event) {
		return nil, fail("Select a fiscal year and workspace.")
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	// Writers hold the same event row lock while accepting entries. After acquiring it,
	// validation sees all previously committed entries in a fresh statement snapshot.
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock_shared(751025)"); err != nil {
		return nil, err
	}
	var previous string
	err = tx.QueryRow(ctx, "SELECT coalesce(fiscal_year::text,'') FROM events WHERE id=$1 FOR UPDATE", in.Event).Scan(&previous)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fail("Unknown workspace.")
	}
	if err != nil {
		return nil, err
	}
	if previous == in.Year {
		return true, tx.Commit(ctx)
	}
	if previous != "" {
		return nil, problem{409, "This workspace already belongs to another fiscal year."}
	}
	tag, err := tx.Exec(ctx, `UPDATE events e SET fiscal_year=y.id FROM fiscal_years y
		WHERE e.id=$1 AND y.id=$2 AND e.starts>=y.starts AND e.ends<=y.ends
		AND NOT EXISTS(SELECT 1 FROM entries j WHERE j.event=e.id AND j.kind=ANY($3::text[]) AND
			((j.data->>'Date')::date NOT BETWEEN y.starts AND y.ends OR
			 (CASE WHEN j.kind='period' THEN j.data->>'To' END)::date NOT BETWEEN y.starts AND y.ends))`, in.Event, in.Year, fiscalDatedKinds)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() != 1 {
		return nil, fail("The workspace and all its existing transactions must fall within the fiscal year.")
	}
	if err = checkYearSetup(ctx, tx, in.Event); err != nil {
		return nil, err
	}
	if err = audit(ctx, tx, in.Event, user, "Bestehenden Arbeitsbereich zugeordnet", in.Year); err != nil {
		return nil, err
	}
	return true, tx.Commit(ctx)
}
