# Run with a checkout of the last release that wrote schema-21 BONFIRE2 archives.
param([Parameter(Mandatory=$true)][string]$PreviousSource)
$ErrorActionPreference = 'Stop'
$previousCompose = (Resolve-Path (Join-Path $PreviousSource 'compose.yaml')).Path
if (!(Test-Path (Join-Path $PreviousSource 'migrations/021.sql')) -or (Test-Path (Join-Path $PreviousSource 'migrations/022.sql'))) {
  throw 'Für die Ausgangssicherung den Quellstand mit Schema 21 angeben.'
}
$project = 'bonfire-backup-upgrade-' + [guid]::NewGuid().ToString('N')
$saved = @{}
foreach ($key in 'COMPOSE_PROJECT_NAME','BONFIRE_PORT','BONFIRE_OFFLINE_ENABLED','BONFIRE_DB_PASSWORD','BONFIRE_RUNTIME_PASSWORD','BONFIRE_ADMIN_PASSWORD') {
  $saved[$key] = [Environment]::GetEnvironmentVariable($key,'Process')
}
Push-Location (Join-Path $PSScriptRoot '..')
try {
  $env:COMPOSE_PROJECT_NAME = $project
  $env:BONFIRE_PORT = '0'
  $env:BONFIRE_OFFLINE_ENABLED = 'false'
  $env:BONFIRE_DB_PASSWORD = [guid]::NewGuid().ToString('N')
  $env:BONFIRE_RUNTIME_PASSWORD = [guid]::NewGuid().ToString('N')
  $env:BONFIRE_ADMIN_PASSWORD = [guid]::NewGuid().ToString('N')
  function Start-TestStack($compose) {
    docker compose -f $compose up -d --build --wait
    if ($LASTEXITCODE) {throw 'Prüfstack konnte nicht starten.'}
    $address = (docker compose -f $compose port app 8080).Trim()
    if ($address -notmatch '^127\.0\.0\.1:[0-9]+$' -or $address -eq '127.0.0.1:8137') {throw 'Isolierter Prüfport fehlt.'}
    $script:api = 'http://' + $address + '/api/'
  }
  function Connect-TestAccount {
    $script:session = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
    $basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('leitung:' + $env:BONFIRE_ADMIN_PASSWORD))
    $login = Invoke-WebRequest -Uri ($api + 'login') -MaximumRedirection 0 -Method Post -Headers @{Authorization='Basic ' + $basic}
    # This isolated loopback API client uses the issued token directly. Browser
    # enforcement of Secure cookies is exercised separately over real HTTPS.
    $cookie = @($login.Headers['Set-Cookie']) | Where-Object { $_ -match '^bonfire_session=' } | Select-Object -First 1
    if (!$cookie -or $cookie -notmatch '^bonfire_session=([A-Za-z0-9_-]+);') { throw 'No session issued by the disposable stack.' }
    $session.Cookies.Add([uri]$api,[Net.Cookie]::new('bonfire_session',$Matches[1],'/api/'))
    $null = $session.Headers.Remove('Authorization')
  }
  function Post-Data($path, $data) {
    Invoke-RestMethod -Uri ($api + $path) -WebSession $session -Method Post -ContentType 'application/json' -Body (ConvertTo-Json -Depth 6 $data)
  }
  function Wait-BackupJob($action) {
    for ($try = 0; $try -lt 120; $try++) {
      $status = Invoke-RestMethod -Uri ($api + 'admin/backup') -WebSession $session
      if (!$status.active -and $status.recent[0].action -eq $action) {
        if ($status.recent[0].outcome -ne 'ok') {throw $status.recent[0].message}
        return $status
      }
      Start-Sleep -Milliseconds 500
    }
    throw "Auftrag $action ist nicht abgeschlossen."
  }
  Start-TestStack $previousCompose
  Connect-TestAccount
  $year = Post-Data 'years' @{Name='Übung';Starts='2049-01-01';Ends='2049-12-31'}
  $event = Post-Data 'events' @{Name='Übungsfest';Starts='2049-03-01';Ends='2049-03-01';Year=$year.ID}
  $target = [guid]::NewGuid().ToString()
  $entry = @{ID=[guid]::NewGuid().ToString();Target=$target;Kind='income';Data=@{Label='Übungseintritt';Date='2049-03-01';Amount=125}}
  $null = Post-Data ('online?event=' + $event.ID) @{Ops=@($entry)}
  # Some legacy entries have no matching operation in the audit history.
  $legacyEvent = Post-Data 'events' @{Name='Legacy order fixture';Starts='2049-03-01';Ends='2049-03-02';Year=$year.ID}
  $opening = @{ID=[guid]::NewGuid().ToString(); Target=[guid]::NewGuid().ToString(); Kind='opening'; Data=@{Label='Opening';Date='2049-03-01';Amount=0}}
  $observation = @{ID=[guid]::NewGuid().ToString(); Target=[guid]::NewGuid().ToString(); Kind='actual'; Data=@{Label='Observed cash';Date='2049-03-02';Amount=125}}
  $null = Post-Data ('online?event=' + $legacyEvent.ID) @{Ops=@($opening,$observation)}
  $legacyID = [guid]::NewGuid().ToString()
  $fixtureSQL = "INSERT INTO entries(event,id,revision,device,kind,data) SELECT :'legacy'::uuid, :'id', revision, device, kind, data FROM entries WHERE event=:'event'::uuid AND id=:'source';"
  $fixtureSQL | docker compose -p $project exec -T db psql -X -v ON_ERROR_STOP=1 -U bonfire -d bonfire -v "legacy=$($legacyEvent.ID)" -v "id=$legacyID" -v "event=$($event.ID)" -v "source=$target"
  if ($LASTEXITCODE) {throw 'Could not prepare legacy posting-order fixture.'}
  function Remove-TestBooking {
    $null = Post-Data 'events/entries' @{Event=$event.ID;Target=$target;Request=[guid]::NewGuid().ToString();Action='remove';Revision=1;Reason='Berichtigt im isolierten Übungsbestand'}
  }
  $null = Post-Data 'admin/backup' @{action='backup';target='local'}
  $name = (Wait-BackupJob 'backup').recent[0].message
  $file = Invoke-WebRequest -Uri ($api + 'admin/backup/file?target=local&name=' + $name) -WebSession $session
  if ([Text.Encoding]::ASCII.GetString($file.Content[0..7]) -ne 'BONFIRE2') {throw 'Verschlüsselte BONFIRE2-Datei erwartet.'}
  Write-Output 'PASS Verschlüsseltes Archiv unter Schema 21 erstellt.'

  Start-TestStack 'compose.yaml'
  Connect-TestAccount
  Remove-TestBooking
  $null = Post-Data 'events/delete' @{Event=$event.ID}
  $null = Post-Data 'admin/backup' @{action='probe';target='local';name=$name}
  $null = Wait-BackupJob 'probe'
  Write-Output 'PASS Archiv im ursprünglichen Schema geprüft und isoliert migriert.'
  $null = Post-Data 'admin/backup' @{action='promote';target='local';name=$name;confirmation='WIEDERHERSTELLEN';password=$env:BONFIRE_ADMIN_PASSWORD}
  $revoked = $false
  for ($try = 0; $try -lt 120; $try++) {
    $check = Invoke-WebRequest -Uri ($api + 'events') -WebSession $session -SkipHttpErrorCheck
    if ($check.StatusCode -eq 401) {$revoked=$true; break}
    Start-Sleep -Milliseconds 500
  }
  if (!$revoked) {throw 'Alte Sitzung wurde nicht widerrufen.'}
  # During the database swap the old session can already be invalid while
  # the pool is still reconnecting to the restored database.
  for ($try = 0; $try -lt 30; $try++) {
    try {Connect-TestAccount; break} catch {if ($try -eq 29) {throw}}
    Start-Sleep -Milliseconds 300
  }
  $null = Wait-BackupJob 'promote'
  $events = Invoke-RestMethod -Uri ($api + 'events') -WebSession $session
  if ($event.ID -notin $events.ID) {throw 'Veranstaltung aus dem früheren Archiv fehlt.'}
  $book = Post-Data ('online?event=' + $event.ID) @{}
  $restored = @($book.entries | Where-Object {$_.ID -eq $target})
  if ($restored.Count -ne 1 -or $restored[0].Data.Amount -ne 125) {throw 'Ursprüngliche Finanzbuchung fehlt.'}
  $orderSQL = "SELECT count(*) FROM settlement_entries WHERE (event=:'event'::uuid AND id=:'source' AND (data->>'PostingOrder')::bigint>0) OR (event=:'legacy'::uuid AND id=:'id' AND NOT (data ? 'PostingOrder') AND (data->>'BalanceOrder')::bigint > (SELECT balance_order FROM entries WHERE event=:'event'::uuid AND id=:'source'));"
  $orders = $orderSQL | docker compose -p $project exec -T db psql -X -At -v ON_ERROR_STOP=1 -U bonfire -d bonfire -v "legacy=$($legacyEvent.ID)" -v "id=$legacyID" -v "event=$($event.ID)" -v "source=$target"
  if ($LASTEXITCODE -or $orders -ne '2') {throw 'Restored legacy entries must distinguish known posting order from unknown order.'}
  $close = @{Action='Abschluss'}
  try {
    $null = Post-Data ('online?event=' + $legacyEvent.ID) $close
    throw 'Historical observation accepted before recount.'
  } catch {
    if ($_.Exception.Response.StatusCode.value__ -ne 422 -or $_.ErrorDetails.Message -notmatch 'final posting') {throw}
  }
  $observation.ID = [guid]::NewGuid().ToString()
  $observation.Base = 1
  $observation.Data.Note = 'Reconfirmed after migration'

  $recount = Post-Data ('online?event=' + $legacyEvent.ID) @{Ops=@($observation)}
  $count = $recount.entries | Where-Object {$_.ID -eq $observation.Target}
  $historical = $recount.entries | Where-Object {$_.ID -eq $legacyID}
  if (!(Post-Data ('online?event=' + $legacyEvent.ID) $close).closed) {throw 'Reconfirmed event did not close.'}
  if (!$count -or !$historical -or [long]$count.Data.BalanceOrder -le [long]$historical.Data.BalanceOrder) {throw 'Recount must supersede the migrated posting boundary.'}
  Remove-TestBooking
  $null = Post-Data 'events/delete' @{Event=$event.ID}
  $events = Invoke-RestMethod -Uri ($api + 'events') -WebSession $session
  if ($event.ID -in $events.ID) {throw 'Löschung nach der Wiederherstellung unwirksam.'}
  Write-Output 'PASS Schema-21-Archiv erstellt, mit der aktuellen Version geprüft und wiederhergestellt, Veranstaltung erneut gelöscht.'
} catch {
  Write-Output $_.ScriptStackTrace
  throw
} finally {
  docker compose -p $project down -v
  foreach ($key in $saved.Keys) {[Environment]::SetEnvironmentVariable($key,$saved[$key],'Process')}
  Pop-Location
}
