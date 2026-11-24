package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
)

type donationCommand struct{ Action, Period, Report, Request, Digest, Reason string }
type donationPerson struct{ Vorname, Nachname, Geburtsdatum string }
type donationLine struct {
	Vorgang, Datum       string
	Revision, BetragCent int64
	Person               donationPerson
}
type excludedDonation struct{ Vorgang, Grund string }
type donationSnapshot struct {
	Format, Veranstaltung, Meldezeitraum string
	Spenden                              []donationLine
	Ausgeschlossen                       []excludedDonation
	SummeCent                            int64
}

func donationBytes(ctx context.Context, tx pgx.Tx, event, period string) ([]byte, string, error) {
	snapshot := donationSnapshot{"BONFIRE-Spendenpruefung/1", event, period, []donationLine{}, []excludedDonation{}, 0}
	rows, err := tx.Query(ctx, `SELECT e.id,e.revision,e.data->>'Date',(e.data->>'Amount')::bigint,
 coalesce(e.data->>'Status',''),coalesce(c.data->'Fields'->>'given',''),coalesce(c.data->'Fields'->>'family',''),
 coalesce(c.data->'Fields'->>'birth','') FROM entries e LEFT JOIN directory c ON c.id=e.data->>'Contact'
 WHERE e.event=$1 AND e.kind='donation' AND coalesce(nullif(trim(e.data->'Fields'->>'reporting'),''),left(e.data->>'Date',4))=$2 ORDER BY e.id`, event, period)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	for rows.Next() {
		var line donationLine
		var status string
		p := &line.Person
		if err = rows.Scan(&line.Vorgang, &line.Revision, &line.Datum, &line.BetragCent, &status, &p.Vorname, &p.Nachname, &p.Geburtsdatum); err != nil {
			return nil, "", err
		}
		reason := ""
		switch {
		case status == "Anonym":
			reason = "Anonym"
		case strings.TrimSpace(p.Vorname) == "" || strings.TrimSpace(p.Nachname) == "" || !date(p.Geburtsdatum) || p.Geburtsdatum > line.Datum:
			reason = "Personendaten unvollständig oder ungültig"
		case line.BetragCent <= 0:
			reason = "Betrag prüfen"
		}
		if reason != "" {
			snapshot.Ausgeschlossen = append(snapshot.Ausgeschlossen, excludedDonation{line.Vorgang, reason})
			continue
		}
		snapshot.Spenden = append(snapshot.Spenden, line)
		snapshot.SummeCent += line.BetragCent
	}
	if err = rows.Err(); err != nil {
		return nil, "", err
	}
	raw, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return nil, "", err
	}
	return raw, hex.EncodeToString(hash(string(raw))), nil
}

func donationStepAllowed(from, to string) bool {
	switch to {
	case "Exportiert":
		return from == "Geprüft"
	case "Übermittelt":
		return from == "Exportiert"
	case "Bestätigt":
		return from == "Übermittelt"
	case "Korrektur":
		return from == "Geprüft" || from == "Exportiert" || from == "Übermittelt" || from == "Bestätigt"
	}
	return false
}

