param(
  [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9_-]+$')][string]$PostgresService,
  [Parameter(Mandatory)][string]$SignerKey,
  [Parameter(Mandatory)][string]$Destination,
  [string]$RestoreReference = ''
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$directory = (Resolve-Path -LiteralPath $Destination).Path
$key = (Resolve-Path -LiteralPath $SignerKey).Path
$sql = @'
SELECT jsonb_build_object(
  'installation', (SELECT installation FROM backup_installation),
  'observedAt', clock_timestamp(),
  'chains', (SELECT jsonb_agg(jsonb_build_object('lane',lane,'position',position,
    'sha256',encode(digest,'hex')) ORDER BY lane) FROM audit_chain_heads)
)::text;
'@
$state = (psql -XAt --no-password -v ON_ERROR_STOP=1 --dbname "service=$PostgresService" -c $sql) | ConvertFrom-Json
if (!$state.installation -or @($state.chains).Count -ne 2) { throw 'Incomplete audit checkpoint.' }
$state | Add-Member -NotePropertyName format -NotePropertyValue 'bonfire-audit-v1'
$state | Add-Member -NotePropertyName restoreReference -NotePropertyValue $RestoreReference
$payload = [Text.Encoding]::UTF8.GetBytes(($state | ConvertTo-Json -Compress -Depth 6))
$temp = [IO.Path]::GetTempFileName()
$signature = "$temp.sig"
try {
  [IO.File]::WriteAllBytes($temp,$payload)
  openssl pkeyutl -sign -inkey $key -rawin -in $temp -out $signature
  $envelope = [ordered]@{payload=[Convert]::ToBase64String($payload); signature=[Convert]::ToBase64String([IO.File]::ReadAllBytes($signature))}
  $record = [Text.Encoding]::UTF8.GetBytes(($envelope | ConvertTo-Json -Compress))
  $name = 'audit-checkpoint-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + [guid]::NewGuid().ToString('N') + '.json'
  $file = [IO.File]::Open((Join-Path $directory $name),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
  try { $file.Write($record); $file.Flush($true) } finally { $file.Dispose() }
  $name
} finally {
  [IO.File]::Delete($temp)
  [IO.File]::Delete($signature)
}
