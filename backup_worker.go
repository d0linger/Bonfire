package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/minio/minio-go/v7"
	"github.com/robfig/cron/v3"
)

type backupSchedule struct {
	Cron  string    `json:"cron"`
	Days  int       `json:"days"`
	Since time.Time `json:"since"`
}
type backupResult struct {
	Action  string    `json:"action"`
	Target  string    `json:"target"`
	At      time.Time `json:"at"`
	Outcome string    `json:"outcome"`
	Message string    `json:"message"`
	Actor   string    `json:"actor"`
}
type backupReceipt struct {
	Target, Name, Hash string
	Manifest           backupManifest
	At                 time.Time
}
type backupHealth struct {
	Enabled     bool       `json:"enabled"`
	Due         bool       `json:"due"`
	Next        *time.Time `json:"next,omitempty"`
	LastSuccess *time.Time `json:"lastSuccess,omitempty"`
	LastAttempt *time.Time `json:"lastAttempt,omitempty"`
	Outcome     string     `json:"outcome"`
}
type backupState struct {
	Schedules map[string]backupSchedule `json:"schedules"`
	Recent    []backupResult            `json:"recent"`
	Last      map[string]backupHealth   `json:"last"`
	Probe     *backupReceipt            `json:"receipt"`
}
type backupWorker struct {
	db             *pgx.ConnConfig
	key            []byte
	s3             *minio.Client
	bucket, prefix string
	mu             sync.Mutex
	state          backupState
	active         bool
}

func (b *backupWorker) persist() error {
	return saveBackupJSON(filepath.Join(backupHome, "state.json"), b.state)
}
func backupNow() time.Time { return time.Now().UTC() }
func writeBackupJSON(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(data); err != nil {
		log.Print("Backup response interrupted")
	}
}
func badBackup(w http.ResponseWriter, msg string) { http.Error(w, msg, http.StatusUnprocessableEntity) }

func (b *backupWorker) health(target string, now time.Time) backupHealth {
	sched := b.state.Schedules[target]
	h := b.state.Last[target]
	h.Enabled = sched.Cron != "" && (target != "s3" || b.s3 != nil)
	if !h.Enabled {
		return h
	}
	c, err := cron.ParseStandard(sched.Cron)
	if err != nil {
		return h
	}
	since := sched.Since
	if h.LastAttempt != nil && h.LastAttempt.After(since) {
		since = *h.LastAttempt
	}
	next := c.Next(since.In(time.Local))
	if next.IsZero() {
		return h
	}
	h.Next = &next
	h.Due = !next.After(now)
	return h
}
func (b *backupWorker) status(w http.ResponseWriter, r *http.Request) {
	files, err := b.listFiles(r.Context(), "local")
	if err != nil {
		http.Error(w, "Lokale Sicherungen nicht lesbar.", 503)
		return
	}
	remoteErr := ""
	if b.s3 != nil && r.URL.Query().Get("files") == "all" {
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		defer cancel()
		remote, e := b.listFiles(ctx, "s3")
		if e != nil {
			remoteErr = "S3-Dateiliste nicht erreichbar."
		} else {
			files = append(files, remote...)
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].At.After(files[j].At) })
	b.mu.Lock()
	defer b.mu.Unlock()
	now := backupNow()
	writeBackupJSON(w, map[string]any{"active": b.active, "files": files, "s3Configured": b.s3 != nil, "s3Error": remoteErr, "schedules": b.state.Schedules, "recent": b.state.Recent, "receipt": b.state.Probe, "local": b.health("local", now), "s3": b.health("s3", now), "probe": b.health("probe", now), "timezone": time.Local.String()})
}

func (b *backupWorker) audit(actor, action, subject string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := b.connect(ctx, b.db.Database)
	if err != nil {
		return err
	}
	defer c.Close(ctx)
	_, err = c.Exec(ctx, "INSERT INTO audit(username,action,subject) VALUES($1,$2,$3)", actor, "Backup · "+action, subject)
	return err
}

