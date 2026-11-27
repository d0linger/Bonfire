package main

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type catalogWallet struct {
	ID, Name, Note, DefaultBar string
	FloatCents                 *int64
	Pieces                     map[string]int64
	Revision                   int
	Active, Used               bool
}

type walletCommand struct {
	Action, ID, Name, Note, DefaultBar, Event string
	FloatCents                                *int64
	Pieces                                    map[string]int64
	Revision                                  int
	Active                                    *bool
	IDs                                       []string
	ConfirmOverlap                            bool
}

// Use the snapshot saved at assignment, even if the catalogue defaults have since changed.
func catalogWalletFields(ctx context.Context, tx pgx.Tx, eventID, localID string, edited map[string]string) (map[string]string, error) {
	var saved map[string]string
	err := tx.QueryRow(ctx, `SELECT j.data->'Fields' FROM entries j JOIN event_catalog_wallets l ON (l.event,l.local_id)=(j.event,j.id)
		WHERE j.event=$1 AND j.id=$2`, eventID, localID).Scan(&saved)
	if errors.Is(err, pgx.ErrNoRows) {
		return edited, nil
	}
	if err != nil {
		return nil, err
	}
	out := maps.Clone(edited)
	if out == nil {
		out = map[string]string{}
	}
	for _, key := range []string{"suggestedFloatCents", "suggestedPieces", "suggestedBar"} {
		if v, ok := saved[key]; ok {
			out[key] = v
		} else {
			delete(out, key)
		}
	}
	return out, nil
}

