package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/crypto/bcrypt"
)

func (a *app) registerUsers(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/admin/users", route(a.adminUsers))
	mux.HandleFunc("POST /api/admin/users", route(a.editAdminUser))
	mux.HandleFunc("POST /api/password-change", route(a.changeRequiredPassword))
}

type accountSummary struct {
	ID, Login, Label, Role  string
	Active, MFA, MustChange bool
	LastLogin               *time.Time
	Version                 int64
	Events                  []string
	Sessions                int
}

type accountEvent struct{ ID, Name, Year string }

func accountManager(ctx context.Context, tx pgx.Tx, r *http.Request, write bool) (string, error) {
	c, err := r.Cookie("bonfire_session")
	if err != nil || c.Value == "" {
		return "", problem{401, "Anmeldung erforderlich."}
	}
	query := "SELECT u.name,u.role FROM sessions s JOIN users u ON u.name=s.username WHERE s.token=$1 AND s.expires>now() AND u.active AND NOT u.password_change_required"
	if write {
		query += " FOR UPDATE OF u"
	}
	var name, role string
	err = tx.QueryRow(ctx, query, hash(c.Value)).Scan(&name, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", problem{401, "Anmeldung abgelaufen."}
	}
	if err != nil {
		return "", err
	}
	if write {
		var valid bool
		if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM sessions WHERE token=$1 AND username=$2 AND expires>clock_timestamp() FOR SHARE)", hash(c.Value), name).Scan(&valid); err != nil {
			return "", err
		}
		if !valid {
			return "", problem{401, "Session expired."}
		}
	}
	if role != roleAdmin {
		return "", problem{403, "Benutzerverwaltung erfordert Adminrechte."}
	}
	return name, nil
}

func (a *app) adminUsers(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	tx, err := a.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	self, err := accountManager(ctx, tx, r, false)
	if err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `SELECT name,coalesce(login_alias,name),display_name,role,active,otp_secret IS NOT NULL,
		password_change_required,last_login_at,account_revision,
		ARRAY(SELECT event::text FROM grants_event WHERE username=u.name ORDER BY event),
		(SELECT count(*) FROM sessions WHERE username=u.name AND expires>now())
		FROM users u ORDER BY u.active DESC, lower(coalesce(nullif(display_name,''),login_alias,name)),name`)
	if err != nil {
		return nil, err
	}
	users, err := pgx.CollectRows(rows, pgx.RowToStructByPos[accountSummary])
	if err != nil {
		return nil, err
	}
	rows, err = tx.Query(ctx, `SELECT e.id::text,e.name,coalesce(y.name,'Ohne Jahreszuordnung') FROM events e LEFT JOIN fiscal_years y ON y.id=e.fiscal_year ORDER BY y.starts DESC NULLS LAST,e.general_ledger DESC,e.name,e.id`)
	if err != nil {
		return nil, err
	}
	events, err := pgx.CollectRows(rows, pgx.RowToStructByPos[accountEvent])
	if err != nil {
		return nil, err
	}
	return map[string]any{"self": self, "users": users, "events": events}, tx.Commit(ctx)
}

type changeAccount struct {
	Action, ID, Login, Label, Role, Password, Reason string
	MustChange                                       bool
	Version                                          int64
	Events                                           []string
}

func accountPassword(value string) ([]byte, error) {
	if len(value) < 14 || len(value) > 72 {
		return nil, fail("Das Passwort muss 14 bis 72 Bytes umfassen.")
	}
	return bcrypt.GenerateFromPassword([]byte(value), 12)
}

