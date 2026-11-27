package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"strings"
	"testing"
)

func TestRestoreAuthorizationBindsExactArchiveIdentity(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	key := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
	expected := restoreAuthorization{Installation: uuid(), SHA256: strings.Repeat("1", 64)}
	body, err := json.Marshal(expected)
	if err != nil {
		t.Fatal(err)
	}
	signature := ed25519.Sign(private, body)
	got, err := validateRestoreAuthorization(key, body, signature)
	if err != nil || *got != expected {
		t.Fatalf("the signed archive could not be authorized: %v", err)
	}
	changed := append([]byte(nil), body...)
	changed[0] = '['
	if _, err := validateRestoreAuthorization(key, changed, signature); err == nil {
		t.Fatal("authorization accepted modified manifest bytes")
	}
}
