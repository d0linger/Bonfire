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
	"hash/maphash"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

//go:embed migrations/*.sql
var migrations embed.FS

type app struct {
	db                *pgxpool.Pool
	mu                sync.Mutex
	attempts          map[string]int
	overflowAttempts  bool
	verificationSlots chan struct{}
	reset             time.Time
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
				log.Printf("request handler failed (%T)", err)
			}
			http.Error(w, p.message, p.code)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(result); err != nil {
			failedRequests.Add(1)
		}
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
	return a.authenticate(ctx, a.db, r)
}

type authDB interface {
	factorExecutor
	QueryRow(context.Context, string, ...any) pgx.Row
}

func loginSource(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

const exactLoginCounters = 16384

var loginHashSeed = maphash.MakeSeed()

// Once exact storage fills, new keys share fixed, process-keyed buckets until expiry.
// Separate namespaces keep source pressure independent of account and pair limits.
func (a *app) counterKey(group, identity string) string {
	key := group + "|" + identity
	if _, exists := a.attempts[key]; exists || !a.overflowAttempts {
		return key
	}
	bucket := maphash.String(loginHashSeed, key) % 4096
	return "bucket|" + group + "|" + strconv.FormatUint(bucket, 10)
}

func (a *app) passwordCounters(r *http.Request, name string) (string, string, string) {
	source := loginSource(r)
	return a.counterKey("pair", source+"|"+name), a.counterKey("source", source), a.counterKey("account", name)
}

// A distributed burst tightens the per-source allowance on this account.
// A fresh source can still authenticate while the account is under pressure.
func (a *app) reservePasswordAttempt(r *http.Request, name string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if time.Now().After(a.reset) {
		clear(a.attempts)
		a.overflowAttempts = false
		a.reset = time.Now().Add(time.Minute)
	}
	if len(a.attempts)+3 > exactLoginCounters {
		a.overflowAttempts = true
	}
	pair, source, account := a.passwordCounters(r, name)
	limit := 12
	if a.attempts[account] >= 36 {
		limit = 2
	}
	if a.attempts[pair] >= limit || a.attempts[source] >= 60 {
		return false
	}
	a.attempts[pair]++
	a.attempts[source]++
	a.attempts[account]++
	return true
}

func (a *app) clearPasswordAttempts(r *http.Request, name string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	pair, source, account := a.passwordCounters(r, name)
	n := a.attempts[pair]
	if strings.HasPrefix(pair, "bucket|") && n > 1 {
		// Refund only this successful check in a shared bucket.
		a.attempts[pair]--
		n = 1
	} else {
		delete(a.attempts, pair)
	}
	for _, key := range []string{source, account} {
		if a.attempts[key] <= n {
			delete(a.attempts, key)
		} else {
			a.attempts[key] -= n
		}
	}
}

func (a *app) authenticate(ctx context.Context, db authDB, r *http.Request) (string, string, error) {
	name, pw, ok := r.BasicAuth()
	name = loginName(name)
	deny := problem{401, "Sign-in failed."}
	if !ok && r.URL.Path != "/api/login" {
		if c, err := r.Cookie("bonfire_session"); err == nil {
			var role string
			err = db.QueryRow(ctx, "SELECT u.name,u.role FROM sessions s JOIN users u ON u.name=s.username WHERE s.token=$1 AND s.expires>now() AND u.active AND NOT u.password_change_required", hash(c.Value)).Scan(&name, &role)
			if err == nil {
				return name, role, nil
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return "", "", err
			}
		}
	}
	if !ok || !validLoginName(name) || len(pw) > 72 {
		return "", "", deny
	}
	select {
	case a.verificationSlots <- struct{}{}:
		defer func() { <-a.verificationSlots }()
	default:
		return "", "", problem{429, "Sign-in is busy. Try again shortly."}
	}
	if !a.reservePasswordAttempt(r, name) {
		return "", "", problem{429, "Too many sign-in attempts. Try again shortly."}
	}
	var digest, role, account string
	query := "SELECT password,role,name FROM users WHERE coalesce(login_alias,name)=$1 AND active AND (NOT password_change_required OR $2)"
	if _, transactional := db.(pgx.Tx); transactional {
		query += " FOR UPDATE"
	}
	err := db.QueryRow(ctx, query, name, r.URL.Path == "/api/login").Scan(&digest, &role, &account)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", "", err
	}
	if err != nil || bcrypt.CompareHashAndPassword([]byte(digest), []byte(pw)) != nil {
		return "", "", deny
	}
	if err := factor(ctx, db, account, r.Header.Get("X-Bonfire-OTP")); err != nil {
		return "", "", err
	}
	a.clearPasswordAttempts(r, name)
	return account, role, nil
}

