package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/csv"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

var processStarted = time.Now()

var serverBuild = sync.OnceValue(func() string {
	path, err := os.Executable()
	if err != nil {
		return "Unbekannt"
	}
	file, err := os.Open(path)
	if err != nil {
		return "Unbekannt"
	}
	defer file.Close()
	h := sha256.New()
	if _, err = io.Copy(h, file); err != nil {
		return "Unbekannt"
	}
	return fmt.Sprintf("%x", h.Sum(nil)[:8])
})

// Log the established account, never the credentials or a freely supplied identity.
func (a *app) logDeniedLogin(ctx context.Context, r *http.Request) error {
	name, _, basic := r.BasicAuth()
	if basic {
		_, err := a.db.Exec(ctx, `INSERT INTO audit(username,action,subject)
			SELECT name,'Anmeldung abgewiesen','Passwort oder zweiter Faktor' FROM users WHERE coalesce(login_alias,name)=$1`, loginName(name))
		return err
	}
	if token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bonfire-Challenge "); ok {
		_, err := a.db.Exec(ctx, `INSERT INTO audit(username,action,subject)
			SELECT username,'Anmeldung abgewiesen','Zweiter Faktor' FROM login_challenges WHERE token=$1`, hash(token))
		return err
	}
	return nil
}

func (a *app) registerAdminAudit(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/admin/audit", route(a.adminAudit))
	mux.HandleFunc("POST /api/admin/audit/export", route(a.adminAudit))
	mux.HandleFunc("GET /api/admin/audit/integrity", route(a.adminIntegrity))
	mux.HandleFunc("GET /api/admin/status", route(a.adminStatus))
}

func (a *app) auditAccess(ctx context.Context, r *http.Request, allowReview bool) (string, string, error) {
	cookie, err := r.Cookie("bonfire_session")
	if err != nil || cookie.Value == "" || r.Header.Get("Authorization") != "" {
		return "", "", problem{401, "Persönliche Anmeldung erforderlich."}
	}
	user, role, err := a.auth(ctx, r)
	if err == nil && role != "Leitung" && !(allowReview && role == "Prüfung") {
		return "", "", problem{403, "Keine Berechtigung für diesen Bereich."}
	}
	return user, role, err
}

type auditEntry struct {
	ID                                                        int64
	At                                                        time.Time
	User, Action, Subject, Event, Year, Source, Kind, Outcome string
	Base, Revision                                            *int64
	PreviousCents, Cents                                      *int64
	LocalTime                                                 *time.Time
	Origin, Destination, Reason                               string
}

const auditJoins = ` FROM audit a
 LEFT JOIN event_records e ON e.id=a.event
 LEFT JOIN fiscal_years y ON y.id=e.fiscal_year
 LEFT JOIN operations o ON o.event=a.event AND o.id=CASE WHEN a.subject ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN a.subject::uuid END
 LEFT JOIN devices d ON d.id=coalesce(a.actor_device,o.device)
 `

