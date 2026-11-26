param([Parameter(Mandatory=$true)][string]$Path,[switch]$SkipHistory)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'private-files.ps1')
if(Test-Path -LiteralPath $Path){throw 'Zieldatei existiert bereits.'}
# PowerShell 7.4+ preserves native binary stdout redirection.
if($PSVersionTable.PSVersion -lt [version]'7.4'){throw 'PowerShell 7.4 oder neuer erforderlich.'}
docker compose exec -T db pg_dump -U bonfire -d bonfire -Fc > $Path
if($LASTEXITCODE -ne 0){throw 'Sicherung unvollständig.'}
$hash=Get-FileHash -Algorithm SHA256 -LiteralPath $Path
if($hash.Hash -notmatch '^[0-9A-F]{64}$'){throw 'Prüfsumme ungültig.'}
if (!$SkipHistory) { Write-BackupHistory $hash.Hash }
$hash
