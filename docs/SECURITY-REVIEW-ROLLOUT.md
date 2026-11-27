# Security and recovery release

## Operator-visible changes

- User creation, role and workspace access edits, account enable/disable, password reset and MFA reset require the acting administrator's current password and, when enabled, a fresh authenticator or recovery code. Session revocation remains available immediately. Legacy admin API callers can supply either Basic credentials through the standard verifier or fresh proof with their administrator session.
- The central sponsor picker remains available in events. A user with Write access can edit contacts originating in that workspace. An Admin can edit the central directory across workspaces.
- Reconcile each named card provider before closing an event or fiscal year. A closed event with a previously undetected terminal balance may block year close. Review its terminal entries and reopen it using the existing Admin workflow if correction is required. Old unnamed card records retain their previous treatment.
- The server generates new numbered PDFs and DOCX from stored financial data. Set the contact and address on the posting, or the linked sponsorship for a payment, and reload browser tabs after deployment. Numbered donation confirmations use the contact on the posting. Historical originals and their exact reprint bytes remain in the existing archive. If rendering fails, the transaction rolls back and no number is consumed.
- New event closing snapshots omit the central directory and binary document evidence. Existing originals, historical snapshots and attachments retain their own storage.
- The monitoring overlay scrapes `app:9091/metrics` on the Docker network. Restart or reload Prometheus if it still holds the previous scrape configuration. App port 8080 only serves the application and its health endpoint. The Docker deployment now includes the trusted Node renderer, and the image bases and supporting images have fixed digests.
- The production backup overlay disconnects the web application from the privileged worker. Local and S3 scheduled backups continue. Browser backup actions and same-cluster restore probes are unavailable with this overlay. Operators rehearse recovery with a signed authorization on a separate PostgreSQL cluster. Plaintext backup work uses a dedicated 512 MiB scratch mount. Size a dedicated encrypted volume before migrating larger archives.
- The migration service creates a key in the dedicated `totp-key` volume and encrypts existing TOTP seeds. Enrolled authenticator apps keep the same secret. In-progress plaintext enrollments expire and can be restarted. Preserve this volume independently of database backup media. A new app refuses to start if it cannot decrypt existing enrolled users. Keep the original key for retained archives until each archive is outside the recovery window.
- Migration 036 records provenance for newly carried shared-account opening balances. Closing checks that a source year remains closed and its balance revision matches. Reopening a source year can be blocked by a closed dependent year. Earlier records with unproven provenance retain their values and are not backfilled by inference.
- New card, payout, fee and cashback records require a provider. Issuance is limited to one original per request, and booking batches are capped at 256 operations. The browser backup upload compatibility mode requires a known size and has a 512 MiB default and 15-minute window. Operators can configure a supported upload ceiling with `BONFIRE_BACKUP_UPLOAD_MAX_BYTES`.
- Report downloads still use `manifest.json`. Evidence ZIP document paths now encode document IDs, and duplicate identities stop the export instead of overwriting a file. New period closures store financial evidence without copies of unrelated document files.

## Deployment checks

1. Confirm the existing worker has no restore or database switch in progress. Take an encrypted PostgreSQL backup and keep the release recovery artifacts and keys separately. Rehearse a verified archive on a separate PostgreSQL cluster. Use the independent procedure for BONFIRE2 archives with installation identity and the matching isolated tooling for an older archive. Safeguard any existing key volume, including the backup archive key.
2. Stop app writes in a maintenance window. Apply the approved release and the operator backup and monitoring overlays. Let `migrate` finish migration 036 and TOTP encryption before starting the app. Keep a tested copy of the prior release and a restore point from before the migration.
3. Confirm app health, sign-in, authenticator and recovery sign-ins, and the private metrics target. Retain the generated TOTP key under separate access control. Clients should reload cached tabs. Confirm a scheduled backup and the independent rehearsal timetable.
4. Reconcile each relevant cashbook against the installation's privately recorded totals and confirm a zero difference. Test new issuances and closing with synthetic data in a separate stack.

In PowerShell or a shell with the existing installation configuration loaded:

```sh
docker compose -f compose.yaml -f compose.monitoring.yaml -f compose.operator-backups.yaml up -d --build --wait
```

For signed release artifacts, use the attestation workflow, verify the approved commit and archive digest, load and tag the verified images according to the Compose configuration, then run Compose with `--no-build`. Configure the protected GitHub `release` environment before relying on its approval gate.

Rollback to an older binary requires the pre-upgrade database when TOTP enrollment ciphertext has been written. A binary-only rollback would affect configured MFA accounts. Follow the independent recovery runbook and retain the pre-upgrade PostgreSQL volume until reconciliation is complete.

Normal browser writes acknowledge the committed transaction before refreshing the workspace. The refresh for users who already have a workspace actor no longer takes the event's write lock. The response still includes the complete workspace. Cursor-based loading of entry metadata and separately fetching archived file bodies would reduce transfer size further.

## Audit remediation coverage

| Finding | Implementation and production verification |
|---|---|
| B01, B02 | The operator overlay removes the privileged backup socket from the app. Independently signed authorization binds the exact archive to its installation before PostgreSQL replay in a separate cluster. Rehearse recovery with the production key custody and archive size before rollout. |
| F01–F05 | Requests are decoded before the bookkeeping lock. Evidence fields are gated by record type. Legacy audit visibility and lifecycle descriptions are restricted, and new card entries require a settlement provider. Correct legacy unnamed terminal records only from source evidence. |
| F06, F10 | Plaintext uses capped scratch storage with the operator overlay. Compatibility uploads have a size and time budget. Set the backup and PostgreSQL disk quotas, free-space alerts and retained rollback lifecycle on the host. Review existing backup storage for plaintext left by older versions. |
| F07 | One original per request, two concurrent renderers per app process, a subprocess timeout and a transaction deadline bound issuance. Rendering still runs inside the transaction to keep document numbering atomic. Measure contention with the installation's expected document volume before changing reservation semantics. |
| F08, F09 | Migration 036 enables carry-forward revision checks. Existing authenticator seeds are encrypted in place using a separately held key. Rehearse archive recovery with the original key and document custody and rotation before upgrading. |
| F11–F14 | Cross-workspace resource locks are acquired before audit sealing, database conflicts return a retryable response, the Go dependency is updated, new closures exclude unrelated binary payloads, and exported evidence paths preserve distinct document identities. |
| G01–G03 | The repository supplies release attestation, an off-host checkpoint export, and operator procedures. Configure independent checkpoint custody and alert routing, protected release review, and the applicable data-rights and retention policies in the actual installation. |

## Local verification

Go vet and the PostgreSQL transaction suite passed. The JavaScript build, lint, 29 domain tests, script and service-worker smoke check, and document pagination check passed. Disposable browser and Docker runs covered desktop and mobile layouts, account security, all eleven PDF and DOCX profiles, encrypted local and S3-compatible backups, and isolated restore. The production backup overlay was tested for a healthy app, an absent worker socket on the app, a saved operator schedule and an encrypted local backup. The separately signed recovery rehearsal replayed a synthetic financial record on an independent PostgreSQL server. Production data reconciliation and the hosted release attestation remain deployment checks.

The combined local Go coverage was 80.61% (4,503 of 5,586 Linux-build statements). The repository coverage gate passed after matching Windows Go test results to the Linux Docker build's source blocks and counting the Linux disk-check implementation from its own profile. Local lint also accepted the release workflow.

[Independent recovery and audit checkpoint setup](OPERATOR-RECOVERY.md)
