package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLocalBackupRetentionAndRecoveryCandidates(t *testing.T) {
	b := backupWorker{storageDir: t.TempDir()}
	first := "bonfire-20260101T000000Z-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.dump.enc"
	second := "bonfire-20260102T000000Z-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.dump.enc"
	subdir := "bonfire-20260103T000000Z-cccccccccccccccccccccccccccccccc.dump.enc"
	base := time.Now().UTC().AddDate(0, 0, -30)
	for i, name := range []string{first, second, "other-file"} {
		path := filepath.Join(b.storageDir, name)
		if err := os.WriteFile(path, []byte("unfinished encrypted archive"), 0600); err != nil {
			t.Fatal(err)
		}
		at := base.Add(time.Duration(i) * time.Hour)
		if err := os.Chtimes(path, at, at); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(b.storageDir, subdir), 0700); err != nil {
		t.Fatal(err)
	}
	if err := b.prune(t.Context(), "local", 0); err != nil {
		t.Fatal(err)
	}
	files, err := b.listFiles(t.Context(), "local")
	if err != nil || len(files) != 2 || files[0].Name != second || files[1].Name != first {
		t.Fatalf("zero retention, newest first: %+v, %v", files, err)
	}
	if err = b.prune(t.Context(), "local", 1); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(b.storageDir, first)); !os.IsNotExist(err) {
		t.Fatalf("expired archive: %v", err)
	}
	for _, name := range []string{second, "other-file", subdir} {
		if _, err = os.Stat(filepath.Join(b.storageDir, name)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = b.openArchive(t.Context(), "local", subdir); err == nil {
		t.Fatal("backup directory accepted as file")
	}
	if _, err = b.openArchive(t.Context(), "upload", second); err == nil {
		t.Fatal("local archive accepted as an uploaded candidate")
	}
	if err = os.Mkdir(filepath.Join(b.storageDir, "uploads"), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(b.storageDir, "uploads", second), []byte("uploaded candidate"), 0600); err != nil {
		t.Fatal(err)
	}
	candidate, err := b.openArchive(t.Context(), "upload", second)
	if err != nil {
		t.Fatal(err)
	}
	content, err := io.ReadAll(candidate)
	if closeErr := candidate.Close(); closeErr != nil {
		t.Fatal(closeErr)
	}
	if err != nil || string(content) != "uploaded candidate" {
		t.Fatalf("wrong source: %q, %v", content, err)
	}
	name, _, fingerprint, err := b.stage(t.Context(), "local", second)
	if err == nil || name != "" || fingerprint != "" {
		t.Fatalf("invalid archive staged as %q, %q, error %v", name, fingerprint, err)
	}
	jobs, err := filepath.Glob(filepath.Join(b.storageDir, ".job-*"))
	if err != nil || len(jobs) != 0 {
		t.Fatalf("temporary candidate leaked: %v, %v", jobs, err)
	}
}

func TestBackupStateWriteKeepsLastValidRecord(t *testing.T) {
	dir := t.TempDir()
	b := &backupWorker{storageDir: dir}
	path := filepath.Join(dir, "state.json")
	if err := b.saveBackupJSON("unrelated.json", true); err == nil {
		t.Fatal("accepted an unrelated backup state filename")
	}
	if err := b.saveBackupJSON("state.json", map[string]string{"receipt": "checked"}); err != nil && !errors.Is(err, errBackupStatePublished) {
		t.Fatal(err)
	}
	// Encoding may fail after the staging file exists. The published receipt is immutable until replacement.
	if err := b.saveBackupJSON("state.json", make(chan int)); err == nil || errors.Is(err, errBackupStatePublished) {
		t.Fatalf("invalid value published, error %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var data map[string]string
	if err = json.Unmarshal(raw, &data); err != nil || data["receipt"] != "checked" {
		t.Fatalf("last receipt lost: %s, %v", raw, err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 || entries[0].Name() != "state.json" {
		t.Fatalf("temporary state left behind: %v, %v", entries, err)
	}
}

func TestBackupUploadRefusesAnOccupiedSlotOrInvalidBody(t *testing.T) {
	b := backupWorker{storageDir: t.TempDir()}
	b.uploadSlot.Lock()
	busy := httptest.NewRecorder()
	b.upload(busy, httptest.NewRequest("POST", "/upload", bytes.NewBufferString("synthetic candidate")))
	b.uploadSlot.Unlock()
	if busy.Code != http.StatusConflict {
		t.Fatalf("busy upload returned %d", busy.Code)
	}
	server := httptest.NewServer(http.HandlerFunc(b.upload))
	defer server.Close()
	send := func(size int) int {
		t.Helper()
		response, err := server.Client().Post(server.URL, "application/octet-stream", bytes.NewReader(make([]byte, size)))
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if _, err = io.Copy(io.Discard, response.Body); err != nil {
			t.Fatal(err)
		}
		return response.StatusCode
	}
	if code := send(12); code != http.StatusUnprocessableEntity {
		t.Fatalf("short upload returned %d", code)
	}
	b.mu.Lock()
	b.active = true
	b.mu.Unlock()
	if code := send(50); code != http.StatusConflict {
		t.Fatalf("active job allowed upload: %d", code)
	}
	entries, err := os.ReadDir(filepath.Join(b.storageDir, "uploads"))
	if err != nil || len(entries) != 0 {
		t.Fatalf("failed uploads retained %v, %v", entries, err)
	}
}

func TestScheduledBackupRetriesFromTheLastAttempt(t *testing.T) {
	at := time.Date(2026, 1, 4, 12, 15, 0, 0, time.Local)
	last := at.Add(11 * time.Minute)
	priorSuccess := at.Add(-time.Hour)
	b := backupWorker{state: backupState{
		Schedules: map[string]backupSchedule{"local": {Cron: "*/10 * * * *", Since: at}, "s3": {Cron: "* * * * *", Since: at}},
		Last:      map[string]backupHealth{"local": {LastAttempt: &last, LastSuccess: &priorSuccess, Outcome: "failed"}},
	}}
	h := b.health("local", last)
	if !h.Enabled || h.Due || h.Next == nil || !h.Next.Equal(time.Date(2026, 1, 4, 12, 30, 0, 0, time.Local)) {
		t.Fatalf("did not reschedule from failed attempt: %+v", h)
	}
	if !b.health("local", *h.Next).Due || b.health("s3", last.Add(time.Hour)).Enabled {
		t.Fatal("incorrect due or enabled state")
	}
}