type event struct {
	ID, Name, Starts, Ends    string
	Closed, Accounts, General bool
	Year                      string
}

type listedEvent struct {
	event
	ReceiptsCents    *int64 `json:",omitempty"`
	PaidCents        *int64 `json:",omitempty"`
	OutstandingCents *int64 `json:",omitempty"`
}

func (a *app) events(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	name, role, err := a.auth(ctx, r)
	if err != nil {
		return nil, err
	}
	if r.Method == "POST" {
		if role != roleAdmin {
			return nil, problem{403, "Nur für Admins."}
		}
		var e event
		if err = read(r, &e); err != nil {
			return nil, err
		}
		e.Name = strings.TrimSpace(e.Name)
		if !validEventDetails(e.Name, e.Starts, e.Ends) {
			return nil, fail("Name und Zeitraum prüfen.")
		}
		return a.createEvent(ctx, name, e)
	}
	year := r.URL.Query().Get("year")
	if year != "" && !idPattern.MatchString(year) {
		return nil, fail("Geschäftsjahr ungültig.")
	}
	overview := r.URL.Query().Get("overview") == "1"
	rows, err := a.db.Query(ctx, `SELECT e.id::text,name,starts::text,ends::text,closed,accounts,general_ledger,coalesce(fiscal_year::text,''),
		t.receipts,t.paid,t.outstanding
	    FROM events e LEFT JOIN LATERAL (
			SELECT coalesce(sum(CASE WHEN kind='refund' THEN -amount ELSE amount END)
					FILTER (WHERE kind IN ('income','donation','payment','presale','card','refund')),0)::bigint AS receipts,
				coalesce(sum(amount) FILTER (WHERE kind IN ('expense','reimbursement','fee')),0)::bigint AS paid,
				coalesce(sum(CASE WHEN kind='outlay' THEN amount ELSE -amount END)
					FILTER (WHERE kind IN ('outlay','reimbursement')),0)::bigint AS outstanding
			FROM (SELECT kind,(data->>'Amount')::bigint AS amount FROM entries
				WHERE event=e.id AND $4 AND NOT e.general_ledger
				AND kind IN ('income','donation','payment','presale','card','refund','expense','reimbursement','fee','outlay')) AS amounts
		) t ON $4 AND NOT e.general_ledger
	    WHERE ($1='Admin' OR e.id IN (SELECT event FROM grants_event WHERE username=$2))
	    AND (($3='' AND NOT $4) OR fiscal_year IS NOT DISTINCT FROM nullif($3,'')::uuid)
	    ORDER BY general_ledger DESC,starts DESC,name,e.id`, role, name, year, overview)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (listedEvent, error) {
		var e listedEvent
		err := row.Scan(&e.ID, &e.Name, &e.Starts, &e.Ends, &e.Closed, &e.Accounts, &e.General, &e.Year,
			&e.ReceiptsCents, &e.PaidCents, &e.OutstandingCents)
		return e, err
	})
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
	err = tx.QueryRow(ctx, "SELECT id::text,name,starts::text,ends::text,closed,accounts,general_ledger,coalesce(fiscal_year::text,'') FROM events WHERE id=$1 AND ($2='Admin' OR EXISTS(SELECT 1 FROM grants_event WHERE event=$1 AND username=$3)) FOR UPDATE", in.Event, role, name).Scan(&e.ID, &e.Name, &e.Starts, &e.Ends, &e.Closed, &e.Accounts, &e.General, &e.Year)
	if err != nil || e.Closed {
		return nil, problem{403, "Veranstaltung gesperrt oder nicht zugewiesen."}
	}
	if in.Donor && role != roleAdmin {
		return nil, problem{403, "Meldedatenprofil nur für ausdrücklich berechtigte Admins."}
	}
	id, token := uuid(), secret()
	var block int64
	expiry := time.Now().UTC().Add(72 * time.Hour)
	err = tx.QueryRow(ctx, "INSERT INTO devices(id,username,event,name,secret,expires,donor_access,digital_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING block", id, name, e.ID, in.Name, hash(token), expiry, in.Donor, capacity).Scan(&block)
	if err != nil {
		return nil, err
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
	Sealed, Closed, Accounts, Online     bool
}

