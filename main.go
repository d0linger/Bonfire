package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

//go:embed migrations/*.sql
var migrations embed.FS

type app struct {
	db       *pgxpool.Pool
	mu       sync.Mutex
	attempts map[string]int
	reset    time.Time
}
type problem struct {
	code    int
	message string
}

func (p problem) Error() string { return p.message }
func fail(s string) error       { return problem{422, s} }

var rejectedSync atomic.Uint64
var failedRequests atomic.Uint64

type endpoint func(context.Context, http.ResponseWriter, *http.Request) (any, error)

func route(fn endpoint) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		r.Body = http.MaxBytesReader(w, r.Body, 16<<20)
		result, err := fn(r.Context(), w, r)
		if err != nil {
			if r.URL.Path == "/api/sync" {
				rejectedSync.Add(1)
			}
			failedRequests.Add(1)
			var p problem
			if !errors.As(err, &p) {
				p = problem{500, "Datenbankvorgang fehlgeschlagen."}
				log.Printf("request failed %s %T", r.Pattern, err)
			}
			http.Error(w, p.message, p.code)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result)
	}
}
func read(r *http.Request, v any) error {
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if d.Decode(v) != nil || d.Decode(new(any)) != io.EOF {
		return fail("Ungültige Eingabe.")
	}
	return nil
}
func uuid() string {
	var b [16]byte
	rand.Read(b[:])
	b[6] = b[6]&15 | 64
	b[8] = b[8]&63 | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func secret() string {
	b := make([]byte, 32)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
func hash(s string) []byte { b := sha256.Sum256([]byte(s)); return b[:] }
func (a *app) auth(ctx context.Context, r *http.Request) (string, string, error) {
	name, pw, ok := r.BasicAuth()
	name = loginName(name)
	deny := problem{401, "Anmeldung fehlgeschlagen."}
	if !ok && r.URL.Path != "/api/login" {
		if c, err := r.Cookie("bonfire_session"); err == nil {
			var role string
			err = a.db.QueryRow(ctx, "SELECT u.name,u.role FROM sessions s JOIN users u ON u.name=s.username WHERE s.token=$1 AND s.expires>now() AND u.active", hash(c.Value)).Scan(&name, &role)
			if err == nil {
				return name, role, nil
			}
		}
	}
	if !ok || len(pw) > 72 {
		return "", "", deny
	}
	a.mu.Lock()
	if time.Now().After(a.reset) {
		clear(a.attempts)
		a.reset = time.Now().Add(time.Minute)
	}
	if a.attempts[name] >= 12 {
		a.mu.Unlock()
		return "", "", problem{429, "Bitte später erneut anmelden."}
	}
	a.attempts[name]++
	a.mu.Unlock()
	var digest, role string
	if err := a.db.QueryRow(ctx, "SELECT password,role FROM users WHERE name=$1 AND active", name).Scan(&digest, &role); err != nil || bcrypt.CompareHashAndPassword([]byte(digest), []byte(pw)) != nil {
		return "", "", deny
	}
	if err := a.factor(ctx, name, r.Header.Get("X-Bonfire-OTP")); err != nil {
		return "", "", err
	}
	a.mu.Lock()
	delete(a.attempts, name)
	a.mu.Unlock()
	return name, role, nil
}

type event struct {
	ID, Name, Starts, Ends    string
	Closed, Accounts, General bool
}

func (a *app) events(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	name, role, err := a.auth(ctx, r)
	if err != nil {
		return nil, err
	}
	if r.Method == "POST" {
		if role != "Leitung" {
			return nil, problem{403, "Nur für die Leitung."}
		}
		var e event
		if err = read(r, &e); err != nil {
			return nil, err
		}
		if strings.TrimSpace(e.Name) == "" || len(e.Name) > 160 || !date(e.Starts) || !date(e.Ends) || e.Ends < e.Starts {
			return nil, fail("Name und Zeitraum prüfen.")
		}
		e.ID = uuid()
		_, err = a.db.Exec(ctx, "INSERT INTO events(id,name,starts,ends,accounts,general_ledger) VALUES($1,$2,$3,$4,$5,$6)", e.ID, e.Name, e.Starts, e.Ends, e.Accounts, e.General)
		return e, err
	}
	rows, err := a.db.Query(ctx, "SELECT id::text,name,starts::text,ends::text,closed,accounts,general_ledger FROM events WHERE $1='Leitung' OR id IN (SELECT event FROM grants_event WHERE username=$2) ORDER BY starts DESC,name", role, name)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[event])
}
func (a *app) prepare(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	name, role, err := a.auth(ctx, r)
	if err != nil {
		return nil, err
	}
	var in struct {
		Event, Name  string
		Donor        bool
		DigitalCount *int64
	}
	if err = read(r, &in); err != nil {
		return nil, err
	}
	capacity := int64(1000)
	if in.DigitalCount != nil {
		capacity = *in.DigitalCount
	}
	if capacity < 0 || capacity > 1000 {
		return nil, fail("Zwischen 0 und 1000 Digitalnummern wählen.")
	}
	if len(in.Name) < 1 || len(in.Name) > 100 {
		return nil, fail("Gerätename fehlt.")
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock_shared(751025)"); err != nil {
		return nil, err
	}
	var e event
	err = tx.QueryRow(ctx, "SELECT id::text,name,starts::text,ends::text,closed,accounts,general_ledger FROM events WHERE id=$1 AND ($2='Leitung' OR EXISTS(SELECT 1 FROM grants_event WHERE event=$1 AND username=$3)) FOR UPDATE", in.Event, role, name).Scan(&e.ID, &e.Name, &e.Starts, &e.Ends, &e.Closed, &e.Accounts, &e.General)
	if err != nil || e.Closed {
		return nil, problem{403, "Veranstaltung gesperrt oder nicht zugewiesen."}
	}
	if in.Donor && role != "Leitung" {
		return nil, problem{403, "Meldedatenprofil nur für ausdrücklich berechtigte Leitung."}
	}
	id, token := uuid(), secret()
	var block int64
	expiry := time.Now().UTC().Add(72 * time.Hour)
	err = tx.QueryRow(ctx, "INSERT INTO devices(id,username,event,name,secret,expires,donor_access,digital_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING block", id, name, e.ID, in.Name, hash(token), expiry, in.Donor, capacity).Scan(&block)
	if err != nil {
		return nil, err
	}
	if role == "Leitung" {
		tag, err := tx.Exec(ctx, "UPDATE entries SET revision=revision+1,data=jsonb_set(data,'{Fields,owner}',to_jsonb($2::text)) WHERE event=$1 AND kind='wallet' AND data->'Fields'->>'owner'='unassigned'", e.ID, id)
		if err != nil {
			return nil, err
		}
		if tag.RowsAffected() > 0 {
			if err = audit(ctx, tx, e.ID, name, "Neue Geldtaschen aus Strukturkopie übernommen", id); err != nil {
				return nil, err
			}
		}
	}
	if err = audit(ctx, tx, e.ID, name, "Gerät vorbereitet", id); err != nil {
		return nil, err
	}
	return map[string]any{"device": id, "user": name, "role": role, "event": e, "token": token, "first": block * 1000, "limit": block*1000 + capacity - 1, "paperLimit": block*1000 + 999, "expires": expiry, "donorAccess": in.Donor}, tx.Commit(ctx)
}
func audit(ctx context.Context, tx pgx.Tx, event, user, act, subject string) error {
	_, err := tx.Exec(ctx, "INSERT INTO audit(event,username,action,subject) VALUES($1,$2,$3,$4)", event, user, act, subject)
	return err
}

type device struct {
	Donor                                bool
	ID, User, Role, Event, IncidentState string
	Block, Last, DigitalCount            int64
	Sealed, Closed, Accounts             bool
}

func lock(ctx context.Context, tx pgx.Tx, r *http.Request) (device, error) {
	var d device
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock_shared(751025)"); err != nil {
		return d, err
	}
	var digest []byte
	id, token, ok := strings.Cut(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), ".")
	if !ok {
		return d, problem{401, "Gerätefreigabe erforderlich."}
	}
	// Lock event before any reads of operations, balances or other device seals.
	err := tx.QueryRow(ctx, "SELECT e.id::text FROM events e JOIN devices d ON d.event=e.id WHERE d.id=$1 FOR UPDATE OF e", id).Scan(&d.Event)
	if err != nil {
		return d, problem{403, "Gerät unbekannt."}
	}
	err = tx.QueryRow(ctx, "SELECT d.id::text,d.username,u.role,d.block,d.last_seq,d.sealed,e.closed,e.accounts,d.secret,d.donor_access,d.incident_state,d.digital_count FROM devices d JOIN users u ON u.name=d.username JOIN events e ON e.id=d.event WHERE d.id=$1 AND u.active AND d.expires>now() AND (u.role='Leitung' OR EXISTS(SELECT 1 FROM grants_event g WHERE g.username=u.name AND g.event=e.id))", id).Scan(&d.ID, &d.User, &d.Role, &d.Block, &d.Last, &d.Sealed, &d.Closed, &d.Accounts, &digest, &d.Donor, &d.IncidentState, &d.DigitalCount)
	if err != nil || subtle.ConstantTimeCompare(digest, hash(token)) != 1 {
		return d, problem{403, "Gerätefreigabe abgelaufen oder entzogen."}
	}
	if d.IncidentState == "missing" || d.IncidentState == "incomplete" || (d.IncidentState == "returning" && r.URL.Path != "/api/sync") {
		return d, problem{403, "Gerätevorfall offen. Rückkehr durch Leitung bestätigen lassen."}
	}
	_, err = tx.Exec(ctx, "SELECT set_config('bonfire.device',$1,true)", d.ID)
	return d, err
}
func date(s string) bool { _, err := time.Parse("2006-01-02", s); return err == nil }
func initialize(ctx context.Context, db *pgxpool.Pool) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(751024)"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "CREATE TABLE IF NOT EXISTS migrations(version int PRIMARY KEY, digest text NOT NULL)"); err != nil {
		return err
	}
	sql, _ := migrations.ReadFile("migrations/001.sql")
	sum := migrationHash(sql, false)
	var saved string
	err = tx.QueryRow(ctx, "SELECT digest FROM migrations WHERE version=1").Scan(&saved)
	if errors.Is(err, pgx.ErrNoRows) {
		if _, err = tx.Exec(ctx, string(sql)); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "INSERT INTO migrations VALUES(1,$1)", sum); err != nil {
			return err
		}
		pw := os.Getenv("BONFIRE_ADMIN_PASSWORD")
		if len(pw) < 14 || len(pw) > 72 {
			return errors.New("Startpasswort muss 14 bis 72 Bytes umfassen")
		}
		digest, err := bcrypt.GenerateFromPassword([]byte(pw), 12)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "INSERT INTO users VALUES('leitung',$1,'Leitung',true)", string(digest)); err != nil {
			return err
		}
	} else if err != nil || (saved != sum && saved != migrationHash(sql, true)) {
		return errors.New("Migrationsstand nicht verifiziert")
	}
	upgrade, _ := migrations.ReadFile("migrations/002.sql")
	checksum := migrationHash(upgrade, false)
	err = tx.QueryRow(ctx, "SELECT digest FROM migrations WHERE version=2").Scan(&saved)
	if errors.Is(err, pgx.ErrNoRows) {
		if _, err = tx.Exec(ctx, string(upgrade)); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "INSERT INTO migrations VALUES(2,$1)", checksum); err != nil {
			return err
		}
	} else if err != nil || (saved != checksum && saved != migrationHash(upgrade, true)) {
		return errors.New("Migration 2 stimmt nicht überein")
	}
	if err = applyUpgrade(ctx, tx, 3, "migrations/003.sql"); err != nil {
		return err
	}
	if err = applyUpgrade(ctx, tx, 4, "migrations/004.sql"); err != nil {
		return err
	}
	if err = applyUpgrade(ctx, tx, 5, "migrations/005.sql"); err != nil {
		return err
	}
	if err = applyUpgrade(ctx, tx, 6, "migrations/006.sql"); err != nil {
		return err
	}
	if err = applyUpgrade(ctx, tx, 7, "migrations/007.sql"); err != nil {
		return err
	}
	if err = applyUpgrade(ctx, tx, 8, "migrations/008.sql"); err != nil {
		return err
	}
	if err = applyUpgrade(ctx, tx, 9, "migrations/009.sql"); err != nil {
		return err
	}
	if err = applyUpgrade(ctx, tx, 10, "migrations/010.sql"); err != nil {
		return err
	}
	if err = applyUpgrade(ctx, tx, 11, "migrations/011.sql"); err != nil {
		return err
	}
	if err = applyUpgrade(ctx, tx, 12, "migrations/012.sql"); err != nil {
		return err
	}
	if err = applyUpgrade(ctx, tx, 13, "migrations/013.sql"); err != nil {
		return err
	}
	if err = applyUpgrade(ctx, tx, 14, "migrations/014.sql"); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func main() {
	ctx := context.Background()
	db, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal("Datenbankkonfiguration ungültig")
	}
	defer db.Close()
	if len(os.Args) > 1 && os.Args[1] == "migrate" {
		if err = initialize(ctx, db); err != nil {
			log.Fatal(err)
		}
		if err = configureRuntime(ctx, db); err != nil {
			log.Fatal(err)
		}
		return
	}
	if err = db.Ping(ctx); err != nil {
		log.Fatal("Datenbank nicht bereit")
	}
	a := &app{db: db, attempts: map[string]int{}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/donation-reports", route(a.donationReports))
	mux.HandleFunc("POST /api/login", route(a.login))
	mux.HandleFunc("POST /api/logout", route(a.logout))
	mux.HandleFunc("POST /api/mfa", route(a.mfa))
	mux.HandleFunc("POST /api/manage", route(a.manage))
	mux.HandleFunc("GET /api/workplace", route(a.workplace))
	mux.HandleFunc("GET /api/events", route(a.events))
	mux.HandleFunc("POST /api/events", route(a.events))
	mux.HandleFunc("POST /api/prepare", route(a.prepare))
	mux.HandleFunc("POST /api/renew", route(a.renew))
	mux.HandleFunc("POST /api/sync", route(a.syncEvent))
	mux.HandleFunc("POST /api/access", route(a.access))
	mux.HandleFunc("POST /api/users", route(a.user))
	mux.HandleFunc("GET /health", route(func(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
		return "bereit", db.Ping(ctx)
	}))
	mux.HandleFunc("GET /metrics", a.metrics)
	mux.Handle("GET /", http.FileServer(http.Dir("dist")))
	protected := http.NewCrossOriginProtection().Handler(mux)
	server := &http.Server{Addr: ":8080", ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 45 * time.Second, WriteTimeout: 60 * time.Second, IdleTimeout: 90 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		if r.URL.Path == "/word-renderer.html" {
			w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-src 'self' about:; img-src data: blob:; font-src data:; frame-ancestors 'self'; object-src 'none'; base-uri 'none'; form-action 'none'")
		}
		protected.ServeHTTP(w, r)
	})}
	log.Fatal(server.ListenAndServe())
}
