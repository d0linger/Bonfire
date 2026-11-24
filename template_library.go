package main

import (
	"context"
	"github.com/jackc/pgx/v5"
	"net/http"
	"strconv"
)

func (a *app) templateLibrary(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = accountManager(ctx, tx, r, false); err != nil {
		return nil, err
	}
	id := r.URL.Query().Get("id")
	if id != "" {
		if n, e := strconv.ParseInt(id, 10, 64); e != nil || n <= 0 {
			return nil, fail("Vorlagenstand auswählen.")
		}
		var v data
		err = tx.QueryRow(ctx, "SELECT data FROM template_library WHERE id=$1", id).Scan(&v)
		if err == pgx.ErrNoRows {
			return nil, problem{404, "Vorlagenstand fehlt."}
		}
		return v, err
	}
	rows, err := tx.Query(ctx, `SELECT id, source_name AS source,revision,data->>'Reference' AS profile,data->>'Label' AS label FROM template_library ORDER BY source_name,profile,revision DESC`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToMap)
}
