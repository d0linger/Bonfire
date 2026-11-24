# Runs the synthetic fixture suite on a disposable PostgreSQL volume.
param([switch]$SkipOnline)
$ErrorActionPreference = 'Stop'
$project = 'bonfire-abnahme-'+[guid]::NewGuid().ToString('N')
$variables = 'COMPOSE_PROJECT_NAME','BONFIRE_ADMIN_PASSWORD','BONFIRE_URL','BONFIRE_PORT','BONFIRE_OFFLINE_ENABLED'
$original = @{}
foreach($key in $variables){$original[$key]=[Environment]::GetEnvironmentVariable($key,'Process')}
Push-Location (Join-Path $PSScriptRoot '..')
try {
  if (-not $SkipOnline) { & ./ops/accept-online.ps1 }
  $env:BONFIRE_OFFLINE_ENABLED='true'
  $env:COMPOSE_PROJECT_NAME=$project
  $env:BONFIRE_ADMIN_PASSWORD = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
  $env:BONFIRE_PORT='0'
  docker compose up -d --build --wait
  if($LASTEXITCODE){throw 'Compose-Erststart der Prüfinstallation fehlgeschlagen.'}
  $address=(docker compose port app 8080).Trim()
  if($address -notmatch '^127\.0\.0\.1:[0-9]+$'){throw 'Lokaler Prüfport fehlt.'}
  $env:BONFIRE_URL='http://'+$address
  node build.mjs
  if($LASTEXITCODE){throw 'Lokales Offlinepaket konnte nicht erstellt werden.'}
  foreach($suite in 'api','accounts','import','security','incidents','donation-reports','wallet-settlement','prices','conflict-originals','lifecycle','account-mode','carry-forward','attachments','layout-limits','workplace','login','offline','documents','storage','word-layout'){
    node "tests/$suite.mjs"
    if($LASTEXITCODE){throw "Fehler in tests/$suite.mjs"}
  }
  $dir=New-Item -ItemType Directory -Path (Join-Path 'test-results' $project)
  $testKey=Join-Path $dir.FullName 'uebung.key'
  node ops/crypt.mjs keygen $testKey
  if($LASTEXITCODE){throw 'Übungsschlüssel konnte nicht erzeugt werden.'}
  $archive=& ./ops/rotate-backup.ps1 -Directory $dir.FullName -KeyFile $testKey
  & ./ops/verify-restore.ps1 -Path $archive -KeyFile $testKey -VerifyExercise
} finally {
  docker compose -p $project down -v
  foreach($key in $variables){[Environment]::SetEnvironmentVariable($key,$original[$key],'Process')}
  Pop-Location
}
