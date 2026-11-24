package main

import (
	"bytes"
	"crypto/rand"
	"testing"
)

func TestBackupArchiveAuthentication(t *testing.T) {
	key := make([]byte, 32)
	rand.Read(key)
	input := make([]byte, frameSize+17)
	rand.Read(input)
	meta := backupManifest{Installation: "test", DataHash: "content", Originals: 2}
	var enc bytes.Buffer
	if err := sealBackup(bytes.NewReader(input), &enc, key, meta); err != nil {
		t.Fatal(err)
	}
	var plain bytes.Buffer
	m, err := unsealBackup(bytes.NewReader(enc.Bytes()), &plain, key)
	if err != nil || m != meta || !bytes.Equal(plain.Bytes(), input) {
		t.Fatal("Archiv stimmt nicht überein", err)
	}
	for _, change := range []func([]byte) []byte{
		func(b []byte) []byte { return b[:len(b)-20] },
		func(b []byte) []byte { b[70] ^= 1; return b },
		func(b []byte) []byte { return append(b, 0) },
	} {
		data := change(bytes.Clone(enc.Bytes()))
		var discarded bytes.Buffer
		if _, err = unsealBackup(bytes.NewReader(data), &discarded, key); err == nil {
			t.Fatal("Manipulation unerkannt")
		}
	}
}
