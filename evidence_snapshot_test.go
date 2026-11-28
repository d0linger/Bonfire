package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type beforeAllocationHistory struct {
	write func()
}

func (hook *beforeAllocationHistory) TraceQueryStart(ctx context.Context, _ *pgx.Conn, query pgx.TraceQueryStartData) context.Context {
	if hook.write != nil && strings.Contains(query.SQL, "FROM wallet_receipt_revisions l") {
		write := hook.write
		hook.write = nil
		write()
	}
	return ctx
}

func (*beforeAllocationHistory) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestEvidenceSnapshotDuringAllocation(t *testing.T) {
	f := newTxFixture(t)
	call := func(fn endpoint, path string, body any) any {
		t.Helper()
		got, err := f.request(t.Context(), fn, path, body)
		if err != nil {
			t.Fatal(path, err)
		}
		return got
	}
	const day = "2868-07-12"
	year := call(f.app.years, "/api/years", fiscalYear{Name: "Evidence snapshot", Starts: day, Ends: day}).(fiscalYear)
	ledger := f.value("SELECT id::text FROM events WHERE fiscal_year=$1 AND general_ledger", year.ID)
	event := call(f.app.events, "/api/events", event{Name: "Synthetic wallet", Year: year.ID, Starts: day, Ends: day}).(event).ID
	route := "/api/online?event=" + ledger
	// Prepare the account's actor before interleaving two independent connections.
	call(f.app.syncEvent, route, request{})
	count := func(phase string, n int64) op {
		return op{ID: uuid(), Target: countKey("count", "till", phase), Kind: "count", Data: data{Label: phase, Date: day, Amount: amount(n), Wallet: "till", Phase: phase, Fields: map[string]string{"countMode": "amount"}}}
	}
	call(f.app.syncEvent, "/api/online?event="+event, request{Ops: []op{
		{ID: uuid(), Target: "till", Kind: "wallet", Data: data{Label: "Practice till", Date: day}},
		count("Anfang", 0), count("Ende", 2500),
	}})
	receipt := op{ID: uuid(), Kind: "income", Target: "receipt", Data: data{Date: day, Label: "Practice payment", Method: "Bar", Amount: amount(2500)}}
	hook := &beforeAllocationHistory{write: func() {
		call(f.app.syncEvent, route, request{Ops: []op{receipt}})
		call(f.app.saveWalletLink, "/api/events/wallet-links", walletReceiptChange{
			Event: event, Wallet: "till", Receipt: receipt.Target, Request: uuid(), SourceRevision: 1, Amount: 2500, Counted: 2500,
		})
	}}
	config := f.app.db.Config()
	config.ConnConfig.Tracer = hook
	reader, err := pgxpool.NewWithConfig(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(reader.Close)
	exporter := &app{db: reader}
	var previous time.Time
	for _, want := range []int{0, 1} {
		snapshot := call(exporter.syncEvent, route, request{EvidenceSnapshot: true}).(map[string]any)
		timestamp, ok := snapshot["synced"].(time.Time)
		if !ok || !timestamp.After(previous) {
			t.Fatalf("Missing or non-increasing export transaction time: %v", snapshot["synced"])
		}
		previous = timestamp
		movements := 0
		for _, r := range snapshot["entries"].([]row) {
			if r.ID == receipt.Target {
				movements++
			}
		}
		allocations := snapshot["allocations"].([]map[string]any)
		if movements != want || len(allocations) != want || (want == 1 && allocations[0]["Receipt"] != receipt.Target) {
			t.Fatalf("Inconsistent evidence snapshot: journal entries %d, allocations %v, expected %d of each", movements, allocations, want)
		}
	}
}
