package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

type data struct {
	BalanceOrder                                                                                                                             int64             `json:",string,omitempty"`
	PostingOrder                                                                                                                             int64             `json:",string,omitempty"`
	Retired                                                                                                                                  bool              `json:",omitempty"`
	Lines                                                                                                                                    []position        `json:",omitempty"`
	Allocations                                                                                                                              map[string]int64  `json:",omitempty"`
	Fields                                                                                                                                   map[string]string `json:",omitempty"`
	Label, Date, Bar, Wallet, Account, To, Contact, Method, Category, Reference, Note, Phase, Address, Unit, Variant, Status, Filename, File string
	Amount                                                                                                                                   *int64
	Pieces                                                                                                                                   map[string]int64
	Number                                                                                                                                   int64
	PDF, DOCX                                                                                                                                string
}
type op struct {
	yearCarry        bool
	LocalTime        string `json:",omitempty"`
	ID, Target, Kind string
	Seq, Base        int64
	Data             data
}
type row struct {
	ID, Kind, Device string
	Revision         int64
	Data             data
}
type clash struct {
	ID, Target, Kind string
	Data             data
	Base             int64
}
type request struct {
	Prints                                                []printLog
	Ops                                                   []op
	Resolve, Choice, Reason, Action, Account, Destination string
	Last                                                  int64
}

var key = regexp.MustCompile("^[a-zA-Z0-9_.:-]{1,160}$")
var idPattern = regexp.MustCompile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
var kinds = strings.Fields("income expense refund deposit deposit-return transfer outlay reimbursement card fee payout cashback donation sponsorship payment presale price contact bar wallet shift count plan supply skim return opening actual period template attachment attachment-file original dispatch organization handover import-source account paper reserve")
var money = strings.Fields("income expense refund deposit deposit-return transfer outlay reimbursement card fee payout cashback donation sponsorship payment presale price supply skim return opening actual")
var denoms = map[string]int64{"20000": 20000, "10000": 10000, "5000": 5000, "2000": 2000, "1000": 1000, "500": 500, "200": 200, "100": 100, "50": 50, "20": 20, "10": 10, "5": 5, "2": 2, "1": 1}

func checkCashAmount(v data) error {
	if v.Amount == nil || *v.Amount < 0 || *v.Amount > 999999999999 {
		return fail("Gültigen Centbetrag angeben.")
	}
	if v.Pieces == nil {
		return nil
	}
	var total int64
	for k, n := range v.Pieces {
		c, ok := denoms[k]
		if !ok || n < 0 || n > 1000000 {
			return fail("Ungültige Stückelung.")
		}
		total += c * n
	}
	if *v.Amount != total {
		return fail("Zählsumme stimmt nicht.")
	}
	return nil
}

