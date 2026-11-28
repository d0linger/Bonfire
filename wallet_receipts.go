package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

type walletReceiptChange struct {
	Event, Wallet, Receipt, Request, Reason                 string
	Revision, SourceRevision, PostRevision, Amount, Counted int64
	CorrectPosted                                           bool
}

func linkedReceipts(rows []row, wallet string) int64 {
	var n int64
	for _, r := range rows {
		if r.Kind == "wallet-link" && r.Data.Wallet == wallet && r.Data.Amount != nil {
			n += *r.Data.Amount
		}
	}
	return n
}

func (a *app) walletLinks(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	user, role, err := a.auth(ctx, r)
	if err != nil {
		return nil, err
	}
	q := r.URL.Query()
	event := q.Get("event")
	if !idPattern.MatchString(event) {
		return nil, fail("Select a workspace.")
	}
	if q.Get("history") == "1" {
		return walletReceiptHistory(ctx, a.db, event, role, user)
	}
	// Both ends must be visible. A journal-only reader must not see private event names.
	if receipt := q.Get("receipt"); receipt != "" {
		rows, err := a.db.Query(ctx, `SELECT e.name AS "EventName",coalesce(w.data->>'Label','All wallets') AS "WalletName",l.amount AS "Amount",l.counted_on::text AS "Date"
   FROM wallet_receipt_links l JOIN events e ON e.id=l.event LEFT JOIN entries w ON w.event=l.event AND w.id=l.wallet
   WHERE l.source_event=$1 AND l.receipt=$2 AND l.amount>0 AND ($3='Admin' OR (EXISTS(SELECT FROM grants_event WHERE event=l.source_event AND username=$4) AND EXISTS(SELECT FROM grants_event WHERE event=l.event AND username=$4))) ORDER BY l.counted_on,e.name,l.wallet`, event, receipt, role, user)
		if err != nil {
			return nil, err
		}
		return pgx.CollectRows(rows, pgx.RowToMap)
	}
	wallet := q.Get("wallet")
	if wallet != "" && !key.MatchString(wallet) {
		return nil, fail("Select an event wallet.")
	}
	search := strings.TrimSpace(q.Get("search"))
	if len(search) > 160 {
		return nil, fail("Use a shorter receipt search.")
	}
	page := 0
	if value := q.Get("page"); value != "" {
		page, err = strconv.Atoi(value)
		if err != nil || page < 0 || page > 100000 {
			return nil, fail("Select a valid receipt page.")
		}
	}
	rows, err := a.db.Query(ctx, `SELECT j.id AS "ID",j.revision AS "SourceRevision",j.data->>'Label' AS "Label",
 j.data->>'Date' AS "Date",coalesce(nullif(j.data->>'Reference',''),j.data->'Fields'->>'receipt','') AS "Reference",
 g.name AS "Workspace", (j.data->>'Amount')::bigint AS "Total",
 (j.data->>'Amount')::bigint-coalesce(t.used,0)+coalesce(t.mine,0) AS "Available",
 coalesce(t.mine,0) AS "Assigned",coalesce(t.revision,0) AS "Revision"
 FROM events e JOIN events g ON g.fiscal_year=e.fiscal_year AND g.general_ledger
 JOIN entries j ON j.event=g.id AND j.kind='income'
 LEFT JOIN LATERAL(SELECT sum(l.amount)::bigint AS used,max(l.amount) FILTER(WHERE l.event=e.id AND l.wallet=$2) AS mine,
 max(l.revision) FILTER(WHERE l.event=e.id AND l.wallet=$2) AS revision FROM wallet_receipt_links l WHERE l.source_event=g.id AND l.receipt=j.id) t ON true
 WHERE e.id=$1 AND NOT e.general_ledger AND ($3='Admin' OR (EXISTS(SELECT FROM grants_event WHERE event=e.id AND username=$4) AND EXISTS(SELECT FROM grants_event WHERE event=g.id AND username=$4)))
 AND (j.data->>'Amount')::bigint>0 AND (coalesce(t.mine,0)>0 OR strpos(lower(concat_ws(' ',j.data->>'Label',j.data->>'Date',j.data->>'Reference',j.data->'Fields'->>'receipt')),lower($5))>0)
 ORDER BY (coalesce(t.mine,0)>0) DESC,j.data->>'Date' DESC,j.data->>'Label',j.id LIMIT 101 OFFSET $6`, event, wallet, role, user, search, page*100)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToMap)
}