func lock(ctx context.Context, tx pgx.Tx, r *http.Request) (device, error) {
	var d device
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock_shared(751025)"); err != nil {
		return d, err
	}
	if r.URL.Path == "/api/online" || (r.URL.Path == "/api/manage" || r.URL.Path == "/api/donation-reports") && r.Header.Get("X-Bonfire-Event") != "" {
		return lockOnline(ctx, tx, r)
	}
	if !offlineEnabled() {
		return d, problem{403, "Offline-Erfassung ist deaktiviert."}
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
	err = tx.QueryRow(ctx, "SELECT d.id::text,d.username,u.role,d.block,d.last_seq,d.sealed,e.closed,e.accounts,d.secret,d.donor_access,d.incident_state,d.digital_count FROM devices d JOIN users u ON u.name=d.username JOIN events e ON e.id=d.event WHERE d.id=$1 AND NOT d.online_actor AND u.active AND NOT u.password_change_required AND d.expires>now() AND (u.role='Admin' OR EXISTS(SELECT 1 FROM grants_event g WHERE g.username=u.name AND g.event=e.id))", id).Scan(&d.ID, &d.User, &d.Role, &d.Block, &d.Last, &d.Sealed, &d.Closed, &d.Accounts, &digest, &d.Donor, &d.IncidentState, &d.DigitalCount)
	if err != nil || subtle.ConstantTimeCompare(digest, hash(token)) != 1 {
		return d, problem{403, "Gerätefreigabe abgelaufen oder entzogen."}
	}
	d.Donor = d.Donor && d.Role == roleAdmin
	if d.IncidentState == "missing" || d.IncidentState == "incomplete" || (d.IncidentState == "returning" && r.URL.Path != "/api/sync") {
		return d, problem{403, "Gerätevorfall offen. Rückkehr durch einen Admin bestätigen lassen."}
	}
	_, err = tx.Exec(ctx, "SELECT set_config('bonfire.device',$1,true)", d.ID)
	return d, err
}
func date(s string) bool {
	_, err := time.Parse("2006-01-02", s)
	return err == nil && s >= "0001-01-01"
}
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
	if err = applyUpgrade(ctx, tx, 15, "migrations/015.sql"); err != nil {
		return err
	}
	if err = applyUpgrade(ctx, tx, 16, "migrations/016.sql"); err != nil {
		return err
	}
	if err = applyUpgrade(ctx, tx, 17, "migrations/017.sql"); err != nil {
		return err
	}
	for version := 18; version <= 30; version++ {
		if err = applyUpgrade(ctx, tx, version, fmt.Sprintf("migrations/%03d.sql", version)); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
func main() {
	if len(os.Args) > 1 && os.Args[1] == "backup-worker" {
		if err := runBackupWorker(); err != nil {
			log.Fatal(err)
		}
		return
	}
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
	a := &app{db: db, attempts: map[string]int{}, verificationSlots: make(chan struct{}, 8)}
	mux := http.NewServeMux()
	a.registerBackup(mux)
	a.registerUsers(mux)
	a.registerAccountSecurity(mux)
	a.registerPasskeys(mux)
	a.registerAdminAudit(mux)
	mux.HandleFunc("POST /api/donation-reports", route(a.donationReports))
	mux.HandleFunc("POST /api/login", route(a.login))
	mux.HandleFunc("POST /api/logout", route(a.logout))
	mux.HandleFunc("POST /api/mfa", route(a.mfa))
	mux.HandleFunc("POST /api/manage", route(a.manage))
	mux.HandleFunc("GET /api/workplace", route(a.workplace))
	mux.HandleFunc("GET /api/events", route(a.events))
	mux.HandleFunc("GET /api/years", route(a.years))
	mux.HandleFunc("POST /api/years", route(a.years))
	mux.HandleFunc("POST /api/years/edit", route(a.editYear))
	mux.HandleFunc("GET /api/template-library", route(a.templateLibrary))
	mux.HandleFunc("GET /api/fire-accounts", route(a.fireAccounts))
	mux.HandleFunc("POST /api/fire-accounts", route(a.fireAccounts))
	mux.HandleFunc("GET /api/year-balances", route(a.yearBalances))
	mux.HandleFunc("POST /api/years/assign", route(a.assignYear))
	mux.HandleFunc("POST /api/events", route(a.events))
	mux.HandleFunc("POST /api/events/edit", route(a.editEvent))
	mux.HandleFunc("POST /api/events/delete", route(a.deleteEvent))
	mux.HandleFunc("GET /api/events/entries", route(a.eventInventory))
	mux.HandleFunc("POST /api/events/entries", route(a.changeEventEntry))
	a.registerCapture(mux)
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
	stopping, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	drained := make(chan struct{})
	go func() {
		<-stopping.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			log.Print("HTTP shutdown timed out")
		}
		close(drained)
	}()
	if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	<-drained
}
