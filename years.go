package main

import (
	"context"
	"errors"
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
		return nil, problem{403, "Nur Admins können Geschäftsjahre anlegen."}
	}
	var y fiscalYear
	if err = read(r, &y); err != nil {
		return nil, err
	}
	y.Name = strings.TrimSpace(y.Name)
	y.Closed = false
	if y.Name == "" || len(y.Name) > 100 || !date(y.Starts) || !date(y.Ends) || y.Starts > y.Ends {
		return nil, fail("Bezeichnung und Zeitraum des Geschäftsjahrs prüfen.")
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	y.ID = uuid()
	if _, err = tx.Exec(ctx, "INSERT INTO fiscal_years(id,name,starts,ends) VALUES($1,$2,$3,$4)", y.ID, y.Name, y.Starts, y.Ends); err != nil {
		var dbErr *pgconn.PgError
		if errors.As(err, &dbErr) {
			switch dbErr.Code {
			case "23P01":
				return nil, problem{409, "Der Zeitraum überschneidet sich mit einem bestehenden Geschäftsjahr."}
			case "23505":
				return nil, problem{409, "Diese Geschäftsjahresbezeichnung ist bereits vergeben."}
			}
		}
		return nil, err
	}
	ledger := uuid()
	_, err = tx.Exec(ctx, `INSERT INTO events(id,name,starts,ends,general_ledger,fiscal_year)
		VALUES($1,'Allgemeines Kassenbuch',$2,$3,true,$4)`, ledger, y.Starts, y.Ends, y.ID)
	if err != nil {
		return nil, err
	}
	if err = audit(ctx, tx, ledger, user, "Geschäftsjahr angelegt", y.ID); err != nil {
		return nil, err
	}
	return y, tx.Commit(ctx)
}

func (a *app) createEvent(ctx context.Context, user string, e event) (event, error) {
	e.ID, e.Closed = uuid(), false
	if e.Year == "" && offlineEnabled() {
		// Compatibility for the explicitly enabled legacy device workflow.
		_, err := a.db.Exec(ctx, "INSERT INTO events(id,name,starts,ends,accounts,general_ledger) VALUES($1,$2,$3,$4,$5,$6)", e.ID, e.Name, e.Starts, e.Ends, e.Accounts, e.General)
		return e, err
	}
	if !idPattern.MatchString(e.Year) {
		return e, fail("Bitte ein Geschäftsjahr auswählen.")
	}
	if e.General {
		return e, fail("Das allgemeine Kassenbuch wird beim Anlegen des Geschäftsjahrs erstellt.")
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
		return e, fail("Der Veranstaltungszeitraum muss vollständig im gewählten Geschäftsjahr liegen.")
	}
	if err = checkYearSetup(ctx, tx, e.ID); err != nil {
		return e, err
	}
	if err = audit(ctx, tx, e.ID, user, "Veranstaltung im Geschäftsjahr angelegt", e.Year); err != nil {
		return e, err
	}
	return e, tx.Commit(ctx)
}

var fiscalDatedKinds = strings.Fields("income expense refund deposit deposit-return transfer outlay reimbursement card fee payout donation sponsorship payment presale supply skim return opening actual count period")

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
		return problem{409, "Der Arbeitsbereich fällt in eine bereits abgeschlossene Periode dieses Geschäftsjahrs."}
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
		return fail("Das Buchungsdatum bzw. Periodenende liegt außerhalb des Geschäftsjahrs.")
	}
	return nil
}

func (a *app) assignYear(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	user, role, err := a.auth(ctx, r)
	if err != nil {
		return nil, err
	}
	if role != roleAdmin {
		return nil, problem{403, "Nur Admins können bestehende Arbeitsbereiche zuordnen."}
	}
	var in struct{ Year, Event string }
	if err = read(r, &in); err != nil {
		return nil, err
	}
	if !idPattern.MatchString(in.Year) || !idPattern.MatchString(in.Event) {
		return nil, fail("Geschäftsjahr und Arbeitsbereich auswählen.")
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
		return nil, fail("Arbeitsbereich unbekannt.")
	}
	if err != nil {
		return nil, err
	}
	if previous == in.Year {
		return true, tx.Commit(ctx)
	}
	if previous != "" {
		return nil, problem{409, "Dieser Arbeitsbereich ist bereits einem anderen Geschäftsjahr zugeordnet."}
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
		return nil, fail("Der Arbeitsbereich und seine vorhandenen Buchungen müssen vollständig im Geschäftsjahr liegen.")
	}
	if err = checkYearSetup(ctx, tx, in.Event); err != nil {
		return nil, err
	}
	if err = audit(ctx, tx, in.Event, user, "Bestehenden Arbeitsbereich zugeordnet", in.Year); err != nil {
		return nil, err
	}
	return true, tx.Commit(ctx)
}
