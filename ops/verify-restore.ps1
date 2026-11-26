param([Parameter(Mandatory=$true)][string]$Path,[string]$KeyFile,[switch]$VerifyExercise)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'private-files.ps1')
if ($VerifyExercise) { throw 'Offline replay was retired. Run ops/accept-online.ps1 to verify supported online recovery.' }
if($KeyFile){
  $stage=New-PrivateDirectory ([IO.Path]::GetTempPath())
  $tempDump=Join-Path $stage 'restore.dump'
  try {
    node ./ops/crypt.mjs decrypt $KeyFile $Path $tempDump
    if($LASTEXITCODE){throw 'Backup authentication failed.'}
    $output=& ./ops/restore-test.ps1 -Path $tempDump
  } finally {
    if ([IO.File]::Exists($tempDump)) { [IO.File]::Delete($tempDump) }
    [IO.Directory]::Delete($stage)
  }
}else{
  if(!(Test-Path -LiteralPath $Path)){& ./ops/backup.ps1 -Path $Path | Out-Null}
  $output=& ./ops/restore-test.ps1 -Path $Path
}
$output | Write-Output
$restored=($output | Select-String '^Restored isolated database: (restore_[0-9a-f]{32})$').Matches.Groups[1].Value
if($restored -notmatch '^restore_[0-9a-f]{32}$'){throw 'The isolated target database is missing.'}
$query="SELECT number,encode(sha256(pdf),'hex'),encode(sha256(docx),'hex') FROM originals ORDER BY number"
$before=@(docker compose exec -T db psql -X -At -U bonfire -d bonfire -c $query)
if($LASTEXITCODE -ne 0){throw 'The original document register is unavailable or the test document is missing.'}
$after=@(docker compose exec -T db psql -X -At -U bonfire -d $restored -c $query)
if($LASTEXITCODE -ne 0 -or (Compare-Object $before $after)){throw 'The original files do not match.'}
$yearQuery="SELECT y.id,y.name,y.starts,y.ends,e.id,e.deleted_at FROM fiscal_years y FULL JOIN event_records e ON e.fiscal_year=y.id ORDER BY y.id,e.id"
$yearsBefore=@(docker compose exec -T db psql -X -At -v ON_ERROR_STOP=1 -U bonfire -d bonfire -c $yearQuery)
if($LASTEXITCODE){throw 'Fiscal year assignments are unavailable.'}
$yearsAfter=@(docker compose exec -T db psql -X -At -v ON_ERROR_STOP=1 -U bonfire -d $restored -c $yearQuery)
if($LASTEXITCODE -or (Compare-Object $yearsBefore $yearsAfter)){throw 'Restored fiscal years or workspaces differ from the source.'}
$conflictQuery="SELECT id,encode(sha256(decode(data->>'PDF','base64')),'hex'),encode(sha256(decode(data->>'DOCX','base64')),'hex') FROM operations WHERE kind='original' AND outcome IN ('Konflikt','Geklärt') ORDER BY id"
$conflictSource=@(docker compose exec -T db psql -X -At -v ON_ERROR_STOP=1 -U bonfire -d bonfire -c $conflictQuery)
if($LASTEXITCODE){throw 'Cannot read the source conflict revisions.'}
$conflictCopy=@(docker compose exec -T db psql -X -At -v ON_ERROR_STOP=1 -U bonfire -d $restored -c $conflictQuery)
if($LASTEXITCODE -or (Compare-Object $conflictSource $conflictCopy)){throw 'Archived conflict revisions differ from the source.'}
Write-Output ("Restored conflict revisions with matching PDF and DOCX hashes: "+$conflictCopy.Count)
$reportQuery="SELECT r.id,r.digest,encode(sha256(r.payload),'hex'),s.seq,s.status,encode(sha256(convert_to(s.evidence,'UTF8')),'hex') FROM donation_reports r JOIN donation_report_steps s ON s.report=r.id ORDER BY r.id,s.seq"
$expectedReports=@(docker compose exec -T db psql -X -At -v ON_ERROR_STOP=1 -U bonfire -d bonfire -c $reportQuery)
if($LASTEXITCODE){throw 'Cannot read source evidence for donation reviews.'}
$restoredReports=@(docker compose exec -T db psql -X -At -v ON_ERROR_STOP=1 -U bonfire -d $restored -c $reportQuery)
if($LASTEXITCODE -or (Compare-Object $expectedReports $restoredReports)){throw 'Archived donation reviews or supporting evidence differ from the source.'}
foreach($line in $restoredReports){$fields=$line.Split('|');if($fields[1] -ne $fields[2]){throw 'Invalid donation export checksum.'}}
Write-Output ("Restored review steps with verified donation exports: "+$restoredReports.Count)
$name='bonfire-restore-'+[guid]::NewGuid().ToString('N')
$previousMode=$env:BONFIRE_DISPOSABLE_TEST
$previousURL=$env:BONFIRE_URL
docker compose run -d --no-deps --name $name -p 127.0.0.1::8080 -e "BONFIRE_TEST_DB=$restored" --entrypoint sh app -c 'export DATABASE_URL="${DATABASE_URL%/bonfire*}/${BONFIRE_TEST_DB}?sslmode=disable"; exec /app/bonfire'
if($LASTEXITCODE -ne 0){throw 'Failed to start the isolated application.'}
try {
  $port=(docker port $name 8080/tcp).Split(':')[-1]
  $env:BONFIRE_DISPOSABLE_TEST='1'
  $env:BONFIRE_URL='http://127.0.0.1:'+$port
  $ready=$false
  for($i=0;$i -lt 30;$i++){try{Invoke-RestMethod -Uri ($env:BONFIRE_URL+'/health') -ErrorAction Stop | Out-Null;$ready=$true;break}catch{Start-Sleep -Milliseconds 300}}
  if(!$ready){throw 'The restored application is not ready.'}
  Write-Output ("Originals with matching PDF and DOCX hashes: "+$after.Count)
} finally {
  docker stop $name | Out-Null
  docker rm $name | Out-Null
  $env:BONFIRE_DISPOSABLE_TEST=$previousMode
  $env:BONFIRE_URL=$previousURL
}
