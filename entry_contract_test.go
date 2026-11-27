package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestEntryValidationPreservesFinancialContracts(t *testing.T) {
	const day = "2029-07-31"
	simple := func(kind string, d data) op {
		d.Date = day
		d.Label = "Synthetic record"
		return op{ID: uuid(), Target: uuid(), Seq: 1, Kind: kind, Data: d}
	}
	income := simple("income", data{Amount: amount(0), Account: "cash"})
	bill := simple("sponsorship", data{Amount: amount(3750), Lines: []position{{Description: "Program listing", UnitCents: 2500, QuantityMilli: 1500}}})
	period := simple("period", data{To: day})
	approved := simple("price", data{Amount: amount(180), Unit: "0.25 L", Category: "Drinks", Status: "Freigegeben"})
	cn := simple("count", data{Amount: amount(500), Phase: "Anfang", Wallet: "north", Pieces: map[string]int64{"500": 1}})
	cn.Target = countKey("count", "north", "Anfang")
	pooled := simple("count", data{Amount: amount(500), Phase: "Ende", Fields: map[string]string{"countScope": "all", "countMode": "amount"}})
	pooled.Target = countKey("count", "", "Ende")
	supply := simple("supply", data{Amount: amount(500), Wallet: "north", Account: "safe", To: "north"})
	reserve := simple("reserve", data{Amount: amount(500), Pieces: map[string]int64{"500": 1}})
	reserve.Target = "coinreserve"
	original := simple("original", sampleInvoice(t, bill.Target, day, 11))
	original.Target = "original:" + bill.Target
	org := simple("organization", data{})
	org.Target = "organization"
	file := []byte("synthetic journal")
	digest := digestHex(file)
	src := simple("import-source", data{Reference: digest, Status: "Journal", File: base64.StdEncoding.EncodeToString(file)})
	src.Target = "source:" + digest
	dispatch := simple("dispatch", data{Reference: original.Target, Status: "Extern übergeben", Note: "Confirmed in person"})
	dispatch.Target = "dispatch:" + original.Target
	cases := []struct {
		name   string
		valid  op
		change func(*op)
	}{
		{"missing monetary amount", income, func(o *op) { o.Data.Amount = nil }},
		{"over maximum amount", income, func(o *op) { o.Data.Amount = amount(1000000000000) }},
		{"unassigned account", income, func(o *op) { o.Data.Account = "" }},
		{"blank correction", income, func(o *op) { o.Base = 1 }},
		{"retire cash movement", income, func(o *op) { o.Data.Retired = true }},
		{"impossible reporting date", income, func(o *op) { o.Data.Date = "2029-02-29" }},
		{"unexpected reimbursement split", income, func(o *op) { o.Data.Allocations = map[string]int64{"claim": 1} }},
		{"oversized custom field", income, func(o *op) { o.Data.Fields = map[string]string{"note": strings.Repeat("x", 8001)} }},
		{"too many fields", income, func(o *op) {
			o.Data.Fields = map[string]string{}
			for i := range 36 {
				o.Data.Fields[fmt.Sprint(i)] = "value"
			}
		}},
		{"line total mismatch", bill, func(o *op) { o.Data.Amount = amount(3749) }},
		{"fractional item without unit price", bill, func(o *op) { o.Data.Lines = []position{{Description: "Line", QuantityMilli: 1500, UnitCents: -1}} }},
		{"unknown pledge status", bill, func(o *op) { o.Data.Fields = map[string]string{"pledge": "invalid"} }},
		{"inverted period", period, func(o *op) { o.Data.To = "2029-07-30" }},
		{"unknown price approval state", approved, func(o *op) { o.Data.Status = "invalid" }},
		{"missing approved serving unit", approved, func(o *op) { o.Data.Unit = "" }},
		{"unexplained conflicting serving evidence", approved, func(o *op) { o.Data.Fields = map[string]string{"unitA": "0.25 L", "unitB": "0.33 L"} }},
		{"wrong count key", cn, func(o *op) { o.Target = uuid() }},
		{"count without denominations", cn, func(o *op) { o.Data.Pieces = nil }},
		{"unexpected intermediate observation", cn, func(o *op) { o.Data.Fields = map[string]string{"observation": uuid()} }},
		{"invalid pooled count scope", pooled, func(o *op) { o.Data.Fields = map[string]string{"countScope": "several", "countMode": "amount"} }},
		{"wallet assigned to pooled count", pooled, func(o *op) { o.Data.Wallet = "north" }},
		{"reserve attached to bar", reserve, func(o *op) { o.Data.Bar = "north" }},
		{"supply between identical accounts", supply, func(o *op) { o.Data.Account = "north" }},
		{"supply without wallet", supply, func(o *op) { o.Data.Wallet = "" }},
		{"supply to different wallet", supply, func(o *op) { o.Data.Wallet = "south" }},
		{"original without reference", original, func(o *op) { o.Data.Reference = "" }},
		{"changed receipt reference", dispatch, func(o *op) { o.Data.Reference = "other" }},
		{"changed source digest", src, func(o *op) { o.Data.File = base64.StdEncoding.EncodeToString([]byte("different file")) }},
		{"wrong organization identity", org, func(o *op) { o.Target = uuid() }},
		{"unsupported logo", org, func(o *op) { o.Data.File = base64.StdEncoding.EncodeToString([]byte("spreadsheet")) }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			o := c.valid
			if err := validate(o, true); err != nil {
				t.Fatalf("valid starting record rejected: %v", err)
			}
			c.change(&o)
			if validate(o, true) == nil {
				t.Fatal("invalid record accepted")
			}
		})
	}
}

