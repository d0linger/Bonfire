package main

import (
	"bytes"
	"path/filepath"
	"testing"
)

func TestTOTPStorageSeparatesAccountsAndPurposes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "totp-key")
	store, err := loadTOTPStorage(path, true)
	if err != nil {
		t.Fatal(err)
	}
	const seed = "SYNTHETIC-SAMPLE"
	saved, err := store.seal("cashier", "active", seed)
	if err != nil || bytes.Contains([]byte(saved), []byte(seed)) {
		t.Fatalf("could not seal seed: %v", err)
	}
	again, err := store.seal("cashier", "active", seed)
	if err != nil || again == saved {
		t.Fatalf("could not seal the same seed with a fresh nonce: %v", err)
	}
	reopened, err := loadTOTPStorage(path, false)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := reopened.open("cashier", "active", saved); got != seed || err != nil {
		t.Fatalf("could not read saved seed: %v", err)
	}
	for _, item := range []struct{ User, Purpose string }{{"different", "active"}, {"cashier", "enroll:session"}} {
		if _, err := reopened.open(item.User, item.Purpose, saved); err == nil {
			t.Fatal("the stored seed crossed its account or purpose boundary")
		}
	}
}

func TestTOTPDatabaseMigrationPreservesExistingEnrollment(t *testing.T) {
	fixture := newTxFixture(t)
	ctx := t.Context()
	const seed = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"
	var previous *string
	if err := fixture.owner.QueryRow(ctx, "SELECT otp_secret FROM users WHERE name='leitung'").Scan(&previous); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := fixture.owner.Exec(ctx, "UPDATE users SET otp_secret=$1 WHERE name='leitung'", previous); err != nil {
			t.Error(err)
		}
	}()
	if _, err := fixture.owner.Exec(ctx, "UPDATE users SET otp_secret=$1 WHERE name='leitung'", seed); err != nil {
		t.Fatal(err)
	}
	if err := fixture.app.totp.verifyDatabase(ctx, fixture.owner, true); err != nil {
		t.Fatal(err)
	}
	got := fixture.value("SELECT otp_secret FROM users WHERE name='leitung'")
	if got == seed {
		t.Fatal("seed was not encrypted")
	}
	if opened, err := fixture.app.totp.open("leitung", "active", got); err != nil || opened != seed {
		t.Fatalf("legacy authenticator changed during migration: %v", err)
	}
}
