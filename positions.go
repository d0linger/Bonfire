package main

import (
	"context"
	"github.com/jackc/pgx/v5"
)

type position struct {
	Description              string
	QuantityMilli, UnitCents int64
}

func amountPositions(lines []position) (int64, error) {
	var total int64
	if len(lines) > 200 {
		return 0, fail("Zu viele Positionen.")
	}
	for _, l := range lines {
		if l.Description == "" || len(l.Description) > 200 || l.QuantityMilli < 1 || l.QuantityMilli > 10000000 || l.UnitCents < 0 || l.UnitCents > 999999999 {
			return 0, fail("Ungültige Rechnungsposition.")
		}
		total += (l.QuantityMilli*l.UnitCents + 500) / 1000
	}
	return total, nil
}
func checkReimbursements(ctx context.Context, tx pgx.Tx, d device, o op) (bool, error) {
	if o.Kind != "reimbursement" {
		return true, nil
	}
	alloc := o.Data.Allocations
	if len(alloc) == 0 {
		alloc = map[string]int64{o.Data.Reference: *o.Data.Amount}
	}
	var total int64
	for id, n := range alloc {
		if !key.MatchString(id) || n <= 0 || n > 999999999999 {
			return false, fail("Ungültige Teilzuordnung.")
		}
		var limit, paid int64
		err := tx.QueryRow(ctx, "SELECT (data->>'Amount')::bigint FROM entries WHERE event=$1 AND id=$2 AND kind='outlay'", d.Event, id).Scan(&limit)
		if err == pgx.ErrNoRows {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		err = tx.QueryRow(ctx, "SELECT coalesce(sum(CASE WHEN data->'Allocations' ? $2 THEN (data->'Allocations'->>$2)::bigint WHEN data->>'Reference'=$2 AND NOT(data ? 'Allocations') THEN (data->>'Amount')::bigint ELSE 0 END),0)::bigint FROM entries WHERE event=$1 AND id<>$3 AND kind='reimbursement'", d.Event, id, o.Target).Scan(&paid)
		if err != nil {
			return false, err
		}
		if n > limit-paid {
			return false, nil
		}
		total += n
	}
	return total == *o.Data.Amount, nil
}
