param([string]$CoverProfile)
# The test uses a separate PostgreSQL server with the normal migration and runtime grants.
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$name = 'bonfire-tx-' + [guid]::NewGuid().ToString('N')
$vars = 'POSTGRES_PASSWORD','BONFIRE_TEST_PGPORT','BONFIRE_TEST_PGPASSWORD'
$original = @{}
foreach ($key in $vars) { $original[$key] = [Environment]::GetEnvironmentVariable($key,'Process') }
$started = $false
Push-Location (Join-Path $PSScriptRoot '..')
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'The document renderer build failed.' }
  $env:POSTGRES_PASSWORD = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
  $null = docker run -d --name $name -e POSTGRES_PASSWORD -e POSTGRES_DB=bonfire_tx_tests --publish 127.0.0.1::5432 --health-cmd 'pg_isready -h 127.0.0.1' --health-interval 1s --health-retries 30 postgres:18-alpine
  $started = $true
  for ($attempt=0; $attempt -lt 45; $attempt++) {
    if ((docker inspect --format '{{.State.Health.Status}}' $name) -eq 'healthy') { break }
    Start-Sleep -Seconds 1
  }
  if ($attempt -eq 45) { throw 'Disposable PostgreSQL did not start.' }
  $address = (docker port $name 5432/tcp).Trim()
  if ($address -notmatch '^127\.0\.0\.1:([0-9]+)$') { throw 'Expected a disposable loopback port.' }
  $env:BONFIRE_TEST_PGPORT = $Matches[1]
  $env:BONFIRE_TEST_PGPASSWORD = $env:POSTGRES_PASSWORD
  $arguments = @('test','-count=1','-timeout=15m')
  if ($CoverProfile) { $arguments += @('-covermode=set',"-coverprofile=$CoverProfile") }
  go @arguments .
} finally {
  if ($started) { docker rm --force --volumes $name | Out-Null }
  foreach ($key in $vars) { [Environment]::SetEnvironmentVariable($key,$original[$key],'Process') }
  Pop-Location
}
