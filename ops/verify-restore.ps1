param([Parameter(Mandatory=$true)][string]$Path,[string]$KeyFile)
$ErrorActionPreference='Stop'
if(!(Test-Path -LiteralPath 'test-results/replay.json')){throw 'Zuerst node tests/api.mjs mit fiktiven Daten ausführen.'}
if($KeyFile){
  $tempDump=Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N')+'.dump')
  try {
    node ./ops/crypt.mjs decrypt $KeyFile $Path $tempDump
    if($LASTEXITCODE){throw 'Sicherungsauthentisierung fehlgeschlagen.'}
    $output=& ./ops/restore-test.ps1 -Path $tempDump
  }finally{if(Test-Path -LiteralPath $tempDump){Remove-Item -LiteralPath $tempDump}}
}else{
  & ./ops/backup.ps1 -Path $Path
  $output=& ./ops/restore-test.ps1 -Path $Path
}
$output | Write-Output
$restored=($output | Select-String '^Wiederhergestellte isolierte Datenbank: (restore_[0-9a-f]{32})$').Matches.Groups[1].Value
if($restored -notmatch '^restore_[0-9a-f]{32}$'){throw 'Isolierte Zieldatenbank fehlt.'}
$query="SELECT number,encode(sha256(pdf),'hex'),encode(sha256(docx),'hex') FROM originals ORDER BY number"
$before=@(docker compose exec -T db psql -X -At -U bonfire -d bonfire -c $query)
if($LASTEXITCODE -ne 0 -or !$before.Count){throw 'Vorbedingung: Mindestens ein synchronisierter Übungsbeleg.'}
$after=@(docker compose exec -T db psql -X -At -U bonfire -d $restored -c $query)
if($LASTEXITCODE -ne 0 -or (Compare-Object $before $after)){throw 'Originaldateien stimmen nicht überein.'}
$name='bonfire-restore-'+[guid]::NewGuid().ToString('N')
$env:BONFIRE_TEST_DB=$restored
docker compose run -d --no-deps --name $name -p 127.0.0.1::8080 -e BONFIRE_TEST_DB --entrypoint sh app -c 'export DATABASE_URL="${DATABASE_URL%/bonfire*}/${BONFIRE_TEST_DB}?sslmode=disable"; exec /app/bonfire'
if($LASTEXITCODE -ne 0){throw 'Isolierte App konnte nicht starten.'}
try {
  $port=(docker port $name 8080/tcp).Split(':')[-1]
  $env:BONFIRE_URL='http://127.0.0.1:'+$port
  $ready=$false
  for($i=0;$i -lt 30;$i++){try{Invoke-RestMethod -Uri ($env:BONFIRE_URL+'/health') -ErrorAction Stop | Out-Null;$ready=$true;break}catch{Start-Sleep -Milliseconds 300}}
  if(!$ready){throw 'Wiederhergestellte App nicht bereit.'}
  node tests/api.mjs --replay
  if($LASTEXITCODE -ne 0){throw 'Sync nach Wiederherstellung fehlgeschlagen.'}
  Write-Output ("Originale mit übereinstimmenden PDF- und DOCX-Hashes: "+$after.Count)
} finally {
  docker stop $name | Out-Null
  docker rm $name | Out-Null
  Remove-Item Env:BONFIRE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:BONFIRE_TEST_DB -ErrorAction SilentlyContinue
}
