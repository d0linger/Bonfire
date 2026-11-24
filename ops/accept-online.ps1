# Run the normal online workflow with a fresh database and a random loopback port.
$ErrorActionPreference = 'Stop'
$project = 'bonfire-online-' + [guid]::NewGuid().ToString('N')
$original = @{}
foreach ($key in 'COMPOSE_PROJECT_NAME','BONFIRE_ADMIN_PASSWORD','BONFIRE_URL','BONFIRE_PORT','BONFIRE_PASSKEY_ORIGIN','BONFIRE_OFFLINE_ENABLED','BONFIRE_YEAR_FIXTURE_ID','BONFIRE_BACKUP_RESTORE_TEST') {
  $original[$key] = [Environment]::GetEnvironmentVariable($key,'Process')
}
Push-Location (Join-Path $PSScriptRoot '..')
try {
  $env:COMPOSE_PROJECT_NAME = $project
  $env:BONFIRE_ADMIN_PASSWORD = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { $env:BONFIRE_PORT = [string]$listener.LocalEndpoint.Port } finally { $listener.Stop() }
  $env:BONFIRE_PASSKEY_ORIGIN = "http://localhost:$env:BONFIRE_PORT"
  $env:BONFIRE_OFFLINE_ENABLED = 'false'
  docker compose up -d --build --wait
  if ($LASTEXITCODE) { throw 'Start der Online-Prüfinstallation fehlgeschlagen.' }
  $env:BONFIRE_URL = 'http://' + (docker compose port app 8080).Trim()
  $env:BONFIRE_YEAR_FIXTURE_ID = (docker compose exec -T db psql -X -qAt -v ON_ERROR_STOP=1 -U bonfire -d bonfire -c "INSERT INTO events(id,name,starts,ends) VALUES(gen_random_uuid(),'Fiktiver Altbestand','2026-03-01','2026-03-02') RETURNING id").Trim()
  if ($LASTEXITCODE -or !$env:BONFIRE_YEAR_FIXTURE_ID) { throw 'Fiktiver Altbestand konnte nicht vorbereitet werden.' }
  foreach ($suite in 'years','online-api','year-workplace','event-cleanup','admin-navigation','admin-users','account-security','admin-audit','action-spacing') {
    node "tests/$suite.mjs"
    if ($LASTEXITCODE) { throw "Fehler in tests/$suite.mjs" }
  }
  $dir = New-Item -ItemType Directory -Path (Join-Path 'test-results' $project) -Force
  $keyFile = Join-Path $dir.FullName 'uebung.key'
  node ops/crypt.mjs keygen $keyFile
  if ($LASTEXITCODE) { throw 'Testschlüssel konnte nicht erzeugt werden.' }
  $archive = & ./ops/rotate-backup.ps1 -Directory $dir.FullName -KeyFile $keyFile
  & ./ops/verify-restore.ps1 -Path $archive -KeyFile $keyFile
  $env:BONFIRE_BACKUP_RESTORE_TEST = 'isolated'
  node tests/admin-backup.mjs
  if ($LASTEXITCODE) { throw 'Wiederherstellung mit Datenbankwechsel fehlgeschlagen.' }
} finally {
  docker compose -p $project down -v
  foreach ($key in $original.Keys) { [Environment]::SetEnvironmentVariable($key,$original[$key],'Process') }
  Pop-Location
}
