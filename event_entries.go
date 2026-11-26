package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
)

type eventEntryChoice struct {
	ID, Kind, Label, Date    string
	Revision                 int64
	Amount                   *int64
	Wallet, Bar, Account, To string
	Movable, Removable       bool
}

func (a *app) eventInventory(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	_, role, err := a.auth(ctx, r)
	if err != nil {
		return nil, err
	}
	if role != roleAdmin {
		return nil, problem{403, "Adminrecht erforderlich."}
	}
	id := r.URL.Query().Get("event")
	if !idPattern.MatchString(id) {
		return nil, fail("Arbeitsbereich auswählen.")
	}
	rows, err := a.db.Query(ctx, `SELECT j.id,j.kind,j.data->>'Label',j.data->>'Date',j.revision,(j.data->>'Amount')::bigint,
		coalesce(j.data->>'Wallet',''),coalesce(j.data->>'Bar',''),coalesce(j.data->>'Account',''),coalesce(j.data->>'To',''),
		j.kind=ANY($2), j.kind=ANY($3)
		FROM entries j JOIN events e ON e.id=j.event WHERE j.event=$1 ORDER BY j.data->>'Date',j.data->>'Label',j.id`, id, portableKinds, removableKinds)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[eventEntryChoice])
}

type eventEntryChange struct {
	Event, Target, Request, Action, Destination, Reason string
	Account, Wallet, Bar, To                            string
	Revision                                            int64
}

var portableKinds = strings.Fields("income expense refund deposit deposit-return donation presale transfer outlay sponsorship bar wallet shift account price")
var removableKinds = append(slices.Clone(portableKinds), strings.Fields("payment reimbursement opening actual plan count reserve supply skim return period")...)

func entryChangeAllowed(ctx context.Context, tx pgx.Tx, source device, current row, moving bool) error {
	v := current.Data
	if !slices.Contains(removableKinds, current.Kind) || moving && !slices.Contains(portableKinds, current.Kind) ||
		strings.HasPrefix(current.ID, "import:") || current.ID == "settlement:"+v.Wallet || current.ID == pooledSettlement || v.Fields["previous"] != "" {
		return problem{409, "Dieser Vorgang ist an einen Fachablauf gebunden. Belege, Überträge und Sammelabrechnungen bleiben nachvollziehbar."}
	}
	if current.Kind == "price" && v.Status == "Freigegeben" {
		return problem{409, "Ein freigegebener Artikelpreis bleibt mit seinem Preisstand verbunden."}
	}
	frozen, err := protectedPeriod(ctx, tx, source, op{Target: current.ID, Data: v})
	if err != nil {
		return err
	}
	if frozen {
		return problem{409, "Der Eintrag gehört zu einer abgeschlossenen Periode."}
	}
	var blocker string
	err = tx.QueryRow(ctx, `SELECT CASE
		WHEN EXISTS(SELECT FROM operations WHERE event=$1 AND outcome='Konflikt') THEN 'Zuerst offene Konflikte der Veranstaltung klären.'
		WHEN EXISTS(SELECT FROM devices WHERE event=$1 AND NOT online_actor AND NOT sealed) THEN 'Zuerst die Erfassung aller vorbereiteten Geräte abschließen.'
		WHEN EXISTS(SELECT FROM originals WHERE event=$1 AND (subject=$2 OR snapshot->>'subject'=$2))
		  OR EXISTS(SELECT FROM entries WHERE event=$1 AND id<>$2 AND ($2 IN (data->>'Bar',data->>'Wallet',data->>'Account',data->>'To',data->>'Reference',data->'Fields'->>'sale') OR data->'Allocations' ? $2))
		  THEN 'Andere Einträge oder Originalbelege verweisen auf diesen Vorgang. Zuerst die verknüpften Einträge prüfen.'
		WHEN EXISTS(SELECT FROM fire_account_links WHERE event=$1 AND local_id=$2) THEN 'Dieses Konto ist einem Feuerwehrkonto zugeordnet.'
        WHEN $3<>'' AND EXISTS(SELECT FROM entries WHERE event=$1 AND id='settlement:' || $3) THEN 'Die Geldtasche ist bereits abgerechnet.'
		WHEN ($3<>'' OR $4='count') AND EXISTS(SELECT FROM entries WHERE event=$1 AND id='settlement-total') THEN 'Die Geldtaschen sind gemeinsam abgerechnet.'
		WHEN $4='period' AND EXISTS(SELECT FROM period_closures WHERE period_id=$2) THEN 'Für diese Periode besteht ein Abschlussnachweis.'
		WHEN $4='donation' AND EXISTS(SELECT FROM donation_reports WHERE event=$1 AND period=$5) THEN 'Für diesen Meldezeitraum besteht bereits ein Spendenprüflauf.'
		ELSE '' END`, source.Event, current.ID, v.Wallet, current.Kind, donationPeriod(v)).Scan(&blocker)
	if err != nil {
		return err
	}
	if blocker != "" {
		return problem{409, blocker}
	}
	return nil
}

