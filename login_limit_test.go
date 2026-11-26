package main

import (
	"net/http/httptest"
	"strconv"
	"testing"
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