func (b *backupWorker) command(w http.ResponseWriter, r *http.Request) {
	var q backupCommand
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	if read(r, &q) != nil {
		badBackup(w, "Ungültiger Auftrag.")
		return
	}
	actor := r.Header.Get("X-Bonfire-Actor")
	if q.Action == "schedule" {
		if q.Target != "local" && q.Target != "s3" && q.Target != "probe" || q.Days < 0 || q.Days > 3650 {
			badBackup(w, "Ziel oder Aufbewahrung ungültig.")
			return
		}
		if q.Cron != "" {
			if _, err := cron.ParseStandard(q.Cron); err != nil {
				badBackup(w, "Ungültiger Cron-Ausdruck.")
				return
			}
		}
		if q.Target == "s3" && q.Cron != "" && b.s3 == nil {
			badBackup(w, "S3 nicht eingerichtet.")
			return
		}
		b.mu.Lock()
		defer b.mu.Unlock()
		if err := b.audit(actor, "Zeitplan geändert", q.Target); err != nil {
			http.Error(w, "Protokollierung fehlgeschlagen.", 503)
			return
		}
		prev := b.state.Schedules[q.Target]
		b.state.Schedules[q.Target] = backupSchedule{q.Cron, q.Days, backupNow()}
		if err := b.persist(); err != nil {
			b.state.Schedules[q.Target] = prev
			http.Error(w, "Zeitplan konnte nicht gespeichert werden.", 500)
			return
		}
		writeBackupJSON(w, true)
		return
	}
	if err := b.start(q, actor); err != nil {
		badBackup(w, err.Error())
		return
	}
	w.WriteHeader(202)
	writeBackupJSON(w, true)
}

func (b *backupWorker) start(q backupCommand, actor string) error {
	return b.startIfDue(q, actor, "")
}

func (b *backupWorker) startIfDue(q backupCommand, actor, schedule string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if schedule != "" && !b.health(schedule, backupNow()).Due {
		return nil
	}
	if b.active {
		return errors.New("Ein Sicherungsauftrag läuft bereits")
	}
	if q.Target == "s3" && b.s3 == nil {
		return errors.New("S3 nicht eingerichtet")
	}
	switch q.Action {
	case "backup":
		if q.Target != "local" && q.Target != "s3" {
			return errors.New("Sicherungsziel ungültig")
		}
	case "test":
		if q.Target != "s3" {
			return errors.New("S3-Ziel erforderlich")
		}
	case "probe", "promote":
		if !backupName.MatchString(q.Name) || (q.Target != "local" && q.Target != "s3" && q.Target != "upload") {
			return errors.New("Sicherungsdatei auswählen")
		}
		if q.Action == "promote" {
			pr := b.state.Probe
			if q.Confirmation != "WIEDERHERSTELLEN" || pr == nil || pr.Name != q.Name || pr.Target != q.Target || pr.Manifest.Installation == "" || time.Since(pr.At) > time.Hour {
				return errors.New("Aktuelle bestandene Probe dieser Sicherung und Bestätigung erforderlich")
			}
		}
	default:
		return errors.New("Unbekannter Auftrag")
	}
	if err := b.audit(actor, "Gestartet "+q.Action, q.Target); err != nil {
		return errors.New("Auftrag konnte nicht protokolliert werden")
	}
	b.active = true
	now := backupNow()
	key := q.Target
	if q.Action == "probe" {
		key = "probe"
	}
	previous, existed := b.state.Last[key]
	if q.Action == "backup" || q.Action == "probe" {
		h := previous
		h.LastAttempt = &now
		h.Outcome = "running"
		b.state.Last[key] = h
	}
	if err := b.persist(); err != nil {
		b.active = false
		if existed {
			b.state.Last[key] = previous
		} else {
			delete(b.state.Last, key)
		}
		return errors.New("Auftragsstatus konnte nicht gespeichert werden")
	}
	prev := b.state.Probe
	days := b.state.Schedules[q.Target].Days
	go b.run(q, actor, key, days, prev)
	return nil
}

