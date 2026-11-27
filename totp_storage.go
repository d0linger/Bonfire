package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const totpEnvelope = "v1:"

type totpStorage struct{ cipher.AEAD }

func newTOTPStorage(key []byte) (totpStorage, error) {
	if len(key) != 32 {
		return totpStorage{}, errors.New("TOTP storage requires a 32-byte key")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return totpStorage{}, err
	}
	box, err := cipher.NewGCMWithRandomNonce(block)
	return totpStorage{box}, err
}

func loadTOTPStorage(path string, create bool) (totpStorage, error) {
	if path == "" {
		return totpStorage{}, errors.New("Configure BONFIRE_TOTP_KEY_FILE")
	}
	key, err := os.ReadFile(path) // #nosec G304 G703 -- Only the process operator selects the mounted key path.
	if !create || !errors.Is(err, os.ErrNotExist) {
		if err != nil {
			return totpStorage{}, err
		}
		return newTOTPStorage(key)
	}
	key = make([]byte, 32)
	rand.Read(key)
	temp, err := os.CreateTemp(filepath.Dir(path), ".totp-key-")
	if err != nil {
		return totpStorage{}, err
	}
	defer os.Remove(temp.Name())
	_, writeErr := temp.Write(key)
	err = errors.Join(writeErr, temp.Sync(), temp.Close())
	if err != nil {
		return totpStorage{}, err
	}
	if err = os.Link(temp.Name(), path); err != nil {
		if errors.Is(err, os.ErrExist) {
			return loadTOTPStorage(path, false)
		}
		return totpStorage{}, err
	}
	return newTOTPStorage(key)
}

func totpContext(user, use string) []byte {
	return []byte("BONFIRE TOTP v1\x00" + use + "\x00" + user)
}

func (s totpStorage) seal(user, use, seed string) (string, error) {
	if s.AEAD == nil {
		return "", errors.New("TOTP storage is unavailable")
	}
	data := s.Seal(nil, nil, []byte(seed), totpContext(user, use)) // #nosec G407 -- NewGCMWithRandomNonce creates and prepends the nonce and requires this argument to be empty.
	return totpEnvelope + base64.RawStdEncoding.EncodeToString(data), nil
}

func (s totpStorage) open(user, use, stored string) (string, error) {
	payload, valid := strings.CutPrefix(stored, totpEnvelope)
	if !valid || s.AEAD == nil {
		return "", errors.New("TOTP storage is unavailable or requires migration")
	}
	data, err := base64.RawStdEncoding.DecodeString(payload)
	if err != nil {
		return "", errors.New("Invalid TOTP storage envelope")
	}
	seed, err := s.Open(nil, nil, data, totpContext(user, use))
	if err != nil {
		return "", errors.New("The TOTP storage key cannot decrypt this installation")
	}
	return string(seed), nil
}

func (s totpStorage) verifyDatabase(ctx context.Context, db *pgxpool.Pool, migrate bool) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if migrate {
		if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(751024)"); err != nil {
			return err
		}
	}
	rows, err := tx.Query(ctx, "SELECT name,otp_secret FROM users WHERE otp_secret IS NOT NULL")
	if err != nil {
		return err
	}
	type accountSeed struct{ User, Stored string }
	seeds, err := pgx.CollectRows(rows, pgx.RowToStructByPos[accountSeed])
	if err != nil {
		return err
	}
	for _, seed := range seeds {
		if !migrate || strings.HasPrefix(seed.Stored, totpEnvelope) {
			if _, err := s.open(seed.User, "active", seed.Stored); err != nil {
				return err
			}
			continue
		}
		sealed, err := s.seal(seed.User, "active", seed.Stored)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "UPDATE users SET otp_secret=$1 WHERE name=$2 AND otp_secret=$3", sealed, seed.User, seed.Stored); err != nil {
			return err
		}
	}
	if migrate {
		if _, err := tx.Exec(ctx, "DELETE FROM mfa_enrollments WHERE left(secret,3)<>'v1:'"); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
