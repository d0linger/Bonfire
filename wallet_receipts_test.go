package main

import (
	"github.com/jackc/pgx/v5"
	"net/url"
	"testing"
)

func TestWalletReceiptLinks(t *testing.T) {
	f := newTxFixture(t)
	a := f.app
	call := func(fn endpoint, path string, body any) any {
		t.Helper()
		v, err := f.request(t.Context(), fn, path, body)
		if err != nil {
			t.Fatal(path, err)
		}
		return v
	}
	const day = "2318-04-15"
	const priorDay = "2318-04-14"
	y := call(a.years, "/api/years", fiscalYear{Name: "Receipt allocations", Starts: priorDay, Ends: day}).(fiscalYear)
	ledger := f.value("SELECT id::text FROM events WHERE fiscal_year=$1 AND general_ledger", y.ID)
	e := call(a.events, "/api/events", event{Name: "Spring exercise", Year: y.ID, Starts: day, Ends: day}).(event).ID
	number := func(n int64) *int64 { return &n }
	income := func(id string, n int64) op {
		return op{ID: uuid(), Target: id, Kind: "income", Data: data{Label: "Same receipt label", Date: day, Amount: number(n), Method: "Bar"}}
	}
	post := func(event string, ops ...op) { call(a.syncEvent, "/api/online?event="+event, request{Ops: ops}) }
	post(ledger, income("first", 10000), income("second", 10000))
	count := func(w, phase string, n int64) op {
		return op{ID: uuid(), Target: countKey("count", w, phase), Kind: "count", Data: data{Label: phase, Date: day, Amount: number(n), Wallet: w, Phase: phase, Fields: map[string]string{"countMode": "amount", "countScope": "wallet"}}}
	}
	for _, w := range []string{"food", "drinks"} {
		post(e, op{ID: uuid(), Target: w, Kind: "wallet", Data: data{Label: w, Date: day}}, count(w, "Anfang", 1000), count(w, "Ende", 7000))
	}
	const path = "/api/events/wallet-links"
	choices := call(a.walletLinks, path+"?event="+e+"&wallet=food&search="+url.QueryEscape("Same receipt label"), nil).([]map[string]any)
	if len(choices) != 2 {
		t.Fatal("Equal-amount receipts were collapsed", choices)
	}
	q := walletReceiptChange{Event: e, Wallet: "food", Receipt: "first", Request: uuid(), Amount: 6000, Counted: 6000, SourceRevision: 1}
	f.atomic(a.saveWalletLink, path, q)
	call(a.saveWalletLink, path, q)
	// Device conflicts must advance the outbox even when the corresponding online edit fails.
	tx, err := f.owner.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	for _, o := range []op{
		{Target: "first", Kind: "income", Base: 1, Data: data{Date: day, Amount: number(1)}},
		{Target: "import:unverifiable", Kind: "income", Base: 1, Data: data{Date: day, Amount: number(1)}},
	} {
		ok, err := preconditions(t.Context(), tx, device{Event: ledger}, o)
		if ok || err != nil {
			t.Fatalf("offline correction should become an operation conflict, got %v, %v", ok, err)
		}
		ok, err = preconditions(t.Context(), tx, device{Event: ledger, Online: true}, o)
		if ok || err == nil {
			t.Fatalf("online correction should fail with explanation, got %v, %v", ok, err)
		}
	}
	if err := tx.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	q.Wallet = "drinks"
	q.Request = uuid()
	if _, err := f.request(t.Context(), a.saveWalletLink, path, q); err == nil {
		t.Fatal("allocated beyond receipt")
	}
	q.Amount = 4000
	call(a.saveWalletLink, path, q)
	links := call(a.walletLinks, path+"?event="+ledger+"&receipt=first", nil).([]map[string]any)
	if len(links) != 2 {
		t.Fatal("Missing source-side links", links)
	}
	residual := income("settlement:drinks", 2000)
	residual.Data.Wallet = "drinks"
	residual.Data.Account = "drinks"
	residual.Data.Reference = "wallet-settlement"
	post(e, residual)
	snapshots := func() []row {
		t.Helper()
		r, err := f.owner.Query(t.Context(), "SELECT id,kind,device::text,revision,data FROM settlement_entries WHERE event=$1", e)
		if err != nil {
			t.Fatal(err)
		}
		rs, err := pgx.CollectRows(r, pgx.RowToStructByPos[row])
		if err != nil {
			t.Fatal(err)
		}
		return rs
	}
	if err := validateSettlement(snapshots()); err != nil {
		t.Fatal(err)
	}
	// An existing posting requires a deliberate, reasoned correction before another link can replace it.
	q.Receipt = "second"
	q.Amount = 2000
	q.Request = uuid()
	q.PostRevision = 1
	if _, err := f.request(t.Context(), a.saveWalletLink, path, q); err == nil {
		t.Fatal("replaced posted income without confirmation")
	}
	q.CorrectPosted = true
	q.Reason = "Confirmed second receipt"
	f.atomic(a.saveWalletLink, path, q)
	if f.value("SELECT sum((data->>'Amount')::bigint)::text FROM entries WHERE event IN ($1,$2) AND kind='income'", e, ledger) != "20000" {
		t.Fatal("attribution duplicated income")
	}
	if err := validateSettlement(snapshots()); err != nil {
		t.Fatal(err)
	}
	q.Request = uuid()
	q.Revision = 1
	q.PostRevision = 2
	q.Amount = 0
	q.Reason = "Wrong receipt selected"
	call(a.saveWalletLink, path, q)
	if err := validateSettlement(snapshots()); err == nil {
		t.Fatal("closing accepted a newly uncovered balance")
	}
	// Removing an assignment leaves the source payment and its audit evidence untouched.
	if f.value("SELECT revision::text FROM entries WHERE event=$1 AND id='second'", ledger) != "1" {
		t.Fatal("source receipt changed")
	}
	// Two independent events race for the last unallocated share of one receipt.
	post(ledger, income("race", 2000))
	other := call(a.events, "/api/events", event{Name: "Parallel event", Year: y.ID, Starts: day, Ends: day}).(event).ID
	post(other, op{ID: uuid(), Target: "drinks", Kind: "wallet", Data: data{Label: "drinks", Date: day}}, count("drinks", "Anfang", 1000), count("drinks", "Ende", 7000))
	start := make(chan struct{})
	finished := make(chan error, 2)
	for _, eventID := range []string{e, other} {
		candidate := walletReceiptChange{Event: eventID, Wallet: "drinks", Receipt: "race", Request: uuid(), Amount: 2000, SourceRevision: 1, Counted: 6000}
		if eventID == e {
			candidate.PostRevision = 2
		}
		call(a.saveWalletLink, path, candidate)
		release := candidate
		release.Request, release.Amount, release.Revision, release.Reason = uuid(), 0, 1, "Reset this candidate before the race"
		call(a.saveWalletLink, path, release)
		candidate.Request, candidate.Revision, candidate.Reason = uuid(), 2, "Apply verified receipt share"
		go func() {
			<-start
			_, err := f.request(t.Context(), a.saveWalletLink, path, candidate)
			finished <- err
		}()
	}
	close(start)
	first, second := <-finished, <-finished
	if (first == nil) == (second == nil) || f.value("SELECT sum(amount)::text FROM wallet_receipt_links WHERE source_event=$1 AND receipt='race'", ledger) != "2000" {
		t.Fatalf("expected one allocation to succeed, got %v, %v", first, second)
	}
	loser := first
	if loser == nil {
		loser = second
	}
	if loser != (problem{409, "The receipt has insufficient unallocated funds for this allocation."}) {
		t.Fatalf("wrong competing-allocation error: %v", loser)
	}

	closingEvent := call(a.events, "/api/events", event{Name: "Closing guards", Year: y.ID, Starts: priorDay, Ends: day}).(event).ID
	startCount, endCount := count("closing", "Anfang", 1000), count("closing", "Ende", 7000)
	startCount.Data.Date, endCount.Data.Date = priorDay, priorDay
	post(closingEvent, op{ID: uuid(), Target: "closing", Kind: "wallet", Data: data{Label: "closing", Date: priorDay}}, startCount, endCount)
	post(ledger, income("closing-receipt", 6000))
	correction := walletReceiptChange{Event: closingEvent, Wallet: "closing", Receipt: "closing-receipt", Request: uuid(), Amount: 1000, SourceRevision: 1, Counted: 6000}
	call(a.saveWalletLink, path, correction)
	endCount.ID, endCount.Base, endCount.Data.Date, endCount.Data.Note = uuid(), 1, day, "Correction to the count date"
	post(closingEvent, endCount)
	correction.Request, correction.Revision, correction.Amount, correction.Reason = uuid(), 1, 1500, "Correct the receipt share"
	f.value("UPDATE event_records SET closed=true WHERE id=$1 RETURNING id::text", closingEvent)
	if _, err := f.request(t.Context(), a.saveWalletLink, path, correction); err != (problem{409, "Reopen the affected workspace before changing an allocation."}) {
		t.Fatalf("expected closed-workspace error, got %v", err)
	}
	f.value("UPDATE event_records SET closed=false WHERE id=$1 RETURNING id::text", closingEvent)
	period := f.value("INSERT INTO period_closures(id,period_id,version,starts,ends,reviewer,snapshot,fiscal_year) VALUES($1,'allocation-cutoff',1,$2,$2,'leitung','[]',$3) RETURNING id::text", uuid(), priorDay, y.ID)
	if _, err := f.request(t.Context(), a.saveWalletLink, path, correction); err != (problem{409, "A linked date is in a closed accounting period."}) {
		t.Fatalf("expected protected prior-date error, got %v", err)
	}
	f.value("UPDATE period_closures SET reopened_at=now() WHERE id=$1 RETURNING id::text", period)
	call(a.saveWalletLink, path, correction)
}
