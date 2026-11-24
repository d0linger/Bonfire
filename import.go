package main

import (
	"context"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Journal imports identify a file row; historical workbooks identify a sheet and cell.
var importLocation = regexp.MustCompile(`^import:([0-9a-f]{64}):(?:([1-9][0-9]*)|[0-9]+-([A-Z]{1,3}[1-9][0-9]*))$`)

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
