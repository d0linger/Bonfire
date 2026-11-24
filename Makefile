.PHONY: check lint test test-finance test-integration test-e2e test-connectivity test-documents test-security test-restore

check: lint test test-integration test-security

lint:
	@test -z "$$(gofmt -l *.go)" || { gofmt -l *.go; exit 1; }
	go vet ./...
	@for f in web/*.js tests/*.mjs ops/*.mjs build.mjs; do node --check "$$f" || exit 1; done

test:
	go test -race -cover ./...
	npm test

test-finance:
	go test -run 'Test(CashVectors|AccountReconciliation|ZeroVersusUnknown|UsedWalletRequiresSettlement)' ./...
	node --test tests/domain.test.mjs tests/kassenalltag.test.mjs tests/reports.test.mjs

# These checks share one isolated stack when requested together.
test-e2e test-connectivity test-restore: test-integration

test-integration:
	pwsh -NoProfile -File ops/accept-online.ps1

test-documents:
	node tests/documents.mjs
	node tests/word-layout.mjs

test-security:
	go run golang.org/x/vuln/cmd/govulncheck@v1.8.0 ./...
	npm audit --package-lock-only --audit-level=high
