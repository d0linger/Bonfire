package main

import (
	"crypto/hmac"
	"crypto/sha1" // #nosec G505 -- the test authenticates against the configured RFC 6238 profile.
	"encoding/base32"
	"encoding/binary"
	"errors"
	"fmt"
	"maps"
	"strings"
	"time"
)

func (f *transactionFixture) checkPeriodSource(source string, active bool) {
	t := f.t
	ctx := t.Context()
	tx, err := f.app.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	for _, c := range []struct {
		name    string
		fields  map[string]string
		balance int64
		ok      bool
	}{
		{"manual", nil, 12000, true},
		{"unchanged cash", map[string]string{"previous": source}, 12345, active},
		{"wrong cash", map[string]string{"previous": source}, 12346, false},
		{"obsolete source", map[string]string{"previous": uuid()}, 12345, false},
		{"confirmed annual snapshot", map[string]string{"yearPeriod": source}, 12345, active},
		{"obsolete annual snapshot", map[string]string{"yearPeriod": uuid()}, 12345, false},
	} {
		opening := row{Kind: "opening", Data: data{Date: "2077-05-02", Amount: amount(c.balance), Fields: c.fields}}
		err := validateCarry(ctx, tx, []row{opening, opening})
		if (err == nil) != c.ok {
			t.Fatalf("Carry-forward %s (source active=%t): got %v", c.name, active, err)
		}
	}
}

// Rejecting a posting must preserve journal positions, reserved numbers and balances.
func (f *transactionFixture) checkPaymentRules(year, day string) {
	t, a := f.t, f.app
	e := f.atomic(a.events, "/api/events", event{Name: "Terminal reconciliation", Year: year, Starts: day, Ends: day}).(event)
	f.event = e.ID
	path := "/api/online?event=" + e.ID
	entry := func(kind string, cents int64) op {
		return op{ID: uuid(), Target: uuid(), Kind: kind, Data: data{Label: "Synthetic " + kind, Date: day, Amount: amount(cents)}}
	}
	post := func(o op) { f.atomic(a.syncEvent, path, request{Ops: []op{o}}) }
	reject := func(o op, status int) {
		t.Helper()
		before := f.snapshot()
		_, err := f.request(t.Context(), a.syncEvent, path, request{Ops: []op{o}})
		var p problem
		if !errors.As(err, &p) || p.code != status || !maps.Equal(before, f.snapshot()) {
			t.Fatalf("Rejected %s: want %d with unchanged ledger, got %v", o.Kind, status, err)
		}
	}
	sale := entry("presale", 1500)
	sale.Data.Fields = map[string]string{"saleQuantity": "3", "unitCents": "510"}
	reject(sale, 422)
	sale.Data.Fields["unitCents"] = "500"
	post(sale)
	expense := entry("expense", 400)
	expense.Data.Fields = map[string]string{"sale": uuid()}
	reject(expense, 409)
	expense.Data.Fields["sale"] = sale.Target
	post(expense)
	card := entry("card", 5000)
	card.Data.Fields = map[string]string{"provider": "Synthetic terminal"}
	post(card)
	fee := entry("fee", 5100)
	fee.Data.Fields = map[string]string{"provider": "Synthetic terminal"}
	reject(fee, 409)
	fee.Data.Amount = amount(100)
	post(fee)
	revision := card
	revision.ID = uuid()
	revision.Base = 1
	revision.Data.Note = "Corrected terminal description"
	revision.Data.Fields = map[string]string{"provider": "Other terminal"}
	reject(revision, 409)
	revision.Data.Fields = card.Data.Fields
	revision.Data.Amount = amount(6000)
	post(revision)
	if got := f.value("SELECT sum(direction*(data->>'Amount')::int)::text FROM journal_history WHERE event=$1 AND kind='card'", e.ID); got != "6000" {
		t.Fatal("A correction counted both the original and replacement card amount")
	}
	cash := entry("income", 900)
	cash.Data.Method = "Bar"
	post(cash)
	number := f.atomic(a.syncEvent, path, request{}).(map[string]any)["nextNumber"].(int64)
	paper := entry("paper", 0)
	paper.Target = fmt.Sprintf("paper:%d", number)
	paper.Data.Number = number
	paper.Data.Status = "Ausgegeben"
	paper.Data.Reference = cash.Target
	post(paper)
	paper.ID = uuid()
	paper.Data.Number++
	paper.Target = fmt.Sprintf("paper:%d", paper.Data.Number)
	reject(paper, 409)
	paper.Data.Reference = ""
	paper.Data.Status = "Verworfen"
	paper.Data.Note = "Paper damaged before use"
	post(paper)
	numbers := f.atomic(a.manage, "/api/manage", map[string]string{"Action": "numbers"}).([]map[string]any)
	if len(numbers) != 1 || fmt.Sprint(numbers[0]["paper"]) != fmt.Sprintf("[P-%d Ausgegeben P-%d Verworfen]", number, number+1) {
		t.Fatal("Receipt number report did not retain the issued and voided slips")
	}
}

