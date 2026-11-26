param([Parameter(Mandatory=$true)][string]$Directory,[Parameter(Mandatory=$true)][string]$KeyFile,[ValidateRange(1,3650)][int]$RetentionDays=30)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'private-files.ps1')
$root=(Get-Item -LiteralPath $Directory).FullName
$key=(Get-Item -LiteralPath $KeyFile).FullName
if(!(Get-Item -LiteralPath $root).PSIsContainer){throw 'Sicherungsverzeichnis fehlt.'}
$id=[guid]::NewGuid().ToString('N')
$name='bonfire-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')+'-'+$id+'.dump.enc'
$stage=New-PrivateDirectory ([IO.Path]::GetTempPath())
$tmp=Join-Path $stage 'backup.dump'
try{
 & ./ops/backup.ps1 -Path $tmp -SkipHistory | Out-Null
 node ./ops/crypt.mjs encrypt $key $tmp (Join-Path $root $name)
 if($LASTEXITCODE){throw 'Verschlüsselung fehlgeschlagen.'}
 Write-BackupHistory (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $root $name)).Hash
} finally {
 if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) }
 [IO.Directory]::Delete($stage)
}
$cutoff=[DateTime]::UtcNow.AddDays(-$RetentionDays)
Get-ChildItem -LiteralPath $root -File -Filter 'bonfire-*.dump.enc' | Where-Object { $_.Name -cmatch '^bonfire-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{32}\.dump\.enc$' -and $_.LastWriteTimeUtc -lt $cutoff -and !$_.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint) } | ForEach-Object {Remove-Item -LiteralPath $_.FullName}
Write-Output (Join-Path $root $name)
