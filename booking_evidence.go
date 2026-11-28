package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"mime"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

// Each open or download rechecks the session, its workspace grant and the
// explicit booking link. A matching filename, date or amount grants no access.
func (a *app) bookingEvidence(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	q := r.URL.Query()
	filename, body, err := a.linkedEvidence(r, q.Get("event"), q.Get("booking"), q.Get("file"))
	if err != nil {
		route(func(context.Context, http.ResponseWriter, *http.Request) (any, error) { return nil, err })(w, r)
		return
	}
	kind := http.DetectContentType(body)
	if kind != "application/pdf" && kind != "image/jpeg" && kind != "image/png" {
		http.Error(w, "This file format cannot be opened.", http.StatusUnsupportedMediaType)
		return
	}
	disposition := "inline"
	if q.Get("download") == "1" {
		disposition = "attachment"
	}
	w.Header().Set("Content-Type", kind)
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": filename}))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
	http.ServeContent(w, r, filename, time.Time{}, bytes.NewReader(body))
}

func (a *app) linkedEvidence(r *http.Request, event, booking, file string) (string, []byte, error) {
	ctx := r.Context()
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return "", nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := onlineWorkspace(ctx, tx, r, event, true); err != nil {
		return "", nil, err
	}
	var name, encoded string
	err = tx.QueryRow(ctx, `SELECT coalesce(nullif(f.data->>'Filename',''),'Receipt'),f.data->>'File'
		FROM entries f JOIN entries b ON b.event=f.event AND b.id=f.data->>'Reference'
		WHERE f.event=$1 AND f.id=$2 AND f.kind='attachment' AND coalesce(f.data->>'File','')<>''
		AND b.id=$3 AND b.kind=ANY($4)`, event, file, booking, money).Scan(&name, &encoded)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil, problem{404, "This booking has no such supporting file."}
	}
	if err != nil {
		return "", nil, err
	}
	body, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", nil, err
	}
	return name, body, tx.Commit(ctx)
}
