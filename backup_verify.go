package main

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
)

type restoreAuthorization struct {
	Installation string `json:"installation"`
	SHA256       string `json:"sha256"`
}

func validateRestoreAuthorization(publicPEM, body, signature []byte) (*restoreAuthorization, error) {
	block, _ := pem.Decode(publicPEM)
	if block == nil || block.Type != "PUBLIC KEY" {
		return nil, errors.New("Invalid restore authorization public key")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	public, ok := parsed.(ed25519.PublicKey)
	if !ok || !ed25519.Verify(public, body, signature) {
		return nil, errors.New("Invalid restore authorization signature")
	}
	var a restoreAuthorization
	if err := json.Unmarshal(body, &a); err != nil {
		return nil, err
	}
	digest, err := hex.DecodeString(a.SHA256)
	if err != nil || !idPattern.MatchString(a.Installation) || len(digest) != 32 || hex.EncodeToString(digest) != a.SHA256 {
		return nil, errors.New("Invalid installation ID or archive digest")
	}
	return &a, nil
}

func runBackupVerification() error {
	cfg, err := pgx.ParseConfig(os.Getenv("DATABASE_URL"))
	if err != nil || cfg.Host != "recovery-db" || cfg.Database != "bonfire_rehearsal" {
		return errors.New("Use the dedicated recovery Compose project")
	}
	form, err := os.ReadFile("/input/authorization.json")
	if err != nil {
		return err
	}
	pub, err := os.ReadFile("/input/operator-public.pem")
	if err != nil {
		return err
	}
	signature, err := os.ReadFile("/input/authorization.sig")
	if err != nil {
		return err
	}
	authorization, err := validateRestoreAuthorization(pub, form, signature)
	if err != nil {
		return err
	}
	key, err := os.ReadFile("/input/archive.key")
	if err != nil || len(key) != 32 {
		return errors.New("The archive recovery key is unavailable")
	}
	archive, err := os.Open("/input/archive.dump.enc")
	if err != nil {
		return err
	}
	defer archive.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Hour)
	defer cancel()
	worker := &backupWorker{db: cfg, key: key}
	db, manifest, digest, err := worker.stageArchive(ctx, archive, authorization)
	if err != nil {
		return err
	}
	fmt.Printf("Verified archive %s in disposable database %s (%d fiscal years, %d entries, %d originals).\n",
		digest, db, manifest.Years, manifest.Entries, manifest.Originals)
	return nil
}
