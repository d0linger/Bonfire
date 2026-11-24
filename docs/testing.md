# Test strategy

Run tests with synthetic fixtures, PostgreSQL, Docker Compose, PowerShell 7, Node.js 22 and the Go version from go.mod. On Linux, Make provides the entry points below. On Windows, run the corresponding commands from the Makefile directly.

| Command | Scope |
| --- | --- |
| make lint | Go formatting, go vet and JavaScript syntax checks. |
| make test | Go race detection and statement coverage, then the Node unit tests. The race detector requires a C compiler. |
| make test-finance | Financial invariants and independently derived amounts. Go and JavaScript both consume tests/cash-vectors.json. |
| make test-integration | A fresh PostgreSQL/Compose stack exercises the HTTP API, Chromium workflows, year boundaries, roles, audit and encrypted restoration. |
| make test-connectivity, make test-e2e, make test-restore | These run the shared isolated integration suite. tests/year-workplace.mjs drops a real response after the transaction commits. tests/online-api.mjs retries the same posting five times in parallel. |
| make test-documents | Browser-based exchange and Word rendering. The Word test requires a running local server, selected with BONFIRE_URL. |
| make test-security | govulncheck and npm lockfile audit. |
| make check | Local lint, tests, integration and dependency checks. |

Run npm ci, install Chromium with npx playwright install chromium and initialize local configuration using ./ops/init.ps1 before integration testing. A failing suite reports its name. The script removes its own disposable volumes. Keep generated keys and archives outside Git.

The initial Go unit run measured 5.6% statement coverage in the single application package. HTTP tests against a separate uninstrumented Compose binary contribute no statements to this measurement. Acceptance targets remain 90% for pure financial calculations and 80% for handwritten application logic. Physical printing and testing on actual mobile devices require separate evidence.
