package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

type backupCommand struct {
	Action       string `json:"action"`
	Target       string `json:"target"`
	Name         string `json:"name"`
	Cron         string `json:"cron"`
	Days         int    `json:"days"`
	Confirmation string `json:"confirmation"`
	Password     string `json:"password,omitempty"`
	OTP          string `json:"otp,omitempty"`
}

var backupTransport = &http.Transport{
	DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		path := os.Getenv("BONFIRE_BACKUP_SOCKET")
		if path == "" {
			return nil, errors.New("Sicherungsdienst nicht verbunden")
		}
		return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "unix", path)
	},
	ResponseHeaderTimeout: 45 * time.Second,
}

func (a *app) registerBackup(mux *http.ServeMux) {
	for _, pattern := range []string{"GET /api/admin/backup", "POST /api/admin/backup", "GET /api/admin/backup/file", "POST /api/admin/backup/upload"} {
		mux.HandleFunc(pattern, a.proxyBackup)
	}
}

func (a *app) proxyBackup(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if _, e := r.Cookie("bonfire_session"); e != nil || r.Header.Get("Authorization") != "" {
		http.Error(w, "Persönliche Sitzung erforderlich.", 401)
		return
	}
	user, role, err := a.auth(r.Context(), r)
	if err != nil {
		http.Error(w, "Bitte erneut anmelden.", 401)
		return
	}
	if role != roleAdmin {
		http.Error(w, "Adminrecht erforderlich.", 403)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/admin/backup")
	if path == "" {
		path = "/"
	}
	var body io.Reader
	if r.Method == "POST" {
		if path == "/upload" {
			r.Body = http.MaxBytesReader(w, r.Body, archiveLimit+(64<<20))
			body = r.Body
		} else {
			r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
			var command backupCommand
			if read(r, &command) != nil {
				http.Error(w, "Ungültiger Auftrag.", 400)
				return
			}
			if command.Action == "promote" {
				if command.Confirmation != "WIEDERHERSTELLEN" || command.Password == "" {
					http.Error(w, "Passwort und ausdrückliche Bestätigung erforderlich.", 422)
					return
				}
				verify := r.Clone(r.Context())
				var alias string
				if err = a.db.QueryRow(r.Context(), "SELECT coalesce(login_alias,name) FROM users WHERE name=$1 AND active", user).Scan(&alias); err != nil {
					http.Error(w, "Erneute Anmeldung erforderlich.", 403)
					return
				}
				verify.SetBasicAuth(alias, command.Password)
				verify.Header.Set("X-Bonfire-OTP", command.OTP)
				if verified, checkRole, err := a.auth(r.Context(), verify); err != nil || verified != user || checkRole != roleAdmin {
					http.Error(w, "Erneute Anmeldung fehlgeschlagen.", 403)
					return
				}
			}
			command.Password, command.OTP = "", ""
			raw, _ := json.Marshal(command)
			body = bytes.NewReader(raw)
		}
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, "http://backup"+path, body)
	if err != nil {
		http.Error(w, "Auftrag ungültig.", 400)
		return
	}
	req.URL.RawQuery = r.URL.Query().Encode()
	req.Header.Set("X-Bonfire-Actor", user)
	res, err := backupTransport.RoundTrip(req)
	if err != nil {
		http.Error(w, "Sicherungsdienst nicht erreichbar.", 503)
		return
	}
	defer res.Body.Close()
	for _, k := range []string{"Content-Type", "Content-Disposition", "Content-Length"} {
		if v := res.Header.Get(k); v != "" {
			w.Header().Set(k, v)
		}
	}
	w.WriteHeader(res.StatusCode)
	_, _ = io.Copy(w, res.Body)
}
