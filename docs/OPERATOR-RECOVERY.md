# Independent backup verification

Use the production Compose overlay when the operator backup procedure is ready. The app has no access to the privileged backup worker socket with this overlay. Local and S3 backup schedules continue. Treat the encrypted archive, archive encryption key, authenticator storage key and approval signing key as separate recovery inputs with separate custody.

## Manage backup schedules from the operator host

Use the same Compose files and project as the production stack to manage the worker from an authorized Docker session.

```sh
docker compose exec backup /app/bonfire operator-backup status
docker compose exec backup /app/bonfire operator-backup backup local
docker compose exec backup /app/bonfire operator-backup schedule local "0 2 * * *" 30
```

Use `s3` when the worker has an approved S3 destination. The example schedule runs at 02:00 in the configured worker timezone, with 30 days of local retention. Use your approved retention period. These commands cannot probe or promote an archive.

## Prepare a recovery authorization

Create one Ed25519 operator signing key on the authorized system. Keep its private part outside the application containers and the input directory.

```sh
openssl genpkey -algorithm Ed25519 -out operator-private.pem
openssl pkey -in operator-private.pem -pubout -out operator-public.pem
```

Use the recorded installation UUID and SHA-256 of the selected encrypted archive from a trusted backup record. Place an `authorization.json` file at the operator's private location containing `installation` and `sha256` string fields. The verifier checks the signature over the exact file bytes, the encrypted archive digest, and the installation ID inside the authenticated archive before PostgreSQL replay.

```sh
openssl pkeyutl -sign -inkey operator-private.pem -rawin -in authorization.json -out authorization.sig
```

Place `archive.dump.enc`, `archive.key`, `operator-public.pem`, `authorization.json`, and `authorization.sig` in a restricted directory readable by the recovery container UID. Select the expected public key from independent custody, alongside the signed authorization. Keep the private key elsewhere.

```powershell
./ops/rehearse-recovery.ps1 -InputDirectory <private-directory> -BackupImage <verified-backup-worker-image>
```

The script creates a unique private Docker project, with no published database port and an internal network. It creates a separate PostgreSQL server and reports the verified archive fingerprint and recovered counts. It restores data with BONFIRE's runtime grants and leaves source-specific access grants for the operator to verify separately. Review the result before an independently authorized production switch. Production promotion is an operator maintenance action. Reconcile the financial totals and credential availability, record the recovery reference, and preserve a verified pre-switch backup. The command is for BONFIRE2 archives with installation identity. Rehearse older authorized backups separately with the matching tooling and an independently provisioned PostgreSQL server.

## Capture audit checkpoints

Configure a PostgreSQL client service on an independently managed host. Use a dedicated read-only database principal with access to `backup_installation` and `audit_chain_heads`, and certificate validation for a remote database. The checkpoint signer should be unavailable to the app and backup worker. Send the destination to operator-controlled append-only storage and have monitoring alert on missing checkpoints, decreasing positions, or changes to previously recorded digests. A production restore requires a reference linking the old and new checkpoints.

```powershell
./ops/export-audit-checkpoint.ps1 -PostgresService bonfire_audit -SignerKey <operator-signing-key> -Destination <append-only-directory> -RestoreReference <approved-reference>
```

The output contains the base64-encoded checkpoint and Ed25519 signature. The operator or independent monitoring system verifies the signature using the separately trusted public key. The application repository does not configure the receiving storage, retention locks, alert recipients or cloud IAM.

## Capacity, data and retention

Test the largest legitimate archive against the scratch mount before enabling scheduled jobs. Use a quota-backed encrypted scratch volume for larger databases. Retain rollback databases according to the approved records policy and remove only reviewed copies after an independent backup and restore check. Protect the TOTP key separately and retain it for any encrypted database backup that still depends on it.

Configure proxy TLS, HSTS, S3 access, alert routing, and legal retention and access procedures in the actual installation. Document and verify them before a production release.
