package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// A canceled statement models the database connection disappearing before the
// command reaches PostgreSQL. Cleanup uses the original context and can roll back.
type interruptedQuery struct {
	at, seen    int
	interrupted bool
}
type interruptionKey struct{}

func (interruptionKey) TraceQueryStart(ctx context.Context, _ *pgx.Conn, q pgx.TraceQueryStartData) context.Context {
	plan, _ := ctx.Value(interruptionKey{}).(*interruptedQuery)
	if plan == nil || strings.EqualFold(q.SQL, "rollback") {
		return ctx
	}
	plan.seen++
	if plan.seen != plan.at {
		return ctx
	}
	plan.interrupted = true
	stopped, cancel := context.WithCancel(ctx)
	cancel()
	return stopped
}
func (interruptionKey) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

type transactionFixture struct {
	t             *testing.T
	owner         *pgxpool.Pool
	app           *app
	cookie, event string
}

// Fingerprint rows, including audit, operation sequence, journal and balances.
// PostgreSQL sequences may advance on rollback. They convey no business state.
func (f *transactionFixture) snapshot() map[string]string {
	f.t.Helper()
	rows, err := f.owner.Query(f.t.Context(), "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
	if err != nil {
		f.t.Fatal(err)
	}
	names, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		f.t.Fatal(err)
	}
	// Collect the small fixture in one query to keep failure tests inexpensive.
	parts := make([]string, 0, len(names))
	for i, name := range names {
		parts = append(parts, fmt.Sprintf("SELECT %d AS table_index, coalesce(string_agg(to_jsonb(r)::text, E'\\n' ORDER BY to_jsonb(r)::text),'') AS state FROM %s AS r", i, pgx.Identifier{name}.Sanitize()))
	}
	result, err := f.owner.Query(f.t.Context(), strings.Join(parts, " UNION ALL "))
	if err != nil {
		f.t.Fatal(err)
	}
	defer result.Close()
	state := map[string]string{}
	for result.Next() {
		var i int
		var value string
		if err := result.Scan(&i, &value); err != nil {
			f.t.Fatal(err)
		}
		state[names[i]] = value
	}
	if result.Err() != nil {
		f.t.Fatal(result.Err())
	}
	return state
}

func newTxFixture(t *testing.T) *transactionFixture {
	t.Helper()
	port := os.Getenv("BONFIRE_TEST_PGPORT")
	if port == "" {
		t.Skip("Use ops/test-transactions.ps1 to exercise real PostgreSQL transactions")
	}
	n, err := strconv.ParseUint(port, 10, 16)
	if err != nil || n == 0 {
		t.Fatal("Invalid disposable database port")
	}
	cfg, err := pgxpool.ParseConfig("postgres://postgres@127.0.0.1/bonfire_tx_tests?sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.Port = uint16(n)
	cfg.ConnConfig.Password = os.Getenv("BONFIRE_TEST_PGPASSWORD")
	owner, err := pgxpool.NewWithConfig(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owner.Close)
	t.Setenv("BONFIRE_ADMIN_PASSWORD", secret())
	t.Setenv("BONFIRE_RUNTIME_PASSWORD", secret())
	if err := initialize(t.Context(), owner); err != nil {
		t.Fatal(err)
	}
	if err := configureRuntime(t.Context(), owner); err != nil {
		t.Fatal(err)
	}
	runtime := cfg.Copy()
	runtime.ConnConfig.User = "bonfire_runtime"
	runtime.ConnConfig.Password = os.Getenv("BONFIRE_RUNTIME_PASSWORD")
	runtime.ConnConfig.Tracer = interruptionKey{}
	db, err := pgxpool.NewWithConfig(t.Context(), runtime)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	cookie := secret()
	if _, err := owner.Exec(t.Context(), "INSERT INTO sessions(token,username,expires) VALUES($1,'leitung',now()+interval '1 hour')", hash(cookie)); err != nil {
		t.Fatal(err)
	}
	return &transactionFixture{t: t, owner: owner, app: &app{db: db, loginLimits: db, attempts: map[string]int{}, verificationSlots: make(chan struct{}, 4)}, cookie: cookie}
}

func (f *transactionFixture) request(ctx context.Context, fn endpoint, path string, body any) (any, error) {
	f.t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		f.t.Fatal(err)
	}
	method := "POST"
	if body == nil {
		method = "GET"
	}
	r := httptest.NewRequestWithContext(ctx, method, path, bytes.NewReader(raw))
	r.AddCookie(&http.Cookie{Name: "bonfire_session", Value: f.cookie})
	r.Header.Set("X-Bonfire-Event", f.event)
	r.Header.Set("X-Bonfire-Donor", "true")
	return fn(ctx, httptest.NewRecorder(), r)
}

