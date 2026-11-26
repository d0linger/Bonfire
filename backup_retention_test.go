package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// Exercise the observable S3 requests using the same client as the worker.
func TestRemoteBackupSelectionAndRetention(t *testing.T) {
	const prefix = "fire/archives/"
	const first = "bonfire-20260101T000000Z-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.dump.enc"
	const newest = "bonfire-20260103T000000Z-cccccccccccccccccccccccccccccccc.dump.enc"
	const middle = "bonfire-20260102T000000Z-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.dump.enc"
	const other = "bonfire-ledger.csv"
	base := time.Now().UTC().AddDate(0, 0, -30)
	times := map[string]time.Time{first: base, newest: base.Add(2 * time.Hour), middle: base.Add(time.Hour), other: base}
	const content = "sample-encrypted-file"
	var mu sync.Mutex
	var removed []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/practice" || r.URL.Path == "/practice/":
			if r.Method != "GET" || r.URL.Query().Get("prefix") != prefix+"bonfire-" {
				http.Error(w, "unexpected listing", 400)
				return
			}
			w.Header().Set("Content-Type", "application/xml")
			fmt.Fprint(w, "<ListBucketResult><Name>practice</Name><IsTruncated>false</IsTruncated>")
			// Most recent appears in the middle of the response.
			for _, key := range []string{first, newest, middle, other} {
				fmt.Fprintf(w, "<Contents><Key>%s%s</Key><LastModified>%s</LastModified><ETag>&quot;0123456789abcdef0123456789abcdef&quot;</ETag><Size>%d</Size><StorageClass>STANDARD</StorageClass></Contents>", prefix, key, times[key].Format(time.RFC3339Nano), len(content))
			}
			fmt.Fprint(w, "</ListBucketResult>")
		case strings.HasPrefix(r.URL.Path, "/practice/"+prefix):
			name := strings.TrimPrefix(r.URL.Path, "/practice/"+prefix)
			if _, ok := times[name]; !ok {
				http.NotFound(w, r)
				return
			}
			switch r.Method {
			case "DELETE":
				mu.Lock()
				removed = append(removed, name)
				mu.Unlock()
				w.WriteHeader(http.StatusNoContent)
			case "HEAD", "GET":
				w.Header().Set("Content-Length", fmt.Sprint(len(content)))
				w.Header().Set("Last-Modified", times[name].UTC().Format(http.TimeFormat))
				w.Header().Set("ETag", "0123456789abcdef0123456789abcdef")
				if r.Method == "GET" {
					fmt.Fprint(w, content)
				}
			default:
				http.Error(w, "unexpected operation", 405)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	for k, v := range map[string]string{"ENDPOINT": strings.TrimPrefix(server.URL, "http://"), "BUCKET": "practice", "ACCESS_KEY": "test-key", "SECRET_KEY": "test-secret", "PREFIX": "/" + prefix, "USE_HTTP": "true", "REGION": "us-east-1"} {
		t.Setenv("BONFIRE_S3_"+k, v)
	}
	client, bucket, keyPrefix, err := newS3()
	if err != nil {
		t.Fatal(err)
	}
	b := backupWorker{s3: client, bucket: bucket, prefix: keyPrefix}
	files, err := b.listFiles(t.Context(), "s3")
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(files))
	for _, file := range files {
		names = append(names, file.Name)
		if file.Target != "s3" || file.Bytes != int64(len(content)) {
			t.Fatalf("wrong archive metadata: %+v", file)
		}
	}
	if !slices.Equal(names, []string{newest, middle, first}) {
		t.Fatalf("listed %v", names)
	}
	file, err := b.openArchive(t.Context(), "s3", middle)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(file)
	closeErr := file.Close()
	if err != nil || closeErr != nil || string(body) != content {
		t.Fatalf("download %q: %v, %v", body, err, closeErr)
	}
	if err = b.prune(t.Context(), "s3", 7); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	slices.Sort(removed)
	if !slices.Equal(removed, []string{first, middle}) {
		t.Fatalf("removed %v; most recent backup and unrelated objects must survive", removed)
	}
}

func TestBackupCommandsRejectUnverifiedOperations(t *testing.T) {
	b := backupWorker{service: t.Context()}
	const name = "bonfire-20260101T000000Z-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.dump.enc"
	commands := []backupCommand{
		{Action: "schedule", Target: "local", Days: -1},
		{Action: "schedule", Target: "local", Cron: "60 * * * *"},
		{Action: "schedule", Target: "s3", Cron: "30 12 * * *"},
		{Action: "backup", Target: "unknown"},
		{Action: "test", Target: "local"},
		{Action: "probe", Target: "local", Name: "unselected"},
		{Action: "promote", Target: "local", Name: name, Confirmation: "RESTORE"},
		{Action: "backup", Target: "s3"},
		{Action: "unknown"},
	}
	for _, command := range commands {
		raw, err := json.Marshal(command)
		if err != nil {
			t.Fatal(err)
		}
		out := httptest.NewRecorder()
		b.command(out, httptest.NewRequest("POST", "/command", strings.NewReader(string(raw))))
		if out.Code != http.StatusUnprocessableEntity || b.active || len(b.state.Recent) != 0 || len(b.state.Schedules) != 0 {
			t.Errorf("unexpected state for %+v: %d", command, out.Code)
		}
	}
	b.state.Probe = &backupReceipt{At: time.Now().Add(-2 * time.Hour), Name: name, Target: "local", Manifest: backupManifest{Installation: "test"}}
	if err := b.start(backupCommand{Action: "promote", Name: name, Target: "local", Confirmation: "RESTORE"}, "test"); err == nil {
		t.Fatal("expired probe permitted restore")
	}
	b.active = true
	if err := b.start(backupCommand{Action: "backup", Target: "local"}, "test"); err == nil {
		t.Fatal("concurrent job accepted")
	}
}
