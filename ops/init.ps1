$ErrorActionPreference='Stop'
$path=Join-Path (Get-Location) '.env'
if(Test-Path -LiteralPath $path){
  if(!([IO.File]::ReadAllText($path) -match '(?m)^BONFIRE_RUNTIME_PASSWORD=')){
    [IO.File]::AppendAllText($path,([Environment]::NewLine+'BONFIRE_RUNTIME_PASSWORD='+[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))+[Environment]::NewLine))
  }
  return
}
$lines=@(('BONFIRE_ADMIN_PASSWORD='+[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))),('BONFIRE_DB_PASSWORD='+[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))))
$lines+=('BONFIRE_RUNTIME_PASSWORD='+[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)))
[IO.File]::WriteAllLines($path,$lines)
Write-Output 'Lokale Zugangsdaten in .env erstellt.'