func (b *backupWorker) run(q backupCommand, actor, key string, days int, pr *backupReceipt) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Hour)
	defer cancel()
	var receipt *backupReceipt
	result := backupResult{q.Action, q.Target, time.Now().UTC(), "ok", "Abgeschlossen", actor}
	do := func() error {
		ctl, err := b.connect(ctx, "postgres")
		if err != nil {
			return err
		}
		defer ctl.Close(ctx)
		var lock bool
		if err = ctl.QueryRow(ctx, "SELECT pg_try_advisory_lock(751036)").Scan(&lock); err != nil || !lock {
			return errors.New("Ein anderer Sicherungsauftrag ist aktiv")
		}
		switch q.Action {
		case "test":
			ok, e := b.s3.BucketExists(ctx, b.bucket)
			if e != nil || !ok {
				return errors.New("S3-Bucket nicht erreichbar")
			}
			result.Message = "S3-Bucket erreichbar"
			return nil
		case "backup":
			result.Message, err = b.makeArchive(ctx, b.db.Database, q.Target)
			if err != nil {
				return err
			}
			return b.prune(ctx, q.Target, days)
		case "probe", "promote":
			db, m, fingerprint, e := b.stage(ctx, q.Target, q.Name)
			if e != nil {
				return e
			}
			defer func() {
				clean, cancel := context.WithTimeout(context.Background(), time.Minute)
				defer cancel()
				if _, err := ctl.Exec(clean, "DROP DATABASE IF EXISTS "+dbIdent(db)+" WITH (FORCE)"); err != nil {
					log.Print("Failed to remove temporary restore database")
				}
			}()
			if q.Action == "promote" {
				if pr.Hash != fingerprint {
					return errors.New("Datei seit der Prüfung verändert")
				}
				if err = b.promote(ctx, ctl, db, actor, m); err != nil {
					return err
				}
				result.Message = "Übernahme abgeschlossen. Neu anmelden."
				return nil
			}
			receipt = &backupReceipt{q.Target, q.Name, fingerprint, m, backupNow()}
			result.Message = fmt.Sprintf("Probe bestanden · %d Geschäftsjahre, %d Einträge, %d Originalbelege", m.Years, m.Entries, m.Originals)
			return nil
		}
		return nil
	}
	err := do()
	if err != nil {
		result.Outcome = "failed"
		result.Message = safeBackupError(err)
	}
	if err = b.audit(actor, q.Action+" "+result.Outcome, q.Target); err != nil {
		log.Print("Sicherungsdienst: DB-Audit vorübergehend nicht erreichbar")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	at := backupNow()
	if q.Action == "backup" || q.Action == "probe" {
		h := b.state.Last[key]
		h.Outcome = result.Outcome
		if result.Outcome == "ok" {
			h.LastSuccess = &at
		}
		b.state.Last[key] = h
	}
	if q.Action == "probe" {
		b.state.Probe = receipt
	}
	if q.Action == "promote" && result.Outcome == "ok" {
		b.state.Probe = nil
	}
	b.state.Recent = append([]backupResult{result}, b.state.Recent...)
	if len(b.state.Recent) > 100 {
		b.state.Recent = b.state.Recent[:100]
	}
	if err = b.persist(); err != nil {
		log.Print("Sicherungsdienst: Statusdatei konnte nicht geschrieben werden")
	}
	b.active = false
}

func safeBackupError(err error) string {
	// Keep connection strings, object paths, PostgreSQL details and credentials out of logs/UI.
	for _, prefix := range []string{"Sicherungsdatei ", "Migrationsnachweis ", "Schemaversion ", "Prüfsummen ", "Andere Installation ", "Datei seit ", "S3-Bucket ", "Legacy-Archiv ", "pg_", "Ein anderer ", "Sicherung überschreitet "} {
		if strings.HasPrefix(err.Error(), prefix) {
			return err.Error()
		}
	}
	return "Auftrag fehlgeschlagen. Verbindung, Schlüssel und freien Speicher prüfen."
}

func (b *backupWorker) tick() {
	for _, target := range []string{"local", "s3", "probe"} {
		b.mu.Lock()
		due := !b.active && b.health(target, backupNow()).Due
		b.mu.Unlock()
		if !due {
			continue
		}
		q := backupCommand{Action: "backup", Target: target}
		if target == "probe" {
			files, err := b.listFiles(context.Background(), "local")
			if err != nil || len(files) == 0 {
				continue
			}
			q = backupCommand{Action: "probe", Target: "local", Name: files[0].Name}
		}
		_ = b.startIfDue(q, "System", target)
		return
	}
}

