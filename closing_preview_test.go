package main

import (
	"slices"
	"testing"
)

func TestClosingPreviewChecksCurrentLedgerWithoutLockingIt(t *testing.T) {
	f := newTxFixture(t)
	const day = "2815-05-10"
	call := func(fn endpoint, path string, body any) any {
		t.Helper()
		out, err := f.request(t.Context(), fn, path, body)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	year := call(f.app.years, "/api/years", fiscalYear{Name: "Closing exercise", Starts: day, Ends: day}).(fiscalYear)
	ledger := f.value("SELECT id::text FROM events WHERE fiscal_year=$1 AND general_ledger", year.ID)
	path := "/api/online?event=" + ledger
	preview := func() []closingIssue {
		t.Helper()
		return call(f.app.syncEvent, path, request{ClosingPreview: true}).([]closingIssue)
	}
	if !slices.ContainsFunc(preview(), func(i closingIssue) bool { return i.Area == "balances" }) {
		t.Fatal("missing balances did not block closing")
	}
	post := func(kind string, value data) op {
		value.Date = day
		return op{ID: uuid(), Target: uuid(), Kind: kind, Data: value}
	}
	question := post("source-question", data{Label: "Check delivery note", Status: "Open", Reference: "Delivery slip 4"})
	if _, err := f.request(t.Context(), f.app.syncEvent, path, request{ClosingPreview: true, Ops: []op{question}}); err == nil {
		t.Fatal("a preview accepted a write")
	}
	call(f.app.syncEvent, path, request{Ops: []op{
		post("opening", data{Label: "Opening count", Amount: amount(0)}),
		post("actual", data{Label: "Observed count", Amount: amount(0)}), question,
	}})
	if issues := preview(); len(issues) != 0 {
		t.Fatalf("balanced ledger with advisory source question: %v", issues)
	}
	call(f.app.events, "/api/events", event{Name: "Open practice event", Year: year.ID, Starts: day, Ends: day})
	if !slices.ContainsFunc(preview(), func(i closingIssue) bool { return i.Area == "events" }) {
		t.Fatal("open event missing from year checks")
	}
	if got := f.value("SELECT closed::text FROM fiscal_years WHERE id=$1", year.ID); got != "false" {
		t.Fatal("preview changed fiscal year state")
	}
}
