package main

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"io"
	"testing"
)

func TestTemplateAttachmentProfilesAndPackageStructure(t *testing.T) {
	wordFile := func(names ...string) []byte {
		t.Helper()
		var body bytes.Buffer
		writer := zip.NewWriter(&body)
		for _, name := range names {
			part, err := writer.Create(name)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := io.WriteString(part, "<test />"); err != nil {
				t.Fatal(err)
			}
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		return body.Bytes()
	}
	validWord := wordFile("[Content_Types].xml", "word/document.xml")
	fixtures := []struct {
		name, profile string
		body          []byte
		accepted      bool
	}{
		{"Word accepted for the donation letter", "donation_letter_a4_new", validWord, true},
		{"Word rejected for the PDF form", "donation_lfk_a6", validWord, false},
		{"Unrecognized attachments rejected for standard profiles", "donation_confirmation_a4", validWord, false},
		{"Missing document part", "donation_letter_a4_new", wordFile("[Content_Types].xml"), false},
		{"Duplicate part names", "donation_letter_a4_new", wordFile("[Content_Types].xml", "word/document.xml", "word/document.xml"), false},
		{"Unknown package part", "donation_letter_a4_new", wordFile("[Content_Types].xml", "word/document.xml", "extra.xml"), false},
	}
	for _, fixture := range fixtures {
		t.Run(fixture.name, func(t *testing.T) {
			err := checkTemplateAttachment(data{Reference: fixture.profile, File: base64.StdEncoding.EncodeToString(fixture.body)})
			if (err == nil) != fixture.accepted {
				t.Fatalf("unexpected attachment validation result: %v", err)
			}
		})
	}
}
