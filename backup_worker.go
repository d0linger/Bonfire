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
	"os/signal"
	"path/filepath"
	"sort"
	"sync"
	"syscall"
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
	storageDir     string
	service        context.Context
	jobs           sync.WaitGroup
	db             *pgx.ConnConfig
	key            []byte
	s3             *minio.Client
	bucket, prefix string
	uploadSlot     sync.Mutex
	mu             sync.Mutex
	state          backupState
	active         bool
}

func (b *backupWorker) storageRoot() string {
	if b.storageDir != "" {
		return b.storageDir
	}
	return backupHome
}

func (b *backupWorker) persist() error {
	return b.saveBackupJSON("state.json", b.state)
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
	h.Due = false
	h.Next = nil
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
		http.Error(w, "Could not read local backups.", 503)
		return
	}
	remoteErr := ""
	if b.s3 != nil && r.URL.Query().Get("files") == "all" {
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		defer cancel()
		remote, e := b.listFiles(ctx, "s3")
		if e != nil {
			remoteErr = "Could not retrieve the S3 file list."
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
		badBackup(w, "Invalid job.")
		return
	}
	actor := r.Header.Get("X-Bonfire-Actor")
	if q.Action == "schedule" {
		if q.Target != "local" && q.Target != "s3" && q.Target != "probe" || q.Days < 0 || q.Days > 3650 {
			badBackup(w, "Invalid destination or retention period.")
			return
		}
		if q.Cron != "" {
			schedule, err := cron.ParseStandard(q.Cron)
			if err != nil || schedule.Next(backupNow().In(time.Local)).IsZero() {
				badBackup(w, "Enter a valid schedule with a future occurrence.")
				return
			}
		}
		if q.Target == "s3" && q.Cron != "" && b.s3 == nil {
			badBackup(w, "S3 is not configured.")
			return
		}
		b.mu.Lock()
		defer b.mu.Unlock()
		if err := b.audit(actor, "Zeitplan geändert", q.Target); err != nil {
			http.Error(w, "Could not write the audit record.", 503)
			return
		}
		prev := b.state.Schedules[q.Target]
		b.state.Schedules[q.Target] = backupSchedule{q.Cron, q.Days, backupNow()}
		if err := b.persist(); err != nil {
			b.state.Schedules[q.Target] = prev
			http.Error(w, "Could not save the schedule.", 500)
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
	if b.service.Err() != nil {
		return errors.New("Backup service is stopping")
	}
	if schedule != "" && !b.health(schedule, backupNow()).Due {
		return nil
	}
	if b.active {
		return errors.New("A backup job is already running.")
	}
	if q.Target == "s3" && b.s3 == nil {
		return errors.New("S3 is not configured.")
	}
	switch q.Action {
	case "backup":
		if q.Target != "local" && q.Target != "s3" {
			return errors.New("Invalid backup destination.")
		}
	case "test":
		if q.Target != "s3" {
			return errors.New("An S3 destination is required.")
		}
	case "probe", "promote":
		if !backupName.MatchString(q.Name) || (q.Target != "local" && q.Target != "s3" && q.Target != "upload") {
			return errors.New("Select a backup file.")
		}
		if q.Action == "promote" {
			pr := b.state.Probe
			if !confirmedRestore(q.Confirmation) || pr == nil || pr.Name != q.Name || pr.Target != q.Target || pr.Manifest.Installation == "" || time.Since(pr.At) > time.Hour {
				return errors.New("Confirm the restore after a successful, recent test of this backup.")
			}
		}
	default:
		return errors.New("Unknown job.")
	}
	if err := b.audit(actor, "Gestartet "+q.Action, q.Target); err != nil {
		return errors.New("Could not audit the backup job.")
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
	if err := b.persist(); errors.Is(err, errBackupStatePublished) {
		log.Print("Backup start record published with uncertain directory durability")
	} else if err != nil {
		b.active = false
		if existed {
			b.state.Last[key] = previous
		} else {
			delete(b.state.Last, key)
		}
		return errors.New("Could not save the job status.")
	}
	prev := b.state.Probe
	days := b.state.Schedules[q.Target].Days
	b.jobs.Go(func() { b.run(q, actor, key, days, prev) })
	return nil
}

func (b *backupWorker) run(q backupCommand, actor, key string, days int, pr *backupReceipt) {
	ctx, cancel := context.WithTimeout(b.service, 2*time.Hour)
	defer cancel()
	var archiveDigest string
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
			return errors.New("Another backup job is active.")
		}
		switch q.Action {
		case "test":
			ok, e := b.s3.BucketExists(ctx, b.bucket)
			if e != nil || !ok {
				return errors.New("The S3 bucket is unreachable.")
			}
			result.Message = "The S3 bucket is reachable."
			return nil
		case "backup":
			result.Message, archiveDigest, err = b.makeArchive(ctx, b.db.Database, q.Target)
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
					return errors.New("The file has changed since verification.")
				}
				if err = b.promote(ctx, ctl, db, actor, m); err != nil {
					return err
				}
				result.Message = "Restore complete. Sign in again."
				return nil
			}
			receipt = &backupReceipt{q.Target, q.Name, fingerprint, m, backupNow()}
			result.Message = fmt.Sprintf("Restore test passed: %d fiscal years, %d entries and %d original documents", m.Years, m.Entries, m.Originals)
			return nil
		}
		return nil
	}
	err := do()
	if err != nil {
		result.Outcome = "failed"
		result.Message = safeBackupError(err)
		if errors.Is(err, errRestoreUnconfirmed) {
			result.Message = "The database was switched, but the connection could not be verified. The recovery journal was retained."
		} else if errors.Is(err, errRestoredPending) {
			result.Outcome = "warning"
			result.Message = "Restored database is live. Audit or journal cleanup is pending."
		}
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	at := backupNow()
	previousSuccess := b.state.Last[key].LastSuccess
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
	err = b.persist()
	if err == nil && q.Action == "backup" && result.Outcome == "ok" {
		var c *pgx.Conn
		c, err = b.connect(ctx, b.db.Database)
		if err == nil {
			_, err = c.Exec(ctx, "INSERT INTO backup_history(digest) VALUES($1)", archiveDigest)
			defer c.Close(ctx)
		}
	}
	if err != nil {
		log.Print("Could not record backup job completion")
		if result.Outcome == "ok" {
			result.Outcome = "warning"
			result.Message = "Job completed but its completion record could not be saved."
			b.state.Recent[0] = result
			if q.Action == "backup" || q.Action == "probe" {
				h := b.state.Last[key]
				h.Outcome, h.LastSuccess = result.Outcome, previousSuccess
				b.state.Last[key] = h
			}
			if retry := b.persist(); retry != nil {
				log.Print("Could not persist backup status warning")
			}
		}
	}
	if err = b.audit(actor, q.Action+" "+result.Outcome, q.Target); err != nil {
		log.Print("Could not record backup audit event")
	}
	b.active = false
}

