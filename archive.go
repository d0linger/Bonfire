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
		return nil, nil, fail("Belegdateien und Ausgabestand passen nicht zusammen.")
	}
	switch snapshot.Profile {
	case "invoice_cash_a4", "invoice_transfer_a4":
	case "donation_lfk_a6":
		if !d.Donor {
			return nil, nil, problem{403, "Belegprofil fehlt."}
		}
	default:
		return nil, nil, fail("Unzulässiges Originalprofil.")
	}
	pdf, err := base64.StdEncoding.DecodeString(v.PDF)
	if err != nil || !bytes.HasPrefix(pdf, []byte("%PDF-")) || !bytes.Contains(pdf, []byte("%%EOF")) {
		return nil, nil, fail("PDF unvollständig.")
	}
	doc, err := base64.StdEncoding.DecodeString(v.DOCX)
	if err != nil {
		return nil, nil, fail("DOCX fehlerhaft.")
	}
	reader, err := zip.NewReader(bytes.NewReader(doc), int64(len(doc)))
	if err != nil {
		return nil, nil, fail("DOCX unvollständig.")
	}
	document, types := false, false
	var size uint64
	for _, f := range reader.File {
		if f.UncompressedSize64 > 16<<20 || strings.Contains(strings.ToLower(f.Name), "vbaproject") || strings.Contains(f.Name, "../") {
			return nil, nil, fail("Unzulässiger DOCX-Inhalt.")
		}
		size += f.UncompressedSize64
		document = document || f.Name == "word/document.xml"
		types = types || f.Name == "[Content_Types].xml"
	}
	if !document || !types || size > 32<<20 {
		return nil, nil, fail("DOCX-Struktur ungültig.")
	}
	if snapshot.Archive.Device != "" && (snapshot.Archive.Device != d.ID || snapshot.Archive.PDFSHA256 != digestHex(pdf) || snapshot.Archive.DOCXSHA256 != digestHex(doc)) {
		return nil, nil, fail("Archivsignaturen stimmen nicht mit den Originaldateien überein.")
	}
	return pdf, doc, nil
}