// Older audit entries may contain a free-text reason after the action.
// Keep reasons separate and expose financial data through specific allowlisted fields.
const auditProjection = `WITH projected AS (
 SELECT a.id,a.at,a.username AS "user",
 CASE WHEN a.action LIKE 'Storno und Ersatz · %' THEN 'Geldbewegung berichtigt'
      WHEN a.action LIKE 'Backup · %' OR a.action LIKE 'Spendenprüflauf · %' THEN left(a.action,180)
      WHEN a.action IN ('Übernommen','Konflikt') AND o.kind IS NOT NULL THEN
        CASE WHEN o.kind='original' THEN 'Belegausgabe'
             WHEN o.kind IN ('income','expense','payment','transfer','supply','skim','return','donation','card','fee','payout','refund','deposit','deposit-return','reimbursement','presale') THEN 'Geldbewegung'
             ELSE 'Facheintrag' END || ' · ' || a.action
      WHEN a.action LIKE 'grant %' THEN 'Zugriff zugewiesen'
      WHEN a.action LIKE 'revoke %' THEN 'Zugriff entzogen'
      WHEN a.action LIKE 'reopen %' THEN 'Arbeitsbereich wieder geöffnet'
      ELSE left(split_part(split_part(a.action,' · ',1),': ',1),160) END AS action,
 left(coalesce(o.target,a.subject),256) AS subject, coalesce(e.name,'') AS event, coalesce(y.name,'') AS year,
 CASE WHEN d.online_actor THEN 'Online-Arbeitsplatz' WHEN d.id IS NOT NULL THEN d.name
      WHEN a.username='System' THEN 'System' ELSE 'Server' END AS source,
 coalesce(o.kind,'') AS kind,
 CASE WHEN a.action IN ('Übernommen','Konflikt') THEN a.action
      WHEN a.action LIKE 'Backup · % failed' THEN 'Fehlgeschlagen'
      WHEN a.action LIKE 'Backup · % ok' THEN 'Erfolgreich'
      WHEN a.action='Anmeldung abgewiesen' THEN 'Abgewiesen'
      ELSE coalesce(o.outcome,'') END AS outcome, o.base,
 o.local_time, a.event AS event_id,e.fiscal_year AS year_id,o.id AS op_id,
 CASE WHEN a.action LIKE ANY(ARRAY['Eintrag entfernt · %','Buchung storniert · %','Eintrag umgebucht · %','Umbuchung aus Veranstaltung · %'])
      THEN substr(a.action,strpos(a.action,' · ')+3)
      WHEN a.action LIKE 'Storno und Ersatz · %' THEN substr(a.action,length('Storno und Ersatz · ')+1)
      WHEN a.action LIKE 'beibehalten: %' OR a.action LIKE 'übernehmen: %' OR a.action LIKE 'Periode wieder geöffnet: %' THEN substr(a.action,strpos(a.action,': ')+2)
      WHEN a.event IS NULL AND a.action NOT LIKE 'Backup · %' AND strpos(a.action,' · ')>0 THEN substr(a.action,strpos(a.action,' · ')+3)
      WHEN a.action LIKE 'grant %' OR a.action LIKE 'revoke %' OR a.action LIKE 'reopen %' THEN substr(a.action,strpos(a.action,' ')+1)
      ELSE '' END AS reason
 ` + auditJoins + `
 WHERE ($1='Leitung' OR EXISTS (SELECT 1 FROM grants_event g WHERE g.event=a.event AND g.username=$2))
 AND ($3='' OR e.fiscal_year=nullif($3,'')::uuid) AND ($4='' OR a.event=nullif($4,'')::uuid)
 AND ($5='' OR a.username=$5)
 AND ($6='' OR a.at >= (nullif($6,'')::date::timestamp AT TIME ZONE 'Europe/Vienna'))
 AND ($7='' OR a.at < ((nullif($7,'')::date+1)::timestamp AT TIME ZONE 'Europe/Vienna'))
 AND ($8::bigint=0 OR a.id<$8)
), page AS (
 SELECT * FROM projected WHERE ($9='' OR ('#' || id::text)=$9 OR strpos(lower(concat_ws(' ',action,subject,event,year,"user",kind,outcome,id::text)),lower($9))>0)
 AND ($10='' OR strpos(lower(action),lower($10))>0)
 AND ($11='' OR outcome=$11)
 ORDER BY id DESC LIMIT $12)
 SELECT p.id,p.at,p."user",p.action,p.subject,p.event,p.year,p.source,p.kind,p.outcome,p.base,
 after.revision, (prior.data->>'Amount')::bigint AS previous_cents,(after.data->>'Amount')::bigint AS cents,p.local_time,
 coalesce(src.data->>'Label',after.data->>'Account','') AS origin,
 coalesce(dst.data->>'Label',after.data->>'To','') AS destination, left(p.reason,500) AS reason
 FROM page p LEFT JOIN LATERAL (SELECT revision,data FROM journal_history WHERE event=p.event_id AND operation=p.op_id AND direction=1 ORDER BY id DESC LIMIT 1) after ON true
 LEFT JOIN LATERAL (SELECT data FROM journal_history WHERE event=p.event_id AND operation=p.op_id AND direction=-1 ORDER BY id DESC LIMIT 1) prior ON true
 LEFT JOIN entries src ON src.event=p.event_id AND src.id=after.data->>'Account' AND src.kind IN ('wallet','account')
 LEFT JOIN entries dst ON dst.event=p.event_id AND dst.id=after.data->>'To' AND dst.kind IN ('wallet','account')
 ORDER BY p.id DESC`

