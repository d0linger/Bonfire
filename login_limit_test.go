package main

import (
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func TestPasswordAttemptsIsolateSources(t *testing.T) {
	a := &app{attempts: map[string]int{}}
	r := httptest.NewRequest("POST", "/api/login", nil)
	for i := 1; i <= 3; i++ {
		r.RemoteAddr = "192.0.2." + strconv.Itoa(i) + ":123"
		for range 12 {
			if !a.reservePasswordAttempt(r, "cashier") {
				t.Fatal("unexpected early limit")
			}
		}
		if a.reservePasswordAttempt(r, "cashier") {
			t.Fatal("exhausted pair accepted")
		}
	}
	r.RemoteAddr = "192.0.2.9:321"
	if !a.reservePasswordAttempt(r, "cashier") || !a.reservePasswordAttempt(r, "cashier") || a.reservePasswordAttempt(r, "cashier") {
		t.Fatal("fresh source must retain a limited sign-in path")
	}
	a.clearPasswordAttempts(r, "cashier")
	if !a.reservePasswordAttempt(r, "cashier") {
		t.Fatal("successful source remained blocked")
	}
	r.RemoteAddr = "192.0.2.20:123"
	for i := range 60 {
		if !a.reservePasswordAttempt(r, strconv.Itoa(i)) {
			t.Fatal("unexpected source limit")
		}
	}
	if a.reservePasswordAttempt(r, "another") {
		t.Fatal("source limit bypassed across accounts")
	}
}

func TestPasswordAttemptsRetainAdmissionAtCapacity(t *testing.T) {
	a := &app{attempts: map[string]int{}, reset: time.Now().Add(time.Minute)}
	windows := []*attemptWindow{&a.passwordAttempts.pairs, &a.passwordAttempts.sources, &a.passwordAttempts.accounts}
	for i := range loginWindowCapacity {
		for _, window := range windows {
			window.add("existing:"+strconv.Itoa(i), 60)
		}
	}
	r := httptest.NewRequest("POST", "/api/login", nil)
	for range 12 {
		if !a.reservePasswordAttempt(r, "cashier") {
			t.Fatal("new pair blocked by unrelated counters")
		}
	}
	if a.reservePasswordAttempt(r, "cashier") {
		t.Fatal("overflow pair limit not enforced")
	}
	r.RemoteAddr = "192.0.2.251:10000"
	if !a.reservePasswordAttempt(r, "cashier") {
		t.Fatal("fresh source rejected")
	}
	a.clearPasswordAttempts(r, "cashier")
	for _, window := range windows {
		if len(window.entries) > loginWindowCapacity {
			t.Fatal("unbounded counters")
		}
	}
}
