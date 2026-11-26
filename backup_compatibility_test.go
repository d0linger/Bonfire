package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"io"
	"testing"
	"testing/iotest"
)

// The legacy writer authenticated its header and nonce as associated data.
// Construct the archive independently of the production restore reader.
func legacyArchive(t *testing.T, key, plain []byte) []byte {
	t.Helper()
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	nonce := make([]byte, aead.NonceSize())
	rand.Read(nonce)
	header := append([]byte("BONFIRE1"), nonce...)
	return aead.Seal(header, nonce, plain, header)
}

func TestLegacyArchiveRestoresOnlyAuthenticatedDatabaseDumps(t *testing.T) {
	key := make([]byte, 32)
	rand.Read(key)
	payload := []byte("PGDMP synthetic archived database")
	archive := legacyArchive(t, key, payload)
	wrongKey := bytes.Clone(key)
	wrongKey[0] ^= 1
	for _, tc := range []struct {
		name       string
		input, key []byte
		valid      bool
	}{
		{"complete", archive, key, true},
		{"different key", archive, wrongKey, false},
		{"incomplete nonce", archive[:14], key, false},
		{"truncated ciphertext", archive[:len(archive)-1], key, false},
		{"non-database payload", legacyArchive(t, key, []byte("unrelated document")), key, false},
		{"unrecognized format", []byte("BONFIRE0"), key, false},
		{"short header", []byte("BON"), key, false},
		{"missing v2 salt", []byte("BONFIRE2"), key, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			meta, err := unsealBackup(bytes.NewReader(tc.input), &out, tc.key)
			if tc.valid {
				if err != nil || !bytes.Equal(out.Bytes(), payload) || meta != (backupManifest{}) {
					t.Fatalf("legacy restore returned %d bytes, metadata %+v, error %v", out.Len(), meta, err)
				}
			} else if err == nil || out.Len() != 0 {
				t.Fatalf("invalid legacy archive yielded %d bytes, error %v", out.Len(), err)
			}
		})
	}
}

type failedBackupWrite struct{ error }

func (w failedBackupWrite) Write([]byte) (int, error) { return 0, w.error }

func TestBackupReportsInterruptedInputAndOutput(t *testing.T) {
	key := make([]byte, 32)
	rand.Read(key)
	meta := backupManifest{Installation: "exercise", DataHash: "expected"}
	broken := errors.New("test medium unavailable")
	var truncated bytes.Buffer
	if err := sealBackup(io.MultiReader(bytes.NewBufferString("synthetic dump"), iotest.ErrReader(broken)), &truncated, key, meta); !errors.Is(err, broken) {
		t.Fatalf("input failure: %v", err)
	}
	if _, err := unsealBackup(&truncated, io.Discard, key); err == nil {
		t.Fatal("an interrupted stream appeared complete")
	}
	if err := sealBackup(bytes.NewReader(nil), failedBackupWrite{broken}, key, meta); !errors.Is(err, broken) {
		t.Fatalf("archive write: %v", err)
	}
	var archive bytes.Buffer
	if err := sealBackup(bytes.NewBufferString("synthetic dump"), &archive, key, meta); err != nil {
		t.Fatal(err)
	}
	if _, err := unsealBackup(&archive, failedBackupWrite{broken}, key); !errors.Is(err, broken) {
		t.Fatalf("restore write: %v", err)
	}
	archive.Reset()
	if err := sealBackup(bytes.NewReader(nil), &archive, key, backupManifest{}); err != nil {
		t.Fatal(err)
	}
	if _, err := unsealBackup(&archive, io.Discard, key); err == nil {
		t.Fatal("missing installation and digest accepted")
	}
}
