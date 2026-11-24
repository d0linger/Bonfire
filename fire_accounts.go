package main

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type fireAccount struct {
	ID, Name string
	Active   bool
	Revision int
}
type localAccount struct {
	Event, Space, ID, Name, Master string
	Closed                         bool
}
type cashLine struct {
	Event, Space, Date, Label, Kind string
	Amount                          int64
}
type accountBalance struct {
	ID, Name                            string
	Shared                              bool
	Opening, Actual, PriorActual        *int64
	Incoming, Outgoing, Transfers, Soll int64
	Revision                            int
	Lines                               []cashLine
}

func (a *app) fireAccounts(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	opts := pgx.TxOptions{}
	if r.Method == "GET" {
		opts = pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}
	}
	tx, err := a.db.BeginTx(ctx, opts)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if r.Method == "POST" {
		if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(751025)"); err != nil {
			return nil, err
		}
	}
	user, err := accountManager(ctx, tx, r, r.Method == "POST")
	if err != nil {
		return nil, err
	}
	if r.Method == "GET" {
		records, err := tx.Query(ctx, "SELECT id::text,name,active,revision FROM fire_accounts ORDER BY lower(name)")
		if err != nil {
			return nil, err
		}
		masters, err := pgx.CollectRows(records, pgx.RowToStructByPos[fireAccount])
		if err != nil {
			return nil, err
		}
		records, err = tx.Query(ctx, `SELECT e.id::text,e.name,j.id,j.data->>'Label',coalesce(l.account::text,''),e.closed OR y.closed FROM entries j
   JOIN events e ON e.id=j.event JOIN fiscal_years y ON y.id=e.fiscal_year LEFT JOIN fire_account_links l ON l.event=e.id AND l.local_id=j.id
   WHERE j.kind IN ('account','wallet') ORDER BY y.starts DESC,e.name,j.data->>'Label'`)
		if err != nil {
			return nil, err
		}
		locals, err := pgx.CollectRows(records, pgx.RowToStructByPos[localAccount])
		return map[string]any{"accounts": masters, "locals": locals}, err
	}
	var q struct {
		Action, ID, Name, Event, Local, Year string
		Active                               bool
		Revision                             int
		Opening, Actual                      *int64
	}
	if err = read(r, &q); err != nil {
		return nil, err
	}
	var eventID any
	var action, subject string
	switch q.Action {
	case "create", "edit":
		name := strings.TrimSpace(q.Name)
		if name == "" || len(name) > 160 {
			return nil, fail("Kontonamen angeben.")
		}
		if q.Action == "create" {
			q.ID = uuid()
			_, err = tx.Exec(ctx, "INSERT INTO fire_accounts(id,name) VALUES($1,$2)", q.ID, name)
		} else {
			if !idPattern.MatchString(q.ID) {
				return nil, fail("Konto auswählen.")
			}
			tag, e := tx.Exec(ctx, "UPDATE fire_accounts SET name=$2,active=$3,revision=revision+1 WHERE id=$1 AND revision=$4", q.ID, name, q.Active, q.Revision)
			err = e
			if err == nil && tag.RowsAffected() != 1 {
				return nil, problem{409, "Kontostand geändert. Neu laden."}
			}
		}
		if err != nil {
			var dbErr *pgconn.PgError
			if errors.As(err, &dbErr) && dbErr.Code == "23505" {
				return nil, problem{409, "Kontoname bereits vergeben."}
			}
			return nil, err
		}
		action = "Feuerwehrkonto gepflegt"
		subject = q.ID + " · " + name
	case "link":
		if !idPattern.MatchString(q.ID) || !idPattern.MatchString(q.Event) {
			return nil, fail("Feuerwehrkonto und Arbeitsbereich auswählen.")
		}
		d, e := lockOnlineEvent(ctx, tx, r, q.Event)
		if e != nil {
			return nil, e
		}
		if d.Closed {
			return nil, problem{409, "Arbeitsbereich abgeschlossen."}
		}
		if err = checkYearSetup(ctx, tx, q.Event); err != nil {
			return nil, err
		}
		var name, start string
		if err = tx.QueryRow(ctx, "SELECT a.name,e.starts::text FROM fire_accounts a,events e WHERE a.id=$1 AND a.active AND e.id=$2", q.ID, q.Event).Scan(&name, &start); err != nil {
			return nil, fail("Aktives Konto auswählen.")
		}
		if q.Local == "" {
			var exists bool
			if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT FROM fire_account_links WHERE event=$1 AND account=$2)", q.Event, q.ID).Scan(&exists); err != nil {
				return nil, err
			}
			if exists {
				return true, tx.Commit(ctx)
			}
			q.Local = uuid()
			_, err = tx.Exec(ctx, "INSERT INTO entries(event,id,revision,device,kind,data) VALUES($1,$2,1,$3,'account',$4)", q.Event, q.Local, d.ID, data{Label: name, Date: start})
			if err != nil {
				return nil, err
			}
		}
		tag, e := tx.Exec(ctx, `INSERT INTO fire_account_links(event,local_id,account) SELECT event,id,$3 FROM entries WHERE event=$1 AND id=$2 AND kind IN ('account','wallet') ON CONFLICT DO NOTHING`, q.Event, q.Local, q.ID)
		if e != nil {
			return nil, e
		}
		if tag.RowsAffected() != 1 {
			return nil, problem{409, "Lokales Konto fehlt oder ist bereits zugeordnet."}
		}
		eventID = q.Event
		action = "Feuerwehrkonto zugeordnet"
		subject = q.Local + " → " + q.ID
	case "count", "carry":
		if !idPattern.MatchString(q.Year) || !idPattern.MatchString(q.ID) {
			return nil, fail("Geschäftsjahr und Konto auswählen.")
		}
		var ledger string
		err = tx.QueryRow(ctx, `SELECT e.id::text FROM events e JOIN fiscal_years y ON e.fiscal_year=y.id WHERE y.id=$1 AND NOT y.closed AND NOT e.closed AND e.general_ledger ORDER BY e.id LIMIT 1`, q.Year).Scan(&ledger)
		if err != nil {
			return nil, fail("Offenes Geschäftsjahr erforderlich.")
		}
		if q.Action == "carry" {
			err = tx.QueryRow(ctx, `SELECT c.actual FROM fire_year_counts c JOIN fiscal_years y ON y.id=c.year WHERE c.account=$1 AND c.actual IS NOT NULL AND y.closed AND y.id=(SELECT id FROM fiscal_years WHERE ends<(SELECT starts FROM fiscal_years WHERE id=$2) ORDER BY ends DESC LIMIT 1)`, q.ID, q.Year).Scan(&q.Opening)
			if err != nil {
				return nil, fail("Kein bestätigter Schlussbestand im unmittelbar vorherigen Geschäftsjahr.")
			}
		}
		for _, v := range []*int64{q.Opening, q.Actual} {
			if v != nil && (*v < 0 || *v > 999999999999) {
				return nil, fail("Bestand prüfen.")
			}
		}
		tag, e := tx.Exec(ctx, `INSERT INTO fire_year_counts(year,account,opening,actual,revision)
   SELECT $1,$2,$3::bigint,$4::bigint,1 WHERE EXISTS(SELECT FROM fire_account_links l JOIN events e ON e.id=l.event WHERE e.fiscal_year=$1 AND l.account=$2 AND e.accounts)
    AND ($5::integer=0 OR EXISTS(SELECT FROM fire_year_counts WHERE year=$1 AND account=$2 AND revision=$5))
   ON CONFLICT(year,account) DO UPDATE SET opening=excluded.opening,actual=CASE WHEN $6 AND excluded.actual IS NULL THEN fire_year_counts.actual ELSE excluded.actual END,revision=fire_year_counts.revision+1 WHERE fire_year_counts.revision=$5`, q.Year, q.ID, q.Opening, q.Actual, q.Revision, q.Action == "carry")
		if e != nil {
			return nil, e
		}
		if tag.RowsAffected() != 1 {
			return nil, problem{409, "Zuordnung oder Jahresstand geändert. Neu laden."}
		}
		eventID = ledger
		action = "Jahreskontenstand erfasst"
		display := func(n *int64) string {
			if n == nil {
				return "offen"
			}
			return strconv.FormatInt(*n, 10) + " Cent"
		}
		subject = q.ID + " · Anfang " + display(q.Opening) + " · Ist " + display(q.Actual)
	default:
		return nil, fail("Unbekannte Kontenaktion.")
	}
	if _, err = tx.Exec(ctx, "INSERT INTO audit(event,username,action,subject) VALUES($1,$2,$3,$4)", eventID, user, action, subject); err != nil {
		return nil, err
	}
	return q.ID, tx.Commit(ctx)
}

