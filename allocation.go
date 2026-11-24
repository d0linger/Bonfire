package main

import (
	"context"
	"github.com/jackc/pgx/v5"
	"slices"
	"strings"
)

var accountEntries = strings.Fields("opening actual income expense refund deposit deposit-return reimbursement fee card payout donation payment presale transfer supply skim return cashback")
var transferEntries = []string{"transfer", "supply", "skim", "return", "payout", "cashback"}

func allocationValid(ctx context.Context, tx pgx.Tx, d device, o op) (bool, error) {
	if !d.Accounts || !slices.Contains(accountEntries, o.Kind) {
		return true, nil
	}
	ids := []string{o.Data.Account}
	if slices.Contains(transferEntries, o.Kind) {
		ids = append(ids, o.Data.To)
	}
	var n int
	err := tx.QueryRow(ctx, "SELECT count(*) FROM entries e WHERE e.event=$1 AND e.id=ANY($2) AND e.kind IN ('account','wallet') AND ($3 OR NOT EXISTS(SELECT FROM fire_account_links l JOIN fire_accounts a ON a.id=l.account WHERE l.event=e.event AND l.local_id=e.id AND NOT a.active))", d.Event, ids, o.Base > 0 || o.Kind == "opening" || o.Kind == "actual").Scan(&n)
	return n == len(ids), err
}