func (a *app) editAdminUser(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	var q changeAccount
	if err := read(r, &q); err != nil {
		return nil, err
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	// Also serializes checks for the last active administrator with concurrent edits.
	// The existing access endpoint takes the shared form of this lock.
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(751025)"); err != nil {
		return nil, err
	}
	self, err := accountManager(ctx, tx, r, true)
	if err != nil {
		return nil, err
	}
	q.Login = loginName(q.Login)
	q.Label = strings.TrimSpace(q.Label)
	q.Reason = strings.TrimSpace(q.Reason)
	if len(q.Reason) < 3 || len(q.Reason) > 320 {
		return nil, fail("Begründung mit 3 bis 320 Zeichen angeben.")
	}
	creating := q.Action == "create"
	if creating || q.Action == "edit" {
		q.Role = canonicalRole(q.Role)
		if !validLoginName(q.Login) || len(q.Label) > 160 || !slices.Contains([]string{roleAdmin, roleWrite, roleRead}, q.Role) {
			return nil, fail("Anmeldung, Anzeigename oder Rolle ungültig.")
		}
		slices.Sort(q.Events)
		q.Events = slices.Compact(q.Events)
		for _, id := range q.Events {
			if !idPattern.MatchString(id) {
				return nil, fail("Ungültiger Arbeitsbereich.")
			}
		}
		if creating {
			q.ID = q.Login
		}
		var clash bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE (name=$1 OR coalesce(login_alias,name)=$1) AND (name<>$2 OR $3))`, q.Login, q.ID, creating).Scan(&clash); err != nil {
			return nil, err
		}
		if clash {
			return nil, problem{409, "Dieser Anmeldename ist bereits vergeben."}
		}
	}
	var oldRole, oldLogin string
	var active bool
	var current int64
	if !creating {
		err = tx.QueryRow(ctx, "SELECT role,active,coalesce(login_alias,name),account_revision FROM users WHERE name=$1 FOR UPDATE", q.ID).Scan(&oldRole, &active, &oldLogin, &current)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, problem{404, "Benutzer unbekannt."}
		}
		if err != nil {
			return nil, err
		}
		if current != q.Version {
			return nil, problem{409, "Das Konto wurde inzwischen geändert. Bitte Liste aktualisieren."}
		}
		if active && oldRole == roleAdmin && (q.Action == "disable" || (q.Action == "edit" && q.Role != roleAdmin)) {
			var remaining bool
			if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM users WHERE active AND role='Admin' AND name<>$1)", q.ID).Scan(&remaining); err != nil {
				return nil, err
			}
			if !remaining {
				return nil, fail("Mindestens ein aktives Admin-Konto muss erhalten bleiben.")
			}
		}
	}
	action := ""
	revoke := false
	switch q.Action {
	case "create", "edit":
		if creating {
			digest, err := accountPassword(q.Password)
			if err != nil {
				return nil, err
			}
			_, err = tx.Exec(ctx, `INSERT INTO users(name,display_name,password,role,password_change_required) VALUES($1,$2,$3,$4,$5)`, q.ID, q.Label, string(digest), q.Role, q.MustChange)
			if err != nil {
				var violation *pgconn.PgError
				if errors.As(err, &violation) && violation.Code == "23505" {
					return nil, problem{409, "Dieser Anmeldename ist bereits vergeben."}
				}
				return nil, err
			}
			action = "Benutzer angelegt · Rolle " + q.Role
		} else {
			if _, err = tx.Exec(ctx, `UPDATE users SET display_name=$2,login_alias=nullif($3,name),role=$4 WHERE name=$1`, q.ID, q.Label, q.Login, q.Role); err != nil {
				return nil, err
			}
			action = "Kontodaten bearbeitet"
			if oldRole != q.Role {
				action += " · Rolle " + oldRole + " → " + q.Role
			}
			if oldLogin != q.Login {
				action += " · Anmeldename geändert"
			}
			revoke = oldRole != q.Role || oldLogin != q.Login
		}
		changes, err := replaceAccountGrants(ctx, tx, q.ID, q.Events)
		if err != nil {
			return nil, err
		}
		action += changes
		revoke = revoke || (!creating && changes != "")
	case "password":
		digest, err := accountPassword(q.Password)
		if err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, "UPDATE users SET password=$2,password_change_required=$3 WHERE name=$1", q.ID, string(digest), q.MustChange); err != nil {
			return nil, err
		}
		action = "Passwort zurückgesetzt"
		if q.MustChange {
			action += " · Wechsel bei nächster Anmeldung"
		}
		revoke = true
	case "mfa":
		if _, err = tx.Exec(ctx, "UPDATE users SET otp_secret=NULL,otp_last=-1 WHERE name=$1", q.ID); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, "DELETE FROM recovery_codes WHERE username=$1", q.ID); err != nil {
			return nil, err
		}
		action = "Zweiter Faktor und Recoverycodes zurückgesetzt"
		revoke = true
	case "disable", "enable":
		next := q.Action == "enable"
		if active == next {
			return nil, fail("Der Zugang hat bereits diesen Status.")
		}
		if _, err = tx.Exec(ctx, "UPDATE users SET active=$2 WHERE name=$1", q.ID, next); err != nil {
			return nil, err
		}
		action = "Benutzer gesperrt"
		if next {
			action = "Benutzer wieder aktiviert"
		}
		revoke = true
	case "sessions":
		action = "Sitzungen widerrufen"
		revoke = true
	default:
		return nil, fail("Unbekannte Kontoaktion.")
	}
	if !creating {
		if _, err = tx.Exec(ctx, "UPDATE users SET account_revision=account_revision+1 WHERE name=$1", q.ID); err != nil {
			return nil, err
		}
	}
	if revoke {
		if err = revokeAccountAccess(ctx, tx, q.ID); err != nil {
			return nil, err
		}
		action += " · Zugänge widerrufen"
	}
	if _, err = tx.Exec(ctx, "INSERT INTO audit(username,action,subject) VALUES($1,$2,$3)", self, action+" · "+q.Reason, q.ID); err != nil {
		return nil, err
	}
	return map[string]bool{"signedOut": revoke && self == q.ID}, tx.Commit(ctx)
}

func replaceAccountGrants(ctx context.Context, tx pgx.Tx, user string, desired []string) (string, error) {
	rows, err := tx.Query(ctx, "SELECT event::text FROM grants_event WHERE username=$1 ORDER BY event", user)
	if err != nil {
		return "", err
	}
	old, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return "", err
	}
	if slices.Equal(old, desired) {
		return "", nil
	}
	added, removed := []string{}, []string{}
	for _, id := range desired {
		if !slices.Contains(old, id) {
			result, err := tx.Exec(ctx, "INSERT INTO grants_event(username,event) SELECT $1,id FROM events WHERE id=$2", user, id)
			if err != nil {
				return "", err
			}
			if result.RowsAffected() != 1 {
				return "", fail("Arbeitsbereich unbekannt.")
			}
			added = append(added, id)
		}
	}
	for _, id := range old {
		if !slices.Contains(desired, id) {
			if _, err := tx.Exec(ctx, "DELETE FROM grants_event WHERE username=$1 AND event=$2", user, id); err != nil {
				return "", err
			}
			removed = append(removed, id)
		}
	}
	return fmt.Sprintf(" · Freigaben hinzugefügt %v, entzogen %v", added, removed), nil
}

func revokeAccountAccess(ctx context.Context, tx pgx.Tx, user string) error {
	for _, sql := range []string{
		"DELETE FROM sessions WHERE username=$1",
		"DELETE FROM login_challenges WHERE username=$1",
		"DELETE FROM password_changes WHERE username=$1",
		"UPDATE devices SET expires=least(now(),expires) WHERE username=$1 AND NOT online_actor",
	} {
		if _, err := tx.Exec(ctx, sql, user); err != nil {
			return err
		}
	}
	return nil
}

func (a *app) changeRequiredPassword(ctx context.Context, w http.ResponseWriter, r *http.Request) (any, error) {
	var q struct{ Ticket, Password string }
	if err := read(r, &q); err != nil {
		return nil, err
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var id, old string
	err = tx.QueryRow(ctx, `SELECT u.name,u.password FROM password_changes c JOIN users u ON u.name=c.username WHERE c.token=$1 AND c.expires>now() AND u.active AND u.password_change_required FOR UPDATE OF u`, hash(q.Ticket)).Scan(&id, &old)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, problem{410, "Passwortwechsel abgelaufen. Bitte erneut anmelden."}
	}
	if err != nil {
		return nil, err
	}
	consumed, err := tx.Exec(ctx, "DELETE FROM password_changes WHERE token=$1 AND expires>clock_timestamp()", hash(q.Ticket))
	if err != nil {
		return nil, err
	}
	if consumed.RowsAffected() != 1 {
		return nil, problem{410, "Passwortwechsel abgelaufen. Bitte erneut anmelden."}
	}
	if bcrypt.CompareHashAndPassword([]byte(old), []byte(q.Password)) == nil {
		return nil, fail("Ein anderes Passwort als das Startpasswort wählen.")
	}
	digest, err := accountPassword(q.Password)
	if err != nil {
		return nil, err
	}
	if err = revokeAccountAccess(ctx, tx, id); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, "UPDATE users SET password=$2,password_change_required=false,account_revision=account_revision+1 WHERE name=$1", id, string(digest)); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO audit(username,action,subject) VALUES($1,'Startpasswort geändert',$1)", id); err != nil {
		return nil, err
	}
	return true, tx.Commit(ctx)
}
