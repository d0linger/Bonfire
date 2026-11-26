package main

import (
	"strings"
	"testing"
)

func TestAttachmentMetadataMatchesLegacyEncoding(t *testing.T) {
	digest := digestHex([]byte("%PDF-example"))
	fields := map[string]string{"size": "12", "sha256": digest}
	if !attachmentMetadataMatches("0012", strings.ToUpper(digest), fields) {
		t.Fatal("equivalent legacy metadata rejected")
	}
	for _, test := range []struct{ size, digest string }{{"11", digest}, {"bad", digest}, {"12", "invalid"}, {"12", strings.Repeat("0", 64)}} {
		if attachmentMetadataMatches(test.size, test.digest, fields) {
			t.Fatal("incorrect metadata accepted")
		}
	}
}
