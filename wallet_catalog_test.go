package main

import (
	"maps"
	"testing"
)

func TestCatalogWalletSuggestedFloat(t *testing.T) {
	for _, tc := range []struct {
		name   string
		pieces map[string]int64
		cents  *int64
		ok     bool
	}{
		{"no default", nil, nil, true},
		{"manual zero", nil, amount(0), true},
		{"negative amount", nil, amount(-1), false},
		{"denomination sum", map[string]int64{"10000": 1, "10": 3}, amount(10030), true},
		{"different total", map[string]int64{"10": 3}, amount(31), false},
		{"unsupported denomination", map[string]int64{"5": 1}, nil, false},
		{"negative pieces", map[string]int64{"500": -1}, nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := walletCommand{Name: "Float", Pieces: tc.pieces, FloatCents: tc.cents}
			if err := q.validateCatalogDetails(); (err == nil) != tc.ok {
				t.Fatalf("valid=%t: %v", tc.ok, err)
			}
		})
	}
}

func (f *transactionFixture) checkWalletCatalog(year, day string) {
	t, a := f.t, f.app
	const path = "/api/wallet-catalog"
	save := func(q walletCommand) any { return f.atomic(a.walletCatalog, path, q) }
	w := walletCommand{Action: "create", Name: "Physical drawer", Note: "Silver", DefaultBar: "Tea tent", Pieces: map[string]int64{"500": 4}}
	w.ID = save(w).(map[string]string)["ID"]
	makeEvent := func(name string) string {
		return f.atomic(a.events, "/api/events", event{Name: name, Year: year, Starts: day, Ends: day}).(event).ID
	}
	e := makeEvent("First event with drawers")
	bar := op{Kind: "bar", ID: uuid(), Target: uuid(), Data: data{Label: "Tea tent", Date: day}}
	f.event = e
	f.atomic(a.syncEvent, "/api/online?event="+e, request{Ops: []op{bar}})
	assignment := walletCommand{Action: "assign", Event: e, IDs: []string{w.ID}}
	local := save(assignment).(*walletAssignment).Assigned[0]
	if got := f.value("SELECT data->'Fields'->>'suggestedFloatCents' FROM entries WHERE event=$1 AND id=$2 AND data->>'Bar'=$3", e, local, bar.Target); got != "2000" {
		t.Fatal("Missing float or bar suggestion")
	}
	if got := save(assignment).(*walletAssignment).Existing; len(got) != 1 || got[0] != local {
		t.Fatal("Duplicate request added a second instance")
	}
	target := makeEvent("Concurrent event with drawers")
	assignment.Event = target
	before := f.snapshot()
	warning, err := f.request(t.Context(), a.walletCatalog, path, assignment)
	if err != nil || len(warning.(*walletAssignment).Overlaps) != 1 || !maps.Equal(before, f.snapshot()) {
		t.Fatalf("Expected an overlap warning with unchanged data, got %v, %v", warning, err)
	}
	assignment.ConfirmOverlap = true
	save(assignment)
	w.Action = "edit"
	w.Revision = 1
	w.Name = "Renamed drawer"
	w.Note = "New instructions"
	w.Pieces = nil
	save(w)
	if got := f.value("SELECT data->>'Label' FROM entries WHERE event=$1 AND id=$2", e, local); got != "Physical drawer" {
		t.Fatal("Editing catalogue changed an existing wallet")
	}
	edit := op{Target: local, Kind: "wallet", Data: data{Date: day, Label: "East counter", Note: "Corrected local label"}}
	for i, fields := range []map[string]string{nil, {"suggestedFloatCents": "1", "suggestedBar": "Other", "suggestedPieces": "{}", "localSetting": "current"}} {
		edit.ID, edit.Base, edit.Data.Fields = uuid(), int64(i+1), fields
		f.atomic(a.syncEvent, "/api/online?event="+e, request{Ops: []op{edit}})
		var stored data
		if err := f.owner.QueryRow(t.Context(), "SELECT data FROM entries WHERE event=$1 AND id=$2", e, local).Scan(&stored); err != nil {
			t.Fatal(err)
		}
		if stored.Label != edit.Data.Label || stored.Fields["suggestedFloatCents"] != "2000" || stored.Fields["suggestedBar"] != "Tea tent" ||
			stored.Fields["suggestedPieces"] != `{"500":4}` || stored.Fields["localSetting"] != fields["localSetting"] {
			t.Fatalf("Wallet edit lost its original hints or editable details: %+v", stored.Fields)
		}
	}
	oneOff := op{ID: uuid(), Target: uuid(), Kind: "wallet", Data: data{Date: day, Label: "Temporary till", Fields: map[string]string{"localSetting": "previous"}}}
	post := func(o op) {
		t.Helper()
		if _, err := f.request(t.Context(), a.syncEvent, "/api/online?event="+e, request{Ops: []op{o}}); err != nil {
			t.Fatal(err)
		}
	}
	post(oneOff)
	oneOff.ID, oneOff.Base = uuid(), 1
	oneOff.Data.Note = "Cleared local setting"
	oneOff.Data.Fields = nil
	post(oneOff)
	if hasFields := f.value("SELECT (data ? 'Fields')::text FROM entries WHERE event=$1 AND id=$2", e, oneOff.Target); hasFields != "false" {
		t.Fatal("Editing a one-off wallet retained cleared settings or added catalogue hints")
	}
	save(walletCommand{Action: "retire", ID: w.ID, Revision: 2})
	items := f.atomic(a.walletCatalog, path+"?event="+e, nil).(map[string]any)["wallets"].([]catalogWallet)
	if len(items) != 1 || items[0].Active || !items[0].Used || items[0].Revision != 3 {
		t.Fatal("Retirement lost the event association")
	}
	copyID := f.atomic(a.manage, "/api/manage", map[string]any{"Action": "copy", "Target": "Repeated drawer setup", "Start": day, "End": day, "Year": year, "CopyKinds": []string{"bar", "wallet"}}).(string)
	if got := f.value("SELECT count(*)::text FROM event_catalog_wallets WHERE event=$1 AND wallet=$2", copyID, w.ID); got != "1" {
		t.Fatal("Copying the event lost its physical wallet association")
	}
	if got := f.value("SELECT count(*)::text FROM journal_history WHERE event IN ($1,$2,$3)", e, target, copyID); got != "0" {
		t.Fatal("A catalogue operation affected the journal")
	}
}
