package main

import (
	"errors"
	"maps"
	"slices"
	"testing"
)

func TestWalletBatchValidation(t *testing.T) {
	base := walletBatchCommand{Event: uuid(), Request: uuid(), Mode: "opening", Date: "2030-03-24", Wallets: []string{"north", "west"}, Amount: amount(10)}
	for _, tc := range []struct {
		name string
		edit func(*walletBatchCommand)
		ok   bool
	}{
		{"manual opening", func(q *walletBatchCommand) { q.Amount = amount(0) }, true},
		{"zero counted opening", func(q *walletBatchCommand) { q.Amount = nil; q.Pieces = map[string]int64{} }, true},
		{"denominations", func(q *walletBatchCommand) { q.Amount = nil; q.Pieces = map[string]int64{"10": 3, "10000": 1} }, true},
		{"missing amount", func(q *walletBatchCommand) { q.Amount = nil }, false},
		{"both modes", func(q *walletBatchCommand) { q.Pieces = map[string]int64{"10": 1} }, false},
		{"invalid quantity", func(q *walletBatchCommand) { q.Amount = nil; q.Pieces = map[string]int64{"500": -1} }, false},
		{"unknown denomination", func(q *walletBatchCommand) { q.Amount = nil; q.Pieces = map[string]int64{"3": 1} }, false},
		{"over amount limit", func(q *walletBatchCommand) { q.Amount = amount(1000000000000) }, false},
		{"empty selection", func(q *walletBatchCommand) { q.Wallets = nil }, false},
		{"duplicate wallet", func(q *walletBatchCommand) { q.Wallets = []string{"a", "a"} }, false},
		{"opening with a source", func(q *walletBatchCommand) { q.Source = "reserve" }, false},
		{"zero top-up", func(q *walletBatchCommand) { q.Mode = "topup"; q.Source = "cash"; q.Amount = amount(0) }, false},
		{"selected source", func(q *walletBatchCommand) { q.Mode = "topup"; q.Source = "north" }, false},
		{"invalid date", func(q *walletBatchCommand) { q.Date = "2030-02-29" }, false},
		{"closing count", func(q *walletBatchCommand) { q.Mode = "closing" }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := base
			tc.edit(&q)
			result, err := q.validate()
			if (err == nil) != tc.ok {
				t.Fatalf("expected valid=%t, got %v", tc.ok, err)
			}
			if tc.name == "denominations" && (result.PerWalletCents != 10030 || result.TotalCents != 20060) {
				t.Fatalf("wrong allocation summary: %+v", result)
			}
		})
	}
}

func (f *transactionFixture) checkWalletBatches(year, day string) {
	t, a := f.t, f.app
	const path = "/api/events/wallet-batch"
	e := f.atomic(a.events, "/api/events", event{Name: "Two till allocation", Year: year, Starts: day, Ends: day}).(event)
	f.event = e.ID
	var wallets []op
	for _, id := range []string{"till-a", "till-b", "till-c"} {
		wallets = append(wallets, op{ID: uuid(), Target: id, Kind: "wallet", Data: data{Date: day, Label: id}})
	}
	f.atomic(a.syncEvent, "/api/online?event="+e.ID, request{Ops: wallets})
	post := func(q walletBatchCommand) walletBatchResult {
		return f.atomic(a.walletBatch, path, q).(walletBatchResult)
	}
	reject := func(q walletBatchCommand, code int) {
		t.Helper()
		before := f.snapshot()
		_, err := f.request(t.Context(), a.walletBatch, path, q)
		var p problem
		if !errors.As(err, &p) || p.code != code || !maps.Equal(before, f.snapshot()) {
			t.Fatalf("Rejected wallet batch changed data or returned the wrong status: %v", err)
		}
	}
	open := walletBatchCommand{Event: e.ID, Request: uuid(), Mode: "opening", Date: day, Wallets: []string{"till-c", "till-b"}, Pieces: map[string]int64{"500": 3, "20": 2}}
	if got := post(open); got != (walletBatchResult{2, 1540, 3080}) {
		t.Fatalf("Incorrect opening summary: %+v", got)
	}
	slices.Reverse(open.Wallets)
	before := f.snapshot()
	post(open)
	if !maps.Equal(before, f.snapshot()) {
		t.Fatal("Retrying the opening count changed recorded data")
	}
	replacement := open
	replacement.Request = uuid()
	replacement.Wallets = []string{"till-a", "till-b"}
	reject(replacement, 409)
	topUp := walletBatchCommand{Event: e.ID, Request: uuid(), Mode: "topup", Date: day, Source: "till-a", Wallets: open.Wallets, Amount: amount(285)}
	topUpResult := post(topUp)
	if topUpResult != (walletBatchResult{2, 285, 570}) {
		t.Fatalf("Incorrect top-up summary: %+v", topUpResult)
	}
	post(topUp)
	if got := f.value("SELECT sum((data->>'Amount')::int)::text FROM journal_history WHERE event=$1 AND kind='supply' AND data->>'Account'='till-a' AND data->>'To'=data->>'Wallet'", e.ID); got != "570" {
		t.Fatal("Unexpected total debited from the source")
	}
	if got := f.value("SELECT count(*)::text FROM journal_history WHERE event=$1 AND kind<>'supply'", e.ID); got != "0" {
		t.Fatal("Wallet allocation created revenue or an expense")
	}
	changed := topUp
	changed.Amount = amount(300)
	reject(changed, 409)
	changed.Request = uuid()
	changed.Source = "absent-till"
	reject(changed, 422)
	changed.Source = "main-cashbox"
	changed.Wallets = []string{"till-b", "outside-event"}
	reject(changed, 422)
	changed.Wallets = []string{"till-b"}
	post(changed)
}
