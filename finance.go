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

const pooledSettlement = "settlement-total"

// A return hands over the previously counted closing balance. Only movements
// before that count adjust the cash takings.
func cashAdjustment(r row, includes func(string) bool, pooled bool) int64 {
	v := r.Data
	if v.Amount == nil || v.Method != "" && v.Method != "Bar" {
		return 0
	}
	n := *v.Amount
	var adjustment int64
	switch r.Kind {
	case "supply", "skim", "transfer", "cashback":
		from, to := v.Account, v.To
		if r.Kind == "supply" {
			to = v.Wallet
		} else if r.Kind == "skim" || r.Kind == "cashback" {
			from = v.Wallet
		}
		if includes(from) {
			adjustment += n
		}
		if includes(to) {
			adjustment -= n
		}
	default:
		assigned := includes(v.Wallet)
		if v.Wallet == "" && v.Method == "Bar" {
			assigned = includes(v.Account) || (pooled && v.Account == "")
		}
		if !assigned {
			return 0
		}
		switch r.Kind {
		case "expense", "refund", "deposit-return":
			return n
		case "income", "donation", "payment", "presale", "deposit":
			return -n
		}
	}
	return adjustment
}

func withinCount(movement, closing data) bool {
	if closing.Date == "" || movement.Date != closing.Date {
		return closing.Date == "" || movement.Date < closing.Date
	}
	return movement.PostingOrder == 0 || closing.PostingOrder == 0 || movement.PostingOrder <= closing.PostingOrder
}

func unknownOrder(movement, boundary data) bool {
	return boundary.Date != "" && movement.Date == boundary.Date && (boundary.PostingOrder == 0 || movement.PostingOrder == 0)
}

func afterOpening(movement, opening data) bool {
	if movement.Date != opening.Date {
		return opening.Date == "" || movement.Date > opening.Date
	}
	return movement.PostingOrder == 0 || opening.PostingOrder == 0 || movement.PostingOrder > opening.PostingOrder
}

func walletRevenue(rows []row, wallet string) (int64, bool) {
	var start, end *int64
	var opening, cutoff data
	for _, r := range rows {
		v := r.Data
		if r.Kind == "count" && v.Wallet == wallet {
			if v.Phase == "Anfang" {
				start = v.Amount
				opening = v
			} else if v.Phase == "Ende" {
				end = v.Amount
				cutoff = v
			}
		}
	}
	if start == nil || end == nil {
		return 0, false
	}
	total := *end - *start
	for _, r := range rows {
		if afterOpening(r.Data, opening) && withinCount(r.Data, cutoff) {
			adjustment := cashAdjustment(r, func(id string) bool { return id != "" && id == wallet }, false)
			if adjustment != 0 && (unknownOrder(r.Data, opening) || unknownOrder(r.Data, cutoff)) {
				return 0, false
			}
			total += adjustment
		}
	}
	return total, true
}