func (a *app) donationReports(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	var q donationCommand
	if err := read(r, &q); err != nil {
		return nil, err
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	d, err := lock(ctx, tx, r)
	if err != nil {
		return nil, err
	}
	if !d.Donor || d.Role != roleAdmin {
		return nil, problem{403, "Freigegebenes Meldedatenprofil erforderlich."}
	}
	q.Period = strings.TrimSpace(q.Period)
	q.Reason = strings.TrimSpace(q.Reason)
	if q.Period == "" || len(q.Period) > 100 {
		return nil, fail("Meldezeitraum angeben.")
	}
	if q.Action == "Verlauf" {
		rows, err := tx.Query(ctx, `SELECT r.id::text,r.previous::text,r.digest,s.status,s.actor,s.evidence,s.at::text FROM donation_reports r
  JOIN donation_report_steps s ON s.report=r.id WHERE r.event=$1 AND r.period=$2 ORDER BY s.seq`, d.Event, q.Period)
		if err != nil {
			return nil, err
		}
		return pgx.CollectRows(rows, pgx.RowToMap)
	}
	if q.Action == "Vorschau" {
		raw, digest, err := donationBytes(ctx, tx, d.Event, q.Period)
		if err != nil {
			return nil, err
		}
		if err = audit(ctx, tx, d.Event, d.User, "Spendenprüfliste eingesehen", d.ID); err != nil {
			return nil, err
		}
		return map[string]any{"daten": json.RawMessage(raw), "sha256": digest}, tx.Commit(ctx)
	}
	if !idPattern.MatchString(q.Report) {
		return nil, fail("Prüflauf wählen.")
	}
	if q.Action != "Datei" {
		if !idPattern.MatchString(q.Request) || len(q.Reason) < 5 || len(q.Reason) > 500 {
			return nil, fail("Begründung oder externen Nachweis angeben.")
		}
		var same bool
		err = tx.QueryRow(ctx, `SELECT r.id=$2 AND r.event=$3 AND r.period=$4 AND s.status=$5 AND s.actor=$6 AND s.evidence=$7 AND (s.status<>'Geprüft' OR r.digest=$8)
      FROM donation_report_steps s JOIN donation_reports r ON r.id=s.report WHERE s.request_id=$1`, q.Request, q.Report, d.Event, q.Period, q.Action, d.User, q.Reason, q.Digest).Scan(&same)
		if err == nil {
			if !same {
				return nil, fail("Entscheidungskennung bereits vergeben.")
			}
			return q.Action, tx.Commit(ctx)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
	}
	if d.Closed && q.Action != "Datei" {
		return nil, problem{409, "Der Arbeitsbereich ist abgeschlossen."}
	}
	var raw []byte
	var digest, status string
	if q.Action == "Geprüft" {
		raw, digest, err = donationBytes(ctx, tx, d.Event, q.Period)
		if err != nil {
			return nil, err
		}
		if digest != q.Digest {
			return nil, fail("Prüfdaten geändert. Vorschau erneut prüfen.")
		}
		var previous *string
		var lastStatus string
		err = tx.QueryRow(ctx, `SELECT r.id::text,s.status FROM donation_reports r JOIN donation_report_steps s ON s.report=r.id WHERE r.event=$1 AND r.period=$2 ORDER BY s.seq DESC LIMIT 1`, d.Event, q.Period).Scan(&previous, &lastStatus)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		if previous != nil && *previous != q.Report && lastStatus != "Korrektur" {
			return nil, fail("Vorhandenen Prüflauf für eine Korrektur kennzeichnen.")
		}
		_, err = tx.Exec(ctx, `INSERT INTO donation_reports(id,event,period,previous,payload,digest) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`, q.Report, d.Event, q.Period, previous, raw, digest)
		if err != nil {
			return nil, err
		}
	}
	err = tx.QueryRow(ctx, `SELECT payload,digest,coalesce((SELECT status FROM donation_report_steps WHERE report=r.id ORDER BY seq DESC LIMIT 1),'') FROM donation_reports r WHERE id=$1 AND event=$2 AND period=$3`, q.Report, d.Event, q.Period).Scan(&raw, &digest, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fail("Prüflauf unbekannt.")
	}
	if err != nil {
		return nil, err
	}
	if q.Action == "Datei" {
		var released bool
		if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM donation_report_steps WHERE report=$1 AND status='Exportiert')", q.Report).Scan(&released); err != nil {
			return nil, err
		}
		if !released {
			return nil, fail("Export zuerst freigeben.")
		}
		if err = audit(ctx, tx, d.Event, d.User, "Spendenexport abgerufen", q.Report); err != nil {
			return nil, err
		}
		return map[string]any{"datei": string(raw), "sha256": digest}, tx.Commit(ctx)
	}
	if !(status == "" && q.Action == "Geprüft") && !donationStepAllowed(status, q.Action) {
		return nil, fail("Unzulässige Statusfolge. Verlauf erneut laden.")
	}
	if q.Action == "Exportiert" {
		_, current, err := donationBytes(ctx, tx, d.Event, q.Period)
		if err != nil {
			return nil, err
		}
		if current != digest {
			return nil, fail("Bestand geändert. Korrekturlauf erforderlich.")
		}
	}
	_, err = tx.Exec(ctx, "INSERT INTO donation_report_steps(request_id,report,status,actor,evidence) VALUES($1,$2,$3,$4,$5)", q.Request, q.Report, q.Action, d.User, q.Reason)
	if err != nil {
		return nil, err
	}
	if err = audit(ctx, tx, d.Event, d.User, "Spendenprüflauf · "+q.Action, q.Report); err != nil {
		return nil, err
	}
	return q.Action, tx.Commit(ctx)
}