func safeBackupError(err error) string {
	// Keep connection strings, object paths, PostgreSQL details and credentials out of logs/UI.
	for _, message := range []string{
		"The backup is incomplete, unreadable or encrypted with another key.", "Migration verification mismatch.",
		"Schema version mismatch. Test the restore with a matching BONFIRE version.", "The checksums or financial records differ from the backup manifest.",
		"This backup belongs to another installation or uses a legacy format. Restore is blocked.", "The file has changed since verification.",
		"The S3 bucket is unreachable.", "Legacy archive unreadable or larger than 128 MiB. Use the external restore procedure.",
		"pg_dump failed", "pg_restore failed", "Another backup job is active.", "The backup exceeds the size limit.",
	} {
		if err.Error() == message {
			return err.Error()
		}
	}
	return "Backup job failed. Check the connection, encryption key and free disk space."
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
		http.Error(w, "File unavailable.", 404)
		return
	}
	defer file.Close()
	if err = b.audit(r.Header.Get("X-Bonfire-Actor"), "Download", target); err != nil {
		http.Error(w, "Could not write the audit record.", 503)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	if _, err := io.Copy(w, file); err != nil {
		panic(http.ErrAbortHandler)
	}
}

func (b *backupWorker) upload(w http.ResponseWriter, r *http.Request) {
	if !b.uploadSlot.TryLock() {
		http.Error(w, "Another backup upload is in progress.", http.StatusConflict)
		return
	}
	defer b.uploadSlot.Unlock()
	if err := backupUploadDeadline(w); err != nil {
		http.Error(w, "Cannot initialize backup upload.", http.StatusInternalServerError)
		return
	}
	dir := filepath.Join(b.storageRoot(), "uploads")
	if err := os.MkdirAll(dir, 0700); err != nil {
		http.Error(w, "Upload storage is unavailable.", 503)
		return
	}
	tmp, err := os.CreateTemp(dir, ".upload-")
	if err != nil {
		http.Error(w, "Upload storage is unavailable.", 503)
		return
	}
	defer os.Remove(tmp.Name())
	size, err := io.Copy(tmp, http.MaxBytesReader(w, r.Body, archiveLimit+(64<<20)))
	closeErr := tmp.Close()
	if err != nil || closeErr != nil || size < 36 {
		badBackup(w, "The upload is incomplete or too large.")
		return
	}
	// One uploaded candidate at a time; its random name and receipt bind the later takeover.
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.active {
		http.Error(w, "A job is in progress.", 409)
		return
	}
	name := "bonfire-" + backupNow().Format("20060102T150405Z") + "-" + uuid() + ".dump.enc"
	if err = b.audit(r.Header.Get("X-Bonfire-Actor"), "Datei zur Probe hochgeladen", "upload"); err != nil {
		http.Error(w, "Could not write the audit record.", 503)
		return
	}
	if err = os.Rename(tmp.Name(), filepath.Join(dir, name)); err != nil {
		http.Error(w, "The upload could not be saved.", 503)
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
		return errors.New("Invalid database configuration.")
	}
	service, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	b := &backupWorker{db: cfg, service: service}
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
		b.key, err = os.ReadFile(backupKeyPath)
		if err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	directory, err := os.Open(backupKeyDirectory)
	if err != nil {
		return err
	}
	if err = errors.Join(directory.Sync(), directory.Close()); err != nil {
		return err
	}
	if len(b.key) != 32 {
		return errors.New("Invalid backup key.")
	}
	b.s3, b.bucket, b.prefix, err = newS3()
	if err != nil {
		return errors.New("Invalid S3 configuration.")
	}
	raw, err := os.ReadFile(filepath.Join(b.storageRoot(), "state.json"))
	if err == nil {
		if err = json.Unmarshal(raw, &b.state); err != nil {
			return errors.New("Could not read the status file.")
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
		return errors.New("The maintenance database is unreachable.")
	}
	err = errors.Join(b.recoverSwap(ctx, c), c.Close(ctx))
	if err != nil {
		return errors.New("Check the backup journal for an incomplete restore.")
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
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		timer := time.NewTicker(30 * time.Second)
		defer timer.Stop()
		for {
			select {
			case <-timer.C:
				b.tick()
			case <-service.Done():
				ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
				defer cancel()
				if err := server.Shutdown(ctx); err != nil {
					log.Print("Backup HTTP shutdown timed out")
				}
				return
			}
		}
	}()
	err = server.Serve(listener)
	stop()
	<-drained
	// Synchronize with any submission that passed the stopping check before cancellation.
	b.mu.Lock()
	b.mu.Unlock()
	b.jobs.Wait()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
