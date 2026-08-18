param(
  [ValidateSet('', 'api', 'admin', 'all', 'migrate')]
  [string]$Mode = ''
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Key = (Get-ChildItem -Path $Root -Recurse -File -Filter 'navicat_equitick_ed25519_v2' |
  Select-Object -First 1).FullName
$HostName = '8.141.13.99'
$Remote = "root@$HostName"

if (-not $Mode) {
  Write-Host ''
  Write-Host 'Select deployment target:'
  Write-Host '1. API only'
  Write-Host '2. Admin only'
  Write-Host '3. API + Admin'
  Write-Host '4. Database migrations only'
  Write-Host '0. Cancel'
  $choice = Read-Host 'Enter number'
  $Mode = switch ($choice) {
    '1' { 'api' }
    '2' { 'admin' }
    '3' { 'all' }
    '4' { 'migrate' }
    '0' { exit 0 }
    default { throw 'Invalid selection' }
  }
}

if (-not $Key -or -not (Test-Path -LiteralPath $Key)) {
  throw "SSH key not found: $Key"
}

$archive = Join-Path $env:TEMP 'siku-admin-source.tar.gz'
try {
  if ($Mode -in @('admin', 'all')) {
    Write-Host '[Local] Packaging Admin source'
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
    & tar -czf $archive --exclude=node_modules --exclude=.next --exclude=.git -C (Join-Path $Root 'admin') .
    if ($LASTEXITCODE -ne 0) { throw 'Failed to package Admin source' }
    Write-Host '[Upload] Sending Admin source to server'
    & scp -i $Key $archive "${Remote}:/tmp/siku-admin-source.tar.gz"
    if ($LASTEXITCODE -ne 0) { throw 'Failed to upload Admin source' }
  }

  Write-Host "[Server] Starting $Mode deployment"
  & ssh -o BatchMode=yes -i $Key $Remote "sudo /usr/local/bin/siku-deploy-services $Mode"
  if ($LASTEXITCODE -ne 0) { throw 'Deployment failed; review the log above' }
  Write-Host '[Done] Deployment succeeded' -ForegroundColor Green
} finally {
  if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
}
