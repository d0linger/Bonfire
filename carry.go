package main

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
)

type priorPeriod struct {
	ID, End string
	Actuals map[string]int64
}

func prior(ctx context.Context, tx pgx.Tx, start string) (priorPeriod, error) {
	var p priorPeriod
	var rows []row
	if !date(start) {
		return p, fail("Periodenbeginn ungültig.")
	}
	err := tx.QueryRow(ctx, "SELECT id::text,ends::text,snapshot FROM period_closures WHERE ends<$1 AND reopened_at IS NULL ORDER BY ends DESC,version DESC LIMIT 1", start).Scan(&p.ID, &p.End, &rows)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, fail("Kein freigegebener Vorperiodenabschluss vorhanden.")
	}
	if err != nil {
		return p, err
	}
	p.Actuals = map[string]int64{}
	for _, r := range rows {
		if r.Kind == "actual" && r.Data.Amount != nil {
			p.Actuals[r.Data.Account] += *r.Data.Amount
		}
	}
	return p, nil
}
