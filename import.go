package main

import (
	"context"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Journal imports identify a file row; historical workbooks identify a sheet and cell.
var importLocation = regexp.MustCompile(`^import:([0-9a-f]{64}):(?:([1-9][0-9]*)|[0-9]+-([A-Z]{1,3}[1-9][0-9]*))$`)

// The historical source remains attached across revisions, including writes from
// older clients that did not send a sheet or cell when correcting a booking.
func preserveImport(ctx context.Context, tx pgx.Tx, event string, o *op) error {
	var stored data
	var note *string
	err := tx.QueryRow(ctx, `SELECT j.data,coalesce(j.data->>'ImportNote',
		(SELECT h.data->>'Note' FROM journal_history h WHERE h.event=j.event AND h.target=j.id
		 AND h.direction=1 AND h.revision=1 ORDER BY h.id LIMIT 1),CASE WHEN j.revision=1 THEN j.data->>'Note' END)
		FROM entries j WHERE j.event=$1 AND j.id=$2`, event, o.Target).Scan(&stored, &note)
	if err != nil {
		return err
	}
	v := &o.Data
	if v.Reference != "" && v.Reference != stored.Reference {
		return fail("The import source is protected. Keep the original file reference.")
	}
	if v.ImportNote != nil && (note == nil || *v.ImportNote != *note) {
		return fail("The original import note is protected. Enter your explanation as the correction reason.")
	}
	v.Reference, v.ImportNote = stored.Reference, note
	if v.Fields == nil {
		v.Fields = map[string]string{}
	}
	for _, key := range []string{"sheet", "cell", "original", "dateOrigin", "sourceColumn"} {
		value, present := stored.Fields[key]
		if incoming, ok := v.Fields[key]; ok && (!present || incoming != value) {
			return fail("The source field " + key + " is protected. Keep its recorded value.")
		}
		if present {
			v.Fields[key] = value
		}
	}
	return nil
}

func importReference(ctx context.Context, tx pgx.Tx, event string, o op) (bool, error) {
	parts := importLocation.FindStringSubmatch(o.Target)
	if len(parts) == 0 || (o.Kind != "income" && o.Kind != "expense") || o.Data.Reference != "source:"+parts[1] || strings.TrimSpace(o.Data.Note) == "" {
		return false, nil
	}
	cell, role := parts[2], "Journal"
	if parts[3] != "" {
		cell, role = parts[3], "D1"
	}
	if o.Data.Fields["cell"] != cell || strings.TrimSpace(o.Data.Fields["sheet"]) == "" {
		return false, nil
	}
	// A source location can be approved in only one workspace, including concurrent imports.
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", o.Target); err != nil {
		return false, err
	}
	var allowed bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM entries WHERE event=$1 AND id=$2 AND kind='import-source' AND data->>'Status'=$3)
 AND NOT EXISTS(SELECT 1 FROM entries WHERE event<>$1 AND id=$4)`, event, o.Data.Reference, role, o.Target).Scan(&allowed)
	return allowed, err
}
