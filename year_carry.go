package main

import (
	"context"

	"github.com/jackc/pgx/v5"
)

type yearCarryLine struct {
	Source, Name, Year, End, Stamp, Period, Account, Label string
	Amount                                                 int64
}

// Both closure types contain frozen entry snapshots. A fiscal closure can
// include several workspaces, so retain only the source workspace's counts.
func yearCarryLines(ctx context.Context, tx pgx.Tx, target string) ([]yearCarryLine, error) {
	rows, err := tx.Query(ctx, `WITH destination AS (
		SELECT e.general_ledger,y.starts FROM events e JOIN fiscal_years y ON y.id=e.fiscal_year WHERE e.id=$1
	), previous_year AS (
		SELECT y.* FROM fiscal_years y,destination d WHERE y.ends<d.starts ORDER BY y.ends DESC LIMIT 1
	)
	SELECT e.id::text,e.name,y.name,e.ends::text,coalesce(c.version::text,p.id::text),
		CASE WHEN c.version IS NULL THEN p.id::text ELSE '' END,
		a.account,coalesce(ac.data->>'Label',nullif(a.account,''),'Gesamtbestand'),sum(a.amount)::bigint
	FROM previous_year y JOIN events e ON e.fiscal_year=y.id
	JOIN destination d ON d.general_ledger=e.general_ledger
	LEFT JOIN LATERAL (SELECT version,snapshot FROM event_closures WHERE event=e.id AND e.closed ORDER BY version DESC LIMIT 1) c ON true
	LEFT JOIN period_closures p ON c.version IS NULL AND p.fiscal_year=y.id AND p.starts=y.starts AND p.ends=y.ends AND p.reopened_at IS NULL
	CROSS JOIN LATERAL (
		SELECT CASE WHEN e.accounts THEN coalesce(j->'Data'->>'Account','') ELSE '' END AS account,
			(j->'Data'->>'Amount')::bigint AS amount
		FROM jsonb_array_elements(coalesce(c.snapshot,p.snapshot)) j
		WHERE j->>'Kind'='actual' AND (c.version IS NOT NULL OR EXISTS(
			SELECT FROM devices WHERE id=(j->>'Device')::uuid AND event=e.id))
	) a
	LEFT JOIN entries ac ON ac.event=e.id AND ac.id=a.account AND ac.kind IN ('wallet','account')
	GROUP BY e.id,e.name,e.ends,y.name,c.version,p.id,a.account,ac.data->>'Label' ORDER BY e.name,e.id,a.account`, target)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[yearCarryLine])
}

func carryYear(ctx context.Context, tx pgx.Tx, d device, source, stamp string, accounts map[string]string) (any, error) {
	if !d.Online || d.Role != roleAdmin || d.Closed {
		return nil, problem{403, "Übernahme nur durch einen Admin in einen offenen Arbeitsbereich."}
	}
	lines, err := yearCarryLines(ctx, tx, d.Event)
	if err != nil {
		return nil, err
	}
	if source == "" {
		return lines, nil
	}
	if !d.Accounts && len(accounts) > 0 {
		return nil, fail("Die Kontozuordnung hat sich geändert. Arbeitsbereich neu öffnen.")
	}
	var origin yearCarryLine
	totals := make(map[string]int64)
	for _, l := range lines {
		if l.Source != source || l.Stamp != stamp {
			continue
		}
		origin = l
		to := ""
		if d.Accounts {
			to = accounts[l.Account]
			if to == "" {
				return nil, fail("Für jeden Vorjahresbestand ein Zielkonto wählen.")
			}
		}
		totals[to] += l.Amount
	}
	if len(totals) == 0 {
		return nil, fail("Der gewählte Vorjahresabschluss ist nicht mehr verfügbar.")
	}
	var start string
	if err = tx.QueryRow(ctx, "SELECT starts::text FROM events WHERE id=$1", d.Event).Scan(&start); err != nil {
		return nil, err
	}
	var used bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT FROM entries WHERE kind='opening' AND (
		(data->'Fields'->>'yearSource'=$1 AND event<>$2) OR ($3<>'' AND data->'Fields'->>'previous'=$3)))`, source, d.Event, origin.Period).Scan(&used)
	if err != nil {
		return nil, err
	}
	if used {
		return nil, fail("Dieser Vorjahresbestand wurde bereits übernommen.")
	}
	existing, err := tx.Query(ctx, "SELECT id,kind,device::text,revision,data FROM entries WHERE event=$1 AND kind='opening'", d.Event)
	if err != nil {
		return nil, err
	}
	openings, err := pgx.CollectRows(existing, pgx.RowToStructByPos[row])
	if err != nil {
		return nil, err
	}
	for _, r := range openings {
		n, ok := totals[r.Data.Account]
		if !ok || r.Data.Fields["yearSource"] != source || r.Data.Fields["yearStamp"] != stamp || r.Data.Amount == nil || *r.Data.Amount != n {
			return nil, fail("Ein Anfangsbestand ist bereits vorhanden. Bestehende Einträge zuerst prüfen.")
		}
		delete(totals, r.Data.Account)
	}
	for account, amount := range totals {
		v := data{
			Date: start, Label: "Vorjahresübertrag · " + origin.Year, Amount: &amount, Account: account,
			Note:   origin.Name + " · " + origin.End,
			Fields: map[string]string{"yearSource": source, "yearStamp": stamp, "yearPeriod": origin.Period},
		}
		if err = accept(ctx, tx, &d, op{yearCarry: true, ID: uuid(), Target: countKey("opening", start, account), Kind: "opening", Data: v}); err != nil {
			return nil, err
		}
	}
	return true, tx.Commit(ctx)
}
