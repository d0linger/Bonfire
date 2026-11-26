# Current acceptance scope. The historical device suites remain in tests/.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'accept-online.ps1')