func donationPeriod(v data) string {
	if period := strings.TrimSpace(v.Fields["reporting"]); period != "" {
		return period
	}
	return strings.SplitN(v.Date, "-", 2)[0]
}

func (a *app) changeEventEntry(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	_, role, err := a.auth(ctx, r)
	if err != nil {
		return nil, err
	}
	if role != roleAdmin {
		return nil, problem{403, "Adminrecht erforderlich."}
	}
	var q eventEntryChange
	if err = read(r, &q); err != nil {
		return nil, err
	}
	q.Reason = strings.TrimSpace(q.Reason)
	moving := q.Action == "move"
	if !idPattern.MatchString(q.Event) || !idPattern.MatchString(q.Request) || !key.MatchString(q.Target) || q.Revision < 1 ||
		len(q.Reason) < 3 || len(q.Reason) > 500 || (!moving && q.Action != "remove") ||
		(moving && (!idPattern.MatchString(q.Destination) || q.Destination == q.Event)) || (!moving && q.Destination != "") {
		return nil, fail("Vorgang, Ziel und eine Begründung (3–500 Zeichen) angeben.")
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock_shared(751025)"); err != nil {
		return nil, err
	}
	ids := []string{q.Event}
	if moving {
		ids = append(ids, q.Destination)
	}
	// Both directions take the same event locks before creating an online actor.
	rows, err := tx.Query(ctx, `SELECT id::text,name,starts::text,ends::text,closed,accounts,general_ledger,coalesce(fiscal_year::text,'') FROM events WHERE id::text=ANY($1) ORDER BY id FOR UPDATE`, ids)
	if err != nil {
		return nil, err
	}
	spaces, err := pgx.CollectRows(rows, pgx.RowToStructByPos[event])
	if err != nil {
		return nil, err
	}
	if len(spaces) != len(ids) {
		return nil, problem{409, "Ein gewählter Arbeitsbereich ist nicht mehr verfügbar."}
	}
	source, err := lockOnlineEvent(ctx, tx, r, q.Event)
	if err != nil {
		return nil, err
	}
	if source.Role != roleAdmin {
		return nil, problem{403, "Adminrecht erforderlich."}
	}
	raw, err := json.Marshal(q)
	if err != nil {
		return nil, err
	}
	digest := hash(string(raw))
	var prior []byte
	err = tx.QueryRow(ctx, "SELECT digest FROM operations WHERE id=$1 AND event=$2 AND device=$3", q.Request, q.Event, source.ID).Scan(&prior)
	if err == nil {
		if !bytes.Equal(prior, digest) {
			return nil, problem{409, "Die Anforderung wurde bereits anders verarbeitet."}
		}
		return true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	year := spaces[0].Year
	for _, e := range spaces {
		if e.Closed || e.ID == q.Event && e.General {
			return nil, problem{409, "Nur Einträge einer offenen Veranstaltung können bereinigt werden."}
		}
		if moving && (year == "" || e.Year != year) {
			return nil, problem{409, "Das Ziel muss im selben Geschäftsjahr liegen."}
		}
	}
	var current row
	err = tx.QueryRow(ctx, "SELECT id,kind,device::text,revision,data FROM entries WHERE event=$1 AND id=$2", q.Event, q.Target).Scan(&current.ID, &current.Kind, &current.Device, &current.Revision, &current.Data)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && current.Revision != q.Revision {
		return nil, problem{409, "Eintrag inzwischen geändert oder entfernt. Liste neu öffnen."}
	}
	if err != nil {
		return nil, err
	}
	if err = entryChangeAllowed(ctx, tx, source, current, moving); err != nil {
		return nil, err
	}
	var destinationOp *string
	action := "Eintrag entfernt"
	if slices.Contains(journalKinds, current.Kind) {
		action = "Buchung storniert"
	}
	if moving {
		dest, err := lockOnlineEvent(ctx, tx, r, q.Destination)
		if err != nil {
			return nil, err
		}
		if dest.Role != roleAdmin {
			return nil, problem{403, "Adminrecht erforderlich."}
		}
		replacement := op{ID: uuid(), Target: uuid(), Kind: current.Kind, Data: current.Data}
		if current.Data.Bar != "" && q.Bar == "" || current.Data.Wallet != "" && q.Wallet == "" ||
			current.Data.Account != "" && q.Account == "" || current.Data.To != "" && q.To == "" {
			return nil, fail("Die Zuordnungen der Quelle müssen im Ziel neu gewählt werden.")
		}
		replacement.Data.Bar = q.Bar
		replacement.Data.Wallet = q.Wallet
		replacement.Data.Account = q.Account
		replacement.Data.To = q.To
		// References selected during the move are always scoped to the destination,
		// including installations with optional account assignment.
		for _, ref := range []string{q.Account, q.To} {
			if ref == "" {
				continue
			}
			var found bool
			if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT FROM entries WHERE event=$1 AND id=$2 AND kind IN ('account','wallet'))", dest.Event, ref).Scan(&found); err != nil {
				return nil, err
			}
			if !found {
				return nil, fail("Zielkonto oder Geldtasche im Zielarbeitsbereich auswählen.")
			}
		}
		if q.Wallet != "" {
			var settled bool
			if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT FROM entries WHERE event=$1 AND id IN ('settlement-total','settlement:' || $2))", dest.Event, q.Wallet).Scan(&settled); err != nil {
				return nil, err
			}
			if settled {
				return nil, problem{409, "Die Geldtasche im Ziel ist bereits abgerechnet."}
			}
		}
		if replacement.Kind == "donation" {
			var reported bool
			if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT FROM donation_reports WHERE event=$1 AND period=$2)", dest.Event, donationPeriod(current.Data)).Scan(&reported); err != nil {
				return nil, err
			}
			if reported {
				return nil, problem{409, "Im Ziel besteht für diesen Zeitraum ein Spendenprüflauf."}
			}
		}
		if replacement.Data.Fields["sale"] != "" || strings.HasPrefix(replacement.Data.Reference, "source:") {
			return nil, problem{409, "Der Vorgang hat einen veranstaltungsgebundenen Quellenbezug."}
		}
		if err = validate(op{ID: replacement.ID, Target: replacement.Target, Kind: replacement.Kind, Seq: dest.Last + 1, Data: replacement.Data}, dest.Accounts); err != nil {
			return nil, err
		}
		if err = accept(ctx, tx, &dest, replacement); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, "UPDATE devices SET last_seq=$1,last_seen=now() WHERE id=$2", dest.Last, dest.ID); err != nil {
			return nil, err
		}
		if err = audit(ctx, tx, dest.Event, dest.User, "Umbuchung aus Veranstaltung · "+q.Event, replacement.ID); err != nil {
			return nil, err
		}
		destinationOp = &replacement.ID
		action = "Eintrag umgebucht"
	}
	if _, err = tx.Exec(ctx, "SELECT set_config('bonfire.device',$1,true)", source.ID); err != nil {
		return nil, err
	}
	if slices.Contains(journalKinds, current.Kind) {
		_, err = tx.Exec(ctx, `INSERT INTO journal_history(event,target,operation,revision,direction,kind,data,actor)
		SELECT event,id,$3,revision,-1,kind,data,$4 FROM entries WHERE event=$1 AND id=$2`, q.Event, q.Target, q.Request, source.User)
		if err != nil {
			return nil, err
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO operations(id,event,device,seq,digest,target,base,kind,data,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, q.Request, q.Event, source.ID, source.Last+1, digest, q.Target, current.Revision, current.Kind, current.Data, action)
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO entry_removals(event,target,operation,destination_operation) VALUES($1,$2,$3,$4)", q.Event, q.Target, q.Request, destinationOp); err != nil {
		return nil, err
	}

	if _, err = tx.Exec(ctx, "UPDATE devices SET last_seq=$1,last_seen=now() WHERE id=$2", source.Last+1, source.ID); err != nil {
		return nil, err
	}
	if err = audit(ctx, tx, q.Event, source.User, action+" · "+q.Reason, q.Request); err != nil {
		return nil, err
	}
	return true, tx.Commit(ctx)
}