var sensitiveReason = regexp.MustCompile(`(?i)(passwor[dt]|kennwort|secret|token|otp|recovery|wiederherstellungscode|geburt|iban|[a-z]{2}[0-9]{2}[ ]?[0-9]{4}|[\w.+-]+@[\w.-]+\.[a-z]{2,})`)

func (a *app) adminAudit(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	user, role, err := a.auditAccess(ctx, r, true)
	if err != nil {
		return nil, err
	}
	q := r.URL.Query()
	export := r.Method == http.MethodPost
	limit := 50
	if export {
		limit = 10000
	}
	before := int64(0)
	if !export && q.Get("before") != "" {
		before, err = strconv.ParseInt(q.Get("before"), 10, 64)
		if err != nil || before < 1 {
			return nil, fail("Seitengrenze ungültig.")
		}
	}
	for _, name := range []string{"year", "event"} {
		if val := q.Get(name); val != "" && !idPattern.MatchString(val) {
			return nil, fail("Arbeitsbereich oder Geschäftsjahr ungültig.")
		}
	}
	for _, name := range []string{"from", "until"} {
		if v := q.Get(name); v != "" && !date(v) {
			return nil, fail("Ungültiges Datum.")
		}
	}
	if q.Get("until") != "" && q.Get("from") > q.Get("until") {
		return nil, fail("Datumsbereich prüfen.")
	}
	for _, k := range []string{"q", "user", "action", "outcome"} {
		if len(q.Get(k)) > 256 {
			return nil, fail("Suchtext zu lang.")
		}
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, auditProjection, role, user, q.Get("year"), q.Get("event"), q.Get("user"),
		q.Get("from"), q.Get("until"), before, strings.TrimSpace(q.Get("q")), q.Get("action"), q.Get("outcome"), limit+1)
	if err != nil {
		return nil, err
	}
	items, err := pgx.CollectRows(rows, pgx.RowToStructByPos[auditEntry])
	if err != nil {
		return nil, err
	}
	for i, item := range items {
		if item.Kind == "donation" || sensitiveReason.MatchString(item.Reason) {
			items[i].Reason = ""
			if item.Reason != "" {
				items[i].Reason = "Sensible Angabe ausgeblendet."
			}
		}
	}
	more := len(items) > limit
	if export {
		if more {
			return nil, fail("Export auf 10.000 Einträge begrenzt. Zeitraum oder Filter eingrenzen.")
		}
		out, err := auditCSV(items)
		if err != nil {
			return nil, err
		}
		_, err = tx.Exec(ctx, "INSERT INTO audit(username,action,subject) VALUES($1,'Audit-CSV exportiert',$2)", user, fmt.Sprintf("%d Einträge", len(items)))
		if err != nil {
			return nil, err
		}
		return map[string]string{"csv": out}, tx.Commit(ctx)
	}
	if more {
		items = items[:limit]
	}
	return map[string]any{"rows": items, "more": more}, tx.Commit(ctx)
}

func csvText(s string) string {
	t := strings.TrimLeft(s, " \t\r\n")
	if t != "" && strings.ContainsAny(t[:1], "=+-@") || strings.HasPrefix(s, "\t") || strings.HasPrefix(s, "\r") || strings.HasPrefix(s, "\n") {
		return "'" + s
	}
	return s
}

