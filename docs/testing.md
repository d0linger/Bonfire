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

The initial Go unit run measured 5.6% statement coverage in the single application package. This baseline measured unit tests alone. The online acceptance workflow now builds the Go server with coverage instrumentation. Its integration-coverage artifact contains measurements from the migration, online server and backup worker processes, including a check that login code executed. The full Compose run on commit 6cce7f7 measured 50.0% Go statement coverage. Wallet revenue reached 100%, pooled revenue 85.3% and financial preconditions 52.5% in that run. These figures come from the [integration job](https://github.com/d0linger/bonfire/actions/runs/45780463697/job/139774381839). Acceptance targets remain 90% for pure financial calculations and 80% for handwritten application logic. The combined report merges matching statement blocks from the same commit. CI enforces 90% for each of ten core finance functions and a 52% whole-application minimum against a measured combined baseline of 52.8% on a4d930c. The 80% application target remains open. Physical printing and testing on actual mobile devices require separate evidence.

## GitHub checks

The pull request gate waits for online acceptance, coverage collection, source analysis, browser checks, container inspection, dependency and secret checks, and extended recovery. The coverage artifact contains a navigable Go report, function totals and browser-domain LCOV. Its percentages count executed unit tests. Browser actions against the instrumented Compose server contribute to the separate integration report.

CodeQL analyzes Go, JavaScript and Python. Each language supplies a SARIF report and the required job checks it for findings. The source workflow also runs gosec with SARIF upload, deadcode, actionlint and zizmor. Chromium, Firefox and WebKit exercise login, session persistence, CSP response headers and axe accessibility checks on sign-in, workspace, password change and expanded audit events in desktop light and mobile dark views over TLS. Each container image has its own Trivy scan and CycloneDX SBOM. Dependency Review evaluates PR changes, govulncheck and npm audit inspect dependencies, and Gitleaks checks Git history. Weekly runs on the default branch repeat source analysis, image and dependency scans, fuzz tests and recovery tests against newer advisory data.

Run `python ops/test-mutations.py` from a committed checkout to verify fault detection. It exports tracked files into a disposable directory, perturbs a denomination sum, removes the coverage prerequisite, then builds a separate Compose installation with duplicate-reference detection removed. Each case must fail its designated assertion. The regular acceptance suite also exercises the duplicate test against the unchanged application.
