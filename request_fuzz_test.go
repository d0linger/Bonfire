package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func FuzzPostingDate(f *testing.F) {
	for _, day := range []string{"2024-02-29", "2025-02-29", "2026-03-29", "2026-10-25", "0000-01-01", "2026-12-31"} {
		f.Add(day)
	}
	f.Fuzz(func(t *testing.T, value string) {
		if !date(value) {
			return
		}
		parsed, err := time.Parse(time.DateOnly, value)
		if err != nil || parsed.Year() < 1 || parsed.Format(time.DateOnly) != value {
			t.Fatal("accepted noncanonical posting date")
		}
	})
}

func FuzzOnlineRequest(f *testing.F) {
	f.Add(`{"Ops":[]}`)
	f.Add(`{"Ops":[{"Kind":"income","Data":{"Date":"2026-07-02","Label":"Fixture","Amount":125}}]}`)
	f.Add(`{"Ops":[]} {}`)
	f.Fuzz(func(t *testing.T, payload string) {
		if len(payload) > 8192 {
			return
		}
		r := httptest.NewRequest("POST", "/api/online", strings.NewReader(payload))
		var req request
		if read(r, &req) != nil {
			return
		}
		if !json.Valid([]byte(payload)) {
			t.Fatal("accepted invalid JSON")
		}
		for _, op := range req.Ops {
			if err := validate(op, false); err == nil && (!date(op.Data.Date) || op.Seq < 1) {
				t.Fatal("invalid accepted operation")
			}
		}
	})
}

func TestOnlineFailureMetric(t *testing.T) {
	for _, tc := range []struct {
		method, path string
		code         int
		increment    uint64
	}{
		{"POST", "/api/online", 500, 1}, {"POST", "/api/online", 503, 1},
		{"POST", "/api/online", 409, 0}, {"POST", "/api/online", 401, 0},
		{"POST", "/api/sync", 500, 0}, {"GET", "/api/online", 500, 0},
	} {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		before := onlineSaveErrors.Load()
		route(func(context.Context, http.ResponseWriter, *http.Request) (any, error) {
			return nil, problem{tc.code, "fixture"}
		})(httptest.NewRecorder(), req)
		if got := onlineSaveErrors.Load() - before; got != tc.increment {
			t.Errorf("%s %s %d: increment %d", tc.method, tc.path, tc.code, got)
		}
	}
}
