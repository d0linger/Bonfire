package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const backupHome = "/var/lib/bonfire-backup"
const backupKeyPath = "/var/lib/bonfire-key/backup.key"

func (b *backupWorker) connect(ctx context.Context, name string) (*pgx.Conn, error) {
	cfg := b.db.Copy()
	cfg.Database = name
	cfg.RuntimeParams["timezone"] = "UTC"
	return pgx.ConnectConfig(ctx, cfg)
}

func stateManifest(ctx context.Context, tx pgx.Tx, schema int) (backupManifest, error) {
	var m backupManifest
	err := tx.QueryRow(ctx, `SELECT (SELECT installation::text FROM backup_installation),(SELECT count(*) FROM fiscal_years),(SELECT count(*) FROM events),(SELECT count(*) FROM entries),(SELECT count(*) FROM originals)`).Scan(&m.Installation, &m.Years, &m.Workspaces, &m.Entries, &m.Originals)
	if err != nil {
		return m, err
	}
	h := sha256.New()
	// Stable ordering preserves associations, individual cent amounts and both original files.
	eventTable := "events"
	if schema >= 22 {
		eventTable = "event_records"
	}
	tables := []string{"fiscal_years", eventTable, "entries"}
	if schema >= 23 {
		tables = append(tables, "entry_removals")
	}
	for _, table := range append(tables, "originals") {
		rows, err := tx.Query(ctx, "SELECT sha256(convert_to(to_jsonb(r)::text,'UTF8')) FROM "+pgx.Identifier{table}.Sanitize()+" r ORDER BY 1")
		if err != nil {
			return m, err
		}
		if _, err := io.WriteString(h, table); err != nil {
			rows.Close()
			return m, err
		}
		for rows.Next() {
			var sum []byte
			if err = rows.Scan(&sum); err != nil {
				rows.Close()
				return m, err
			}
			h.Write(sum)
		}
		if err = rows.Err(); err != nil {
			return m, err
		}
	}
	m.DataHash = hex.EncodeToString(h.Sum(nil))
	return m, nil
}

func (b *backupWorker) pgTool(ctx context.Context, name, dbname string, args ...string) error {
	var cmd *exec.Cmd
	switch name {
	case "pg_dump":
		cmd = exec.CommandContext(ctx, "pg_dump", args...) // #nosec G204 -- internal pg_dump options only, credentials are supplied via the environment.
	case "pg_restore":
		cmd = exec.CommandContext(ctx, "pg_restore", args...) // #nosec G204 -- internal options and a private staging file, no shell.
	default:
		return errors.New("unsupported PostgreSQL client")
	}
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "PGHOST=" + b.db.Host, "PGPORT=" + fmt.Sprint(b.db.Port), "PGUSER=" + b.db.User, "PGPASSWORD=" + b.db.Password, "PGDATABASE=" + dbname, "PGCLIENTENCODING=UTF8", "PGSSLMODE=" + os.Getenv("BONFIRE_BACKUP_PGSSLMODE")}
	if os.Getenv("BONFIRE_BACKUP_PGSSLMODE") == "" {
		cmd.Env[len(cmd.Env)-1] = "PGSSLMODE=prefer"
	}
	if err := cmd.Run(); err != nil {
		return errors.New(name + " fehlgeschlagen")
	}
	return nil
}

func (b *backupWorker) makeArchive(ctx context.Context, db, target string) (string, error) {
	c, err := b.connect(ctx, db)
	if err != nil {
		return "", err
	}
	defer c.Close(ctx)
	tx, err := c.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	var schema int
	if err = tx.QueryRow(ctx, "SELECT max(version) FROM migrations").Scan(&schema); err != nil {
		return "", err
	}
	m, err := stateManifest(ctx, tx, schema)
	if err != nil {
		return "", err
	}
	m.Created = time.Now().UTC().Format(time.RFC3339Nano)
	var snap string
	if err = tx.QueryRow(ctx, "SELECT pg_export_snapshot()").Scan(&snap); err != nil {
		return "", err
	}
	dir, err := os.MkdirTemp(backupHome, ".job-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	dump := filepath.Join(dir, "db.dump")
	if err = b.pgTool(ctx, "pg_dump", db, "--format=custom", "--snapshot="+snap, "--file="+dump); err != nil {
		return "", err
	}
	if err = tx.Commit(ctx); err != nil {
		return "", err
	}
	input, err := os.OpenInRoot(dir, "db.dump")
	if err != nil {
		return "", err
	}
	defer input.Close()
	name := "bonfire-" + time.Now().UTC().Format("20060102T150405Z") + "-" + uuid() + ".dump.enc"
	tmp := filepath.Join(dir, name)
	// The destination is generated in this worker-owned private temporary directory.
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600) // #nosec G304 -- server-generated UUID filename inside MkdirTemp.
	if err != nil {
		return "", err
	}
	if err = sealBackup(input, out, b.key, m); err == nil {
		err = out.Sync()
	}
	cerr := out.Close()
	if err != nil {
		return "", err
	}
	if cerr != nil {
		return "", cerr
	}
	if target == "s3" {
		err = b.putS3(ctx, name, tmp)
	} else {
		err = os.Rename(tmp, filepath.Join(backupHome, name))
	}
	return name, err
}