func (f *transactionFixture) checkReadModels(ledger, year string) {
	t, a := f.t, f.app
	f.event = ledger
	workspace := f.atomic(a.workplace, "/api/workplace?event="+ledger, nil).(map[string]any)
	if workspace["event"].(event).ID != ledger || workspace["role"] != roleAdmin {
		t.Fatal("Workspace response does not match the selected cashbook")
	}
	preview := f.atomic(a.adminAudit, "/api/admin/audit?year="+year, nil).(map[string]any)
	if len(preview["rows"].([]auditEntry)) == 0 {
		t.Fatal("No financial audit events in the current fiscal year")
	}
	export := f.atomic(a.adminAudit, "/api/admin/audit/export?year="+year, map[string]string{}).(map[string]string)
	if !strings.Contains(export["csv"], "Fire brigade account linked") {
		t.Fatal("Export is missing the account assignment decision")
	}
	status := f.atomic(a.adminStatus, "/api/admin/status", nil).(map[string]any)
	if status["sessions"].(int64) < 1 || status["schema"].(int) == 0 {
		t.Fatal("Status does not reflect the current installation")
	}
	chains := f.atomic(a.adminIntegrity, "/api/admin/audit/integrity", nil).(map[string]any)["chains"].([]auditChainCheck)
	if len(chains) == 0 {
		t.Fatal("No audit chains")
	}
	for _, chain := range chains {
		if !chain.OK {
			t.Fatalf("Broken audit chain on %s", chain.Lane)
		}
	}
	for _, action := range []string{"period", "journal-period"} {
		out := f.atomic(a.manage, "/api/manage", map[string]string{"Action": action, "Target": "2077-05-01", "Reason": "2077-05-01"}).([]map[string]any)
		var income int64
		for _, r := range out {
			if r["art"] == "income" {
				income += r["cent"].(int64)
			}
		}
		if income != 12345 {
			t.Fatalf("Reversing and moving income changed its value in %s: %d", action, income)
		}
	}
}

func (f *transactionFixture) completeAuthenticatorSetup(seed, password string) {
	t, a := f.t, f.app
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(seed)
	if err != nil {
		t.Fatal(err)
	}
	counter := binary.BigEndian.AppendUint64(nil, uint64(time.Now().Unix()/30))
	mac := hmac.New(sha1.New, key)
	mac.Write(counter)
	digest := mac.Sum(nil)
	code := fmt.Sprintf("%06d", (binary.BigEndian.Uint32(digest[digest[len(digest)-1]&15:])&0x7fffffff)%1000000)
	codes := f.atomic(a.mfa, "/api/mfa", map[string]string{"Code": code, "Secret": seed}).([]string)
	if len(codes) != 8 {
		t.Fatal("Missing recovery codes after enrollment")
	}
	change := func(q accountCommand) any { return f.atomic(a.changeAccountSecurity, "/api/account/security", q) }
	newCodes := change(accountCommand{Action: "recovery", Password: password, Code: codes[0]}).(map[string]any)["codes"].([]string)
	if got := f.value("SELECT count(*)::text FROM recovery_codes WHERE digest=$1", hash(codes[1])); got != "0" {
		t.Fatal("Old recovery codes survived rotation")
	}
	change(accountCommand{Action: "mfa-disable", Password: password, Code: newCodes[0]})
	summary := f.atomic(a.accountSecurity, "/api/account/security", nil).(map[string]any)
	if summary["mfa"] != false || summary["recoveryRemaining"] != 0 {
		t.Fatal("Disabled MFA still exposes usable credentials")
	}
	nextPassword := secret()
	change(accountCommand{Action: "password", Password: password, NewPassword: nextPassword})
	if got := f.value("SELECT count(*)::text FROM sessions WHERE token=$1", hash(f.cookie)); got != "0" {
		t.Fatal("Changing the password failed to rotate the session token")
	}
}
