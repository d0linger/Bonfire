# Run the normal online workflow with a fresh database and a random loopback port.
$ErrorActionPreference = 'Stop'
$project = 'bonfire-online-' + [guid]::NewGuid().ToString('N')
$original = @{}
foreach ($key in 'BONFIRE_DISPOSABLE_TEST','COMPOSE_PROJECT_NAME','BONFIRE_ADMIN_PASSWORD','BONFIRE_URL','BONFIRE_PORT','BONFIRE_PASSKEY_ORIGIN','BONFIRE_OFFLINE_ENABLED','BONFIRE_YEAR_FIXTURE_ID','BONFIRE_BACKUP_RESTORE_TEST') {
  $original[$key] = [Environment]::GetEnvironmentVariable($key,'Process')
}
Push-Location (Join-Path $PSScriptRoot '..')
try {
  $env:BONFIRE_DISPOSABLE_TEST = '1'
  $env:COMPOSE_PROJECT_NAME = $project
  $env:BONFIRE_ADMIN_PASSWORD = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { $env:BONFIRE_PORT = [string]$listener.LocalEndpoint.Port } finally { $listener.Stop() }
  $env:BONFIRE_PASSKEY_ORIGIN = "http://localhost:$env:BONFIRE_PORT"
  $env:BONFIRE_OFFLINE_ENABLED = 'false'
  docker compose up -d --build --wait
  if ($LASTEXITCODE) { throw 'Failed to start the online test installation.' }
  $env:BONFIRE_URL = 'http://' + (docker compose port app 8080).Trim()
  Get-Content -Raw -LiteralPath tests/login-windows.sql | docker compose exec -T db psql -X -q -v ON_ERROR_STOP=1 -U bonfire -d bonfire
  if ($LASTEXITCODE) { throw "Login window regression failed." }
  Write-Output "PASS independent login limits under counter pressure and removal of expired windows"
  $env:BONFIRE_YEAR_FIXTURE_ID = (docker compose exec -T db psql -X -qAt -v ON_ERROR_STOP=1 -U bonfire -d bonfire -c "INSERT INTO events(id,name,starts,ends) VALUES(gen_random_uuid(),'Fiktiver Altbestand','2026-03-01','2026-03-02') RETURNING id").Trim()
  if ($LASTEXITCODE -or !$env:BONFIRE_YEAR_FIXTURE_ID) { throw 'Failed to prepare the synthetic legacy records.' }
  foreach ($suite in 'years','online-api','duplicate-reference','attachments','prices','wallet-settlement','donation-reports','year-workplace','event-cleanup','login','admin-navigation','admin-users','account-security','admin-audit','action-spacing','documents','word-layout','profile-exports') {
    node "tests/$suite.mjs"
    if ($LASTEXITCODE) { throw "Test failed in tests/$suite.mjs" }
  }
  $dir = New-Item -ItemType Directory -Path (Join-Path 'test-results' $project) -Force
  $keyFile = Join-Path $dir.FullName 'uebung.key'
  node ops/crypt.mjs keygen $keyFile
  if ($LASTEXITCODE) { throw 'Failed to generate the test key.' }
  $badKey = Join-Path $dir.FullName 'invalid-test.key'
  [IO.File]::WriteAllText($badKey,'invalid disposable key')
  $historyQuery = 'SELECT count(*) FROM backup_history'
  $beforeFailure = docker compose exec -T db psql -X -At -v ON_ERROR_STOP=1 -U bonfire -d bonfire -c $historyQuery
  if ($LASTEXITCODE) { throw 'Cannot inspect backup history.' }
  $rotationFailed = $false
  try { & ./ops/rotate-backup.ps1 -Directory $dir.FullName -KeyFile $badKey *> $null } catch { $rotationFailed = $true }
  $afterFailure = docker compose exec -T db psql -X -At -v ON_ERROR_STOP=1 -U bonfire -d bonfire -c $historyQuery
  if ($LASTEXITCODE -or !$rotationFailed -or $beforeFailure -ne $afterFailure) { throw 'Failed encryption must not advance backup history.' }
  Write-Output 'PASS failed encryption preserved backup freshness'
  $archive = & ./ops/rotate-backup.ps1 -Directory $dir.FullName -KeyFile $keyFile
  & ./ops/verify-restore.ps1 -Path $archive -KeyFile $keyFile
  $env:BONFIRE_BACKUP_RESTORE_TEST = 'isolated'
  node tests/admin-backup.mjs
  if ($LASTEXITCODE) { throw 'Database switchover failed during restore.' }
} finally {
  docker compose -p $project down -v
  foreach ($key in $original.Keys) { [Environment]::SetEnvironmentVariable($key,$original[$key],'Process') }
  Pop-Location
}