func pooledRevenue(rows []row) (int64, bool) {
	wallets := map[string]bool{}
	openings := map[string]data{}
	var opening, cutoff data
	var start, end *int64
	for _, r := range rows {
		v := r.Data
		switch {
		case r.Kind == "wallet":
			wallets[r.ID] = true
		case strings.HasPrefix(r.ID, "settlement:"):
			return 0, false
		case r.Kind != "count" || v.Amount == nil:
			continue
		case v.Fields["countScope"] == "all":
			if v.Phase == "Anfang" {
				start = v.Amount
				opening = v
			} else if v.Phase == "Ende" {
				end = v.Amount
				cutoff = v
			}
		case v.Phase == "Anfang":
			openings[v.Wallet] = v
		case v.Phase == "Ende":
			return 0, false
		}
	}
	if end == nil || start != nil && len(openings) > 0 {
		return 0, false
	}
	total := *end
	if start != nil {
		total -= *start
	} else {
		if len(wallets) == 0 || len(openings) != len(wallets) {
			return 0, false
		}
		for id := range wallets {
			n, ok := openings[id]
			if !ok {
				return 0, false
			}
			total -= *n.Amount
		}
	}
	for _, r := range rows {
		if r.ID == pooledSettlement || !withinCount(r.Data, cutoff) || !afterOpening(r.Data, opening) {
			continue
		}
		unassigned := true
		if start == nil && r.Data.Wallet == "" && r.Data.Account == "" && cashAdjustment(r, func(string) bool { return false }, true) != 0 {
			active := 0
			for _, o := range openings {
				if unknownOrder(r.Data, o) {
					return 0, false
				}
				if afterOpening(r.Data, o) {
					active++
				}
			}
			if active > 0 && active < len(openings) {
				return 0, false
			}
			unassigned = active == len(openings)
		}
		uncertain := false
		adjustment := cashAdjustment(r, func(id string) bool {
			if !wallets[id] {
				return false
			}
			if unknownOrder(r.Data, openings[id]) && cashAdjustment(r, func(candidate string) bool { return candidate == id }, false) != 0 {
				uncertain = true
			}
			return afterOpening(r.Data, openings[id])
		}, unassigned)
		if uncertain || adjustment != 0 && (unknownOrder(r.Data, opening) || unknownOrder(r.Data, cutoff)) {
			return 0, false
		}
		total += adjustment
	}
	return total, true
}

