package main

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
)

// The immutable operation keeps the issued bytes even when its financial proposal was rejected.
func conflictOriginals(ctx context.Context, tx pgx.Tx, d device, action, id string) (any, error) {
	if action == "conflict-originals" {
		rows, err := tx.Query(ctx, `SELECT id::text,data->>'Number' AS number,outcome FROM operations
 WHERE event=$1 AND kind='original' AND outcome IN ('Konflikt','Geklärt') ORDER BY recorded_at,id`, d.Event)
		if err != nil {
			return nil, err
		}
		return pgx.CollectRows(rows, pgx.RowToMap)
	}
	if !idPattern.MatchString(id) {
		return nil, fail("Belegvorgang wählen.")
	}
	var v data
	err := tx.QueryRow(ctx, `SELECT data FROM operations WHERE id=$1 AND event=$2 AND kind='original' AND outcome IN ('Konflikt','Geklärt')`, id, d.Event).Scan(&v)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fail("Konfliktfassung unbekannt.")
	}
	if err != nil {
		return nil, err
	}
	projectData(&v, "original", d)
	if v.PDF == "" || v.DOCX == "" {
		return nil, problem{403, "Belegprofil erforderlich."}
	}
	if err = audit(ctx, tx, d.Event, d.User, "Archivierte Konfliktfassung abgerufen", id); err != nil {
		return nil, err
	}
	return map[string]any{"pdf": v.PDF, "docx": v.DOCX, "number": v.Number}, tx.Commit(ctx)
}
