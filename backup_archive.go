package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
)

const backupMagic = "BONFIRE2"
const archiveLimit int64 = 16 << 30
const frameSize = 256 << 10

type backupManifest struct {
	Installation                          string
	Created                               string
	Years, Workspaces, Entries, Originals int64
	DataHash                              string
}

// Derive a fresh key per archive; the position is an authenticated nonce within it.
// The final authenticated empty frame detects truncation at a frame boundary.
func backupCipher(key, salt []byte) (cipher.AEAD, error) {
	k, err := hkdf.Key(sha256.New, key, salt, "BONFIRE encrypted database v2", 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(k)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func sealBackup(src io.Reader, dst io.Writer, key []byte, m backupManifest) error {
	salt := make([]byte, 32)
	if _, err := rand.Read(salt); err != nil {
		return err
	}
	header := append([]byte(backupMagic), salt...)
	if _, err := dst.Write(header); err != nil {
		return err
	}
	aead, err := backupCipher(key, salt)
	if err != nil {
		return err
	}
	var nonce [12]byte
	var idx uint64
	put := func(data []byte) error {
		binary.BigEndian.PutUint64(nonce[4:], idx)
		idx++
		ct := aead.Seal(nil, nonce[:], data, header)
		size := len(ct)
		if size > frameSize+16 {
			return errors.New("encrypted frame exceeds its supported size")
		}
		var sz [4]byte
		binary.BigEndian.PutUint32(sz[:], uint32(size))
		if _, err := dst.Write(sz[:]); err != nil {
			return err
		}
		_, err := dst.Write(ct)
		return err
	}
	meta, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if err = put(meta); err != nil {
		return err
	}
	buf := make([]byte, frameSize)
	var total int64
	for {
		n, err := src.Read(buf)
		total += int64(n)
		if total > archiveLimit {
			return errors.New("The archive exceeds the storage limit.")
		}
		if n > 0 {
			if werr := put(buf[:n]); werr != nil {
				return werr
			}
		}
		if err == io.EOF {
			return put(nil)
		}
		if err != nil {
			return err
		}
	}
}

func unsealBackup(src io.Reader, dst io.Writer, key []byte) (backupManifest, error) {
	var m backupManifest
	head := make([]byte, 8)
	invalid := errors.New("The backup is incomplete, unreadable or encrypted with another key.")
	if _, err := io.ReadFull(src, head); err != nil {
		return m, invalid
	}
	if string(head) == "BONFIRE1" {
		// PowerShell's original one-shot GCM format needs bounded memory for authentication.
		nonce := make([]byte, 12)
		if _, err := io.ReadFull(src, nonce); err != nil {
			return m, invalid
		}
		const oldLimit = 128 << 20
		raw, err := io.ReadAll(io.LimitReader(src, oldLimit+1))
		if err != nil || len(raw) > oldLimit {
			return m, errors.New("Legacy archive unreadable or larger than 128 MiB. Use the external restore procedure.")
		}
		block, err := aes.NewCipher(key)
		if err != nil {
			return m, err
		}
		g, err := cipher.NewGCM(block)
		if err != nil {
			return m, err
		}
		plain, err := g.Open(raw[:0], nonce, raw, append(head, nonce...))
		if err != nil {
			return m, invalid
		}
		if !bytes.HasPrefix(plain, []byte("PGDMP")) {
			return m, invalid
		}
		_, err = dst.Write(plain)
		return m, err
	}
	if string(head) != backupMagic {
		return m, invalid
	}
	salt := make([]byte, 32)
	if _, err := io.ReadFull(src, salt); err != nil {
		return m, invalid
	}
	header := append(head, salt...)
	aead, err := backupCipher(key, salt)
	if err != nil {
		return m, err
	}
	var nonce [12]byte
	var total int64
	for idx := uint64(0); ; idx++ {
		var sz [4]byte
		if _, err = io.ReadFull(src, sz[:]); err != nil {
			return m, invalid
		}
		n := binary.BigEndian.Uint32(sz[:])
		if n < 16 || n > frameSize+16 {
			return m, invalid
		}
		ct := make([]byte, n)
		if _, err = io.ReadFull(src, ct); err != nil {
			return m, invalid
		}
		binary.BigEndian.PutUint64(nonce[4:], idx)
		plain, err := aead.Open(ct[:0], nonce[:], ct, header)
		if err != nil {
			return m, invalid
		}
		if idx == 0 {
			if json.Unmarshal(plain, &m) != nil || m.Installation == "" || m.DataHash == "" {
				return m, invalid
			}
			continue
		}
		if len(plain) == 0 {
			var one [1]byte
			_, err := io.ReadFull(src, one[:])
			if err != io.EOF {
				return m, invalid
			}
			return m, nil
		}
		total += int64(len(plain))
		if total > archiveLimit {
			return m, invalid
		}
		if _, err = dst.Write(plain); err != nil {
			return m, err
		}
	}
}

var errBackupStatePublished = errors.New("backup state renamed but directory sync failed")

func saveBackupJSON(path string, v any) error {
	parent := filepath.Dir(path)
	f, err := os.CreateTemp(parent, ".state-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = json.NewEncoder(f).Encode(v); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return err
	}
	dir, err := os.Open(parent)
	if err != nil {
		return errors.Join(errBackupStatePublished, err)
	}
	defer dir.Close()
	if err = dir.Sync(); err != nil {
		return errors.Join(errBackupStatePublished, err)
	}
	return nil
}
