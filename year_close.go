package main

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
)

type closingIssue struct {
	Area, Message string
}

// A preview uses the same rules as closing. The final write checks them again under lock.
func closingPreview(ctx context.Context, tx pgx.Tx, d device, entries []row, pending, conflicts int) ([]closingIssue, error) {
	issues := []closingIssue{}
	add := func(area string, err error) {
		if err != nil {
			issues = append(issues, closingIssue{area, err.Error()})
		}
	}
	if pending != 0 || conflicts != 0 {
		add("discrepancies", fail("Finish recording on all devices and resolve outstanding discrepancies."))
	}
	add("balances", checkBalance(entries, d.Accounts))
	if err := completeAttachments(entries); err != nil {
		add("documents", err)
	} else {
		add("wallets", validateSettlement(entries))
	}
	add("payments", checkOpenPayments(entries))
	var domain problem
	if err := validateCarry(ctx, tx, entries); err != nil {
		if !errors.As(err, &domain) {
			return nil, err
		}
		add("balances", err)
	}
	if d.Role != roleAdmin {
		return issues, nil
	}
	var year string
	if err := tx.QueryRow(ctx, "SELECT coalesce(fiscal_year::text,'') FROM events WHERE id=$1 AND general_ledger", d.Event).Scan(&year); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return issues, nil
		}
		return nil, err
	}
	if year == "" {
		return issues, nil
	}
	if err := checkYearEvents(ctx, tx, year, d.Event); err != nil {
		if !errors.As(err, &domain) {
			return nil, err
		}
		add("events", err)
	}
	balances, err := yearAccountBalances(ctx, tx, year)
	if err != nil {
		return nil, err
	}
	for _, b := range balances {
		if b.Shared && (b.Opening == nil || b.Actual == nil || *b.Actual != b.Soll) {
			add("annual-accounts", fail("Check the annual account reconciliation: "+b.Name))
		}
	}
	return issues, nil
}

func requireOpenYear(ctx context.Context, tx pgx.Tx, event string) error {
	var closed bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT FROM events e JOIN fiscal_years y ON y.id=e.fiscal_year WHERE e.id=$1 AND y.closed)`, event).Scan(&closed)
	if err != nil {
		return err
	}
	if closed {
		return problem{409, "Reopen the fiscal year before making changes."}
	}
	return nil
}

// Called under the exclusive accounting lock, before checking the ledger and
// committing both closures in the same transaction.
func yearForClosure(ctx context.Context, tx pgx.Tx, d device) (fiscalYear, error) {
	var y fiscalYear
	if !d.Online || d.Role != roleAdmin {
		return y, problem{403, "Administrator access is required to close this fiscal year."}
	}
	err := tx.QueryRow(ctx, `SELECT y.id::text,y.name,y.starts::text,y.ends::text,y.closed FROM fiscal_years y JOIN events e ON e.fiscal_year=y.id WHERE e.id=$1 AND e.general_ledger`, d.Event).Scan(&y.ID, &y.Name, &y.Starts, &y.Ends, &y.Closed)
	if err == pgx.ErrNoRows {
		return y, fail("Open the fiscal year closing in the general cashbook.")
	}
	return y, err
}

func checkYearEvents(ctx context.Context, tx pgx.Tx, year, ledger string) error {
	var stale []string
	err := tx.QueryRow(ctx, `SELECT ARRAY(SELECT a.name FROM fire_year_counts c
		JOIN fire_accounts a ON a.id=c.account
		JOIN fiscal_years y ON y.id=c.opening_source_year
		LEFT JOIN fire_year_counts src ON src.year=y.id AND src.account=c.account
		WHERE c.year=$1 AND (NOT y.closed OR src.revision IS DISTINCT FROM c.opening_source_revision
		  OR src.actual IS DISTINCT FROM c.opening) ORDER BY a.name)`, year).Scan(&stale)
	if err != nil {
		return err
	}
	if len(stale) != 0 {
		return problem{409, "Review these carried opening balances before closing: " + strings.Join(stale, ", ")}
	}
	var open []string
	err = tx.QueryRow(ctx, `SELECT ARRAY(SELECT name FROM events WHERE fiscal_year=$1 AND id<>$2 AND NOT closed ORDER BY starts,name)`, year, ledger).Scan(&open)
	if err != nil {
		return err
	}
	if len(open) > 0 {
		return problem{409, "Settle and close these events first: " + strings.Join(open, ", ")}
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

func closureEvidence(entries []row) []row {
	evidence := make([]row, 0, len(entries))
	for _, entry := range entries {
		switch entry.Kind {
		case "contact", "original", "attachment", "attachment-file", "import-source", "template", "organization", "dispatch":
			continue
		}
		evidence = append(evidence, entry)
	}
	return evidence
}

func checkOpenPayments(entries []row) error {
	var outlays int64
	claims := map[string]int64{}
	providers := map[string]int64{}
	for _, r := range entries {
		if r.Data.Amount == nil {
			continue
		}
		n := *r.Data.Amount
		switch r.Kind {
		case "card", "cashback":
			provider := strings.TrimSpace(r.Data.Fields["provider"])
			providers[provider] += n
		case "payout", "fee":
			providers[strings.TrimSpace(r.Data.Fields["provider"])] -= n
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
	// Unnamed historical entries have no settlement group.
	for provider, balance := range providers {
		if provider != "" && balance != 0 {
			return fail("Reconcile the outstanding terminal settlement first: " + provider)
		}
	}
	if outlays != 0 {
		return fail("Settle outstanding personal advances first.")
	}
	for _, balance := range claims {
		if balance > 0 {
			return fail("Resolve outstanding receivables first.")
		}
	}
	return nil
}