func dbIdent(name string) string { return pgx.Identifier{name}.Sanitize() }

func (b *backupWorker) stage(ctx context.Context, target, name string) (string, backupManifest, string, error) {
	var m backupManifest
	dir, err := os.MkdirTemp(backupHome, ".job-")
	if err != nil {
		return "", m, "", err
	}
	defer os.RemoveAll(dir)
	src, err := b.openArchive(ctx, target, name)
	if err != nil {
		return "", m, "", err
	}
	defer src.Close()
	plain := filepath.Join(dir, "candidate.dump")
	file, err := os.OpenFile(plain, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600) // #nosec G304 -- fixed filename inside worker-owned MkdirTemp.
	if err != nil {
		return "", m, "", err
	}
	fingerprint := sha256.New()
	m, err = unsealBackup(io.TeeReader(src, fingerprint), file, b.key)
	cerr := file.Close()
	if err != nil {
		return "", m, "", err
	}
	if cerr != nil {
		return "", m, "", cerr
	}
	admin, err := b.connect(ctx, "postgres")
	if err != nil {
		return "", m, "", err
	}
	defer admin.Close(ctx)
	db := "bf_probe_" + strings.ReplaceAll(uuid(), "-", "")
	// Exclude normal clients from scratch databases before loading private backup data.
	if _, err = admin.Exec(ctx, "CREATE DATABASE "+dbIdent(db)+" TEMPLATE template0 CONNECTION LIMIT 0"); err != nil {
		return "", m, "", err
	}
	keep := false
	defer func() {
		if !keep {
			clean, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if _, err := admin.Exec(clean, "DROP DATABASE IF EXISTS "+dbIdent(db)+" WITH (FORCE)"); err != nil {
				log.Print("Failed to remove temporary restore database")
			}
		}
	}()
	if err = b.pgTool(ctx, "pg_restore", db, "--exit-on-error", "--single-transaction", "--no-owner", "--dbname="+db, plain); err != nil {
		return "", m, "", err
	}
	restored, err := b.connect(ctx, db)
	if err != nil {
		return "", m, "", err
	}
	defer restored.Close(ctx)
	var v int
	if err = restored.QueryRow(ctx, "SELECT max(version) FROM migrations").Scan(&v); err != nil {
		return "", m, "", err
	}
	files, err := migrations.ReadDir("migrations")
	if err != nil || v < 21 || v > len(files) {
		return "", m, "", errors.New("Schemaversion weicht ab. Passende BONFIRE-Version für die Probe verwenden")
	}
	for i := 1; i <= v; i++ {
		raw, err := migrations.ReadFile(fmt.Sprintf("migrations/%03d.sql", i))
		if err != nil {
			return "", m, "", err
		}
		var digest string
		if err = restored.QueryRow(ctx, "SELECT digest FROM migrations WHERE version=$1", i).Scan(&digest); err != nil {
			return "", m, "", err
		}
		if digest != migrationHash(raw, false) && digest != migrationHash(raw, true) {
			return "", m, "", errors.New("Migrationsnachweis stimmt nicht überein")
		}
	}
	tx, err := restored.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return "", m, "", err
	}
	defer tx.Rollback(ctx)
	// Verify the sealed manifest against the original schema before upgrading
	// the isolated candidate. Its fingerprint stays bound to the uploaded bytes.
	check, err := stateManifest(ctx, tx, v)
	if err != nil {
		return "", m, "", err
	}
	if m.Installation != "" && (m.Installation != check.Installation || m.DataHash != check.DataHash || m.Years != check.Years || m.Workspaces != check.Workspaces || m.Entries != check.Entries || m.Originals != check.Originals) {
		return "", m, "", errors.New("Prüfsummen oder Fachbestände weichen vom Sicherungsmanifest ab")
	}
	if m.Installation == "" {
		check.Installation = ""
		m = check
	}
	if v < len(files) {
		for version := v + 1; version <= len(files); version++ {
			if err = applyUpgrade(ctx, tx, version, fmt.Sprintf("migrations/%03d.sql", version)); err != nil {
				return "", m, "", err
			}
		}
		if _, err = tx.Exec(ctx, runtimeGrants); err != nil {
			return "", m, "", err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return "", m, "", err
	}
	keep = true
	return db, m, hex.EncodeToString(fingerprint.Sum(nil)), nil
}

type swapJournal struct {
	Original, Staged uint32
	FallbackDB, User string
}