func validate(o op, accounts bool) error {
	v := o.Data
	if v.Retired && (o.Base == 0 || o.Kind != "contact" && (o.Kind != "price" || v.Status == "Freigegeben")) {
		return fail("Nur ein vorhandener Kontakt oder Preisentwurf kann archiviert werden.")
	}
	if len(v.Lines) > 0 {
		amount, err := amountPositions(v.Lines)
		if err != nil {
			return err
		}
		if o.Kind != "sponsorship" || v.Amount == nil || amount != *v.Amount {
			return fail("Positionssumme stimmt nicht.")
		}
	}
	if len(v.Allocations) > 100 || len(v.Allocations) > 0 && o.Kind != "reimbursement" {
		return fail("Ungültige Erstattungszuordnung.")
	}
	if len(v.Fields) > 35 {
		return fail("Zu viele Zusatzfelder.")
	}
	for k, value := range v.Fields {
		if !key.MatchString(k) || len(value) > 8000 {
			return fail("Ungültiges Zusatzfeld.")
		}
	}
	if o.Kind == "donation" && len(strings.TrimSpace(v.Fields["reporting"])) > 100 {
		return fail("Reporting period exceeds 100 bytes.")
	}
	if o.Kind == "price" && v.Status != "" && v.Status != "Entwurf" && v.Status != "Freigegeben" {
		return fail("Preisstatus ungültig.")
	}
	if o.Kind == "price" {
		if err := validatePrice(v); err != nil {
			return err
		}
	}
	if slices.Contains([]string{"supply", "skim", "return", "cashback"}, o.Kind) && v.Wallet == "" {
		return fail("Geldtasche auswählen.")
	}
	if o.Kind == "sponsorship" && !slices.Contains([]string{"", "Offen", "Zugesagt", "Zurückgezogen"}, v.Fields["pledge"]) {
		return fail("Zusagestatus ungültig.")
	}
	if o.Kind == "dispatch" && (!strings.HasPrefix(v.Reference, "original:") || o.Target != "dispatch:"+v.Reference ||
		!slices.Contains([]string{"Extern übergeben", "Extern versandt", "Vermerk aufgehoben"}, v.Status) || (v.Status == "Vermerk aufgehoben" && o.Base == 0) || len(strings.TrimSpace(v.Note)) < 3) {
		return fail("Originalbeleg, Übergabestatus und Nachweis angeben.")
	}
	if o.Kind == "organization" && o.Target != "organization" {
		return fail("Organisationsprofil ungültig.")
	}
	if !key.MatchString(o.Target) || !idPattern.MatchString(o.ID) || o.Seq < 1 || o.Base < 0 || !slices.Contains(kinds, o.Kind) || len(strings.TrimSpace(v.Label)) == 0 || len(v.Label) > 200 || !date(v.Date) {
		return fail("Vorgangsart, Bezeichnung, Datum oder Kennung ungültig.")
	}
	if slices.Contains(money, o.Kind) && (v.Amount == nil || *v.Amount < 0 || *v.Amount > 999999999999) {
		return fail("Gültigen Centbetrag angeben.")
	}
	if o.Base > 0 && len(strings.TrimSpace(v.Note)) < 3 && !((o.Kind == "price" || o.Kind == "contact") && len(strings.TrimSpace(v.Fields["lifecycleReason"])) >= 3) {
		return fail("Änderung begründen.")
	}
	if accounts && slices.Contains(strings.Fields("income expense refund deposit deposit-return reimbursement fee card payout donation payment presale"), o.Kind) && v.Account == "" {
		return fail("Kontozuordnung fehlt.")
	}
	if slices.Contains([]string{"transfer", "payout", "skim", "supply", "return", "cashback"}, o.Kind) && (v.Account == "" || v.To == "" || v.To == v.Account) {
		return fail("Verschiedene Quell- und Zielkonten angeben.")
	}
	if (o.Kind == "supply" && v.To != v.Wallet) || ((o.Kind == "skim" || o.Kind == "return") && v.Account != v.Wallet) {
		return fail("The cash movement must use the selected wallet as its cash endpoint.")
	}
	if o.Kind == "supply" {
		mode := v.Fields["countMode"]
		if !slices.Contains([]string{"", "amount", "pieces"}, mode) || (mode == "pieces") != (v.Pieces != nil) {
			return fail("Betragseingabe und Stückelung der Nachversorgung prüfen.")
		}
		if err := checkCashAmount(v); err != nil {
			return err
		}
	}
	if o.Kind == "count" || o.Kind == "plan" || o.Kind == "reserve" {
		if o.Kind == "reserve" && (o.Target != "coinreserve" || v.Wallet != "" || v.Bar != "") {
			return fail("Wechselgeldbestand wird zentral erfasst.")
		}
		pooled := o.Kind == "count" && v.Fields["countScope"] == "all"
		manual := o.Kind == "count" && v.Fields["countMode"] == "amount"
		if o.Kind == "count" && (!slices.Contains([]string{"", "wallet", "all"}, v.Fields["countScope"]) ||
			!slices.Contains([]string{"", "amount", "pieces"}, v.Fields["countMode"])) {
			return fail("Zählumfang oder Betragseingabe ungültig.")
		}
		if pooled && (v.Wallet != "" || v.Bar != "" || v.Phase == "Zwischenstand") {
			return fail("Eine Gesamtzählung gehört zur gesamten Veranstaltung.")
		}
		if o.Kind != "reserve" && ((!pooled && v.Wallet == "") || !slices.Contains([]string{"Anfang", "Zwischenstand", "Ende"}, v.Phase)) || (v.Pieces == nil) != manual {
			return fail("Geldtasche, Zählphase und Stückelung angeben.")
		}
		if err := checkCashAmount(v); err != nil {
			return err
		}
		phase := v.Phase
		if observation := v.Fields["observation"]; observation != "" {
			if o.Kind != "count" || phase != "Zwischenstand" || !idPattern.MatchString(observation) {
				return fail("Ungültige Zwischenbeobachtung.")
			}
			phase += "|" + observation
		}
		if o.Kind != "reserve" && o.Target != countKey(o.Kind, v.Wallet, phase) {
			return fail("Kennung der Zählung ungültig.")
		}
	}
	if o.Kind == "period" && (!date(v.To) || v.To < v.Date) {
		return fail("Periodenende prüfen.")
	}
	if o.Kind == "original" && (v.Reference == "" || v.Number <= 0 || !strings.HasPrefix(v.PDF, "JVBER") || !strings.HasPrefix(v.DOCX, "UEsD") || o.Base != 0 || o.Target != "original:"+archiveKey(v)) {
		return fail("Originaldateien oder Belegbezug ungültig.")
	}
	if o.Kind == "import-source" {
		b, err := base64.StdEncoding.DecodeString(v.File)
		if err != nil || len(b) == 0 || len(b) > 4<<20 || fmt.Sprintf("%x", hash(string(b))) != v.Reference || o.Target != "source:"+v.Reference || o.Base != 0 || !slices.Contains([]string{"Journal", "D1"}, v.Status) {
			return fail("Importquelle oder Herkunft ungültig.")
		}
	}
	if o.Kind == "organization" && v.File != "" {
		b, err := base64.StdEncoding.DecodeString(v.File)
		if err != nil || len(b) > 300000 || !bytes.HasPrefix(b, []byte{137, 80, 78, 71, 13, 10, 26, 10}) {
			return fail("Organisationslogo ungültig.")
		}
	}
	if o.Kind == "attachment" || o.Kind == "attachment-file" {
		return attachmentValid(o)
	}
	return nil
}
func countKey(kind, wallet, phase string) string {
	return fmt.Sprintf("%s:%x", kind, hash(wallet + "|" + phase)[:16])
}
func inspect(ctx context.Context, tx pgx.Tx, d device, o op) (string, error) {
	if err := fiscalDateAllowed(ctx, tx, d.Event, o); err != nil {
		return "", err
	}
	if o.Kind == "contact" {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", o.Target); err != nil {
			return "", err
		}
		available, err := contactNameAvailable(ctx, tx, o)
		if err != nil {
			return "", err
		}
		if !available {
			return "Konflikt", nil
		}
		ok, err := lifecycle(ctx, tx, d, o)
		if err != nil {
			return "", err
		}
		if !ok {
			return "Konflikt", nil
		}
		if !d.Donor {
			if o.Data.Fields["birth"] != "" {
				return "", problem{403, "Freigabe für Meldedaten fehlt."}
			}
			var kept *string
			err := tx.QueryRow(ctx, "SELECT data->'Fields'->>'birth' FROM directory WHERE id=$1", o.Target).Scan(&kept)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return "", err
			}
			if kept != nil {
				if o.Data.Fields == nil {
					o.Data.Fields = map[string]string{}
				}
				o.Data.Fields["birth"] = *kept
			}
		}
		tag, err := tx.Exec(ctx, "INSERT INTO directory(id,revision,data,device) SELECT $1,1,$2,$3 WHERE $4::bigint=0 OR EXISTS(SELECT 1 FROM directory WHERE id=$1) ON CONFLICT(id) DO UPDATE SET revision=directory.revision+1,data=excluded.data WHERE directory.revision=$4", o.Target, o.Data, d.ID, o.Base)
		if err != nil {
			return "", err
		}
		if tag.RowsAffected() == 0 {
			return "Konflikt", nil
		}
		return "Übernommen", nil
	}
	frozen, err := protectedPeriod(ctx, tx, d, o)
	if err != nil {
		return "", err
	}
	if frozen {
		return "Konflikt", nil
	}
	if o.Kind == "attachment-file" {
		return attachBody(ctx, tx, d, o)
	}
	if o.Kind == "attachment" && o.Data.Fields["sha256"] != "" {
		o.Data.Fields["uploadDevice"] = d.ID
	}
	var rev int64
	var kind string
	err = tx.QueryRow(ctx, "SELECT revision,kind FROM entries WHERE event=$1 AND id=$2", d.Event, o.Target).Scan(&rev, &kind)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	if rev == 0 && o.Base == 0 {
		var removed bool
		if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT FROM entry_removals WHERE event=$1 AND target=$2)", d.Event, o.Target).Scan(&removed); err != nil {
			return "", err
		}
		if removed {
			return "Konflikt", nil
		}
	}
	if rev != o.Base || rev > 0 && kind != o.Kind {
		return "Konflikt", nil
	}
	if o.Kind == "price" {
		ok, err := lifecycle(ctx, tx, d, o)
		if err != nil {
			return "", err
		}
		if !ok {
			return "Konflikt", nil
		}
	}
	assigned, err := allocationValid(ctx, tx, d, o)
	if err != nil {
		return "", err
	}
	if !assigned {
		return "Konflikt", nil
	}
	ok, err := preconditions(ctx, tx, d, o)
	if err != nil {
		return "", err
	}
	if !ok {
		return "Konflikt", nil
	}
	if o.Kind == "original" {
		v := o.Data
		if d.Online {
			next, err := nextOnlineNumber(ctx, tx, d)
			if err != nil {
				return "", err
			}
			if next != v.Number {
				return "", problem{409, "Belegnummer inzwischen vergeben. Bitte neu laden."}
			}
		}
		var owner, subjectKind string
		var subjectData data
		err = tx.QueryRow(ctx, "SELECT device::text,kind,data FROM entries WHERE event=$1 AND id=$2 AND kind IN ('sponsorship','payment','donation')", d.Event, v.Reference).Scan(&owner, &subjectKind, &subjectData)
		if errors.Is(err, pgx.ErrNoRows) {
			return "Konflikt", nil
		}
		if err != nil || owner != d.ID || v.Number < d.Block*1000 || v.Number >= d.Block*1000+d.DigitalCount {
			return "", fail("Keine Ausstellungszuständigkeit oder Nummernreserve.")
		}
		if v.Fields["series"] == "confirmation" {
			var snap struct {
				Profile       string
				ReceivedCents *int64
			}
			if json.Unmarshal([]byte(v.Note), &snap) != nil || snap.Profile != subjectKind+"_confirmation_a4" || snap.ReceivedCents == nil || subjectData.Amount == nil || *snap.ReceivedCents != *subjectData.Amount {
				return "", fail("Bestätigung passt nicht zum Zahlungseingang.")
			}
		}
		pdf, doc, archiveErr := checkArchive(d, v)
		if archiveErr != nil {
			return "", archiveErr
		}
		previous, match, err := predecessor(ctx, tx, d, v)
		if err != nil {
			return "", err
		}
		if !match {
			return "Konflikt", nil
		}
		tag, err := tx.Exec(ctx, "INSERT INTO originals(event,subject,number,device,pdf,docx,snapshot,previous_number) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING", d.Event, archiveKey(v), v.Number, d.ID, pdf, doc, v.Note, previous)
		if err != nil {
			return "", err
		}
		if tag.RowsAffected() == 0 {
			return "Konflikt", nil
		}
	}
	allowed, err := checkReimbursements(ctx, tx, d, o)
	if err != nil {
		return "", err
	}
	if !allowed {
		return "Konflikt", nil
	}
	if o.Kind == "payment" {
		parent := "sponsorship"
		var limit, paid int64
		err = tx.QueryRow(ctx, "SELECT (data->>'Amount')::bigint FROM entries WHERE event=$1 AND id=$2 AND kind=$3", d.Event, o.Data.Reference, parent).Scan(&limit)
		if err != nil {
			return "Konflikt", nil
		}
		err = tx.QueryRow(ctx, "SELECT coalesce(sum((data->>'Amount')::bigint),0)::bigint FROM entries WHERE event=$1 AND kind=$2 AND data->>'Reference'=$3 AND id<>$4", d.Event, o.Kind, o.Data.Reference, o.Target).Scan(&paid)
		if err != nil {
			return "", err
		}
		if paid+*o.Data.Amount > limit {
			return "Konflikt", nil
		}
	}
	if o.Kind == "handover" {
		valid, err := validHandover(ctx, tx, d, o)
		if err != nil {
			return "", err
		}
		if !valid {
			return "Konflikt", nil
		}
	}
	if o.Kind == "wallet" {
		delete(o.Data.Fields, "owner")
	}
	if err = retainPrior(ctx, tx, d, o); err != nil {
		return "", err
	}
	_, err = tx.Exec(ctx, "INSERT INTO entries(event,id,revision,device,kind,data) VALUES($1,$2,1,$3,$4,$5) ON CONFLICT(event,id) DO UPDATE SET revision=entries.revision+1,data=excluded.data", d.Event, o.Target, d.ID, o.Kind, o.Data)
	return "Übernommen", err
}
func accept(ctx context.Context, tx pgx.Tx, d *device, o op) error {
	if !o.yearCarry && (o.Data.Fields["yearSource"] != "" || o.Data.Fields["yearPeriod"] != "" || o.Data.Fields["yearStamp"] != "") {
		return fail("Vorjahresquelle über die bestätigte Übernahme auswählen.")
	}
	var old []byte
	var owner string
	if !idPattern.MatchString(o.ID) {
		return fail("Ungültige Vorgangs-ID.")
	}
	var storedSeq int64
	err := tx.QueryRow(ctx, "SELECT digest,device::text,seq FROM operations WHERE id=$1", o.ID).Scan(&old, &owner, &storedSeq)
	if d.Online {
		o.Seq = d.Last + 1
		if err == nil {
			o.Seq = storedSeq
		}
	}
	raw, _ := json.Marshal(o)
	digest := hash(string(raw))
	if err == nil {
		if owner != d.ID || subtle.ConstantTimeCompare(old, digest) != 1 {
			return fail("Vorgangs-ID mit abweichendem Inhalt.")
		}
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if d.Closed || d.Sealed || (d.Role != roleAdmin && d.Role != roleWrite) {
		return problem{403, "Erfassung gesperrt."}
	}
	if o.Seq != d.Last+1 {
		return fail("Gerätefolge unvollständig.")
	}
	if err = validate(o, false); err != nil {
		return err
	}
	if (slices.Contains([]string{"opening", "period", "template", "organization", "import-source", "dispatch"}, o.Kind) || strings.HasPrefix(o.Target, "import:") || strings.HasPrefix(o.Data.Reference, "source:")) && d.Role != roleAdmin {
		return problem{403, "Adminrecht erforderlich."}
	}
	outcome := "Konflikt"
	if d.IncidentState != "returning" {
		outcome, err = inspect(ctx, tx, *d, o)
		if err != nil {
			return err
		}
	}
	if d.Online && outcome == "Konflikt" {
		return problem{409, "Buchung widerspricht dem aktuellen Stand. Bitte aktualisieren und Angaben prüfen."}
	}
	if o.Kind == "original" && outcome == "Konflikt" {
		if o.Data.Number < d.Block*1000 || o.Data.Number >= d.Block*1000+d.DigitalCount {
			return fail("Nummer außerhalb der Gerätereserve.")
		}
		if _, _, err := checkArchive(*d, o.Data); err != nil {
			return err
		}
	}
	var localTime *time.Time
	if o.LocalTime != "" {
		t, err := time.Parse(time.RFC3339Nano, o.LocalTime)
		if err != nil {
			return fail("Gerätezeit ungültig.")
		}
		localTime = &t
	}
	_, err = tx.Exec(ctx, "INSERT INTO operations(id,event,device,seq,digest,target,base,kind,data,outcome,local_time) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", o.ID, d.Event, d.ID, o.Seq, digest, o.Target, o.Base, o.Kind, o.Data, outcome, localTime)
	if err != nil {
		return err
	}
	d.Last = o.Seq
	if outcome == "Übernommen" && (o.Kind == "contact" || o.Kind == "price") && (o.Data.Fields["lifecycle"] == "Archiviert" || o.Data.Fields["lifecycle"] == "Wiederhergestellt") {
		return audit(ctx, tx, d.Event, d.User, o.Data.Fields["lifecycle"], o.ID)
	}
	return audit(ctx, tx, d.Event, d.User, outcome, o.ID)
}
func (a *app) syncEvent(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	var q request
	if err := read(r, &q); err != nil {
		return nil, err
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	const closeYear = "Geschäftsjahr abschließen"
	if q.Action == closeYear {
		if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(751025)"); err != nil {
			return nil, err
		}
	}
	d, err := lock(ctx, tx, r)
	if err != nil {
		return nil, err
	}
	if d.Online && q.Action == "Ende" {
		return nil, fail("Onlinebuchungen sind unmittelbar gespeichert.")
	}
	if d.IncidentState == "returning" && (q.Resolve != "" || q.Action != "" && q.Action != "Ende") {
		return nil, problem{403, "Rückkehrprofil darf nur Daten abgleichen und sein Erfassungsende bestätigen."}
	}
	for _, o := range q.Ops {
		if err = accept(ctx, tx, &d, o); err != nil {
			return nil, err
		}
	}
	acceptedPrints, err := acceptPrintLog(ctx, tx, d, q.Prints)
	if err != nil {
		return nil, err
	}
	if q.Resolve != "" {
		if d.Role != roleAdmin || d.Closed || len(strings.TrimSpace(q.Reason)) < 3 {
			return nil, fail("Klärung durch einen Admin mit Begründung erforderlich.")
		}
		var o op
		origin := d
		err = tx.QueryRow(ctx, "SELECT o.id::text,o.target,o.kind,o.data,x.id::text,x.username,u.role,x.donor_access,x.block,x.incident_state,o.seq,x.digital_count FROM operations o JOIN devices x ON x.id=o.device JOIN users u ON u.name=x.username WHERE o.id=$1 AND o.event=$2 AND o.outcome='Konflikt'", q.Resolve, d.Event).Scan(&o.ID, &o.Target, &o.Kind, &o.Data, &origin.ID, &origin.User, &origin.Role, &origin.Donor, &origin.Block, &origin.IncidentState, &o.Seq, &origin.DigitalCount)
		if err != nil {
			return nil, fail("Konflikt bereits geklärt oder unbekannt.")
		}
		if q.Choice == "übernehmen" {
			if o.Kind == "original" && q.Last != 0 {
				return nil, fail("Ein ausgestelltes Original bleibt unverändert.")
			}
			var current int64
			if err = tx.QueryRow(ctx, "SELECT coalesce(max(revision),0) FROM entries WHERE event=$1 AND id=$2", d.Event, o.Target).Scan(&current); err != nil {
				return nil, err
			}
			if o.Kind == "contact" {
				if err = tx.QueryRow(ctx, "SELECT coalesce(max(revision),0) FROM directory WHERE id=$1", o.Target).Scan(&current); err != nil {
					return nil, err
				}
			}
			if current != q.Last {
				return nil, fail("Stand inzwischen geändert. Erneut prüfen.")
			}
			o.Base = current
			if o.Kind == "contact" && current == 0 {
				available, err := contactNameAvailable(ctx, tx, o)
				if err != nil {
					return nil, err
				}
				if !available {
					if o.Data.Fields == nil {
						o.Data.Fields = map[string]string{}
					}
					o.Data.Fields["distinct"] = q.Reason
				}
			}
			if q.Account != "" || q.Destination != "" {
				if !d.Accounts || !slices.Contains(accountEntries, o.Kind) || q.Destination != "" && !slices.Contains(transferEntries, o.Kind) {
					return nil, fail("Kontoklärung passt nicht zum Vorgang.")
				}
				if q.Account != "" {
					o.Data.Account = q.Account
				}
				if q.Destination != "" {
					o.Data.To = q.Destination
				}
				if err = audit(ctx, tx, d.Event, d.User, "Kontozuordnung geklärt · "+o.Data.Account+" · "+o.Data.To, o.ID); err != nil {
					return nil, err
				}
			}
			if current > 0 && len(strings.TrimSpace(o.Data.Note)) < 3 {
				o.Data.Note = q.Reason
			}
			if err = validate(o, d.Accounts); err != nil {
				return nil, err
			}
			outcome, err := inspect(ctx, tx, origin, o)
			if err != nil {
				return nil, err
			}
			if outcome == "Konflikt" {
				return nil, fail("Fachlicher Konflikt besteht weiter.")
			}
		} else if q.Choice != "beibehalten" {
			return nil, fail("Klärentscheidung fehlt.")
		}
		_, err = tx.Exec(ctx, "UPDATE operations SET outcome='Geklärt' WHERE id=$1", q.Resolve)
		if err != nil {
			return nil, err
		}
		if err = audit(ctx, tx, d.Event, d.User, q.Choice+": "+q.Reason, q.Resolve); err != nil {
			return nil, err
		}
	}
	if q.Action == "Ende" {
		var missingFile bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM entries WHERE event=$1 AND kind='attachment' AND data->'Fields'->>'uploadDevice'=$2 AND coalesce(data->>'File','')='')`, d.Event, d.ID).Scan(&missingFile); err != nil {
			return nil, err
		}
		if missingFile {
			return nil, fail("Fehlende Belegdatei zuerst übertragen.")
		}
		if len(acceptedPrints) != len(q.Prints) {
			return nil, fail("Nachdrucke zuerst mit dem gespeicherten Original abgleichen.")
		}
		if q.Last != d.Last {
			return nil, fail("Letzten Stand zuerst synchronisieren.")
		}
		if d.IncidentState == "returning" {
			var open bool
			if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM operations WHERE device=$1 AND outcome='Konflikt')", d.ID).Scan(&open); err != nil {
				return nil, err
			}
			if open {
				return nil, fail("Rückkehrvorgänge zuerst einzeln klären.")
			}
			if _, err = tx.Exec(ctx, "UPDATE devices SET incident=NULL,incident_state='' WHERE id=$1", d.ID); err != nil {
				return nil, err
			}
			d.IncidentState = ""
			if err = audit(ctx, tx, d.Event, d.User, "Rückkehr abgeglichen und bestätigt", d.ID); err != nil {
				return nil, err
			}
		}
		d.Sealed = true
		if err = audit(ctx, tx, d.Event, d.User, "Erfassungsende", d.ID); err != nil {
			return nil, err
		}
	}
	if _, err = tx.Exec(ctx, "UPDATE devices SET last_seq=$1,sealed=$2,last_seen=now() WHERE id=$3", d.Last, d.Sealed, d.ID); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, "SELECT j.id,j.kind,j.device::text,j.revision,CASE WHEN a.active IS FALSE THEN j.data||jsonb_build_object('Fields',coalesce(nullif(j.data->'Fields','null'::jsonb),'{}'::jsonb)||jsonb_build_object('masterInactive','ja')) ELSE j.data END FROM settlement_entries j LEFT JOIN fire_account_links l ON (j.event,j.id)=(l.event,l.local_id) LEFT JOIN fire_accounts a ON a.id=l.account WHERE j.event=$1 AND j.kind<>'contact' UNION ALL SELECT id,'contact',device::text,revision,data FROM directory c WHERE $2='Admin' OR EXISTS(SELECT 1 FROM devices d WHERE d.id=c.device AND d.event=$1) OR EXISTS(SELECT 1 FROM entries j WHERE j.event=$1 AND j.data->>'Contact'=c.id) ORDER BY id", d.Event, d.Role)
	if err != nil {
		return nil, err
	}
	entries, err := pgx.CollectRows(rows, pgx.RowToStructByPos[row])
	if err != nil {
		return nil, err
	}
	rows, err = tx.Query(ctx, "SELECT id::text,target,kind,data,base FROM operations WHERE event=$1 AND outcome='Konflikt' ORDER BY recorded_at", d.Event)
	if err != nil {
		return nil, err
	}
	conflicts, err := pgx.CollectRows(rows, pgx.RowToStructByPos[clash])
	if err != nil {
		return nil, err
	}
	for i := range entries {
		projectData(&entries[i].Data, entries[i].Kind, d)
	}
	for i := range conflicts {
		projectData(&conflicts[i].Data, conflicts[i].Kind, d)
	}
	deviceRows, err := tx.Query(ctx, `SELECT d.id::text,d.name,d.sealed,d.incident_state,d.last_seq,
 CASE WHEN d.incident_state<>'' THEN concat_ws(' · ',nullif(d.incident,''),(SELECT a.action FROM audit a
 WHERE a.event=d.event AND a.subject=d.id::text AND (a.action LIKE 'Ausnahmeentscheid%' OR a.action LIKE 'Gerät zurück%')
 ORDER BY a.id DESC LIMIT 1)) ELSE '' END FROM devices d WHERE d.event=$1 AND NOT d.online_actor ORDER BY d.name,d.id`, d.Event)
	if err != nil {
		return nil, err
	}
	devices, err := pgx.CollectRows(deviceRows, pgx.RowToStructByPos[deviceInfo])
	if err != nil {
		return nil, err
	}
	var pending int
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM devices WHERE event=$1 AND NOT online_actor AND NOT sealed", d.Event).Scan(&pending); err != nil {
		return nil, err
	}
	var year fiscalYear
	if q.Action == closeYear {
		year, err = yearForClosure(ctx, tx, d)
		if err != nil {
			return nil, err
		}
		if !year.Closed {
			if err = checkYearEvents(ctx, tx, year.ID, d.Event); err != nil {
				return nil, err
			}
			balances, err := yearAccountBalances(ctx, tx, year.ID)
			if err != nil {
				return nil, err
			}
			for _, b := range balances {
				if b.Shared && (b.Opening == nil || b.Actual == nil || b.Soll != *b.Actual) {
					return nil, fail("Jahreskontenabgleich prüfen: " + b.Name)
				}
			}
		}
	}
	alreadyClosed := d.Closed
	if q.Action == "Abschluss" || q.Action == closeYear && !alreadyClosed {
		if d.Role != roleAdmin {
			return nil, problem{403, "Adminrecht für den Abschluss erforderlich."}
		}
		if pending != 0 || len(conflicts) > 0 || d.Closed {
			return nil, fail("Vollständige Gerätesiegel, offene Veranstaltung und geklärter Stand erforderlich.")
		}
		if err = validateSettlement(entries); err != nil {
			return nil, fail(err.Error())
		}
		if err = checkOpenPayments(entries); err != nil {
			return nil, err
		}
		if err = validateCarry(ctx, tx, entries); err != nil {
			return nil, err
		}
		if err = checkBalance(entries, d.Accounts); err != nil {
			return nil, err
		}
		_, err = tx.Exec(ctx, "INSERT INTO event_closures(event,version,snapshot,reviewer,account_mode) SELECT $1,coalesce(max(version),0)+1,$2,$3,$4 FROM event_closures WHERE event=$1", d.Event, entries, d.User, d.Accounts)
		if err != nil {
			return nil, err
		}
		_, err = tx.Exec(ctx, "UPDATE events SET closed=true WHERE id=$1", d.Event)
		if err != nil {
			return nil, err
		}
		d.Closed = true
		action := "Veranstaltungsabschluss"
		if q.Action == closeYear {
			action = "Kassenbuch abgeschlossen"
		}
		if err = audit(ctx, tx, d.Event, d.User, action, d.Event); err != nil {
			return nil, err
		}
	}
	if q.Action == closeYear && !year.Closed {
		if alreadyClosed {
			if err = validateSettlement(entries); err != nil {
				return nil, fail(err.Error())
			}
			if err = checkOpenPayments(entries); err != nil {
				return nil, err
			}
			if err = validateCarry(ctx, tx, entries); err != nil {
				return nil, err
			}
		}
		if _, err = tx.Exec(ctx, "UPDATE fiscal_years SET closed=true WHERE id=$1", year.ID); err != nil {
			return nil, err
		}
		if err = audit(ctx, tx, d.Event, d.User, "Geschäftsjahr abgeschlossen", year.ID); err != nil {
			return nil, err
		}
	}
	prices, err := priceHistory(ctx, tx, d.Event)
	if err != nil {
		return nil, err
	}
	out := map[string]any{"priceHistory": prices, "acknowledgedPrints": acceptedPrints, "incidentState": d.IncidentState, "entries": entries, "conflicts": conflicts, "sealed": d.Sealed, "pending": pending, "devices": devices, "accounts": d.Accounts, "closed": d.Closed, "last": d.Last}
	if d.Online {
		if err = onlineDetails(ctx, tx, d, out); err != nil {
			return nil, err
		}
	}
	return out, tx.Commit(ctx)
}
func checkBalance(entries []row, accounts bool) error {
	configured := map[string]bool{}
	if accounts {
		for _, r := range entries {
			if r.Kind == "account" || r.Kind == "wallet" {
				configured[r.ID] = true
			}
		}
	}
	balances := map[string]int64{}
	actual := map[string]data{}
	postings := map[string][]data{}
	opened := false
	for _, r := range entries {
		if accounts && (r.Kind == "account" || r.Kind == "wallet") {
			if _, exists := balances[r.ID]; !exists {
				balances[r.ID] = 0
			}
		}
		v := r.Data
		if v.Amount == nil {
			continue
		}
		account := v.Account
		if !accounts {
			account = "Gesamt"
		}
		n := *v.Amount
		switch r.Kind {
		case "actual":
			if _, ok := actual[account]; ok {
				return fail("Mehrere Istwerte für denselben Bestand.")
			}
			actual[account] = v
		case "opening":
			opened = true
			balances[account] += n
			postings[account] = append(postings[account], v)
		case "income", "payment", "donation", "presale", "card", "deposit":
			balances[account] += n
			postings[account] = append(postings[account], v)
		case "expense", "reimbursement", "fee", "deposit-return", "refund":
			balances[account] -= n
			postings[account] = append(postings[account], v)
		case "transfer", "return", "skim", "supply", "payout", "cashback":
			if accounts {
				balances[account] -= n
				postings[account] = append(postings[account], v)
				balances[v.To] += n
				postings[v.To] = append(postings[v.To], v)
			}
		}
	}
	if !opened || len(balances) != len(actual) {
		return fail("Eröffnung und vollständiger Istbestand erforderlich.")
	}
	for k, n := range balances {
		v, ok := actual[k]
		if !ok || *v.Amount != n || k == "" || accounts && !configured[k] {
			return fail("Bestandsdifferenz oder fehlende Zuordnung.")
		}
		if v.BalanceOrder <= 0 {
			return fail("Reconfirm the observed balance before closing.")
		}
		for _, posting := range postings[k] {
			if posting.Date > v.Date || posting.BalanceOrder <= 0 || posting.BalanceOrder >= v.BalanceOrder {
				return fail("Confirm the observed balance again after the final posting.")
			}
		}
	}
	return nil
}
func (a *app) user(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	admin, role, err := a.auth(ctx, r)
	if err != nil {
		return nil, err
	}
	if role != roleAdmin {
		return nil, problem{403, "Adminrecht erforderlich."}
	}
	var v struct{ Name, Password, Role, Event string }
	if err = read(r, &v); err != nil {
		return nil, err
	}
	v.Name = loginName(v.Name)
	v.Role = canonicalRole(v.Role)
	if !validLoginName(v.Name) || len(v.Password) < 14 || len(v.Password) > 72 || !slices.Contains([]string{roleWrite, roleRead}, v.Role) {
		return nil, fail("Name, Rolle oder Passwort ungültig.")
	}
	digest, err := bcrypt.GenerateFromPassword([]byte(v.Password), 12)
	if err != nil {
		return nil, err
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, "INSERT INTO users VALUES($1,$2,$3,true)", v.Name, string(digest), v.Role)
	if err != nil {
		return nil, fail("Benutzer bereits vorhanden.")
	}
	_, err = tx.Exec(ctx, "INSERT INTO grants_event VALUES($1,$2)", v.Name, v.Event)
	if err != nil {
		return nil, err
	}
	if err = audit(ctx, tx, v.Event, admin, "Benutzer zugewiesen", v.Name); err != nil {
		return nil, err
	}
	return true, tx.Commit(ctx)
}
func (a *app) metrics(w http.ResponseWriter, r *http.Request) {
	var dbBytes, backupAt, stale int64
	var open, clashes int
	err := a.db.QueryRow(r.Context(), "SELECT (SELECT count(*) FROM devices WHERE NOT online_actor AND NOT sealed),(SELECT count(*) FROM operations WHERE outcome='Konflikt'),pg_database_size(current_database()),(SELECT coalesce(extract(epoch FROM max(completed_at)),0)::bigint FROM backup_history),(SELECT count(*) FROM devices WHERE NOT online_actor AND NOT sealed AND last_seen<now()-interval '24 hours')").Scan(&open, &clashes, &dbBytes, &backupAt, &stale)
	if err != nil {
		http.Error(w, "unavailable", 503)
		return
	}
	w.Header().Set("Content-Type", "text/plain")
	fmt.Fprintf(w, "bonfire_online_request_errors_total %d\n", onlineSaveErrors.Load())
	fmt.Fprintf(w, "bonfire_devices_unsealed %d\nbonfire_conflicts_open %d\nbonfire_database_bytes %d\nbonfire_last_backup_timestamp_seconds %d\nbonfire_devices_stale %d\nbonfire_sync_errors_total %d\nbonfire_request_errors_total %d\n", open, clashes, dbBytes, backupAt, stale, rejectedSync.Load(), failedRequests.Load())
}
