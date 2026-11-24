package main

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5/pgxpool"
	"os"
)

func configureRuntime(ctx context.Context, pool *pgxpool.Pool) error {
	password := os.Getenv("BONFIRE_RUNTIME_PASSWORD")
	if len(password) < 24 {
		return errors.New("Separates Runtime-Kennwort erforderlich")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(751024)"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='bonfire_runtime') THEN CREATE ROLE bonfire_runtime LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB; END IF; END $$"); err != nil {
		return err
	}
	var sql string
	if err = tx.QueryRow(ctx, "SELECT format('ALTER ROLE bonfire_runtime PASSWORD %L',$1::text)", password).Scan(&sql); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, sql); err != nil {
		return errors.New("Runtime-Kennwort konnte nicht gesetzt werden")
	}
	if _, err = tx.Exec(ctx, runtimeGrants); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

const runtimeGrants = `REVOKE CREATE ON SCHEMA public FROM PUBLIC;
 GRANT USAGE ON SCHEMA public TO bonfire_runtime;
 GRANT SELECT ON ALL TABLES IN SCHEMA public TO bonfire_runtime;
 GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bonfire_runtime;
 GRANT INSERT ON users,events,fiscal_years,grants_event,devices,entries,operations,audit,originals,sessions,recovery_codes,event_closures,period_closures,directory,journal_history,print_log,donation_reports,donation_report_steps,price_history TO bonfire_runtime;
 GRANT UPDATE ON entries,events,devices,directory TO bonfire_runtime;
 GRANT UPDATE(name,starts,ends,closed) ON fiscal_years TO bonfire_runtime;
 REVOKE INSERT, UPDATE ON event_records FROM bonfire_runtime;
 GRANT UPDATE(deleted_at) ON event_records TO bonfire_runtime;
 GRANT INSERT, DELETE, UPDATE(remaining) ON login_challenges TO bonfire_runtime;
 GRANT UPDATE(otp_secret,otp_last,display_name,login_alias,password,role,active,password_change_required,account_revision,last_login_at) ON users TO bonfire_runtime;
 GRANT INSERT, DELETE ON password_changes, mfa_enrollments, passkeys, passkey_challenges TO bonfire_runtime;
 GRANT UPDATE(token) ON sessions TO bonfire_runtime;
 GRANT UPDATE(credential,last_used_at) ON passkeys TO bonfire_runtime;
 GRANT UPDATE(outcome) ON operations TO bonfire_runtime;
 GRANT UPDATE(reopened_at,reopened_by,reopened_reason) ON period_closures TO bonfire_runtime;
 GRANT INSERT ON entry_removals TO bonfire_runtime;
 GRANT DELETE ON sessions,recovery_codes,grants_event TO bonfire_runtime;`