func auditCSV(items []auditEntry) (string, error) {
	var b bytes.Buffer
	b.WriteString("\uFEFF")
	w := csv.NewWriter(&b)
	w.Comma = ';'
	w.UseCRLF = true
	err := w.Write([]string{"Ereignis", "Serverzeit (UTC)", "Benutzer", "Aktion", "Geschäftsjahr", "Arbeitsbereich", "Objekt", "Herkunft", "Art", "Ergebnis", "Ausgangsrevision", "Zielrevision", "Vorher (Cent)", "Nachher (Cent)", "Quellkonto", "Zielkonto", "Begründung", "Lokale Zeit (UTC)"})
	num := func(n *int64) string {
		if n == nil {
			return ""
		}
		return strconv.FormatInt(*n, 10)
	}
	for _, e := range items {
		local := ""
		if e.LocalTime != nil {
			local = e.LocalTime.UTC().Format(time.RFC3339)
		}
		record := []string{strconv.FormatInt(e.ID, 10), e.At.UTC().Format(time.RFC3339), e.User, e.Action, e.Year, e.Event, e.Subject, e.Source, e.Kind, e.Outcome, num(e.Base), num(e.Revision), num(e.PreviousCents), num(e.Cents), e.Origin, e.Destination, e.Reason, local}
		for i := range record {
			record[i] = csvText(record[i])
		}
		if err == nil {
			err = w.Write(record)
		}
	}
	w.Flush()
	if err == nil {
		err = w.Error()
	}
	return b.String(), err
}

type auditChainCheck struct {
	Lane    string
	Entries int64
	OK      bool
}

func (a *app) chainChecks(ctx context.Context) ([]auditChainCheck, error) {
	// Check adjacency, the recorded head, recomputed content hashes and any unsealed rows in one snapshot.
	rows, err := a.db.Query(ctx, `WITH links AS(
	  SELECT s.*,lag(s.digest,1,''::bytea) OVER(PARTITION BY s.lane ORDER BY s.position) AS previous,
	    row_number() OVER(PARTITION BY s.lane ORDER BY s.position) AS expected FROM audit_seals s)
	  SELECT h.lane,h.position,
	    h.position=count(l.audit_id) AND coalesce(bool_and(l.position=l.expected AND
	     l.digest=audit_row_hash(l.previous,l.lane,l.position,a,l.history_limit,l.has_operation) AND
	     l.lane=CASE WHEN a.event IS NULL THEN 'Betrieb' ELSE 'Finanzen' END),true)
	    AND h.digest=coalesce((SELECT s.digest FROM audit_seals s WHERE s.lane=h.lane ORDER BY s.position DESC LIMIT 1),''::bytea)
	    AND NOT EXISTS(SELECT FROM audit u LEFT JOIN audit_seals s ON s.audit_id=u.id WHERE s.audit_id IS NULL
	      AND h.lane=CASE WHEN u.event IS NULL THEN 'Betrieb' ELSE 'Finanzen' END)
	  FROM audit_chain_heads h LEFT JOIN links l ON l.lane=h.lane LEFT JOIN audit a ON a.id=l.audit_id
	  GROUP BY h.lane,h.position,h.digest ORDER BY h.lane`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[auditChainCheck])
}

func (a *app) adminIntegrity(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	if _, _, err := a.auditAccess(ctx, r, false); err != nil {
		return nil, err
	}
	checks, err := a.chainChecks(ctx)
	return map[string]any{"chains": checks, "at": time.Now().UTC()}, err
}

func (a *app) adminStatus(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	if _, _, err := a.auditAccess(ctx, r, false); err != nil {
		return nil, err
	}
	var version string
	var schema int
	var size, sessions, conflicts int64
	err := a.db.QueryRow(ctx, `SELECT current_setting('server_version'),pg_database_size(current_database()),
	  (SELECT max(version) FROM migrations),(SELECT count(*) FROM sessions WHERE expires>now()),
	  (SELECT count(*) FROM operations WHERE outcome='Konflikt')`).Scan(&version, &size, &schema, &sessions, &conflicts)
	if err != nil {
		return nil, err
	}
	chains, err := a.chainChecks(ctx)
	if err != nil {
		return nil, err
	}
	stat := a.db.Stat()
	return map[string]any{"at": time.Now().UTC(), "started": processStarted.UTC(), "runtime": runtime.Version(),
		"build": serverBuild(), "postgres": version, "databaseBytes": size, "schema": schema, "sessions": sessions, "conflicts": conflicts,
		"openConnections": stat.TotalConns(), "usedConnections": stat.AcquiredConns(), "maxConnections": stat.MaxConns(),
		"offline": offlineEnabled(), "chains": chains, "appDisk": appDiskCapacity(), "failedRequests": failedRequests.Load()}, nil
}