func (a *app) walletCatalog(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	cookie, err := r.Cookie("bonfire_session")
	if err != nil || cookie.Value == "" {
		return nil, problem{401, "Sign in to manage wallets."}
	}
	var q walletCommand
	if r.Method == http.MethodPost {
		r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
		if err := read(r, &q); err != nil {
			return nil, err
		}
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if r.Method == http.MethodPost {
		// Event closure, event setup changes and other assignments share this lock.
		if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(751025)"); err != nil {
			return nil, err
		}
	}
	var user, role string
	err = tx.QueryRow(ctx, `SELECT u.name,u.role FROM sessions s JOIN users u ON u.name=s.username
		WHERE s.token=$1 AND s.expires>clock_timestamp() AND u.active AND NOT u.password_change_required FOR SHARE OF u,s`, hash(cookie.Value)).Scan(&user, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, problem{401, "Sign in to manage wallets."}
	}
	if err != nil {
		return nil, err
	}
	if r.Method == http.MethodGet {
		return listCatalogWallets(ctx, tx, user, role, r.URL.Query().Get("event"))
	}
	if role != roleWrite && role != roleAdmin {
		return nil, problem{403, "Write access is required."}
	}
	var out any
	if q.Action == "assign" {
		var assigned *walletAssignment
		assigned, err = assignCatalogWallets(ctx, tx, r, q)
		// Looking up event access can create the cashier's first online actor.
		// Roll back that setup too when the caller is only receiving a warning.
		if err == nil && len(assigned.Overlaps) > 0 {
			return assigned, nil
		}
		out = assigned
	} else {
		out, err = saveCatalogWallet(ctx, tx, user, q)
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

const walletColumns = "w.id::text,w.name,w.note,w.default_bar,w.float_cents,w.pieces,w.revision,w.active"

func listCatalogWallets(ctx context.Context, tx pgx.Tx, user, role, eventID string) (any, error) {
	if eventID != "" {
		if !idPattern.MatchString(eventID) {
			return nil, fail("Select an event.")
		}
		var allowed bool
		err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT FROM events e WHERE id=$1 AND NOT general_ledger AND
			($2='Admin' OR EXISTS(SELECT FROM grants_event g WHERE g.event=e.id AND g.username=$3)))`, eventID, role, user).Scan(&allowed)
		if err != nil {
			return nil, err
		}
		if !allowed {
			return nil, problem{403, "You have no access to this event."}
		}
	}
	rows, err := tx.Query(ctx, `SELECT `+walletColumns+`,EXISTS(SELECT FROM event_catalog_wallets l WHERE l.wallet=w.id AND l.event=NULLIF($1,'')::uuid)
		FROM wallet_catalog w ORDER BY lower(w.name),w.id`, eventID)
	if err != nil {
		return nil, err
	}
	wallets, err := pgx.CollectRows(rows, pgx.RowToStructByPos[catalogWallet])
	return map[string]any{"wallets": wallets}, err
}

func (q *walletCommand) validateCatalogDetails() error {
	q.Name = strings.TrimSpace(q.Name)
	q.Note = strings.TrimSpace(q.Note)
	q.DefaultBar = strings.TrimSpace(q.DefaultBar)
	if q.Name == "" || utf8.RuneCountInString(q.Name) > 160 || utf8.RuneCountInString(q.Note) > 2000 || utf8.RuneCountInString(q.DefaultBar) > 160 {
		return fail("Enter a wallet name (up to 160 characters), a bar name (up to 160) and an optional note (up to 2,000).")
	}
	if q.Pieces != nil {
		var total int64
		for denomination, count := range q.Pieces {
			cents := denoms[denomination]
			if cents < 10 || cents > 10000 || count < 0 || count > 1000000 {
				return fail("Choose denominations from €0.10 to €100 and a valid piece count.")
			}
			total += cents * count
		}
		if q.FloatCents != nil && *q.FloatCents != total {
			return fail("The suggested float must match the denomination total.")
		}
		q.FloatCents = &total
	}
	if q.FloatCents != nil && (*q.FloatCents < 0 || *q.FloatCents > 999999999999) {
		return fail("Enter a valid suggested float in cents.")
	}
	return nil
}

func saveCatalogWallet(ctx context.Context, tx pgx.Tx, user string, q walletCommand) (any, error) {
	if q.Action != "create" && q.Action != "edit" && q.Action != "retire" {
		return nil, fail("Unknown wallet action.")
	}
	if q.Action != "create" && (!idPattern.MatchString(q.ID) || q.Revision < 1) {
		return nil, fail("Select a wallet and its current revision.")
	}
	if q.Action != "retire" {
		if err := q.validateCatalogDetails(); err != nil {
			return nil, err
		}
	}
	var action string
	var tag pgconn.CommandTag
	var err error
	switch q.Action {
	case "create":
		action = "Wallet created"
		q.ID = uuid()
		tag, err = tx.Exec(ctx, "INSERT INTO wallet_catalog(id,name,note,default_bar,float_cents,pieces) VALUES($1,$2,$3,$4,$5,$6)", q.ID, q.Name, q.Note, q.DefaultBar, q.FloatCents, q.Pieces)
	case "edit":
		action = "Wallet updated"
		tag, err = tx.Exec(ctx, `UPDATE wallet_catalog SET name=$2,note=$3,default_bar=$4,float_cents=$5,pieces=$6,active=coalesce($7,active),revision=revision+1 WHERE id=$1 AND revision=$8`, q.ID, q.Name, q.Note, q.DefaultBar, q.FloatCents, q.Pieces, q.Active, q.Revision)
	case "retire":
		action = "Wallet retired"
		tag, err = tx.Exec(ctx, "UPDATE wallet_catalog SET active=false,revision=revision+1 WHERE id=$1 AND revision=$2 AND active", q.ID, q.Revision)
	}
	var dbErr *pgconn.PgError
	if errors.As(err, &dbErr) && dbErr.Code == "23505" {
		return nil, problem{409, "A wallet with this name already exists."}
	}
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() != 1 {
		return nil, problem{409, "The wallet has changed. Reload its current details."}
	}
	if _, err = tx.Exec(ctx, "INSERT INTO audit(username,action,subject) VALUES($1,$2,$3)", user, action, q.ID); err != nil {
		return nil, err
	}
	return map[string]string{"ID": q.ID}, nil
}

type walletOverlap struct{ ID, Name string }
type walletAssignment struct {
	Assigned []string        `json:"assigned"`
	Existing []string        `json:"existing"`
	Overlaps []walletOverlap `json:"overlaps"`
}
type walletSelection struct {
	Wallet        catalogWallet
	Existing, Bar string
	Overlaps      bool
}

func assignCatalogWallets(ctx context.Context, tx pgx.Tx, r *http.Request, q walletCommand) (*walletAssignment, error) {
	if len(q.IDs) == 0 || len(q.IDs) > 100 {
		return nil, fail("Select between 1 and 100 wallets.")
	}
	seen := map[string]bool{}
	for _, id := range q.IDs {
		if !idPattern.MatchString(id) || seen[id] {
			return nil, fail("Select each wallet once.")
		}
		seen[id] = true
	}
	d, err := lockOnlineEvent(ctx, tx, r, q.Event)
	if err != nil {
		return nil, err
	}
	var starts string
	var ledger bool
	if err = tx.QueryRow(ctx, "SELECT starts::text,general_ledger FROM events WHERE id=$1", q.Event).Scan(&starts, &ledger); err != nil {
		return nil, err
	}
	if ledger || d.Closed {
		return nil, problem{409, "Select an open event to add wallets."}
	}
	if err = checkYearSetup(ctx, tx, q.Event); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `SELECT `+walletColumns+`,coalesce(l.local_id,''),
		coalesce((SELECT min(b.id) FROM entries b WHERE b.event=e.id AND b.kind='bar' AND w.default_bar<>'' AND lower(btrim(b.data->>'Label'))=lower(btrim(w.default_bar)) HAVING count(*)=1),''),
		EXISTS(SELECT FROM event_catalog_wallets other JOIN events open ON open.id=other.event LEFT JOIN fiscal_years y ON open.fiscal_year=y.id
			WHERE other.wallet=w.id AND other.event<>e.id AND NOT open.closed AND y.closed IS NOT TRUE AND open.starts<=e.ends AND e.starts<=open.ends)
		FROM wallet_catalog w CROSS JOIN events e LEFT JOIN event_catalog_wallets l ON l.event=e.id AND l.wallet=w.id
		WHERE w.id=ANY($1::uuid[]) AND w.active AND e.id=$2 ORDER BY lower(w.name),w.id`, q.IDs, q.Event)
	if err != nil {
		return nil, err
	}
	items, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (walletSelection, error) {
		var s walletSelection
		w := &s.Wallet
		err := r.Scan(&w.ID, &w.Name, &w.Note, &w.DefaultBar, &w.FloatCents, &w.Pieces, &w.Revision, &w.Active, &s.Existing, &s.Bar, &s.Overlaps)
		return s, err
	})
	if err != nil {
		return nil, err
	}
	if len(items) != len(q.IDs) {
		return nil, problem{409, "One or more selected wallets are unavailable. Reload the catalogue."}
	}
	result := &walletAssignment{Assigned: []string{}, Existing: []string{}, Overlaps: []walletOverlap{}}
	if !q.ConfirmOverlap {
		for _, s := range items {
			if s.Existing == "" && s.Overlaps {
				result.Overlaps = append(result.Overlaps, walletOverlap{s.Wallet.ID, s.Wallet.Name})
			}
		}
	}
	if len(result.Overlaps) > 0 {
		return result, nil
	}
	for _, s := range items {
		if s.Existing != "" {
			result.Existing = append(result.Existing, s.Existing)
			continue
		}
		w := s.Wallet
		v := data{Label: w.Name, Date: starts, Note: w.Note, Bar: s.Bar, Fields: map[string]string{}}
		if w.DefaultBar != "" {
			v.Fields["suggestedBar"] = w.DefaultBar
		}
		if w.FloatCents != nil {
			v.Fields["suggestedFloatCents"] = strconv.FormatInt(*w.FloatCents, 10)
		}
		if w.Pieces != nil {
			pieces, err := json.Marshal(w.Pieces)
			if err != nil {
				return nil, err
			}
			v.Fields["suggestedPieces"] = string(pieces)
		}
		id := uuid()
		if _, err = tx.Exec(ctx, "INSERT INTO entries(event,id,revision,device,kind,data) VALUES($1,$2,1,$3,'wallet',$4)", q.Event, id, d.ID, v); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, "INSERT INTO event_catalog_wallets(event,wallet,local_id) VALUES($1,$2,$3)", q.Event, w.ID, id); err != nil {
			return nil, err
		}
		if err = audit(ctx, tx, q.Event, d.User, "Wallet added from catalogue", w.Name); err != nil {
			return nil, err
		}
		result.Assigned = append(result.Assigned, id)
	}
	return result, nil
}
