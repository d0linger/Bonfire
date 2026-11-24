package main

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5"
)

func paperReference(ctx context.Context, tx pgx.Tx, d device, o op) (bool, error) {
	v := o.Data
	if o.Target != fmt.Sprintf("paper:%d", v.Number) || o.Base != 0 || v.Number < d.Block*1000 || v.Number > d.Block*1000+999 {
		return false, fail("Papiernummer außerhalb des persönlich reservierten P-Nummernkreises oder bereits registriert.")
	}
	if v.Status == "Verworfen" {
		return v.Reference == "" && len(v.Note) >= 3, nil
	}
	if v.Status != "Ausgegeben" || v.Reference == "" {
		return false, fail("Papierbeleg mit bestehender Zahlung verbinden.")
	}
	var valid bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM entries WHERE event=$1 AND id=$2 AND kind IN ('income','donation','payment','presale') AND data->>'Method'='Bar')
 AND NOT EXISTS(SELECT 1 FROM entries WHERE event=$1 AND kind='paper' AND data->>'Reference'=$2)`, d.Event, v.Reference).Scan(&valid)
	return valid, err
}

func numberReport(ctx context.Context, tx pgx.Tx, d device) (any, error) {
	if d.Role == "Kassa" {
		return nil, problem{403, "Prüfrecht erforderlich."}
	}
	rows, err := tx.Query(ctx, `SELECT x.name,x.block*1000 AS first,x.block*1000+x.digital_count-1 AS last,x.digital_count AS capacity,x.block*1000+999 AS paper_last,
 CASE WHEN coalesce(x.incident,'')<>'' THEN 'Ungeklärte Nummern' WHEN x.sealed THEN 'Bereich beendet' ELSE 'Reserviert' END AS status,
 ARRAY(SELECT number FROM originals WHERE device=x.id UNION SELECT (data->>'Number')::bigint FROM operations WHERE device=x.id AND kind='original' AND outcome IN ('Konflikt','Geklärt') ORDER BY 1) AS used,
 ARRAY(SELECT concat('P-',j.data->>'Number',' ',j.data->>'Status') FROM entries j WHERE j.device=x.id AND j.kind='paper' ORDER BY (j.data->>'Number')::bigint) AS paper
 FROM devices x WHERE x.event=$1 ORDER BY x.block`, d.Event)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToMap)
}
