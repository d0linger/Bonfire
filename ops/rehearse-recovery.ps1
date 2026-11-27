param(
  [Parameter(Mandatory)][string]$InputDirectory,
  [Parameter(Mandatory)][string]$BackupImage
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$inputPath = (Resolve-Path -LiteralPath $InputDirectory).Path
foreach ($file in 'archive.dump.enc','archive.key','authorization.json','authorization.sig','operator-public.pem') {
  if (!(Test-Path -LiteralPath (Join-Path $inputPath $file) -PathType Leaf)) {
    throw "Missing recovery input: $file"
  }
}
$compose = Join-Path $PSScriptRoot '../compose.recovery.yaml'
$project = 'bonfire-rehearsal-' + [guid]::NewGuid().ToString('N')
$settings = @{
  BONFIRE_RECOVERY_IMAGE = $BackupImage
  BONFIRE_RECOVERY_INPUT = $inputPath
  BONFIRE_RECOVERY_PASSWORD = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
}
$previous = @{}
try {
  foreach ($name in $settings.Keys) {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
    [Environment]::SetEnvironmentVariable($name,$settings[$name],'Process')
  }
  docker compose -p $project -f $compose run --rm verify
} finally {
  try {
    docker compose -p $project -f $compose down -v
  } finally {
    foreach ($name in $previous.Keys) {
      [Environment]::SetEnvironmentVariable($name,$previous[$name],'Process')
    }
  }
}