func (b *backupWorker) download(w http.ResponseWriter, r *http.Request) {
	target, name := r.URL.Query().Get("target"), r.URL.Query().Get("name")
	file, err := b.openArchive(r.Context(), target, name)
	if err != nil {
		http.Error(w, "Datei nicht verfügbar.", 404)
		return
	}
	defer file.Close()
	if err = b.audit(r.Header.Get("X-Bonfire-Actor"), "Download", target); err != nil {
		http.Error(w, "Protokollierung fehlgeschlagen.", 503)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	if _, err := io.Copy(w, file); err != nil {
		panic(http.ErrAbortHandler)
	}
}

func (b *backupWorker) upload(w http.ResponseWriter, r *http.Request) {
	dir := filepath.Join(backupHome, "uploads")
	if err := os.MkdirAll(dir, 0700); err != nil {
		http.Error(w, "Uploadspeicher nicht verfügbar.", 503)
		return
	}
	tmp, err := os.CreateTemp(dir, ".upload-")
	if err != nil {
		http.Error(w, "Uploadspeicher nicht verfügbar.", 503)
		return
	}
	defer os.Remove(tmp.Name())
	size, err := io.Copy(tmp, http.MaxBytesReader(w, r.Body, archiveLimit+(64<<20)))
	closeErr := tmp.Close()
	if err != nil || closeErr != nil || size < 36 {
		badBackup(w, "Upload unvollständig oder zu groß.")
		return
	}
	// One uploaded candidate at a time; its random name and receipt bind the later takeover.
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.active {
		http.Error(w, "Ein Auftrag läuft.", 409)
		return
	}
	name := "bonfire-" + backupNow().Format("20060102T150405Z") + "-" + uuid() + ".dump.enc"
	if err = b.audit(r.Header.Get("X-Bonfire-Actor"), "Datei zur Probe hochgeladen", "upload"); err != nil {
		http.Error(w, "Protokollierung fehlgeschlagen.", 503)
		return
	}
	if err = os.Rename(tmp.Name(), filepath.Join(dir, name)); err != nil {
		http.Error(w, "Upload nicht gespeichert.", 503)
		return
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.Name() != name && backupName.MatchString(e.Name()) {
			if err := os.Remove(filepath.Join(dir, e.Name())); err != nil {
				log.Print("Failed to remove superseded backup upload")
			}
		}
	}
	writeBackupJSON(w, map[string]string{"name": name})
}

func runBackupWorker() error {
	cfg, err := pgx.ParseConfig(os.Getenv("DATABASE_URL"))
	if err != nil {
		return errors.New("Datenbankkonfiguration ungültig")
	}
	b := &backupWorker{db: cfg}
	b.key, err = os.ReadFile(backupKeyPath)
	if os.IsNotExist(err) {
		data := make([]byte, 32)
		if _, err = rand.Read(data); err != nil {
			return err
		}
		f, err := os.CreateTemp(backupKeyDirectory, ".key-")
		if err != nil {
			return err
		}
		tmp := f.Name()
		if _, err = f.Write(data); err == nil {
			err = f.Sync()
		}
		err = errors.Join(err, f.Close())
		if err == nil {
			err = os.Link(tmp, backupKeyPath)
		}
		removeErr := os.Remove(tmp)
		if err != nil && !errors.Is(err, os.ErrExist) {
			return errors.Join(err, removeErr)
		}
		if removeErr != nil {
			return removeErr
		}
		directory, err := os.Open(backupKeyDirectory)
		if err != nil {
			return err
		}
		if err = errors.Join(directory.Sync(), directory.Close()); err != nil {
			return err
		}
		b.key, err = os.ReadFile(backupKeyPath)
		if err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	if len(b.key) != 32 {
		return errors.New("Ungültiger Sicherungsschlüssel")
	}
	b.s3, b.bucket, b.prefix, err = newS3()
	if err != nil {
		return errors.New("Ungültige S3-Konfiguration")
	}
	raw, err := os.ReadFile(filepath.Join(backupHome, "state.json"))
	if err == nil {
		if err = json.Unmarshal(raw, &b.state); err != nil {
			return errors.New("Statusdatei unlesbar")
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if b.state.Schedules == nil {
		b.state.Schedules = map[string]backupSchedule{}
	}
	if b.state.Last == nil {
		b.state.Last = map[string]backupHealth{}
	}
	for _, target := range []string{"local", "s3", "probe"} {
		if _, ok := b.state.Schedules[target]; !ok {
			b.state.Schedules[target] = backupSchedule{Days: 30, Since: backupNow()}
		}
		h := b.state.Last[target]
		if h.Outcome == "running" {
			h.Outcome = "failed"
			b.state.Last[target] = h
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c, err := b.connect(ctx, "postgres")
	if err != nil {
		return errors.New("Wartungsdatenbank nicht erreichbar")
	}
	err = errors.Join(b.recoverSwap(ctx, c), c.Close(ctx))
	if err != nil {
		return errors.New("Unvollständigen Restore anhand des Sicherungsjournals prüfen")
	}
	if err = b.persist(); err != nil {
		return err
	}
	sock := "/run/bonfire-backup/worker.sock"
	if err := os.Remove(sock); err != nil && !os.IsNotExist(err) {
		return err
	}
	listener, err := net.Listen("unix", sock)
	if err != nil {
		return err
	}
	defer listener.Close()
	if err = os.Chmod(sock, 0600); err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", b.status)
	mux.HandleFunc("POST /{$}", b.command)
	mux.HandleFunc("GET /file", b.download)
	mux.HandleFunc("POST /upload", b.upload)
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for range t.C {
			b.tick()
		}
	}()
	return (&http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}).Serve(listener)
}
