# Encrypted round trip against an S3-compatible server on a disposable Docker network.
param([switch]$CollectCoverage)
$ErrorActionPreference = 'Stop'
$project = 'bonfire-s3-' + [guid]::NewGuid().ToString('N')
$saved = @{}
foreach ($key in 'BONFIRE_DISPOSABLE_TEST','COMPOSE_PROJECT_NAME','BONFIRE_DB_PASSWORD','BONFIRE_RUNTIME_PASSWORD','BONFIRE_ADMIN_PASSWORD') {
  $saved[$key] = [Environment]::GetEnvironmentVariable($key,'Process')
}
$originalUrl = $env:BONFIRE_URL
$originalMode = $env:BONFIRE_S3_TEST
Push-Location (Join-Path $PSScriptRoot '..')
$stack = @('compose', '-p', $project, '-f', 'compose.yaml', '-f', 'tests/compose.s3.yaml')
if ($CollectCoverage) { $stack += @('-f','tests/compose.coverage.yaml') }
try {
  $env:BONFIRE_DISPOSABLE_TEST = '1'
  $env:COMPOSE_PROJECT_NAME = $project
  foreach ($key in 'BONFIRE_ADMIN_PASSWORD','BONFIRE_DB_PASSWORD','BONFIRE_RUNTIME_PASSWORD') {
    [Environment]::SetEnvironmentVariable($key,[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)),'Process')
  }
  docker @stack up -d --build --wait
  if ($LASTEXITCODE) { throw 'S3 test installation failed to start.' }
  $address = (docker @stack port app 8080).Trim()
  if ($address -notmatch '^127\.0\.0\.1:[0-9]+$') { throw 'Local test port is missing.' }
  $env:BONFIRE_URL = 'http://' + $address
  $env:BONFIRE_S3_TEST = 'isolated'
  node tests/seed-retry.mjs
  if ($LASTEXITCODE) { throw "Seed recovery exercise failed." }
  node tests/admin-s3.mjs
  if ($LASTEXITCODE) { throw 'S3 acceptance failed.' }
} finally {
  docker @stack down -v
  $env:BONFIRE_URL = $originalUrl
  $env:BONFIRE_S3_TEST = $originalMode
  foreach ($key in $saved.Keys) {
    [Environment]::SetEnvironmentVariable($key,$saved[$key],'Process')
  }
  Pop-Location
}
