function New-PrivateDirectory([string]$Parent) {
  $path = Join-Path $Parent ([guid]::NewGuid().ToString('N'))
  if ($IsWindows) {
    $access = [Security.AccessControl.DirectorySecurity]::new()
    $access.SetAccessRuleProtection($true, $false)
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($owner, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $access.AddAccessRule($rule)
    [IO.FileSystemAclExtensions]::Create([IO.DirectoryInfo]::new($path), $access)
  } else {
    $null = [IO.Directory]::CreateDirectory($path, [IO.UnixFileMode]'UserRead,UserWrite,UserExecute')
  }
  return $path
}

function Protect-CredentialFile([string]$Path) {
  if ($IsWindows) {
    $access = [Security.AccessControl.FileSecurity]::new()
    $access.SetAccessRuleProtection($true, $false)
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $access.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($owner, 'FullControl', 'Allow'))
    [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($Path), $access)
  } else {
    [IO.File]::SetUnixFileMode($Path, [IO.UnixFileMode]'UserRead,UserWrite')
  }
}

function Write-BackupHistory([string]$Digest) {
  if ($Digest -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid backup digest.' }
  $query = "INSERT INTO backup_history(digest) VALUES ('$Digest')"
  docker compose exec -T db psql -X -U bonfire -d bonfire -v ON_ERROR_STOP=1 -c $query | Out-Null
  if ($LASTEXITCODE) { throw 'Archive created, but recording its completion failed.' }
}
