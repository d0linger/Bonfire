# Test strategy

Run tests with synthetic fixtures, PostgreSQL, Docker Compose, PowerShell 7, Node.js 22 and the Go version from go.mod. On Linux, Make provides the entry points below. On Windows, run the corresponding commands from the Makefile directly.

The Compose acceptance commands create a disposable database and set `BONFIRE_DISPOSABLE_TEST=1` for their child processes. To run individual authenticated tests, set that flag and point `BONFIRE_URL` at the disposable stack's random loopback port. Port 8137 is reserved for the working installation.

| Command | Scope |
| --- | --- |
| make lint | Go formatting, go vet and ESLint's recommended rules for browser code, Node scripts and tests. |
| make test | Go race detection and statement coverage, then the Node unit tests. The race detector requires a C compiler. |
| make test-finance | Financial invariants and independently derived amounts. Go and JavaScript both consume tests/cash-vectors.json. |
| make test-integration | A fresh PostgreSQL/Compose stack exercises the HTTP API, Chromium workflows, year boundaries, roles, audit and encrypted restoration. |
| make test-connectivity, make test-e2e, make test-restore | These run the shared isolated integration suite. tests/year-workplace.mjs drops a real response after the transaction commits. tests/online-api.mjs retries the same posting five times in parallel. |
| make test-documents | Browser-based exchange and Word rendering. The Word test requires a running local server, selected with BONFIRE_URL. |
| make test-security | govulncheck and npm lockfile audit. |
| make check | Local lint, tests, integration and dependency checks. |

Run npm ci, install Chromium with npx playwright install chromium and initialize local configuration using ./ops/init.ps1 before integration testing. A failing suite reports its name. The script removes its own disposable volumes. Keep generated keys and archives outside Git.

The acceptance workflow instruments migrations, the online server, and the backup worker during the browser and encrypted S3 restore suites. It combines those profiles with Go unit and PostgreSQL integration tests for the same source blocks. The required job enforces at least 80% of application statements before rounding and 90% for each of eleven core finance functions. Physical printing and testing on actual mobile devices require separate evidence.

Run `./ops/test-transactions.ps1` with Docker, Go and PowerShell 7 to exercise database interruption and retry locally. It starts a separate PostgreSQL server, applies the real migrations and grants, then removes its container and volume. The tests interrupt individual database statements during financial and account operations, compare persisted state after rollback, and verify that retrying completes the requested change exactly once.

## GitHub checks

The pull request gate waits for online acceptance, coverage collection, source analysis, browser checks, container inspection, dependency and secret checks, and extended recovery. The `unit-coverage` artifact contains the standalone Go unit report and browser-domain LCOV. The `integration-coverage` artifact includes both the Compose-only profile and the combined profile used by the 80% gate.

CodeQL analyzes Go, JavaScript and Python. Each language supplies a SARIF report and the required job checks it for findings. The source workflow also runs gosec with SARIF upload, deadcode, actionlint and zizmor. Chromium, Firefox and WebKit exercise login, session persistence, CSP response headers and axe accessibility checks on sign-in, workspace, password change and expanded audit events in desktop light and mobile dark views over TLS. Each container image has its own Trivy scan and CycloneDX SBOM. Dependency Review evaluates PR changes, govulncheck and npm audit inspect dependencies, and Gitleaks checks Git history. Weekly runs on the default branch repeat source analysis, image and dependency scans, fuzz tests and recovery tests against newer advisory data.

Run `python ops/test-mutations.py` from a committed checkout to verify fault detection. It exports tracked files into a disposable directory, perturbs a denomination sum, removes the coverage prerequisite, then builds a separate Compose installation with duplicate-reference detection removed. Each case must fail its designated assertion. The regular acceptance suite also exercises the duplicate test against the unchanged application.


The online acceptance suite signs in two distinct cashier accounts and submits competing updates to the same contact and wallet count. It requires a single accepted revision and a visible conflict for the other cashier. Independent equal-value transactions must both survive. Concurrent attempts to issue the same invoice must produce one original under the issuing cashier's reserved number.

Donation reporting runs through the online session API with synthetic donors. The test checks the reporting period, restricted access, exclusion of anonymous or incomplete records, the SHA-256 of the issued export, and preservation of the original following a correction. Transmission and acknowledgment are simulated status entries.
