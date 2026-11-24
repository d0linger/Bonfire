package main

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"
)

func requireOpenYear(ctx context.Context, tx pgx.Tx, event string) error {
	var closed bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT FROM events e JOIN fiscal_years y ON y.id=e.fiscal_year WHERE e.id=$1 AND y.closed)`, event).Scan(&closed)
	if err != nil {
		return err
	}
	if closed {
		return problem{409, "Das Geschäftsjahr ist abgeschlossen. Zuerst das Geschäftsjahr wieder öffnen."}
	}
	return nil
}

// Called under the exclusive accounting lock, before checking the ledger and
// committing both closures in the same transaction.
func yearForClosure(ctx context.Context, tx pgx.Tx, d device) (fiscalYear, error) {
	var y fiscalYear
	if !d.Online || d.Role != roleAdmin {
		return y, problem{403, "Adminrecht für den Jahresabschluss erforderlich."}
	}
	err := tx.QueryRow(ctx, `SELECT y.id::text,y.name,y.starts::text,y.ends::text,y.closed FROM fiscal_years y JOIN events e ON e.fiscal_year=y.id WHERE e.id=$1 AND e.general_ledger`, d.Event).Scan(&y.ID, &y.Name, &y.Starts, &y.Ends, &y.Closed)
	if err == pgx.ErrNoRows {
		return y, fail("Jahresabschluss im allgemeinen Kassenbuch öffnen.")
	}
	return y, err
}

func checkYearEvents(ctx context.Context, tx pgx.Tx, year string) error {
	var open []string
	err := tx.QueryRow(ctx, `SELECT ARRAY(SELECT name FROM events WHERE fiscal_year=$1 AND NOT general_ledger AND NOT closed ORDER BY starts,name)`, year).Scan(&open)
	if err != nil {
		return err
	}
	if len(open) > 0 {
		return problem{409, "Zuerst diese Veranstaltungen abrechnen und abschließen: " + strings.Join(open, ", ")}
	}
	// Older closed events may predate the current wallet and payment checks.
	rows, err := tx.Query(ctx, `SELECT e.name,c.snapshot FROM events e CROSS JOIN LATERAL
		(SELECT snapshot FROM event_closures WHERE event=e.id ORDER BY version DESC LIMIT 1) c
		WHERE e.fiscal_year=$1 AND NOT e.general_ledger`, year)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		var entries []row
		if err = rows.Scan(&name, &entries); err != nil {
			return err
		}
		if err = validateSettlement(entries); err != nil {
			return fail(name + " · " + err.Error())
		}
		if err = checkOpenPayments(entries); err != nil {
			return fail(name + " · " + err.Error())
		}
	}
	return rows.Err()
}

func checkOpenPayments(entries []row) error {
	var outlays int64
	claims := map[string]int64{}
	for _, r := range entries {
		if r.Data.Amount == nil {
			continue
		}
		n := *r.Data.Amount
		switch r.Kind {
		case "outlay":
			outlays += n
		case "reimbursement":
			outlays -= n
		case "sponsorship":
			if r.Data.Fields["pledge"] != "Zurückgezogen" {
				claims[r.ID] += n
			}
		case "payment":
			claims[r.Data.Reference] -= n
		}
	}
	if outlays != 0 {
		return fail("Offene Privatauslagen zuerst abrechnen.")
	}
	for _, balance := range claims {
		if balance > 0 {
			return fail("Offene Sponsoringforderungen zuerst klären.")
		}
	}
	return nil
}
