package main

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"
)

func TestSourcedBookingCorrection(t *testing.T) {
	f := newTxFixture(t)
	day := "2867-04-12"
	year := f.atomic(f.app.years, "/api/years", fiscalYear{Name: "Source test", Starts: day, Ends: day}).(fiscalYear)
	f.event = f.value("SELECT id::text FROM events WHERE general_ledger AND fiscal_year=$1", year.ID)
	path := "/api/online?event=" + f.event
	post := func(operations ...op) error {
		_, err := f.request(t.Context(), f.app.syncEvent, path, request{Ops: operations})
		return err
	}
	reject := func(change op, code int, fragment string) {
		t.Helper()
		err := post(change)
		var p problem
		if !errors.As(err, &p) || p.code != code || !strings.Contains(p.message, fragment) {
			t.Fatalf("Expected %d %q, got %v", code, fragment, err)
		}
	}
	raw := []byte("Synthetic historical workbook " + uuid())
	digest := digestHex(raw)
	source := op{ID: uuid(), Kind: "import-source", Target: "source:" + digest, Data: data{
		Date: day, Label: "Original workbook", Reference: digest, Filename: "synthetic.xlsx", Status: "D1", File: base64.StdEncoding.EncodeToString(raw),
	}}
	imported := op{ID: uuid(), Kind: "income", Target: "import:" + digest + ":0-D9", Data: data{
		Date: day, Label: "Initial caption", Amount: amount(2317), Reference: source.Target, Note: "Checked historical source",
		Fields: map[string]string{"sheet": "Synthetic", "cell": "D9", "original": "23.17", "dateOrigin": "Fixture", "sourceColumn": "D"},
	}}
	pdf := []byte("%PDF-1.4\nSynthetic evidence\n%%EOF")
	doc := op{ID: uuid(), Kind: "attachment", Target: uuid(), Data: data{Date: day, Label: "Evidence", Reference: imported.Target, Filename: "synthetic.pdf", File: base64.StdEncoding.EncodeToString(pdf)}}
	if err := post(source, imported, doc); err != nil {
		t.Fatal(err)
	}
	edit := imported
	edit.ID, edit.Base = uuid(), 1
	edit.Data.Label, edit.Data.Category, edit.Data.Note = "Corrected caption", "Subscriptions", "Corrected the description"
	// An older editor sends only the fields visible on its form.
	edit.Data.Fields, edit.Data.Reference = nil, ""
	if err := post(edit); err != nil {
		t.Fatal(err)
	}
	if err := post(edit); err != nil {
		t.Fatal(err)
	}
	if got := f.value(`SELECT count(*)::text FROM entries WHERE event=$1 AND id=$2 AND revision=2 AND data->>'Label'=$3
	    AND data->>'Category'=$4 AND data->'Fields'=$5::jsonb AND data->>'Reference'=$6 AND data->>'ImportNote'=$7 AND data->>'Note'=$8`,
		f.event, imported.Target, edit.Data.Label, edit.Data.Category, imported.Data.Fields, source.Target, imported.Data.Note, edit.Data.Note); got != "1" {
		t.Fatal("Correction lost source evidence or editable values")
	}
	if got := f.value(`SELECT concat(count(*),'/',sum(direction*(data->>'Amount')::bigint)) FROM journal_history WHERE event=$1 AND target=$2`, f.event, imported.Target); got != "3/2317" {
		t.Fatalf("Expected original, reversal and replacement with unchanged total, got %s", got)
	}
	if got := f.value("SELECT data->>'File' FROM entries WHERE event=$1 AND id=$2 AND data->>'Reference'=$3", f.event, doc.Target, imported.Target); got != doc.Data.File {
		t.Fatal("Correction changed linked evidence")
	}
	// Earlier revisions did not persist ImportNote. Reading them must use the
	// recorded first revision without rewriting the historical entry.
	f.value("UPDATE entries SET data=data-'ImportNote' WHERE event=$1 AND id=$2 RETURNING id", f.event, imported.Target)
	out, err := f.request(t.Context(), f.app.syncEvent, path, request{})
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range out.(map[string]any)["entries"].([]row) {
		if r.ID == imported.Target && (r.Data.ImportNote == nil || *r.Data.ImportNote != imported.Data.Note) {
			t.Fatal("Missing original note on legacy revision")
		}
	}
	edit.ID = uuid()
	reject(edit, 409, "revision")
	edit.Base, edit.Data.Fields = 2, map[string]string{"sheet": "Different"}
	reject(edit, 422, "source field sheet")
	edit.Data.Fields = nil
	f.value("UPDATE events SET closed=true WHERE id=$1 RETURNING id::text", f.event)
	reject(edit, 403, "locked")
}
