package main

import (
	"encoding/json"
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