// Interrupt each individual DB operation, then retry the identical request.
// A failed booking or access change must leave all persisted state intact.
func (f *transactionFixture) atomic(fn endpoint, path string, body any) any {
	f.t.Helper()
	return f.atomicWithBody(fn, path, func() any { return body })
}

func (f *transactionFixture) atomicWithBody(fn endpoint, path string, body func() any) any {
	f.t.Helper()
	before := f.snapshot()
	for boundary := 1; boundary < 300; boundary++ {
		plan := &interruptedQuery{at: boundary}
		ctx := context.WithValue(f.t.Context(), interruptionKey{}, plan)
		result, err := f.request(ctx, fn, path, body())
		if !plan.interrupted {
			if err != nil {
				f.t.Fatalf("%s failed after %d verified rollback boundaries: %v", path, boundary-1, err)
			}
			return result
		}
		if err == nil {
			f.t.Fatalf("%s accepted interrupted statement %d", path, boundary)
		}
		after := f.snapshot()
		for name, was := range before {
			if after[name] != was {
				f.t.Fatalf("%s changed %s after interruption at statement %d", path, name, boundary)
			}
		}
	}
	f.t.Fatal("Too many database operations for a single test request")
	return nil
}

func (f *transactionFixture) value(query string, args ...any) string {
	f.t.Helper()
	var s string
	if err := f.owner.QueryRow(f.t.Context(), query, args...).Scan(&s); err != nil {
		f.t.Fatal(err)
	}
	return s
}

