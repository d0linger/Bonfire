package main

import (
	"encoding/json"
	"strings"
)

func projectData(v *data, kind string, d device) {
	if kind == "import-source" && d.Role != roleAdmin {
		v.File = ""
		v.Filename = ""
	}
	if d.Donor {
		return
	}
	if kind == "contact" {
		delete(v.Fields, "birth")
	}
	if kind != "original" {
		return
	}
	var snapshot struct{ Profile string }
	if json.Unmarshal([]byte(v.Note), &snapshot) != nil || strings.Contains(snapshot.Profile, "donation") {
		v.Note = "A document profile is required to access this original."
		v.PDF = ""
		v.DOCX = ""
	}
}
