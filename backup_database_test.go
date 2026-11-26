package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func (f *transactionFixture) checkBackupDB() {
	t := f.t
	t.Helper()
	ctx := t.Context()
	cfg := f.owner.Config().ConnConfig.Copy()
	cfg.Tracer = interruptionKey{}
	open := func() *pgx.Conn {
		conn, err := pgx.ConnectConfig(ctx, cfg)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if err := conn.Close(context.Background()); err != nil {
				t.Errorf("close fixture connection: %v", err)
			}
		})
		return conn
	}
	frozen, candidate := open(), open()
	exec := func(c *pgx.Conn, sql string) {
		t.Helper()
		if _, err := c.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}

	// Independent session-local tables model the old and restored databases
	// without changing identities, sequence floors or originals in the ledger.
	const numberSchema = "CREATE TEMP SEQUENCE number_blocks; CREATE TEMP TABLE devices(id uuid PRIMARY KEY, online_actor bool, online_number_floor bigint); CREATE TEMP TABLE originals(device uuid, number bigint)"
	exec(frozen, numberSchema)
	exec(candidate, numberSchema)
	exec(frozen, "SELECT setval('number_blocks',33); INSERT INTO devices VALUES ('00000000-0000-4000-8000-000000000001',true,18),('00000000-0000-4000-8000-000000000002',true,20),('00000000-0000-4000-8000-000000000003',false,99); INSERT INTO originals VALUES ('00000000-0000-4000-8000-000000000001',27)")
	const resetCandidate = "SELECT setval('number_blocks',41); TRUNCATE devices; INSERT INTO devices VALUES ('00000000-0000-4000-8000-000000000001',true,3),('00000000-0000-4000-8000-000000000002',true,22),('00000000-0000-4000-8000-000000000003',false,5)"
	floors := func() string {
		var s string
		if err := candidate.QueryRow(ctx, "SELECT string_agg(online_number_floor::text,',' ORDER BY id) FROM devices").Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	for boundary := 1; boundary <= 6; boundary++ {
		exec(candidate, resetCandidate)
		plan := &interruptedQuery{at: boundary}
		err := retainIssuedNumbers(context.WithValue(ctx, interruptionKey{}, plan), frozen, candidate)
		if plan.interrupted && err == nil {
			t.Fatalf("partial transfer of numbering floors reported success at statement %d", boundary)
		}
		if err != nil && !plan.interrupted {
			t.Fatal(err)
		}
		if err = retainIssuedNumbers(ctx, frozen, candidate); err != nil {
			t.Fatal(err)
		}
		if s := floors(); s != "28,22,5" {
			t.Fatalf("numbering floors after retry: %s", s)
		}
		var block int
		if err = candidate.QueryRow(ctx, "SELECT last_value FROM number_blocks").Scan(&block); err != nil || block != 41 {
			t.Fatalf("reserved block moved backwards: %d, %v", block, err)
		}
		if !plan.interrupted {
			break
		}
	}

	t.Run("manifest binds cents and original bytes", func(t *testing.T) {
		tx, err := f.owner.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		sql := "CREATE TEMP TABLE backup_installation(installation text); INSERT INTO backup_installation VALUES ('test-installation'); CREATE TEMP TABLE fiscal_years(id int); INSERT INTO fiscal_years VALUES (1); CREATE TEMP TABLE events(id int); INSERT INTO events VALUES (2); CREATE TEMP TABLE event_records(id int); INSERT INTO event_records VALUES (2); CREATE TEMP TABLE entries(id int, cents bigint); INSERT INTO entries VALUES (3,1000),(4,500); CREATE TEMP TABLE entry_removals(id int); CREATE TEMP TABLE originals(blob bytea); INSERT INTO originals VALUES ('document')"
		if _, err = tx.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
		read := func() backupManifest {
			t.Helper()
			m, err := stateManifest(ctx, tx, 33)
			if err != nil {
				t.Fatal(err)
			}
			if m.Installation != "test-installation" || m.Years != 1 || m.Workspaces != 1 || m.Entries != 2 || m.Originals != 1 {
				t.Fatalf("wrong counts: %+v", m)
			}
			return m
		}
		start := read()
		if _, err = tx.Exec(ctx, "UPDATE entries SET cents=CASE WHEN id=3 THEN 900 ELSE 600 END"); err != nil {
			t.Fatal(err)
		}
		adjusted := read()
		if adjusted.DataHash == start.DataHash {
			t.Fatal("offsetting changes to individual amounts preserved hash")
		}
		if _, err = tx.Exec(ctx, "UPDATE originals SET blob='revised'"); err != nil {
			t.Fatal(err)
		}
		if read().DataHash == adjusted.DataHash {
			t.Fatal("replaced original preserved hash")
		}
	})

	t.Run("failed restore probe retains original archive and last successful verification", func(t *testing.T) {
		last := time.Now().UTC().Add(-time.Hour)
		w := backupWorker{db: cfg, service: ctx, storageDir: t.TempDir(), key: make([]byte, 32), state: backupState{
			Schedules: map[string]backupSchedule{}, Last: map[string]backupHealth{"probe": {LastSuccess: &last}},
			Probe: &backupReceipt{Name: "previous probe", At: last},
		}}
		rand.Read(w.key)
		server := httptest.NewServer(http.HandlerFunc(w.upload))
		defer server.Close()
		var encoded bytes.Buffer
		if err := sealBackup(bytes.NewBufferString("unreadable database dump"), &encoded, w.key, backupManifest{Installation: "test", DataHash: "test"}); err != nil {
			t.Fatal(err)
		}
		upload := func() string {
			t.Helper()
			res, err := server.Client().Post(server.URL, "application/octet-stream", bytes.NewReader(encoded.Bytes()))
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			var result struct{ Name string }
			if res.StatusCode != 200 || json.NewDecoder(res.Body).Decode(&result) != nil || !backupName.MatchString(result.Name) {
				t.Fatalf("upload failed: %d", res.StatusCode)
			}
			return result.Name
		}
		first, second := upload(), upload()
		if first == second {
			t.Fatal("uploads reused a name")
		}
		if _, err := os.Stat(filepath.Join(w.storageDir, "uploads", first)); !os.IsNotExist(err) {
			t.Fatalf("superseded candidate survived: %v", err)
		}
		before := f.value("SELECT count(*)::text FROM pg_database WHERE datname LIKE 'bf_probe_%'")
		err := w.start(backupCommand{Action: "probe", Target: "upload", Name: second}, "leitung")
		if err != nil {
			t.Fatal(err)
		}
		w.jobs.Wait()
		if w.active || w.state.Probe != nil || len(w.state.Recent) != 1 || w.state.Recent[0].Outcome != "failed" || !w.state.Last["probe"].LastSuccess.Equal(last) {
			t.Fatalf("bad state after failed recovery: %+v", w.state)
		}
		after := f.value("SELECT count(*)::text FROM pg_database WHERE datname LIKE 'bf_probe_%'")
		if before != after {
			t.Fatalf("a failed probe leaked a database: %s -> %s", before, after)
		}
		raw, err := os.ReadFile(filepath.Join(w.storageDir, "uploads", second))
		if err != nil || !bytes.Equal(raw, encoded.Bytes()) {
			t.Fatal("failed restore changed the saved candidate", err)
		}
	})

	t.Run("backup actions require a personal administrator session", func(t *testing.T) {
		t.Setenv("BONFIRE_BACKUP_SOCKET", filepath.Join(t.TempDir(), "unavailable.sock"))
		for _, tc := range []struct {
			label, body, cookie string
			status              int
		}{
			{"missing session", "{}", "", 401},
			{"unknown session", "{}", "unknown", 401},
			{"malformed command", "{", f.cookie, 400},
			{"missing confirmation", `{"action":"promote","password":"test"}`, f.cookie, 422},
			{"missing password", `{"action":"promote","confirmation":"RESTORE"}`, f.cookie, 422},
			{"unavailable worker", `{"action":"backup","target":"local"}`, f.cookie, 503},
		} {
			r := httptest.NewRequest("POST", "/api/admin/backup", strings.NewReader(tc.body))
			if tc.cookie != "" {
				r.AddCookie(&http.Cookie{Name: "bonfire_session", Value: tc.cookie})
			}
			out := httptest.NewRecorder()
			f.app.proxyBackup(out, r)
			if out.Code != tc.status || out.Header().Get("Cache-Control") != "no-store" {
				t.Errorf("%s returned %d, cache %q", tc.label, out.Code, out.Header().Get("Cache-Control"))
			}
		}
	})

	t.Run("recovery identifies a completed swap and retries its audit", func(t *testing.T) {
		// Only this newly created database is eligible for ALTER DATABASE here.
		name := "bf_recovery_test_" + strings.ReplaceAll(uuid(), "-", "")
		if _, err := frozen.Exec(ctx, "CREATE DATABASE "+dbIdent(name)); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if _, err := frozen.Exec(ctx, "DROP DATABASE "+dbIdent(name)+" WITH (FORCE)"); err != nil {
				t.Errorf("remove test database: %v", err)
			}
		}()
		databaseConfig := cfg.Copy()
		databaseConfig.Database = name
		w := backupWorker{db: databaseConfig, storageDir: t.TempDir()}
		path := filepath.Join(w.storageDir, ".swap.json")
		var oid uint32
		if err := frozen.QueryRow(ctx, "SELECT oid FROM pg_database WHERE datname=$1", name).Scan(&oid); err != nil {
			t.Fatal(err)
		}
		writeJournal := func(j swapJournal) {
			t.Helper()
			body, err := json.Marshal(j)
			if err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(path, body, 0600); err != nil {
				t.Fatal(err)
			}
		}
		writeJournal(swapJournal{Original: 1, Staged: 2, User: "exercise", FallbackDB: "old_test"})
		if err := w.recoverSwap(ctx, frozen); err == nil {
			t.Fatal("unrelated database identity accepted")
		}
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("uncertain journal lost: %v", err)
		}
		j := swapJournal{Staged: oid, User: "exercise", FallbackDB: "old_test"}
		writeJournal(j)
		if err := w.recoverSwap(ctx, frozen); !errors.Is(err, errRestoredPending) {
			t.Fatalf("missing audit did not leave a pending committed swap: %v", err)
		}
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("failed audit lost its journal: %v", err)
		}
		dest, err := w.connect(ctx, name)
		if err != nil {
			t.Fatal(err)
		}
		defer dest.Close(ctx)
		if _, err = dest.Exec(ctx, "CREATE TABLE audit(username text,action text,subject text)"); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 2; i++ {
			writeJournal(j)
			if err = w.recoverSwap(ctx, frozen); err != nil {
				t.Fatal(err)
			}
			if _, err = os.Stat(path); !os.IsNotExist(err) {
				t.Fatalf("completed journal still present: %v", err)
			}
		}
		var audits int
		if err = dest.QueryRow(ctx, "SELECT count(*) FROM audit WHERE username='exercise' AND subject='old_test'").Scan(&audits); err != nil || audits != 1 {
			t.Fatalf("recovery audit must be idempotent: %d, %v", audits, err)
		}
	})

	b := backupWorker{db: cfg}
	for _, manifest := range []backupManifest{{}, {Installation: "unrelated installation"}} {
		// A nonexistent candidate must never even be opened for a different installation.
		err := b.promote(ctx, frozen, "unselected_restore_candidate", "test", manifest)
		if err == nil || !strings.Contains(err.Error(), "installation") {
			t.Fatalf("foreign or legacy backup reached promotion: %v", err)
		}
	}
}
