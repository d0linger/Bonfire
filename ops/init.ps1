$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'private-files.ps1')
$path=Join-Path (Get-Location) '.env'
if(Test-Path -LiteralPath $path){
  Protect-CredentialFile $path
  if(!([IO.File]::ReadAllText($path) -match '(?m)^BONFIRE_RUNTIME_PASSWORD=')){
    [IO.File]::AppendAllText($path,([Environment]::NewLine+'BONFIRE_RUNTIME_PASSWORD='+[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))+[Environment]::NewLine))
  }
  return
}
$lines=@(('BONFIRE_ADMIN_PASSWORD='+[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))),('BONFIRE_DB_PASSWORD='+[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))))
$lines+=('BONFIRE_RUNTIME_PASSWORD='+[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)))
$stage = New-PrivateDirectory (Split-Path $path)
$temp = Join-Path $stage '.env'
try {
  [IO.File]::WriteAllLines($temp,$lines)
  Protect-CredentialFile $temp
  [IO.File]::Move($temp,$path)
} finally {
  if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) }
  [IO.Directory]::Delete($stage)
}
Write-Output 'Created local credentials in .env.'
