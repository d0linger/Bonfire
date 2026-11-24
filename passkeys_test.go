package main

import (
	"net/http/httptest"
	"testing"

	"github.com/go-webauthn/webauthn/protocol"
)

func TestPasskeyOrigin(t *testing.T) {
	for _, tc := range []struct{ configured, canonical string }{
		{"", "http://localhost:8137"},
		{"http://localhost:8321/", "http://localhost:8321"},
		{"https://Bonfire.example:443/", "https://bonfire.example"},
		{"http://bonfire.example", ""},
		{"https://bonfire.example/app", ""},
		{"https://user@bonfire.example", ""},
		{"https://bonfire.example/?tenant=123", ""},
		{"http://127.0.0.1:8137", ""},
	} {
		t.Run(tc.configured, func(t *testing.T) {
			t.Setenv("BONFIRE_PASSKEY_ORIGIN", tc.configured)
			p, err := passkeyPolicy()
			if tc.canonical == "" {
				if err == nil {
					t.Fatal("invalid installation origin accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got := p.Config.RPOrigins; len(got) != 1 || got[0] != tc.canonical {
				t.Fatalf("origins %q, expected %s", got, tc.canonical)
			}
			if p.Config.AuthenticatorSelection.UserVerification != protocol.VerificationRequired {
				t.Fatal("user verification is required")
			}
			r := httptest.NewRequest("POST", "http://localhost/api/passkey/login/begin", nil)
			r.Header.Set("Origin", tc.canonical)
			if _, err = passkeyRequest(r); err != nil {
				t.Fatal(err)
			}
			r.Header.Set("Origin", "https://other.example")
			if _, err = passkeyRequest(r); err == nil {
				t.Fatal("unconfigured origin accepted")
			}
		})
	}
}
