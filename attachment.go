package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"github.com/jackc/pgx/v5"
	"strconv"
	"strings"
)

func attachmentValid(o op) error {
	v := o.Data
	size, err := strconv.Atoi(v.Fields["size"])
	digest := v.Fields["sha256"]
	if digest != "" || o.Kind == "attachment-file" || v.File == "" {
		expected, e := hex.DecodeString(digest)
		if digest != strings.ToLower(digest) || e != nil || len(expected) != 32 || size <= 0 || size > 4<<20 || err != nil {
			return fail("Beleggröße und SHA-256 erforderlich.")
		}
	}
	if o.Kind == "attachment-file" {
		rev, err := strconv.ParseInt(v.Fields["revision"], 10, 64)
		if err != nil || rev < 1 || v.Reference == "" || o.Target != countKey("file", v.Reference, v.Fields["revision"]) || o.Base != 0 || v.File == "" {
			return fail("Datei gehört zu keiner gültigen Belegrevision.")
		}
	}
	if v.File == "" {
		return nil
	}
	b, err := base64.StdEncoding.DecodeString(v.File)
	if err != nil || len(b) > 4<<20 || !(bytes.HasPrefix(b, []byte("%PDF-")) || bytes.HasPrefix(b, []byte{0xff, 0xd8, 0xff}) || bytes.HasPrefix(b, []byte{137, 80, 78, 71, 13, 10, 26, 10})) {
		return fail("Beleg muss PDF, JPEG oder PNG bis 4 MiB sein.")
	}
	if digest != "" && (digestHex(b) != digest || len(b) != size) {
		return fail("Dateigröße oder Prüfsumme weicht ab.")
	}
	return nil
}

func attachBody(ctx context.Context, tx pgx.Tx, d device, o op) (string, error) {
	var owner, day, digest, file, size string
	var revision int64
	v := o.Data
	err := tx.QueryRow(ctx, `SELECT data->'Fields'->>'uploadDevice',data->>'Date',data->'Fields'->>'sha256',coalesce(data->>'File',''),coalesce(data->'Fields'->>'size',''),revision FROM entries WHERE event=$1 AND id=$2 AND kind='attachment' AND data->'Fields'->>'sha256' IS NOT NULL`, d.Event, v.Reference).Scan(&owner, &day, &digest, &file, &size, &revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return "Konflikt", nil
	}
	if err != nil {
		return "", err
	}
	if size != v.Fields["size"] || owner != d.ID || day != v.Date || digest != v.Fields["sha256"] || strconv.FormatInt(revision, 10) != v.Fields["revision"] {
		return "Konflikt", nil
	}
	if file != "" && file != v.File {
		return "Konflikt", nil
	}
	_, err = tx.Exec(ctx, "UPDATE entries SET data=jsonb_set(data,'{File}',to_jsonb($3::text)) WHERE event=$1 AND id=$2", d.Event, v.Reference, v.File)
	return "Übernommen", err
}

func completeAttachments(rows []row) error {
	for _, r := range rows {
		if r.Kind == "attachment" && r.Data.File == "" {
			return fail("Dateiübertragung für mindestens einen Beleg ausständig.")
		}
	}
	return nil
}