func retainIssuedNumbers(ctx context.Context, frozen, staged *pgx.Conn) error {
	var block int64
	if err := frozen.QueryRow(ctx, "SELECT last_value FROM number_blocks").Scan(&block); err != nil {
		return err
	}
	if _, err := staged.Exec(ctx, "SELECT setval('number_blocks',greatest($1,(SELECT last_value FROM number_blocks)),true)", block); err != nil {
		return err
	}
	rows, err := frozen.Query(ctx, `SELECT d.id::text,greatest(d.online_number_floor,coalesce(max(o.number)+1,0)) FROM devices d LEFT JOIN originals o ON d.id=o.device WHERE d.online_actor GROUP BY d.id HAVING greatest(d.online_number_floor,coalesce(max(o.number)+1,0))>0`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var floor int64
		if err = rows.Scan(&id, &floor); err != nil {
			return err
		}
		if _, err = staged.Exec(ctx, "UPDATE devices SET online_number_floor=greatest(online_number_floor,$2) WHERE id=$1", id, floor); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (b *backupWorker) recoverSwap(ctx context.Context, c *pgx.Conn) error {
	path := filepath.Join(backupHome, ".swap.json")
	data, err := os.ReadFile(path) // #nosec G304 -- fixed backupHome/.swap.json, never a request path.
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var j swapJournal
	if err = json.Unmarshal(data, &j); err != nil {
		return err
	}
	var oid uint32
	if err = c.QueryRow(ctx, "SELECT oid FROM pg_database WHERE datname=$1", b.db.Database).Scan(&oid); err != nil {
		return err
	}
	if oid != j.Original && oid != j.Staged {
		return errors.New("Datenbankidentität nach Restore unklar")
	}
	if _, err = c.Exec(ctx, "ALTER DATABASE "+dbIdent(b.db.Database)+" ALLOW_CONNECTIONS true"); err != nil {
		return err
	}
	if oid == j.Staged {
		dest, err := b.connect(ctx, b.db.Database)
		if err != nil {
			return err
		}
		defer dest.Close(ctx)
		if _, err = dest.Exec(ctx, "INSERT INTO audit(username,action,subject) VALUES($1,'Wiederherstellung übernommen',$2)", j.User, j.FallbackDB); err != nil {
			return err
		}
	}
	return os.Remove(path)
}

func (b *backupWorker) promote(ctx context.Context, c *pgx.Conn, stage, user string, m backupManifest) (result error) {
	live := b.db.Database
	before, err := b.connect(ctx, live)
	if err != nil {
		return err
	}
	var lineage string
	err = before.QueryRow(ctx, "SELECT installation::text FROM backup_installation").Scan(&lineage)
	defer before.Close(ctx)
	if err != nil {
		return err
	}
	if m.Installation == "" || m.Installation != lineage {
		return errors.New("Andere Installation oder Legacy-Datei: Übernahme gesperrt")
	}
	dest, err := b.connect(ctx, stage)
	if err != nil {
		return err
	}
	_, err = dest.Exec(ctx, "DELETE FROM sessions; DELETE FROM password_changes; DELETE FROM login_challenges; DELETE FROM mfa_enrollments; DELETE FROM passkey_challenges; UPDATE devices SET secret=sha256(uuid_send(gen_random_uuid())) WHERE NOT online_actor")
	err = errors.Join(err, dest.Close(ctx))
	if err != nil {
		return err
	}
	prev := "bf_rollback_" + strings.ReplaceAll(uuid(), "-", "")
	j := swapJournal{User: user, FallbackDB: prev}
	err = c.QueryRow(ctx, "SELECT a.oid,b.oid FROM pg_database a,pg_database b WHERE a.datname=$1 AND b.datname=$2", live, stage).Scan(&j.Original, &j.Staged)
	if err != nil {
		return err
	}
	if err = saveBackupJSON(filepath.Join(backupHome, ".swap.json"), j); err != nil {
		return err
	}
	// Crash recovery reopens the original or records the committed swap by OID.
	defer func() {
		clean, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := b.recoverSwap(clean, c); result == nil {
			result = err
		}
	}()
	if _, err = c.Exec(ctx, "ALTER DATABASE "+dbIdent(live)+" ALLOW_CONNECTIONS false"); err != nil {
		return err
	}
	if _, err = c.Exec(ctx, "SELECT pg_terminate_backend(pid,10000) FROM pg_stat_activity WHERE datname=$1 AND pid!=$2", live, before.PgConn().PID()); err != nil {
		return err
	}
	// The source is now write-frozen. Advance all allocation high-water marks
	// before cutting over, including actors and receipts absent from the snapshot.
	staged, err := b.connect(ctx, stage)
	if err != nil {
		return err
	}
	if err = retainIssuedNumbers(ctx, before, staged); err != nil {
		return errors.Join(err, staged.Close(ctx))
	}
	if err = staged.Close(ctx); err != nil {
		return err
	}
	if err = before.Close(ctx); err != nil {
		return err
	}
	// Keep the complete, frozen pre-restore database as an independent rollback copy.
	tx, err := c.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "ALTER DATABASE "+dbIdent(live)+" RENAME TO "+dbIdent(prev)); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "ALTER DATABASE "+dbIdent(stage)+" RENAME TO "+dbIdent(live)); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "ALTER DATABASE "+dbIdent(live)+" CONNECTION LIMIT -1"); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
