package main

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"
)

func (f *transactionFixture) checkYearCarry(source string) {
	a, t := f.app, f.t
	year := f.atomic(a.years, "/api/years", fiscalYear{Name: "Following year", Starts: "2078-01-01", Ends: "2078-12-31"}).(fiscalYear)
	f.event = f.value("SELECT id::text FROM events WHERE fiscal_year=$1 AND general_ledger", year.ID)
	manage := func(stamp, target string) any {
		return f.atomic(a.manage, "/api/manage", map[string]string{"Action": "year-carry", "Stamp": stamp, "Target": target})
	}
	available := manage("", "").([]yearCarryLine)
	if len(available) != 1 || available[0].Source != source || available[0].Amount != 12345 {
		t.Fatalf("Wrong carry-forward: %+v", available)
	}
	for range 2 {
		manage(available[0].Stamp, source)
	}
	if got := f.value("SELECT count(*)::text FROM entries WHERE event=$1 AND kind='opening' AND data->>'Amount'='12345'", f.event); got != "1" {
		t.Fatal("Replayed carry-forward duplicated the opening")
	}
}

// Build a synthetic original without using any of the private reference documents.
func sampleInvoice(t *testing.T, reference, day string, number int64) data {
	t.Helper()
	var doc bytes.Buffer
	z := zip.NewWriter(&doc)
	for _, part := range []string{"[Content_Types].xml", "word/document.xml"} {
		file, err := z.Create(part)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = file.Write([]byte("<sample/>")); err != nil {
			t.Fatal(err)
		}
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	note, err := json.Marshal(map[string]any{"profile": "invoice_transfer_a4", "subject": reference, "date": day, "number": number})
	if err != nil {
		t.Fatal(err)
	}
	return data{Label: "Synthetic invoice", Date: day, Reference: reference, Number: number, Note: string(note), PDF: base64.StdEncoding.EncodeToString([]byte("%PDF-1.4\n%%EOF")), DOCX: base64.StdEncoding.EncodeToString(doc.Bytes())}
}

func (f *transactionFixture) checkDocumentsAndImport(year, day string) {
	a, t := f.app, f.t
	e := f.atomic(a.events, "/api/events", event{Name: "Document checks", Starts: day, Ends: day, Year: year}).(event)
	f.event = e.ID
	path := "/api/online?event=" + e.ID
	post := func(ops ...op) map[string]any { return f.atomic(a.syncEvent, path, request{Ops: ops}).(map[string]any) }
	next := post()["nextNumber"].(int64)
	makeOp := func(kind string, d data) op { d.Date = day; return op{ID: uuid(), Target: uuid(), Kind: kind, Data: d} }
	contact := makeOp("contact", data{Label: "Sample sponsor", Address: "Fixture Street 1\n1000 Exampletown"})
	org := makeOp("organization", data{Label: "Sample brigade", Address: "Fixture Street 2\n1000 Exampletown", Fields: map[string]string{"IBAN": "AT000000000000000000", "holder": "Sample brigade", "legal": "Test statement"}})
	org.Target = "organization"
	sponsor := makeOp("sponsorship", data{Label: "Sponsor's invoice", Amount: amount(10000), Contact: contact.Target, Fields: map[string]string{"service": "Synthetic service", "due": day}})
	post(contact, org, sponsor)
	original := makeOp("original", data{Label: "Synthetic invoice", Reference: sponsor.Target, Number: next, Note: `{"profile":"invoice_transfer_a4"}`})
	original.Target = "original:" + sponsor.Target
	closedDay := f.value(`INSERT INTO period_closures(id,period_id,version,starts,ends,reviewer,snapshot,fiscal_year,source_event)
		SELECT gen_random_uuid(),$1,1,local_day,local_day,'leitung','[]',$2,$3
		FROM (SELECT (now() AT TIME ZONE 'Europe/Vienna')::date AS local_day) issue
		RETURNING id::text`, uuid(), year, e.ID)
	_, err := f.request(t.Context(), a.syncEvent, path, request{Ops: []op{original}})
	var rejection problem
	if !errors.As(err, &rejection) || rejection.code != 409 {
		t.Fatalf("Rendered invoice used a closed period: %v", err)
	}
	if got := post()["nextNumber"].(int64); got != next {
		t.Fatal("Rejected invoice consumed a number")
	}
	f.value("UPDATE period_closures SET reopened_at=now() WHERE id=$1 RETURNING id::text", closedDay)
	first := post(original)
	if first["nextNumber"].(int64) != next+1 {
		t.Fatal("A single issued invoice must reserve exactly one number")
	}
	log := printLog{ID: uuid(), Subject: sponsor.Target, At: time.Now().UTC().Truncate(time.Microsecond)}
	for range 2 {
		result := f.atomic(a.syncEvent, path, request{Prints: []printLog{log}}).(map[string]any)
		accepted := result["acknowledgedPrints"].([]string)
		if len(accepted) != 1 || accepted[0] != log.ID {
			t.Fatal("Identical reprint not acknowledged")
		}
	}
	if got := f.value("SELECT count(*)::text FROM print_log WHERE event=$1", e.ID); got != "1" {
		t.Fatal("Duplicate paper trail")
	}
	receipt := makeOp("dispatch", data{Label: "Handed to sponsor", Status: "Extern übergeben", Note: "Delivered by the cashier", Reference: original.Target})
	receipt.Target = "dispatch:" + original.Target
	post(receipt)
	raw := "date,amount\n" + day + ",32.54\n"
	digest := digestHex([]byte(raw))
	source := makeOp("import-source", data{Label: "Synthetic journal", Filename: "example.csv", Status: "Journal", File: base64.StdEncoding.EncodeToString([]byte(raw)), Reference: digest})
	source.Target = "source:" + digest
	post(source)
	entry := makeOp("income", data{Label: "Membership fee", Amount: amount(3254), Reference: source.Target, Note: "Confirmed row in synthetic journal", Fields: map[string]string{"cell": "2", "sheet": "example.csv"}})
	entry.Target = fmt.Sprintf("import:%s:2", digest)
	post(entry)
	post(entry)
	if got := f.value("SELECT count(*)::text FROM entries WHERE event=$1 AND data->>'Reference'=$2 AND data->>'Amount'='3254'", e.ID, source.Target); got != "1" {
		t.Fatal("Duplicate import")
	}
	bar := makeOp("bar", data{Label: "Tea tent"})
	wallet := makeOp("wallet", data{Label: "Till", Bar: bar.Target, Note: "Previous event's setup note"})
	shift := makeOp("shift", data{Label: "Evening shift", Bar: bar.Target, Wallet: wallet.Target, Note: "Previous shift's instructions"})
	post(bar, wallet, shift)
	copy := f.atomic(a.manage, "/api/manage", map[string]any{"Action": "copy", "Target": "Repeated event", "Start": day, "End": day, "Year": year, "CopyKinds": []string{"bar", "wallet", "shift"}}).(string)
	if got := f.value("SELECT count(*)::text FROM entries WHERE event=$1", copy); got != "3" {
		t.Fatal("Structural copy included cash or original receipts")
	}
	if got := f.value(`SELECT count(*)::text FROM entries s JOIN entries w ON s.event=w.event AND w.id=s.data->>'Wallet' JOIN entries b ON b.event=w.event AND b.id=w.data->>'Bar' WHERE s.event=$1 AND s.kind='shift' AND w.id<>$2 AND b.id<>$3 AND s.data->>'Status'='Geplant'`, copy, wallet.Target, bar.Target); got != "1" {
		t.Fatal("Copied shift lost its link to the copied wallet and bar")
	}
	f.atomic(a.manage, "/api/manage", map[string]string{"Action": "reprint", "Target": sponsor.Target})
}

func (f *transactionFixture) checkSelfService() {
	a, t := f.app, f.t
	sessionID := f.value("INSERT INTO sessions(token,username,expires) VALUES($1,'leitung',now()+interval '1 hour') RETURNING public_id::text", hash(secret()))
	change := func(q accountCommand) any { return f.atomic(a.changeAccountSecurity, "/api/account/security", q) }
	change(accountCommand{Action: "revoke", SessionID: sessionID})
	if f.value("SELECT count(*)::text FROM sessions WHERE public_id=$1", sessionID) != "0" {
		t.Fatal("Session survived revocation")
	}
	f.atomic(a.accountSecurity, "/api/account/security", nil)
	f.atomic(a.accountPasskeys, "/api/account/passkeys", nil)
	f.atomic(a.beginPasskeyLogin, "/api/passkey/login/begin", map[string]any{})
	f.atomic(a.beginPasskeyRegistration, "/api/account/passkeys/register/begin", map[string]string{"Name": "Test security key", "Password": os.Getenv("BONFIRE_ADMIN_PASSWORD")})
	started := change(accountCommand{Action: "mfa-begin", Password: os.Getenv("BONFIRE_ADMIN_PASSWORD")}).(map[string]string)
	if started["secret"] == "" || started["uri"] == "" {
		t.Fatal("Enrollment material missing")
	}
	// The enrollment is only pending until the cashier supplies a valid code.
	if f.value("SELECT (otp_secret IS NULL)::text FROM users WHERE name='leitung'") != "true" {
		t.Fatal("Pending enrollment activated the authenticator")
	}
	f.completeAuthenticatorSetup(started["secret"], os.Getenv("BONFIRE_ADMIN_PASSWORD"))
}
