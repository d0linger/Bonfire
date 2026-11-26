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

func validateCarry(ctx context.Context, tx pgx.Tx, rows []row) error {
	sources := map[string]priorPeriod{}
	for _, r := range rows {
		v := r.Data
		if r.Kind == "opening" && v.Fields["yearSource"] != "" && v.Fields["yearPeriod"] == "" {
			var current bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT FROM events e WHERE e.id=$1 AND e.closed
				AND (SELECT max(version)::text FROM event_closures WHERE event=e.id)=$2)`,
				v.Fields["yearSource"], v.Fields["yearStamp"]).Scan(&current); err != nil {
				return err
			}
			if !current {
				return fail("The prior-year closing has changed. Check and correct the opening balance before closing.")
			}
		}
		if source := v.Fields["yearPeriod"]; r.Kind == "opening" && source != "" {
			var active bool
			if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT FROM period_closures WHERE id=$1 AND reopened_at IS NULL)", source).Scan(&active); err != nil {
				return err
			}
			if !active {
				return fail("The source fiscal year has reopened. Verify the opening balance before approval.")
			}
		}
		if r.Kind != "opening" || v.Fields["previous"] == "" {
			continue
		}
		src, ok := sources[v.Date]
		if !ok {
			var err error
			src, err = prior(ctx, tx, v.Date)
			if err != nil {
				return err
			}
			sources[v.Date] = src
		}
		amount, ok := src.Actuals[v.Account]
		if !ok || src.ID != v.Fields["previous"] || v.Amount == nil || *v.Amount != amount {
			return fail("The carry-forward refers to a superseded closing. Check the source and amount before approval.")
		}
	}
	return nil
}
func prior(ctx context.Context, tx pgx.Tx, start string) (priorPeriod, error) {
	var p priorPeriod
	var rows []row
	if !date(start) {
		return p, fail("Invalid period start date.")
	}
	err := tx.QueryRow(ctx, "SELECT id::text,ends::text,snapshot FROM period_closures WHERE ends<$1 AND reopened_at IS NULL ORDER BY ends DESC,version DESC LIMIT 1", start).Scan(&p.ID, &p.End, &rows)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, fail("No approved closing is available for the previous period.")
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
