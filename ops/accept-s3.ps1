# Encrypted round trip against an S3-compatible server on a disposable Docker network.
$ErrorActionPreference = 'Stop'
$project = 'bonfire-s3-' + [guid]::NewGuid().ToString('N')
$originalUrl = $env:BONFIRE_URL
$originalMode = $env:BONFIRE_S3_TEST
Push-Location (Join-Path $PSScriptRoot '..')
$stack = @('compose', '-p', $project, '-f', 'compose.yaml', '-f', 'tests/compose.s3.yaml')
try {
  docker @stack up -d --build --wait
  if ($LASTEXITCODE) { throw 'Start der S3-Prüfinstallation fehlgeschlagen.' }
  $address = (docker @stack port app 8080).Trim()
  if ($address -notmatch '^127\.0\.0\.1:[0-9]+$') { throw 'Lokaler Prüfport fehlt.' }
  $env:BONFIRE_URL = 'http://' + $address
  $env:BONFIRE_S3_TEST = 'isolated'
  node tests/admin-s3.mjs
  if ($LASTEXITCODE) { throw 'S3-Prüfung fehlgeschlagen.' }
} finally {
  docker @stack down -v
  $env:BONFIRE_URL = $originalUrl
  $env:BONFIRE_S3_TEST = $originalMode
  Pop-Location
}
