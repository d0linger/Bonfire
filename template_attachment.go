package main

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/xml"
	"io"
	"regexp"
	"strings"
)

var approvedWordPart = regexp.MustCompile(`(?i)^(\[Content_Types\]\.xml|_rels/\.rels|docProps/(app|core|custom)\.xml|word/(document|footnotes|endnotes|styles|settings|webSettings|fontTable|numbering|header[0-9]+|footer[0-9]+)\.xml|word/theme/theme[0-9]+\.xml|word/_rels/(document|header[0-9]+|footer[0-9]+|footnotes|endnotes|fontTable|settings|numbering)\.xml\.rels|word/media/[\w.-]+\.(png|jpe?g))$`)
var unsafeRelationshipTarget = regexp.MustCompile(`(?i)^[a-z]+:|^//|\\|(^|/)\.\.(/|$)`)

func checkTemplateAttachment(v data) error {
	if v.File == "" {
		return nil
	}
	if len(v.File) > 4<<20 {
		return fail("The template exceeds the upload limit.")
	}
	body, err := base64.StdEncoding.DecodeString(v.File)
	if err != nil {
		return fail("The template cannot be decoded.")
	}
	switch v.Reference {
	case "donation_lfk_a6":
		if len(body) <= 3<<20 && bytes.HasPrefix(body, []byte("%PDF-")) && bytes.HasSuffix(bytes.TrimSpace(body), []byte("%%EOF")) {
			return nil
		}
	case "donation_letter_a4_new":
		if len(body) <= 2<<20 && approvedWordLayout(body) {
			return nil
		}
	}
	return fail("This profile does not accept this template file.")
}

func approvedWordLayout(body []byte) bool {
	reader, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil || len(reader.File) > 256 {
		return false
	}
	var total uint64
	seen := make(map[string]bool)
	for _, part := range reader.File {
		if part.FileInfo().IsDir() {
			continue
		}
		name := strings.ToLower(part.Name)
		if !approvedWordPart.MatchString(part.Name) || seen[name] ||
			part.UncompressedSize64 > 8<<20 || total+part.UncompressedSize64 > 20<<20 {
			return false
		}
		total += part.UncompressedSize64
		seen[name] = true
		if strings.HasSuffix(name, ".rels") || strings.HasSuffix(name, ".xml") {
			file, err := part.Open()
			if err != nil {
				return false
			}
			valid := safeTemplateXML(xml.NewDecoder(io.LimitReader(file, int64(part.UncompressedSize64)+1)))
			if err := file.Close(); !valid || err != nil {
				return false
			}
		}
	}
	return seen["[content_types].xml"] && seen["word/document.xml"]
}

func safeTemplateXML(decoder *xml.Decoder) bool {
	for {
		token, err := decoder.Token()
		if err != nil {
			return err == io.EOF
		}
		switch value := token.(type) {
		case xml.Directive:
			return false
		case xml.StartElement:
			if value.Name.Local != "Relationship" {
				continue
			}
			for _, attribute := range value.Attr {
				if (attribute.Name.Local == "TargetMode" && strings.EqualFold(attribute.Value, "external")) ||
					(attribute.Name.Local == "Target" && unsafeRelationshipTarget.MatchString(attribute.Value)) {
					return false
				}
			}
		}
	}
}