func TestIssuedDocumentMustMatchBothArchivedFiles(t *testing.T) {
	const day = "2029-07-31"
	good := sampleInvoice(t, uuid(), day, 100)
	cashier := device{ID: uuid(), Donor: true}
	digest := func(encoded string) string {
		t.Helper()
		content, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			t.Fatal(err)
		}
		return digestHex(content)
	}
	pdfHash, docxHash := digest(good.PDF), digest(good.DOCX)
	var snapshot map[string]any
	if err := json.Unmarshal([]byte(good.Note), &snapshot); err != nil {
		t.Fatal(err)
	}
	snapshot["archive"] = map[string]string{"device": cashier.ID, "pdfsha256": pdfHash, "docxsha256": docxHash}
	note, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	good.Note = string(note)
	if _, _, err := checkArchive(cashier, good); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		name   string
		change func(*data)
	}{
		{"changed subject", func(v *data) { v.Reference = uuid() }},
		{"changed issue date", func(v *data) { v.Date = "2029-08-01" }},
		{"wrong series", func(v *data) { v.Fields = map[string]string{"series": "confirmation"} }},
		{"unknown profile", func(v *data) { v.Note = strings.ReplaceAll(v.Note, "invoice_transfer_a4", "obsolete_profile") }},
		{"incomplete pdf", func(v *data) { v.PDF = base64.StdEncoding.EncodeToString([]byte("%PDF-1.4")) }},
		{"invalid word encoding", func(v *data) { v.DOCX = "??" }},
		{"wrong word format", func(v *data) { v.DOCX = v.PDF }},
		{"wrong issuing device", func(v *data) { v.Note = strings.Replace(v.Note, cashier.ID, uuid(), 1) }},
		{"wrong PDF digest", func(v *data) { v.Note = strings.Replace(v.Note, pdfHash, docxHash, 1) }},
		{"wrong DOCX digest", func(v *data) { v.Note = strings.Replace(v.Note, docxHash, pdfHash, 1) }},
	} {
		t.Run(c.name, func(t *testing.T) {
			changed := good
			c.change(&changed)
			pdf, word, err := checkArchive(cashier, changed)
			if err == nil || pdf != nil || word != nil {
				t.Fatal("mismatched document released")
			}
		})
	}
}
