param(
  [ValidateSet('', 'api', 'admin', 'website', 'services', 'all', 'migrate')]
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
  Write-Host '4. Website only'
  Write-Host '5. API + Admin + Website'
  Write-Host '6. Database migrations only'
  Write-Host '0. Cancel'
  $choice = Read-Host 'Enter number'
  $Mode = switch ($choice) {
    '1' { 'api' }
    '2' { 'admin' }
    '3' { 'services' }
    '4' { 'website' }
    '5' { 'all' }
    '6' { 'migrate' }
    '0' { exit 0 }
    default { throw 'Invalid selection' }
  }
}

if (-not $Key -or -not (Test-Path -LiteralPath $Key)) {
  throw "SSH key not found: $Key"
}

$adminArchive = Join-Path $env:TEMP 'siku-admin-source.tar.gz'
$websiteArchive = Join-Path $env:TEMP 'siku-website.tar.gz'
try {
  if ($Mode -in @('admin', 'services', 'all')) {
    Write-Host '[Local] Packaging Admin source'
    if (Test-Path -LiteralPath $adminArchive) { Remove-Item -LiteralPath $adminArchive -Force }
    & tar -czf $adminArchive --exclude=node_modules --exclude=.next --exclude=.git -C (Join-Path $Root 'admin') .
    if ($LASTEXITCODE -ne 0) { throw 'Failed to package Admin source' }
    Write-Host '[Upload] Sending Admin source to server'
    & scp -i $Key $adminArchive "${Remote}:/tmp/siku-admin-source.tar.gz"
    if ($LASTEXITCODE -ne 0) { throw 'Failed to upload Admin source' }
  }

  if ($Mode -in @('website', 'all')) {
    Write-Host '[Local] Packaging Website files'
    if (Test-Path -LiteralPath $websiteArchive) { Remove-Item -LiteralPath $websiteArchive -Force }
    & tar -czf $websiteArchive -C (Join-Path $Root 'website') .
    if ($LASTEXITCODE -ne 0) { throw 'Failed to package Website files' }
    & scp -i $Key $websiteArchive "${Remote}:/tmp/siku-website.tar.gz"
    if ($LASTEXITCODE -ne 0) { throw 'Failed to upload Website files' }
  }

  & scp -i $Key (Join-Path $PSScriptRoot 'siku-deploy-services.sh') "${Remote}:/tmp/siku-deploy-services"
  if ($LASTEXITCODE -ne 0) { throw 'Failed to upload server deployment script' }
  & ssh -o BatchMode=yes -i $Key $Remote "install -m 755 /tmp/siku-deploy-services /usr/local/bin/siku-deploy-services && rm -f /tmp/siku-deploy-services"
  if ($LASTEXITCODE -ne 0) { throw 'Failed to install server deployment script' }

  Write-Host "[Server] Starting $Mode deployment"
  & ssh -o BatchMode=yes -i $Key $Remote "sudo /usr/local/bin/siku-deploy-services $Mode"
  if ($LASTEXITCODE -ne 0) { throw 'Deployment failed; review the log above' }
  Write-Host '[Done] Deployment succeeded' -ForegroundColor Green
} finally {
  if (Test-Path -LiteralPath $adminArchive) { Remove-Item -LiteralPath $adminArchive -Force }
  if (Test-Path -LiteralPath $websiteArchive) { Remove-Item -LiteralPath $websiteArchive -Force }
}