func walletReceiptHistory(ctx context.Context, db interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, event, role, user string) ([]map[string]any, error) {
	rows, err := db.Query(ctx, `SELECT l.request::text AS "Request", e.name AS "Event",
        coalesce(w.data->>'Label','All wallets') AS "Wallet", g.name AS "Cashbook",
        l.receipt AS "Receipt", l.source_revision AS "ReceiptRevision", l.revision AS "Revision",
        l.amount AS "Amount", l.counted_on::text AS "Date", l.reason AS "Reason"
        FROM wallet_receipt_revisions l JOIN events e ON e.id=l.event JOIN events g ON g.id=l.source_event
        LEFT JOIN entries w ON w.event=e.id AND w.id=l.wallet
        WHERE $1 IN (l.event,l.source_event) AND ($2='Admin' OR (EXISTS(SELECT FROM grants_event WHERE event=l.event AND username=$3)
        AND EXISTS(SELECT FROM grants_event WHERE event=l.source_event AND username=$3)))
        ORDER BY l.counted_on,e.name,l.wallet,l.receipt,l.revision`, event, role, user)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToMap)
}

func (a *app) saveWalletLink(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	if _, role, err := a.auth(ctx, r); err != nil {
		return nil, err
	} else if role == roleRead {
		return nil, problem{403, "Write access is required."}
	}
	var q walletReceiptChange
	if err := read(r, &q); err != nil {
		return nil, err
	}
	q.Reason = strings.TrimSpace(q.Reason)
	if !idPattern.MatchString(q.Event) || !idPattern.MatchString(q.Request) || !key.MatchString(q.Receipt) || (q.Wallet != "" && !key.MatchString(q.Wallet)) ||
		q.Amount < 0 || q.Amount > 999999999999 || q.SourceRevision < 1 || q.Revision < 0 || (q.Revision > 0 && len(q.Reason) < 3) || len(q.Reason) > 500 {
		return nil, fail("Select a receipt, enter the allocation and give a reason for corrections.")
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	// Other financial writes hold at least the shared counterpart. This rare two-workspace
	// operation must verify counts, the source and all competing allocations in one snapshot.
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(751025)"); err != nil {
		return nil, err
	}
	d, err := lockOnlineEvent(ctx, tx, r, q.Event)
	if err != nil {
		return nil, err
	}
	if d.Role == roleRead {
		return nil, problem{403, "Write access is required."}
	}
	var source string
	if err = tx.QueryRow(ctx, `SELECT g.id::text FROM events e JOIN events g ON g.general_ledger AND g.fiscal_year=e.fiscal_year WHERE e.id=$1 AND NOT e.general_ledger`, q.Event).Scan(&source); errors.Is(err, pgx.ErrNoRows) {
		return nil, fail("Select an event in a fiscal year.")
	} else if err != nil {
		return nil, err
	}
	ledger, err := lockOnlineEvent(ctx, tx, r, source)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(q)
	if err != nil {
		return nil, err
	}
	digest := hash(string(encoded))
	var saved []byte
	var owner string
	err = tx.QueryRow(ctx, "SELECT digest,actor::text FROM wallet_receipt_revisions WHERE request=$1", q.Request).Scan(&saved, &owner)
	if err == nil {
		if owner != d.ID || !bytes.Equal(saved, digest) {
			return nil, problem{409, "This allocation request already has different details."}
		}
		return true, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if d.Closed || ledger.Closed {
		return nil, problem{409, "Reopen the affected workspace before changing an allocation."}
	}
	if err = requireOpenYear(ctx, tx, d.Event); err != nil {
		return nil, err
	}
	var sourceAmount, sourceRevision int64
	var sourceDate string
	err = tx.QueryRow(ctx, "SELECT (data->>'Amount')::bigint,revision,data->>'Date' FROM entries WHERE event=$1 AND id=$2 AND kind='income'", source, q.Receipt).Scan(&sourceAmount, &sourceRevision, &sourceDate)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && sourceRevision != q.SourceRevision {
		return nil, problem{409, "The selected receipt changed. Review it again."}
	}
	if err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `SELECT id,kind,device::text,revision,data FROM settlement_entries WHERE event=$1 AND (kind IN ('wallet','count','wallet-link') OR kind=ANY($2))`, q.Event, journalKinds)
	if err != nil {
		return nil, err
	}
	entries, err := pgx.CollectRows(rows, pgx.RowToStructByPos[row])
	if err != nil {
		return nil, err
	}
	var countDate string
	var priorPost int64
	var prior row
	var pooled bool
	target := "settlement:" + q.Wallet
	if q.Wallet == "" {
		target = pooledSettlement
	}
	relevant := make([]row, 0, len(entries))
	for _, v := range entries {
		if v.ID == target {
			prior = v
			if v.Data.Amount != nil {
				priorPost = *v.Data.Amount
			}
			continue
		}
		relevant = append(relevant, v)
		if v.Kind == "count" && v.Data.Fields["countScope"] == "all" {
			pooled = true
		}
		if v.Kind == "count" && v.Data.Phase == "Ende" && v.Data.Wallet == q.Wallet {
			countDate = v.Data.Date
		}
	}
	counted, known := walletRevenue(relevant, q.Wallet)
	if q.Wallet == "" {
		counted, known = pooledRevenue(relevant)
	}
	if !known || pooled != (q.Wallet == "") || countDate == "" || counted != q.Counted {
		return nil, problem{409, "The count changed. Review the wallet settlement again."}
	}
	var used, mine, rev int64
	var priorDate string
	err = tx.QueryRow(ctx, `SELECT coalesce(sum(amount),0)::bigint,coalesce(max(amount) FILTER(WHERE event=$3 AND wallet=$4),0),
 coalesce(max(revision) FILTER(WHERE event=$3 AND wallet=$4),0),
 coalesce((max(counted_on) FILTER(WHERE event=$3 AND wallet=$4))::text,'')
 FROM wallet_receipt_links WHERE source_event=$1 AND receipt=$2`, source, q.Receipt, q.Event, q.Wallet).Scan(&used, &mine, &rev, &priorDate)
	if err != nil {
		return nil, err
	}
	for _, item := range []struct {
		d        device
		id, date string
	}{{d, target, countDate}, {ledger, q.Receipt, sourceDate}, {d, target, priorDate}} {
		frozen, err := protectedPeriod(ctx, tx, item.d, op{Target: item.id, Data: data{Date: item.date}})
		if err != nil {
			return nil, err
		}
		if frozen {
			return nil, problem{409, "A linked date is in a closed accounting period."}
		}
	}
	if rev != q.Revision || q.Amount == mine {
		return nil, problem{409, "The available receipt amount or allocation changed. Refresh before continuing."}
	}
	if q.Amount > sourceAmount-used+mine {
		return nil, problem{409, "The receipt has insufficient unallocated funds for this allocation."}
	}
	newLinked := linkedReceipts(entries, q.Wallet) - mine + q.Amount
	if newLinked > counted && q.Amount >= mine {
		return nil, problem{409, "The allocation exceeds the counted takings."}
	}
	if q.PostRevision != prior.Revision {
		return nil, problem{409, "The posted settlement changed. Refresh the count."}
	}
	// A source may need to be released in several steps after a count correction.
	// Only reduce a previous posting to a valid, non-negative remaining amount.
	correct := newLinked <= counted && priorPost > counted-newLinked
	if correct && (!q.CorrectPosted || len(q.Reason) < 3) {
		return nil, problem{409, "Confirm the correction to the previously posted income and give a reason."}
	}
	_, err = tx.Exec(ctx, `INSERT INTO wallet_receipt_revisions(request,digest,event,wallet,source_event,receipt,source_revision,revision,amount,counted_on,actor,reason)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, q.Request, digest, q.Event, q.Wallet, source, q.Receipt, sourceRevision, rev+1, q.Amount, countDate, d.ID, q.Reason)
	if err != nil {
		return nil, err
	}
	if correct {
		d, err = lockOnlineEvent(ctx, tx, r, q.Event)
		if err != nil {
			return nil, err
		}
		n := counted - newLinked
		v := prior.Data
		v.Amount = &n
		v.Note = q.Reason
		v.BalanceOrder = 0
		v.PostingOrder = 0
		correction := op{ID: walletBatchOperationID(q.Request, target), Target: target, Kind: "income", Base: prior.Revision, Data: v}
		if err = accept(ctx, tx, &d, correction); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, "UPDATE devices SET last_seq=$1,last_seen=now() WHERE id=$2", d.Last, d.ID); err != nil {
			return nil, err
		}
	}
	for _, id := range []string{d.Event, source} {
		if err = audit(ctx, tx, id, d.User, "Wallet receipt allocation", q.Request); err != nil {
			return nil, err
		}
	}
	return true, tx.Commit(ctx)
}
