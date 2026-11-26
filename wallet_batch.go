package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
)

type walletBatchCommand struct {
	Event, Request, Mode, Date, Source string
	Wallets                            []string
	Amount                             *int64
	Pieces                             map[string]int64
}

type walletBatchResult struct {
	Count          int   `json:"count"`
	PerWalletCents int64 `json:"perWalletCents"`
	TotalCents     int64 `json:"totalCents"`
}

func (q *walletBatchCommand) validate() (walletBatchResult, error) {
	var summary walletBatchResult
	if !idPattern.MatchString(q.Event) || !idPattern.MatchString(q.Request) || !date(q.Date) {
		return summary, fail("Select an event, date and valid request identifier.")
	}
	if q.Mode != "opening" && q.Mode != "topup" {
		return summary, fail("Select an opening count or a change top-up.")
	}
	if len(q.Wallets) == 0 || len(q.Wallets) > 100 {
		return summary, fail("Select between 1 and 100 wallets.")
	}
	slices.Sort(q.Wallets)
	for i, id := range q.Wallets {
		if !key.MatchString(id) || (i > 0 && q.Wallets[i-1] == id) {
			return summary, fail("Select each wallet once.")
		}
	}
	if (q.Amount == nil) == (q.Pieces == nil) {
		return summary, fail("Enter either a per-wallet amount or a denomination count.")
	}
	if q.Amount != nil {
		summary.PerWalletCents = *q.Amount
	} else {
		for k, count := range q.Pieces {
			cents, ok := denoms[k]
			if !ok || count < 0 || count > 1000000 {
				return summary, fail("Invalid denominations.")
			}
			summary.PerWalletCents += cents * count
		}
	}
	if err := checkCashAmount(data{Amount: &summary.PerWalletCents, Pieces: q.Pieces}); err != nil {
		return summary, err
	}
	if q.Mode == "opening" && q.Source != "" {
		return summary, fail("Opening counts do not have a transfer source.")
	}
	if q.Mode == "topup" && (summary.PerWalletCents == 0 || !key.MatchString(q.Source) || slices.Contains(q.Wallets, q.Source)) {
		return summary, fail("Enter a positive top-up and a source outside the receiving wallets.")
	}
	summary.Count = len(q.Wallets)
	summary.TotalCents = int64(summary.Count) * summary.PerWalletCents
	return summary, nil
}

// Each wallet gets the same operation identity if a request is retried after rollback.
func walletBatchOperationID(request, wallet string) string {
	b := sha256.Sum256([]byte("BONFIRE wallet batch:" + request + ":" + wallet))
	b[6] = (b[6] & 0x0f) | 0x80
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func (a *app) walletBatch(ctx context.Context, _ http.ResponseWriter, r *http.Request) (any, error) {
	var q walletBatchCommand
	if err := read(r, &q); err != nil {
		return nil, err
	}
	result, err := q.validate()
	if err != nil {
		return nil, err
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock_shared(751025)"); err != nil {
		return nil, err
	}
	d, err := lockOnlineEvent(ctx, tx, r, q.Event)
	if err != nil {
		return nil, err
	}
	if d.Role != roleAdmin && d.Role != roleWrite {
		return nil, problem{403, "Write access is required."}
	}
	var ledger bool
	if err = tx.QueryRow(ctx, "SELECT general_ledger FROM events WHERE id=$1", d.Event).Scan(&ledger); err != nil {
		return nil, err
	}
	if ledger {
		return nil, problem{409, "Select an event for wallet allocation."}
	}

	encoded, err := json.Marshal(q)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(encoded)
	tag, err := tx.Exec(ctx, "INSERT INTO wallet_batch_receipts(request,event,device,digest) VALUES($1,$2,$3,$4) ON CONFLICT(request) DO NOTHING", q.Request, d.Event, d.ID, digest[:])
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		var previous []byte
		var own bool
		if err = tx.QueryRow(ctx, "SELECT digest,event=$2 AND device=$3 FROM wallet_batch_receipts WHERE request=$1", q.Request, d.Event, d.ID).Scan(&previous, &own); err != nil {
			return nil, err
		}
		if !own || !bytes.Equal(previous, digest[:]) {
			return nil, problem{409, "The request identifier has already been used with different details."}
		}
		return result, tx.Commit(ctx)
	}
	if d.Closed {
		return nil, problem{409, "This event is closed."}
	}
	if err = requireOpenYear(ctx, tx, d.Event); err != nil {
		return nil, err
	}
	var wallets int
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM entries WHERE event=$1 AND id=ANY($2) AND kind='wallet'", d.Event, q.Wallets).Scan(&wallets); err != nil {
		return nil, err
	}
	if wallets != len(q.Wallets) {
		return nil, fail("Select wallets in the current event.")
	}
	if q.Mode == "topup" && (q.Source != "main-cashbox" || d.Accounts) {
		var valid bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT FROM entries e WHERE e.event=$1 AND e.id=$2 AND e.kind IN ('account','wallet')
            AND NOT EXISTS(SELECT FROM fire_account_links l JOIN fire_accounts f ON f.id=l.account WHERE l.event=e.event AND l.local_id=e.id AND NOT f.active))`, d.Event, q.Source).Scan(&valid); err != nil {
			return nil, err
		}
		if !valid {
			return nil, fail("Select an active change source in the current event.")
		}
	}
	for _, wallet := range q.Wallets {
		if err = accept(ctx, tx, &d, q.operation(wallet, result.PerWalletCents)); err != nil {
			return nil, err
		}
	}
	if _, err = tx.Exec(ctx, "UPDATE devices SET last_seq=$1,last_seen=now() WHERE id=$2", d.Last, d.ID); err != nil {
		return nil, err
	}
	return result, tx.Commit(ctx)
}

func (q walletBatchCommand) operation(wallet string, cents int64) op {
	entryMode := "amount"
	if q.Pieces != nil {
		entryMode = "pieces"
	}
	o := op{ID: walletBatchOperationID(q.Request, wallet), Data: data{Date: q.Date, Amount: &cents, Pieces: q.Pieces, Wallet: wallet, Fields: map[string]string{"countMode": entryMode, "walletBatch": q.Request}}}
	if q.Mode == "opening" {
		o.Kind = "count"
		o.Target = countKey("count", wallet, "Anfang")
		o.Data.Phase = "Anfang"
		o.Data.Status = "Unbestätigt"
		o.Data.Label = "Opening count"
		o.Data.Fields["countScope"] = "wallet"
	} else {
		o.Kind = "supply"
		o.Target = o.ID
		o.Data.Label = "Change top-up"
		o.Data.Account = q.Source
		o.Data.To = wallet
	}
	return o
}