func TestTransactionalRecovery(t *testing.T) {
	f := newTxFixture(t)
	a := f.app
	const date = "2077-05-01"
	year := f.atomic(a.years, "/api/years", fiscalYear{Name: "Synthetic year", Starts: date, Ends: "2077-06-01"}).(fiscalYear)
	ledger := f.value("SELECT id::text FROM events WHERE fiscal_year=$1 AND general_ledger", year.ID)
	oldYear := eventDetails{Name: year.Name, Starts: year.Starts, Ends: year.Ends}
	newYear := oldYear
	newYear.Name = "Renamed year"
	f.atomic(a.editYear, "/api/years/edit", map[string]any{"Year": year.ID, "Previous": oldYear, "Updated": newYear})
	if got := f.value("SELECT name FROM fiscal_years WHERE id=$1", year.ID); got != newYear.Name {
		t.Fatal(got)
	}
	fest := f.atomic(a.events, "/api/events", event{Name: "Spring fair", Starts: date, Ends: date, Year: year.ID}).(event)
	f.event = fest.ID
	post := "/api/online?event=" + fest.ID
	movement := func(kind, label string, cents int64) op {
		return op{ID: uuid(), Target: uuid(), Kind: kind, Data: data{Label: label, Date: date, Amount: amount(cents)}}
	}
	income := movement("income", "Club contribution", 12345)
	expense := movement("expense", "Catering", 345)
	f.atomic(a.syncEvent, post, request{Ops: []op{income, expense}})
	if got := f.value("SELECT sum(CASE WHEN kind='expense' THEN -(data->>'Amount')::int ELSE (data->>'Amount')::int END)::text FROM entries WHERE event=$1", fest.ID); got != "12000" {
		t.Fatal(got)
	}
	move := map[string]any{"Action": "move", "Event": fest.ID, "Target": income.Target, "Destination": ledger, "Request": uuid(), "Revision": 1, "Reason": "Filed in the wrong workspace"}
	f.atomic(a.changeEventEntry, "/api/events/entries", move)
	if got := f.value("SELECT count(*)::text FROM entries WHERE event=$1 AND kind='income' AND data->>'Amount'='12345'", ledger); got != "1" {
		t.Fatal(got)
	}
	f.atomic(a.changeEventEntry, "/api/events/entries", map[string]any{"Action": "remove", "Event": fest.ID, "Target": expense.Target, "Request": uuid(), "Revision": 1, "Reason": "Invoice canceled"})
	f.atomic(a.deleteEvent, "/api/events/delete", map[string]any{"Event": fest.ID})
	if got := f.value("SELECT count(*)::text FROM events WHERE id=$1", fest.ID); got != "0" {
		t.Fatal(got)
	}
	f.event = ledger
	f.atomic(a.syncEvent, "/api/online?event="+ledger, request{Ops: []op{movement("opening", "Cash on hand", 0), movement("actual", "Verified cash", 12345)}})
	period := movement("period", "Reporting month", 0)
	period.Data.To = date
	f.atomic(a.syncEvent, "/api/online?event="+ledger, request{Ops: []op{period}})
	manage := func(action, target, reason string) any {
		return f.atomic(a.manage, "/api/manage", map[string]string{"Action": action, "Target": target, "Reason": reason})
	}
	manage("period-close", period.Target, "")
	prior := manage("prior", "2077-05-02", "").(priorPeriod)
	if prior.Actuals[""] != 12345 {
		t.Fatalf("Closing snapshot lost the cash count: %v", prior.Actuals)
	}
	f.checkPeriodSource(prior.ID, true)
	manage("period-open", period.Target, "Supplier invoice arrived late")
	f.checkPeriodSource(prior.ID, false)
	f.atomic(a.syncEvent, "/api/online?event="+ledger, request{Action: "Geschäftsjahr abschließen"})
	if got := f.value("SELECT closed::text FROM fiscal_years WHERE id=$1", year.ID); got != "true" {
		t.Fatal(got)
	}
	f.checkYearCarry(ledger)
	f.event = ledger
	f.atomic(a.manage, "/api/manage", map[string]string{"Action": "year-reopen", "Reason": "New supporting document"})
	f.checkFinanceAdministration(year.ID, ledger)
	f.checkReadModels(ledger, year.ID)
	f.checkAccessChanges(ledger)
	f.checkHistoricalRecords(year.ID, date)
	f.checkPaymentRules(year.ID, date)
	f.checkDocumentsAndImport(year.ID, date)
	f.checkMigrationIntegrity()
	f.checkBackupDB()
	f.checkSelfService()
}
func (f *transactionFixture) checkFinanceAdministration(year, ledger string) {
	t, a := f.t, f.app
	account := func(body any) any { return f.atomic(a.fireAccounts, "/api/fire-accounts", body) }
	manage := func(body any) any { return f.atomic(a.manage, "/api/manage", body) }
	id := account(map[string]string{"Action": "create", "Name": "Festival reserve"}).(string)
	account(map[string]any{"Action": "edit", "ID": id, "Name": "Events reserve", "Active": true, "Revision": 1})
	manage(map[string]any{"Action": "accounts", "Accounts": true})
	account(map[string]string{"Action": "link", "Event": ledger, "ID": id})
	account(map[string]any{"Action": "count", "Year": year, "ID": id, "Opening": 4000, "Actual": 4000})
	lines := f.atomic(a.yearBalances, "/api/year-balances?year="+year, nil).([]accountBalance)
	found := false
	for _, line := range lines {
		if line.ID == id && line.Opening != nil && *line.Opening == 4000 && line.Actual != nil && *line.Actual == 4000 {
			found = true
		}
	}
	if !found {
		t.Fatal("Treasury count missing after retry")
	}
	accounts := account(nil).(map[string]any)
	if len(accounts["accounts"].([]fireAccount)) != 1 {
		t.Fatal("duplicate treasury account after retry")
	}
	manage(map[string]any{"Action": "accounts", "Accounts": false})
	summary := func(action string) any {
		return f.atomic(a.donationReports, "/api/donation-reports", map[string]string{"Action": action, "Period": "2077"})
	}
	preview := summary("Vorschau").(map[string]any)
	digest := preview["sha256"].(string)
	report := uuid()
	for _, step := range []string{"Geprüft", "Exportiert", "Übermittelt", "Bestätigt", "Korrektur"} {
		f.atomic(a.donationReports, "/api/donation-reports", donationCommand{Action: step, Period: "2077", Report: report, Request: uuid(), Digest: digest, Reason: "Synthetic review evidence"})
	}
	file := f.atomic(a.donationReports, "/api/donation-reports", donationCommand{Action: "Datei", Period: "2077", Report: report}).(map[string]any)
	if file["sha256"] != digest || digestHex([]byte(file["datei"].(string))) != digest {
		t.Fatal("Donation export does not match reviewed preview")
	}
	history := summary("Verlauf").([]map[string]any)
	if len(history) != 5 {
		t.Fatalf("expected five distinct reporting decisions, got %d", len(history))
	}
}
func (f *transactionFixture) checkAccessChanges(ledger string) {
	a, t := f.app, f.t
	user := "assistant-cashier@example.invalid"
	q := changeAccount{Action: "create", Login: user, Label: "Assistant cashier", Role: roleWrite, Password: secret(), Events: []string{ledger}, Reason: "Temporary cashbook access"}
	edit := func() { f.atomic(a.editAdminUser, "/api/admin/users/edit", q) }
	edit()
	q.ID = user
	q.Version = 1
	q.Action = "edit"
	q.Role = roleRead
	q.Events = nil
	edit()
	access := func(action string) {
		f.atomic(a.access, "/api/access", map[string]string{"Action": action, "Name": user, "Event": ledger, "Reason": "Revised duties"})
	}
	access("grant")
	access("revoke")
	q.Version = 4
	for _, action := range []string{"password", "mfa", "disable", "enable", "sessions"} {
		q.Action = action
		edit()
		q.Version++
	}
	if f.value("SELECT role FROM users WHERE name=$1", user) != roleRead || f.value("SELECT count(*)::text FROM grants_event WHERE username=$1", user) != "0" {
		t.Fatal("revoked permissions survived retry")
	}
}
func (f *transactionFixture) checkHistoricalRecords(year, date string) {
	t, a := f.t, f.app
	e := f.atomic(a.events, "/api/events", event{Name: "Migrated records", Starts: date, Ends: date, Year: year}).(event)
	f.event = e.ID
	historical := uuid()
	recorded := uuid()
	// Existing device records must remain reviewable while offline collection is disabled.
	_, err := f.owner.Exec(t.Context(), "INSERT INTO devices(id,username,event,name,secret,expires) VALUES($1,'leitung',$2,'Retired device',$3,now())", historical, e.ID, hash(secret()))
	if err != nil {
		t.Fatal(err)
	}
	historicalFile := data{Date: date, Label: "Historical conflict", Number: 438, PDF: "stored-pdf", DOCX: "stored-word", Note: `{"Profile":"invoice_cash_a4"}`}
	_, err = f.owner.Exec(t.Context(), "INSERT INTO operations(id,event,device,seq,digest,target,base,kind,data,outcome) VALUES($1,$2,$3,1,$4,$5,0,'original',$6,'Konflikt')", recorded, e.ID, historical, hash(recorded), uuid(), historicalFile)
	if err != nil {
		t.Fatal(err)
	}
	manage := func(action, target string) any {
		return f.atomic(a.manage, "/api/manage", map[string]string{"Action": action, "Target": target, "Reason": "Archived statement reconciliation"})
	}
	for _, action := range []string{"incident", "incomplete", "return"} {
		manage(action, historical)
	}
	if got := f.value("SELECT incident_state FROM devices WHERE id=$1", historical); got != "returning" {
		t.Fatal(got)
	}
	file := manage("conflict-file", recorded).(map[string]any)
	if file["pdf"] != historicalFile.PDF || file["docx"] != historicalFile.DOCX {
		t.Fatal("archived receipt bytes changed")
	}
	f.atomic(a.syncEvent, "/api/online?event="+e.ID, request{Resolve: recorded, Choice: "beibehalten", Reason: "Retain the existing original"})
	if got := f.value("SELECT outcome FROM operations WHERE id=$1", recorded); got != "Geklärt" {
		t.Fatalf("unexpected resolution outcome: %s", got)
	}
	list := manage("conflict-originals", "").([]map[string]any)
	if len(list) != 1 || list[0]["outcome"] != "Geklärt" {
		t.Fatal("resolved originals disappeared from history")
	}
	// Historical submissions still require an explicit, current cashier decision.
	target, pending := uuid(), uuid()
	submission := data{Label: "Historical payment", Amount: amount(1900), Date: date}
	_, err = f.owner.Exec(t.Context(), "INSERT INTO operations(id,event,device,seq,digest,target,base,kind,data,outcome) VALUES($1,$2,$3,2,$4,$5,0,'income',$6,'Konflikt')", pending, e.ID, historical, hash(pending), target, submission)
	if err != nil {
		t.Fatal(err)
	}
	resolution := request{Resolve: pending, Choice: "übernehmen", Reason: "Cashier checked receipt and cash count", Last: 1}
	if _, err = f.request(t.Context(), a.syncEvent, "/api/online?event="+e.ID, resolution); err == nil {
		t.Fatal("Accepted a conflict decision against a stale revision")
	}
	resolution.Last = 0
	f.atomic(a.syncEvent, "/api/online?event="+e.ID, resolution)
	if got := f.value("SELECT data->>'Amount' FROM entries WHERE event=$1 AND id=$2", e.ID, target); got != "1900" {
		t.Fatal("Resolution lost the original financial statement")
	}
}

// Previously applied migrations are immutable. Refuse a database whose recorded
// checksum differs, even when all later schema objects already exist.
func (f *transactionFixture) checkMigrationIntegrity() {
	ctx := f.t.Context()
	rows, err := f.owner.Query(ctx, "SELECT version FROM migrations ORDER BY version")
	if err != nil {
		f.t.Fatal(err)
	}
	versions, err := pgx.CollectRows(rows, pgx.RowTo[int])
	if err != nil {
		f.t.Fatal(err)
	}
	for _, v := range versions {
		original := f.value("SELECT digest FROM migrations WHERE version=$1", v)
		if _, err = f.owner.Exec(ctx, "UPDATE migrations SET digest='stale' WHERE version=$1", v); err != nil {
			f.t.Fatal(err)
		}
		if initialize(ctx, f.owner) == nil {
			f.t.Fatalf("Startup accepted a changed migration %d", v)
		}
		if _, err = f.owner.Exec(ctx, "UPDATE migrations SET digest=$2 WHERE version=$1", v, original); err != nil {
			f.t.Fatal(err)
		}
	}
	if err := initialize(ctx, f.owner); err != nil {
		f.t.Fatalf("Verified migrations failed to restart: %v", err)
	}
}
