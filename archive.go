package main

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strings"
)

func checkArchive(d device, v data) ([]byte, []byte, error) {
	var snapshot struct {
		Profile, Subject, Date string
		Archive                struct{ Device, PDFSHA256, DOCXSHA256 string }
		Number                 int64
	}
	if json.Unmarshal([]byte(v.Note), &snapshot) != nil || snapshot.Subject != v.Reference || snapshot.Number != v.Number || snapshot.Date != v.Date {
		return nil, nil, fail("The document files do not match the recorded details at issuance.")
	}
	confirmation := snapshot.Profile == "payment_confirmation_a4" || snapshot.Profile == "donation_confirmation_a4"
	if (v.Fields["series"] == "confirmation") != confirmation {
		return nil, nil, fail("The document number series does not match the profile.")
	}
	switch snapshot.Profile {
	case "invoice_cash_a4", "invoice_transfer_a4", "payment_confirmation_a4":
	case "donation_lfk_a6", "donation_confirmation_a4":
		if !d.Donor {
			return nil, nil, problem{403, "The document profile is unavailable."}
		}
	default:
		return nil, nil, fail("Unsupported original document profile.")
	}
	pdf, err := base64.StdEncoding.DecodeString(v.PDF)
	if err != nil || !bytes.HasPrefix(pdf, []byte("%PDF-")) || !bytes.Contains(pdf, []byte("%%EOF")) {
		return nil, nil, fail("The PDF is incomplete.")
	}
	doc, err := base64.StdEncoding.DecodeString(v.DOCX)
	if err != nil {
		return nil, nil, fail("Invalid DOCX file.")
	}
	reader, err := zip.NewReader(bytes.NewReader(doc), int64(len(doc)))
	if err != nil {
		return nil, nil, fail("The DOCX file is incomplete.")
	}
	document, types := false, false
	var size uint64
	for _, f := range reader.File {
		if f.UncompressedSize64 > 16<<20 || strings.Contains(strings.ToLower(f.Name), "vbaproject") || strings.Contains(f.Name, "../") {
			return nil, nil, fail("Unsupported DOCX content.")
		}
		size += f.UncompressedSize64
		document = document || f.Name == "word/document.xml"
		types = types || f.Name == "[Content_Types].xml"
	}
	if !document || !types || size > 32<<20 {
		return nil, nil, fail("Invalid DOCX structure.")
	}
	if snapshot.Archive.Device != "" && (snapshot.Archive.Device != d.ID || snapshot.Archive.PDFSHA256 != digestHex(pdf) || snapshot.Archive.DOCXSHA256 != digestHex(doc)) {
		return nil, nil, fail("The archive signatures do not match the original files.")
	}
	return pdf, doc, nil
}
