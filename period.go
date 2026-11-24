package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"strings"
)

func migrationHash(sql []byte, windows bool) string {
	body := strings.ReplaceAll(string(sql), "\r\n", "\n")
	if windows {
		body = strings.ReplaceAll(body, "\n", "\r\n")
	}
	return fmt.Sprintf("%x", sha256.Sum256([]byte(body)))
}
func applyUpgrade(ctx context.Context, tx pgx.Tx, version int, path string) error {
	sql, err := migrations.ReadFile(path)
	if err != nil {
		return err
	}
	sum := migrationHash(sql, false)
	var saved string
	err = tx.QueryRow(ctx, "SELECT digest FROM migrations WHERE version=$1", version).Scan(&saved)
	if errors.Is(err, pgx.ErrNoRows) {
		if _, err = tx.Exec(ctx, string(sql)); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, "INSERT INTO migrations VALUES($1,$2)", version, sum)
		return err
	}
	if err != nil {
		return err
	}
	if saved != sum && saved != migrationHash(sql, true) {
		return errors.New("Abweichende Migrationsprüfsumme")
	}
	return nil
}

func closePeriod(ctx context.Context, tx pgx.Tx, d device, id string) (string, error) {
	if d.Role != roleAdmin {
		return "", problem{403, "Adminrecht erforderlich."}
	}
	var start, end string
	var year *string
	err := tx.QueryRow(ctx, "SELECT j.data->>'Date',j.data->>'To',e.fiscal_year::text FROM entries j JOIN events e ON e.id=j.event WHERE j.event=$1 AND j.id=$2 AND j.kind='period'", d.Event, id).Scan(&start, &end, &year)
	if err != nil {
		return "", fail("Periode fehlt.")
	}
	// Preparation, sync and settings hold the shared counterpart. The exclusive lock
	// serializes the final snapshot with every write which could change its scope.
	var overlap bool
	err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM period_closures WHERE reopened_at IS NULL AND starts<=$2 AND ends>=$1 AND (fiscal_year IS NULL OR $3::uuid IS NULL OR fiscal_year=$3))", start, end, year).Scan(&overlap)
	if err != nil {
		return "", err
	}
	if overlap {
		return "", fail("Zeitraum überschneidet sich mit freigegebenem Abschluss.")
	}
	const scope = `SELECT e.id FROM events e WHERE ($3::uuid IS NULL OR e.fiscal_year=$3)
		AND ((e.starts<=$2::date AND e.ends>=$1::date) OR EXISTS(
			SELECT 1 FROM entries j WHERE j.event=e.id AND (j.data->>'Date')::date BETWEEN $1::date AND $2::date))`
	var missing bool
	err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM ("+scope+") s WHERE EXISTS(SELECT 1 FROM devices d WHERE d.event=s.id AND NOT d.online_actor AND NOT d.sealed) OR EXISTS(SELECT 1 FROM operations o WHERE o.event=s.id AND o.outcome='Konflikt'))", start, end, year).Scan(&missing)
	if err != nil {
		return "", err
	}
	if missing {
		return "", fail("Offene Geräte oder ungeklärte Konflikte.")
	}
	var accountMode, allAccounts bool
	err = tx.QueryRow(ctx, "SELECT coalesce(bool_or(accounts),false),coalesce(bool_and(accounts),false) FROM events WHERE id IN ("+scope+")", start, end, year).Scan(&accountMode, &allAccounts)
	if err != nil {
		return "", err
	}
	if accountMode != allAccounts {
		return "", fail("Unterschiedliche Kontozuordnungen zuerst abstimmen.")
	}
	rows, err := tx.Query(ctx, "SELECT event::text,id,kind,device::text,revision,data FROM entries WHERE event IN ("+scope+") AND ((data->>'Date')::date BETWEEN $1 AND $2 OR (kind IN ('account','wallet') AND (data->>'Date')::date<=$2)) ORDER BY id", start, end, year)
	if err != nil {
		return "", err
	}
	byEvent := map[string][]row{}
	entries, err := pgx.CollectRows(rows, func(record pgx.CollectableRow) (row, error) {
		var event string
		var r row
		err := record.Scan(&event, &r.ID, &r.Kind, &r.Device, &r.Revision, &r.Data)
		byEvent[event] = append(byEvent[event], r)
		return r, err
	})
	if err != nil {
		return "", err
	}
	if err = validateCarry(ctx, tx, entries); err != nil {
		return "", err
	}
	if len(byEvent) == 0 {
		return "", fail("No workspace balances in this period.")
	}
	for _, eventRows := range byEvent {
		if err = checkBalance(eventRows, accountMode); err != nil {
			return "", err
		}
		if err = validateSettlement(eventRows); err != nil {
			return "", fail(err.Error())
		}
	}
	closure := uuid()
	_, err = tx.Exec(ctx, "INSERT INTO period_closures(id,period_id,version,starts,ends,reviewer,snapshot,fiscal_year,source_event,account_mode) SELECT $1,$2,coalesce(max(version),0)+1,$3,$4,$5,$6,$7,$8,$9 FROM period_closures WHERE period_id=$2", closure, id, start, end, d.User, entries, year, d.Event, accountMode)
	if err != nil {
		return "", err
	}
	return closure, audit(ctx, tx, d.Event, d.User, "Periodenabschluss", closure)
}
func protectedPeriod(ctx context.Context, tx pgx.Tx, d device, o op) (bool, error) {
	if !date(o.Data.Date) {
		return false, nil
	}
	var frozen bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM period_closures p WHERE p.reopened_at IS NULL
		AND (p.fiscal_year IS NULL OR p.fiscal_year=(SELECT fiscal_year FROM events WHERE id=$2))
		AND ($1::date BETWEEN starts AND ends OR EXISTS(SELECT 1 FROM entries j WHERE j.event=$2 AND j.id=$3
			AND (j.data->>'Date')::date BETWEEN p.starts AND p.ends)))`, o.Data.Date, d.Event, o.Target).Scan(&frozen)
	return frozen, err
}
func periodAction(ctx context.Context, tx pgx.Tx, d device, action, id, reason string) (any, error) {
	if action == "period-close" {
		result, err := closePeriod(ctx, tx, d, id)
		if err != nil {
			return nil, err
		}
		return result, tx.Commit(ctx)
	}
	if d.Role != roleAdmin || len(strings.TrimSpace(reason)) < 5 {
		return nil, fail("Adminrecht und Begründung erforderlich.")
	}
	var source string
	err := tx.QueryRow(ctx, `SELECT p.id::text FROM period_closures p WHERE p.source_event=$1 AND p.period_id=$2 AND p.reopened_at IS NULL`, d.Event, id).Scan(&source)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fail("Kein aktiver Periodenabschluss in diesem Arbeitsbereich.")
	}
	if err != nil {
		return nil, err
	}
	var downstream bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM period_closures p CROSS JOIN LATERAL jsonb_array_elements(p.snapshot) j
      WHERE p.reopened_at IS NULL AND j->>'Kind'='opening' AND $1 IN (j->'Data'->'Fields'->>'previous',j->'Data'->'Fields'->>'yearPeriod'))
      OR EXISTS(SELECT 1 FROM entries j JOIN events e ON e.id=j.event WHERE e.closed AND j.kind='opening' AND $1 IN (j.data->'Fields'->>'previous',j.data->'Fields'->>'yearPeriod'))`, source).Scan(&downstream)
	if err != nil {
		return nil, err
	}
	if downstream {
		return nil, fail("Zuerst den abhängigen Folgeabschluss mit Begründung wieder öffnen.")
	}
	tag, err := tx.Exec(ctx, "UPDATE period_closures SET reopened_by=$1,reopened_reason=$2,reopened_at=now() WHERE id=$3 AND reopened_at IS NULL", d.User, reason, source)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() != 1 {
		return nil, fail("Kein aktiver Periodenabschluss vorhanden.")
	}
	if err = audit(ctx, tx, d.Event, d.User, "Periode wieder geöffnet: "+reason, id); err != nil {
		return nil, err
	}
	return true, tx.Commit(ctx)
}
