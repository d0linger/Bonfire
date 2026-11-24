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
    $null = Invoke-RestMethod -Uri ($api + 'login') -WebSession $session -Method Post -Headers @{Authorization='Basic ' + $basic}
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
