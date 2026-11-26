package main

import (
	"context"
	"github.com/jackc/pgx/v5"
	"regexp"
	"strings"
)

type priceChange struct {
	Version  int64
	ID       string
	Revision int64
	Data     data
	At       string
}

func priceHistory(ctx context.Context, tx pgx.Tx, event string) ([]priceChange, error) {
	rows, err := tx.Query(ctx, "SELECT version,subject,revision,data,at::text FROM price_history WHERE event=$1 ORDER BY version,subject", event)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[priceChange])
}

var smallCentilitre = regexp.MustCompile(`(?i)\b0[.,]02\s*cl\b`)

func validatePrice(v data) error {
	if v.Status != "Freigegeben" {
		return nil
	}
	a, b := strings.TrimSpace(v.Fields["unitA"]), strings.TrimSpace(v.Fields["unitB"])
	if strings.TrimSpace(v.Unit) == "" || v.Category == "" {
		return fail("Confirm the unit and product range before approval.")
	}
	if smallCentilitre.MatchString(v.Unit) || (a != "" && b != "" && !strings.EqualFold(a, b)) {
		if (a == "" && b == "") || len(strings.TrimSpace(v.Fields["unitReason"])) < 5 || strings.Contains(v.Unit, "/") {
			return fail("Record the conflicting sources separately, select the unit to use and explain the decision.")
		}
	}
	return nil
}