func yearAccountBalances(ctx context.Context, tx pgx.Tx, year string) ([]accountBalance, error) {
	rows, err := tx.Query(ctx, `SELECT e.id::text,e.name,e.general_ledger,e.accounts,j.kind,j.id,coalesce(j.data->>'Account',''),coalesce(j.data->>'To',''),
 coalesce((j.data->>'Amount')::bigint,0),j.data->>'Date',j.data->>'Label',coalesce(l.account::text,''),coalesce(a.name,'')
 FROM events e JOIN entries j ON j.event=e.id LEFT JOIN fire_account_links l ON l.event=e.id AND l.local_id=j.id LEFT JOIN fire_accounts a ON a.id=l.account
 WHERE e.fiscal_year=$1 AND (j.kind IN ('account','wallet','opening','actual') OR j.kind=ANY($2)) ORDER BY j.data->>'Date',e.id,j.id`, year, journalKinds)
	if err != nil {
		return nil, err
	}
	balances := map[string]*accountBalance{}
	linked := map[string]string{}
	names := map[string]string{}
	type booking struct {
		cashLine
		general, mode bool
		account, to   string
	}
	var entries []booking
	for rows.Next() {
		var b booking
		var id, master, name string
		if err = rows.Scan(&b.Event, &b.Space, &b.general, &b.mode, &b.Kind, &id, &b.account, &b.to, &b.Amount, &b.Date, &b.Label, &master, &name); err != nil {
			rows.Close()
			return nil, err
		}
		if b.Kind == "account" || b.Kind == "wallet" {
			key := b.Event + "/" + id
			names[key] = b.Label + " · " + b.Space
			if master != "" && b.mode {
				linked[key] = master
				balances[master] = &accountBalance{ID: master, Name: name, Shared: true}
			}
			continue
		}
		entries = append(entries, b)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	for _, b := range entries {
		balance := func(id string) *accountBalance {
			key := b.Event + "/" + id
			name := names[key]
			if !b.mode {
				key = b.Event
				name = b.Space + " · Gesamt"
			} else if master := linked[key]; master != "" {
				return balances[master]
			}
			if name == "" {
				name = b.Space + " · ohne Kontozuordnung"
			}
			if balances[key] == nil {
				balances[key] = &accountBalance{ID: key, Name: name}
			}
			return balances[key]
		}
		src := balance(b.account)
		n := b.Amount
		switch b.Kind {
		case "opening":
			if !src.Shared || b.general {
				if src.Opening == nil {
					src.Opening = new(int64)
				}
				*src.Opening += n
			}
		case "actual":
			if !src.Shared {
				if src.Actual == nil {
					src.Actual = new(int64)
				}
				*src.Actual += n
			}
		case "income", "payment", "donation", "presale", "card", "deposit":
			src.Incoming += n
		case "expense", "reimbursement", "fee", "refund", "deposit-return":
			src.Outgoing += n
		case "transfer", "return", "supply", "skim", "payout", "cashback":
			dest := balance(b.to)
			src.Transfers -= n
			dest.Transfers += n
			if dest != src {
				dest.Lines = append(dest.Lines, b.cashLine)
			}
		default:
			continue
		}
		src.Lines = append(src.Lines, b.cashLine)
	}
	rows, err = tx.Query(ctx, "SELECT c.account::text,c.opening,c.actual,c.revision,a.name FROM fire_year_counts c JOIN fire_accounts a ON a.id=c.account WHERE c.year=$1", year)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var opening, actual *int64
		var rev int
		var name string
		if err = rows.Scan(&id, &opening, &actual, &rev, &name); err != nil {
			return nil, err
		}
		if balances[id] == nil {
			balances[id] = &accountBalance{ID: id, Name: name, Shared: true}
		}
		{
			v := balances[id]
			if opening != nil {
				v.Opening = opening
			}
			v.Actual = actual
			v.Revision = rev
		}
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	prior, err := tx.Query(ctx, `SELECT c.account::text,c.actual FROM fire_year_counts c JOIN fiscal_years y ON y.id=c.year
    WHERE c.actual IS NOT NULL AND y.closed AND y.id=(SELECT id FROM fiscal_years WHERE ends<(SELECT starts FROM fiscal_years WHERE id=$1) ORDER BY ends DESC LIMIT 1)`, year)
	if err != nil {
		return nil, err
	}
	defer prior.Close()
	for prior.Next() {
		var id string
		var n int64
		if err = prior.Scan(&id, &n); err != nil {
			return nil, err
		}
		if b := balances[id]; b != nil {
			b.PriorActual = &n
		}
	}
	if err = prior.Err(); err != nil {
		return nil, err
	}
	result := make([]accountBalance, 0, len(balances))
	for _, v := range balances {
		v.Soll = v.Incoming - v.Outgoing + v.Transfers
		if v.Opening != nil {
			v.Soll += *v.Opening
		}
		result = append(result, *v)
	}
	slices.SortFunc(result, func(a, b accountBalance) int { return strings.Compare(a.Name, b.Name) })
	return result, rows.Err()
}

func (a *app) yearBalances(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	year := r.URL.Query().Get("year")
	if !idPattern.MatchString(year) {
		return nil, fail("Geschäftsjahr auswählen.")
	}
	tx, err := a.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = accountManager(ctx, tx, r, false); err != nil {
		return nil, err
	}
	return yearAccountBalances(ctx, tx, year)
}