func preconditions(ctx context.Context, tx pgx.Tx, d device, o op) (bool, error) {
	v := o.Data
	if o.Kind == "count" && v.Phase != "Zwischenstand" {
		var overlap bool
		err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT FROM entries WHERE event=$1 AND kind='count'
			AND data->>'Phase' IN ('Anfang','Ende')
			AND (coalesce(data->'Fields'->>'countScope','')='all') <> $2
			AND (data->>'Phase'=$3 OR ($2 AND $3='Anfang') OR (NOT $2 AND data->>'Phase'='Anfang')))`,
			d.Event, v.Fields["countScope"] == "all", v.Phase).Scan(&overlap)
		if err != nil || overlap {
			return false, err
		}
	}
	if o.Kind == "presale" && (v.Fields["saleQuantity"] != "" || v.Fields["unitCents"] != "") {
		q, e1 := strconv.ParseInt(v.Fields["saleQuantity"], 10, 64)
		u, e2 := strconv.ParseInt(v.Fields["unitCents"], 10, 64)
		if e1 != nil || e2 != nil || q < 1 || q > 1000000 || u < 0 || u > 999999999 || q*u != *v.Amount {
			return false, fail("The advance sale quantity and price do not match the proceeds.")
		}
	}
	if sale := v.Fields["sale"]; o.Kind == "expense" && sale != "" {
		var exists bool
		if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM entries WHERE event=$1 AND id=$2 AND kind='presale')", d.Event, sale).Scan(&exists); err != nil || !exists {
			return false, err
		}
	}
	if o.Kind == "card" || o.Kind == "fee" || o.Kind == "payout" || o.Kind == "cashback" {
		key := strings.TrimSpace(v.Fields["provider"])
		if o.Kind == "cashback" && (key == "" || v.Wallet == "" || v.Account != v.Wallet || v.Method != "" && v.Method != "Bar") {
			return false, fail("Select the terminal, payout wallet and terminal clearing account.")
		}
		if o.Kind == "cashback" && d.Accounts {
			var terminal bool
			if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT FROM entries WHERE event=$1 AND id=$2 AND kind='account')", d.Event, v.To).Scan(&terminal); err != nil {
				return false, err
			}
			if !terminal {
				return false, fail("Select an account for card terminal settlement.")
			}
		}
		var priorKey string
		if o.Base > 0 {
			if err := tx.QueryRow(ctx, "SELECT coalesce(data->'Fields'->>'provider','') FROM entries WHERE event=$1 AND id=$2", d.Event, o.Target).Scan(&priorKey); err != nil {
				return false, err
			}
			priorKey = strings.TrimSpace(priorKey)
			if priorKey != "" && priorKey != key {
				return false, nil
			}
		}
		if key != "" {
			var balance int64
			err := tx.QueryRow(ctx, "SELECT coalesce(sum(CASE WHEN kind IN ('card','cashback') THEN 1 ELSE -1 END*(data->>'Amount')::bigint),0)::bigint FROM entries WHERE event=$1 AND kind IN ('card','fee','payout','cashback') AND btrim(data->'Fields'->>'provider',$4)=$2 AND id<>$3", d.Event, key, o.Target, trimWhitespace).Scan(&balance)
			if err != nil {
				return false, err
			}
			if o.Kind == "card" || o.Kind == "cashback" {
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
			return false, problem{403, "An administrator must approve the price."}
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
		err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM entries WHERE kind='opening' AND (data->'Fields'->>'yearPeriod'=$1 OR (data->'Fields'->>'previous'=$1 AND data->>'Account'=$2 AND (event<>$3 OR id<>$4))))", p.ID, v.Account, d.Event, o.Target).Scan(&used)
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
			err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM directory c WHERE c.id=$3 AND ("+contactVisible+" OR ($5 AND "+sharedSponsorDirectory+")) AND (NOT coalesce((c.data->>'Retired')::boolean,false) OR EXISTS(SELECT 1 FROM entries WHERE event=$1 AND id=$4 AND data->>'Contact'=$3)))", d.Event, d.Role, ref.id, o.Target, d.Online && d.Role == roleWrite && (o.Kind == "sponsorship" || o.Kind == "payment")).Scan(&exists)
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
	if o.Target == pooledSettlement || strings.HasPrefix(o.Target, "settlement:") || v.Reference == "wallet-settlement" || v.Reference == "wallet-settlement-total" {
		pooled := o.Target == pooledSettlement
		if o.Kind != "income" || v.Method != "Bar" || (pooled && (v.Reference != "wallet-settlement-total" || v.Wallet != "" || v.Bar != "")) ||
			(!pooled && (v.Reference != "wallet-settlement" || v.Wallet == "" || o.Target != "settlement:"+v.Wallet)) {
			return false, fail("Invalid wallet reference.")
		}
		rows, err := tx.Query(ctx, "SELECT id,kind,device::text,revision,data FROM settlement_entries WHERE event=$1 AND id<>$2 AND (kind='wallet' OR kind='count' OR kind=ANY($3))", d.Event, o.Target, journalKinds)
		if err != nil {
			return false, err
		}
		entries, err := pgx.CollectRows(rows, pgx.RowToStructByPos[row])
		if err != nil {
			return false, err
		}
		total, known := walletRevenue(entries, v.Wallet)
		if pooled {
			total, known = pooledRevenue(entries)
		}
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
		return false, fail("Select the cash account that received the payment.")
	}
	return true, nil
}

func validateSettlement(rows []row) error {
	if err := completeAttachments(rows); err != nil {
		return err
	}
	var pooled bool
	var booked *int64
	for _, r := range rows {
		if r.Kind == "count" && r.Data.Fields["countScope"] == "all" {
			pooled = true
		}
		if r.ID == pooledSettlement {
			booked = r.Data.Amount
		}
	}
	if pooled || booked != nil {
		amount, known := pooledRevenue(rows)
		if !known || booked == nil || *booked != amount {
			return errors.New("The combined wallet count is not fully settled.")
		}
		return nil
	}
	movements := make(map[string][]row)
	settlements := make(map[string]*int64)
	for _, entry := range rows {
		if wallet, ok := strings.CutPrefix(entry.ID, "settlement:"); ok {
			settlements[wallet] = entry.Data.Amount
		}
		v := entry.Data
		ids := [3]string{v.Wallet, v.Account, v.To}
		for i, id := range ids {
			if id == "" || slices.Contains(ids[:i], id) || entry.ID == "settlement:"+id {
				continue
			}
			relevant := v.Wallet == id && (entry.Kind == "count" ||
				slices.Contains(journalKinds, entry.Kind) && (v.Method == "" || v.Method == "Bar"))
			if relevant || cashAdjustment(entry, func(value string) bool { return value == id }, false) != 0 {
				movements[id] = append(movements[id], entry)
			}
		}
	}
	for _, r := range rows {
		if r.Kind != "wallet" {
			continue
		}
		booked := settlements[r.ID]
		if len(movements[r.ID]) == 0 && booked == nil {
			continue
		}
		amount, ok := walletRevenue(movements[r.ID], r.ID)
		if !ok || booked == nil || *booked != amount {
			return fmt.Errorf("Wallet %s is not fully settled.", r.Data.Label)
		}
	}
	return nil
}

func (a *app) copyEvent(ctx context.Context, tx pgx.Tx, d device, name, start, end, year string, kinds []string) (string, error) {
	if d.Role != roleAdmin || len(name) == 0 || len(name) > 160 {
		return "", fail("A name and administrator access are required.")
	}
	if (start != "" || end != "") && (!date(start) || !date(end) || end < start) {
		return "", fail("Enter a valid destination period.")
	}
	allowed := strings.Fields("bar wallet shift price template")
	if kinds == nil {
		kinds = allowed
	}
	for _, k := range kinds {
		if !slices.Contains(allowed, k) {
			return "", fail("Unknown copy scope.")
		}
	}
	id := uuid()
	err := tx.QueryRow(ctx, `WITH source AS (
		SELECT accounts,fiscal_year,coalesce(nullif($4,'')::date,starts) AS starts,
		coalesce(nullif($5,'')::date,ends) AS ends FROM events WHERE id=$3 AND (NOT general_ledger OR $6)
	) INSERT INTO events(id,name,starts,ends,accounts,fiscal_year)
		SELECT $1,$2,s.starts,s.ends,s.accounts,y.id FROM source s LEFT JOIN fiscal_years y
		ON y.starts<=s.starts AND y.ends>=s.ends
		WHERE (y.id IS NOT NULL OR (s.fiscal_year IS NULL AND $6)) AND ($7='' OR y.id::text=$7)
		RETURNING starts::text`, id, name, d.Event, start, end, offlineEnabled(), year).Scan(&start)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fail("Create a fiscal year covering the destination period first.")
	}
	if err != nil {
		return "", err
	}
	if err = checkYearSetup(ctx, tx, id); err != nil {
		return "", err
	}
	rows, err := tx.Query(ctx, "SELECT id,kind,device::text,revision,data FROM entries WHERE event=$1 AND kind=ANY($2::text[]) AND NOT coalesce((data->>'Retired')::boolean,false)", d.Event, kinds)
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
		if r.Kind == "wallet" {
			if _, err = tx.Exec(ctx, "INSERT INTO event_catalog_wallets(event,wallet,local_id) SELECT $1,wallet,$2 FROM event_catalog_wallets WHERE event=$3 AND local_id=$4", id, ids[r.ID], d.Event, r.ID); err != nil {
				return "", err
			}
		}
	}
	if err = audit(ctx, tx, id, d.User, "Veranstaltungsstruktur kopiert", d.Event); err != nil {
		return "", err
	}
	return id, nil
}

func (a *app) globalPeriod(ctx context.Context, tx pgx.Tx, d device, start, end string, history bool) (any, error) {
	if !date(start) || !date(end) || start > end {
		return nil, fail("Enter a valid date range.")
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
		AND j.kind IN ('income','expense','refund','deposit','deposit-return','donation','payment','presale','card','fee','reimbursement','outlay','transfer','payout','supply','skim','return','cashback')
		AND ($3='Admin' OR e.id IN (SELECT event FROM grants_event WHERE username=$4))
		AND ($5::uuid IS NULL OR e.fiscal_year=$5) ORDER BY datum,e.name,j.id`, start, end, d.Role, d.User, year)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToMap)
}

var journalKinds = strings.Fields("income expense refund deposit deposit-return transfer payment donation reimbursement card fee payout presale supply skim return cashback")

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
