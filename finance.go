package main

import (
	"context"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"slices"
	"strconv"
	"strings"
)

func walletRevenue(rows []row, wallet string) (int64, bool) {
	var start, end *int64
	var increments int64
	for _, r := range rows {
		v := r.Data
		if v.Wallet != wallet || v.Amount == nil || v.Method != "" && v.Method != "Bar" {
			continue
		}
		switch r.Kind {
		case "count":
			if v.Phase == "Anfang" {
				start = v.Amount
			} else if v.Phase == "Ende" {
				end = v.Amount
			}
		case "skim", "expense", "refund", "deposit-return":
			increments += *v.Amount
		case "supply", "income", "donation", "payment", "presale", "deposit":
			increments -= *v.Amount
		}
	}
	if start == nil || end == nil {
		return 0, false
	}
	return *end - *start + increments, true
}

func preconditions(ctx context.Context, tx pgx.Tx, d device, o op) (bool, error) {
	v := o.Data
	if o.Kind == "presale" && (v.Fields["saleQuantity"] != "" || v.Fields["unitCents"] != "") {
		q, e1 := strconv.ParseInt(v.Fields["saleQuantity"], 10, 64)
		u, e2 := strconv.ParseInt(v.Fields["unitCents"], 10, 64)
		if e1 != nil || e2 != nil || q < 1 || q > 1000000 || u < 0 || u > 999999999 || q*u != *v.Amount {
			return false, fail("Vorverkaufsmenge und Preis passen nicht zum Erlös.")
		}
	}
	if sale := v.Fields["sale"]; o.Kind == "expense" && sale != "" {
		var exists bool
		if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM entries WHERE event=$1 AND id=$2 AND kind='presale')", d.Event, sale).Scan(&exists); err != nil || !exists {
			return false, err
		}
	}
	if o.Kind == "card" || o.Kind == "fee" || o.Kind == "payout" {
		key := strings.TrimSpace(v.Fields["provider"])
		var priorKey string
		if o.Base > 0 {
			if err := tx.QueryRow(ctx, "SELECT coalesce(data->'Fields'->>'provider','') FROM entries WHERE event=$1 AND id=$2", d.Event, o.Target).Scan(&priorKey); err != nil {
				return false, err
			}
			if priorKey != "" && priorKey != key {
				return false, nil
			}
		}
		if key != "" {
			var balance int64
			err := tx.QueryRow(ctx, "SELECT coalesce(sum(CASE kind WHEN 'card' THEN 1 ELSE -1 END*(data->>'Amount')::bigint),0)::bigint FROM entries WHERE event=$1 AND kind IN ('card','fee','payout') AND data->'Fields'->>'provider'=$2 AND id<>$3", d.Event, key, o.Target).Scan(&balance)
			if err != nil {
				return false, err
			}
			if o.Kind == "card" {
				balance += *v.Amount
			} else {
				balance -= *v.Amount
			}
			if balance < 0 {
				return false, nil
			}
		}
	}
	if o.Kind == "paper" {
		return paperReference(ctx, tx, d, o)
	}
	if o.Kind == "price" && d.Role != roleAdmin {
		var approved bool
		if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM entries WHERE event=$1 AND id=$2 AND kind='price' AND data->>'Status'='Freigegeben')", d.Event, o.Target).Scan(&approved); err != nil {
			return false, err
		}
		if approved || v.Status == "Freigegeben" {
			return false, problem{403, "Preisfreigabe durch einen Admin erforderlich."}
		}
	}
	if o.Kind == "opening" && o.Base > 0 && v.Fields["previous"] == "" {
		var hasSource bool
		if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM entries WHERE event=$1 AND id=$2 AND coalesce(data->'Fields'->>'previous','')<>'')", d.Event, o.Target).Scan(&hasSource); err != nil || hasSource {
			return false, err
		}
	}
	if o.Kind == "opening" && v.Fields["previous"] != "" {
		p, err := prior(ctx, tx, v.Date)
		if err != nil {
			return false, err
		}
		n, ok := p.Actuals[v.Account]
		if !ok || p.ID != v.Fields["previous"] || v.Amount == nil || n != *v.Amount {
			return false, nil
		}
		if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", "opening:"+p.ID+":"+v.Account); err != nil {
			return false, err
		}
		var used bool
		err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM entries WHERE kind='opening' AND data->'Fields'->>'previous'=$1 AND data->>'Account'=$2 AND (event<>$3 OR id<>$4))", p.ID, v.Account, d.Event, o.Target).Scan(&used)
		if err != nil || used {
			return false, err
		}
	}
	if matter := v.Fields["matter"]; matter != "" {
		var duplicate bool
		err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM entries WHERE event=$1 AND id<>$2 AND (kind=$3 OR $3 IN ('income','donation','payment','presale','card') AND kind IN ('income','donation','payment','presale','card')) AND lower(trim(data->'Fields'->>'matter'))=lower(trim($4)))", d.Event, o.Target, o.Kind, matter).Scan(&duplicate)
		if err != nil || duplicate {
			return false, err
		}
	}
	if o.Kind == "dispatch" {
		var ok bool
		err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM entries j JOIN entries parent ON parent.event=j.event AND parent.id=j.data->>'Reference'
			WHERE j.event=$1 AND j.id=$2 AND j.kind='original' AND parent.kind IN ('sponsorship','payment'))`, d.Event, v.Reference).Scan(&ok)
		return ok, err
	}
	if strings.HasPrefix(o.Target, "import:") || strings.HasPrefix(v.Reference, "source:") {
		ok, err := importReference(ctx, tx, d.Event, o)
		if err != nil || !ok {
			return false, err
		}
	}
	for _, ref := range []struct{ id, kind string }{{v.Wallet, "wallet"}, {v.Bar, "bar"}, {v.Contact, "contact"}} {
		if ref.id == "" {
			continue
		}
		var exists bool
		var err error
		if ref.kind == "contact" {
			err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM directory WHERE id=$1 AND NOT coalesce((data->>'Retired')::boolean,false)) OR EXISTS(SELECT 1 FROM entries WHERE event=$2 AND id=$3 AND data->>'Contact'=$1)", ref.id, d.Event, o.Target).Scan(&exists)
		} else {
			err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM entries WHERE event=$1 AND id=$2 AND kind=$3)", d.Event, ref.id, ref.kind).Scan(&exists)
		}
		if err != nil || !exists {
			return false, err
		}
	}
	if o.Kind == "attachment" {
		var exists bool
		err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM entries WHERE event=$1 AND id=$2 AND kind<>'attachment')", d.Event, v.Reference).Scan(&exists)
		if err != nil || !exists {
			return false, err
		}
	}
	if o.Kind == "income" && v.Reference == "wallet-settlement" {
		if v.Wallet == "" || o.Target != "settlement:"+v.Wallet {
			return false, fail("Geldtaschenbezug ungültig.")
		}
		rows, err := tx.Query(ctx, "SELECT id,kind,device::text,revision,data FROM entries WHERE event=$1 AND data->>'Wallet'=$2 AND id<>$3", d.Event, v.Wallet, o.Target)
		if err != nil {
			return false, err
		}
		entries, err := pgx.CollectRows(rows, pgx.RowToStructByPos[row])
		if err != nil {
			return false, err
		}
		total, known := walletRevenue(entries, v.Wallet)
		if !known || v.Amount == nil || *v.Amount != total {
			return false, nil
		}
	}
	if o.Kind == "sponsorship" || o.Kind == "outlay" {
		var already int64
		child := "payment"
		if o.Kind == "outlay" {
			child = "reimbursement"
		}
		err := tx.QueryRow(ctx, "SELECT coalesce(sum(CASE WHEN data->'Allocations' ? $3 THEN (data->'Allocations'->>$3)::bigint WHEN data->>'Reference'=$3 AND NOT (data ? 'Allocations') THEN (data->>'Amount')::bigint ELSE 0 END),0)::bigint FROM entries WHERE event=$1 AND kind=$2", d.Event, child, o.Target).Scan(&already)
		if err != nil {
			return false, err
		}
		if already > *v.Amount {
			return false, nil
		}
	}
	if o.Kind == "payment" && v.Method == "Bar" && v.Wallet == "" {
		return false, fail("Tatsächliche Barkassa für den Zahlungseingang angeben.")
	}
	return true, nil
}

func validateSettlement(rows []row) error {
	if err := completeAttachments(rows); err != nil {
		return err
	}
	for _, r := range rows {
		if r.Kind != "wallet" {
			continue
		}
		var booked *int64
		var containsCount bool
		others := make([]row, 0, len(rows))
		for _, j := range rows {
			if j.ID == "settlement:"+r.ID {
				booked = j.Data.Amount
				continue
			}
			if j.Kind == "count" && j.Data.Wallet == r.ID {
				containsCount = true
			}
			others = append(others, j)
		}
		if !containsCount && booked == nil {
			continue
		}
		amount, ok := walletRevenue(others, r.ID)
		if !ok || booked == nil || *booked != amount {
			return fmt.Errorf("Geldtasche %s noch nicht vollständig abgerechnet", r.Data.Label)
		}
	}
	return nil
}

func (a *app) copyEvent(ctx context.Context, tx pgx.Tx, d device, name, start, end string) (string, error) {
	if d.Role != roleAdmin || len(name) == 0 || len(name) > 160 {
		return "", fail("Name und Adminrecht erforderlich.")
	}
	if (start != "" || end != "") && (!date(start) || !date(end) || end < start) {
		return "", fail("Gültigen Zielzeitraum angeben.")
	}
	id := uuid()
	err := tx.QueryRow(ctx, `WITH source AS (
		SELECT accounts,fiscal_year,coalesce(nullif($4,'')::date,starts) AS starts,
		coalesce(nullif($5,'')::date,ends) AS ends FROM events WHERE id=$3
	) INSERT INTO events(id,name,starts,ends,accounts,fiscal_year)
		SELECT $1,$2,s.starts,s.ends,s.accounts,y.id FROM source s LEFT JOIN fiscal_years y
		ON y.starts<=s.starts AND y.ends>=s.ends
		WHERE y.id IS NOT NULL OR (s.fiscal_year IS NULL AND $6)
		RETURNING starts::text`, id, name, d.Event, start, end, offlineEnabled()).Scan(&start)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fail("Für den Zielzeitraum zuerst ein passendes Geschäftsjahr anlegen.")
	}
	if err != nil {
		return "", err
	}
	if err = checkYearSetup(ctx, tx, id); err != nil {
		return "", err
	}
	rows, err := tx.Query(ctx, "SELECT id,kind,device::text,revision,data FROM entries WHERE event=$1 AND kind IN ('bar','wallet','price','template','shift') AND NOT coalesce((data->>'Retired')::boolean,false)", d.Event)
	if err != nil {
		return "", err
	}
	source, err := pgx.CollectRows(rows, pgx.RowToStructByPos[row])
	if err != nil {
		return "", err
	}
	ids := map[string]string{}
	for _, r := range source {
		ids[r.ID] = uuid()
	}
	for _, r := range source {
		v := r.Data
		v.Date = start
		if r.Kind == "wallet" {
			delete(v.Fields, "owner")
		}
		if r.Kind == "shift" {
			v.Fields = nil
			v.To = ""
			v.Status = "Geplant"
			v.Note = ""
		}
		if r.Kind == "template" {
			ids[r.ID] = "template:" + v.Reference
		}
		v.Bar = ids[v.Bar]
		v.Wallet = ids[v.Wallet]
		v.Contact = ""
		if r.Kind == "price" {
			v.Status = "Entwurf"
		}
		_, err = tx.Exec(ctx, "INSERT INTO entries VALUES($1,$2,1,$3,$4,$5)", id, ids[r.ID], d.ID, r.Kind, v)
		if err != nil {
			return "", err
		}
	}
	if err = audit(ctx, tx, id, d.User, "Veranstaltungsstruktur kopiert", d.Event); err != nil {
		return "", err
	}
	return id, nil
}

func (a *app) globalPeriod(ctx context.Context, tx pgx.Tx, d device, start, end string, history bool) (any, error) {
	if !date(start) || !date(end) || start > end {
		return nil, fail("Gültigen Zeitraum angeben.")
	}
	var year *string
	if err := tx.QueryRow(ctx, "SELECT fiscal_year::text FROM events WHERE id=$1", d.Event).Scan(&year); err != nil {
		return nil, err
	}
	if history {
		rows, err := tx.Query(ctx, `SELECT e.name AS veranstaltung,j.kind AS art,j.data->>'Date' AS datum,j.data->>'Label' AS bezeichnung,j.direction*(j.data->>'Amount')::bigint AS cent,
  CASE j.direction WHEN -1 THEN 'Storno' ELSE 'Buchung' END AS richtung,j.revision,j.actor AS akteur,j.recorded_at::text AS angenommen,o.local_time::text AS geraetezeit,
  o.device::text AS geraet,j.target AS vorgang FROM journal_history j JOIN event_records e ON e.id=j.event LEFT JOIN operations o ON o.id=j.operation
  WHERE j.data->>'Date' BETWEEN $1 AND $2 AND ($3='Admin' OR EXISTS (SELECT 1 FROM grants_event g WHERE g.event=e.id AND g.username=$4))
  AND ($5::uuid IS NULL OR e.fiscal_year=$5) ORDER BY j.id`, start, end, d.Role, d.User, year)
		if err != nil {
			return nil, err
		}
		return pgx.CollectRows(rows, pgx.RowToMap)
	}
	rows, err := tx.Query(ctx, `SELECT e.name AS veranstaltung,j.kind AS art,j.data->>'Date' AS datum,j.data->>'Label' AS bezeichnung,(j.data->>'Amount')::bigint AS cent
		FROM entries j JOIN events e ON e.id=j.event WHERE j.data->>'Date' BETWEEN $1 AND $2
		AND j.kind IN ('income','expense','refund','deposit','deposit-return','donation','payment','presale','card','fee','reimbursement','outlay','transfer','payout','supply','skim','return')
		AND ($3='Admin' OR e.id IN (SELECT event FROM grants_event WHERE username=$4))
		AND ($5::uuid IS NULL OR e.fiscal_year=$5) ORDER BY datum,e.name,j.id`, start, end, d.Role, d.User, year)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToMap)
}

var journalKinds = strings.Fields("income expense refund deposit deposit-return transfer payment donation reimbursement card fee payout presale supply skim return")

func retainPrior(ctx context.Context, tx pgx.Tx, d device, o op) error {
	if !slices.Contains(journalKinds, o.Kind) {
		return nil
	}
	if o.Base > 0 {
		_, err := tx.Exec(ctx, "INSERT INTO journal_history(event,target,operation,revision,direction,kind,data,actor) SELECT event,id,$3,revision,-1,kind,data,$4 FROM entries WHERE event=$1 AND id=$2", d.Event, o.Target, o.ID, d.User)
		if err != nil {
			return err
		}
		if err = audit(ctx, tx, d.Event, d.User, "Storno und Ersatz · "+o.Data.Note, o.ID); err != nil {
			return err
		}
	}
	_, err := tx.Exec(ctx, "INSERT INTO journal_history(event,target,operation,revision,direction,kind,data,actor) VALUES($1,$2,$3,$4,1,$5,$6,$7)", d.Event, o.Target, o.ID, o.Base+1, o.Kind, o.Data, d.User)
	return err
}
