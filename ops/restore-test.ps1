param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference='Stop'
$dbName='restore_'+[guid]::NewGuid().ToString('N')
docker compose exec -T db createdb -U bonfire $dbName
if($LASTEXITCODE -ne 0){throw 'Isolierte Testdatenbank konnte nicht erstellt werden.'}
$remotePath='/tmp/'+$dbName+'.dump'
docker compose cp $Path ('db:'+$remotePath)
if($LASTEXITCODE -ne 0){throw 'Kopieren der Sicherung fehlgeschlagen.'}
docker compose exec -T db pg_restore -U bonfire --exit-on-error --single-transaction -d $dbName $remotePath
$restoreExit=$LASTEXITCODE
docker compose exec -T db unlink $remotePath
if($restoreExit -ne 0){throw 'Restore fehlgeschlagen.'}
docker compose exec -T db psql -X -U bonfire -d $dbName -v ON_ERROR_STOP=1 -c 'SELECT (SELECT count(*) FROM entries) AS entries,(SELECT count(*) FROM operations) AS operations,(SELECT count(*) FROM audit) AS audit,(SELECT count(*) FROM originals) AS originals;'
if($LASTEXITCODE -ne 0){throw 'Restoreprüfung fehlgeschlagen.'}
Write-Output ("Wiederhergestellte isolierte Datenbank: "+$dbName)
