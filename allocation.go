package main

import (
	"context"
	"github.com/jackc/pgx/v5"
	"slices"
	"strings"
)

var accountEntries = strings.Fields("opening actual income expense refund deposit deposit-return reimbursement fee card payout donation payment presale transfer supply skim return")
var transferEntries = []string{"transfer", "supply", "skim", "return", "payout"}

func allocationValid(ctx context.Context, tx pgx.Tx, d device, o op) (bool, error) {
	if !d.Accounts || !slices.Contains(accountEntries, o.Kind) {
		return true, nil
	}
	ids := []string{o.Data.Account}
	if slices.Contains(transferEntries, o.Kind) {
		ids = append(ids, o.Data.To)
	}
	var n int
	err := tx.QueryRow(ctx, "SELECT count(*) FROM entries WHERE event=$1 AND id=ANY($2) AND kind IN ('account','wallet')", d.Event, ids).Scan(&n)
	return n == len(ids), err
}
