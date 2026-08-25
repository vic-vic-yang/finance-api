$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Website = Join-Path $Root 'website'
$Key = (Get-ChildItem -Path $Root -Recurse -File -Filter 'navicat_equitick_ed25519_v2' |
  Select-Object -First 1).FullName
$Remote = 'root@8.141.13.99'
$Archive = Join-Path $env:TEMP 'siku-website.tar.gz'

if (-not $Key -or -not (Test-Path -LiteralPath $Key)) {
  throw "SSH key not found: $Key"
}

try {
  if (Test-Path -LiteralPath $Archive) { Remove-Item -LiteralPath $Archive -Force }
  & tar -czf $Archive -C $Website .
  if ($LASTEXITCODE -ne 0) { throw 'Failed to package website' }

  & scp -i $Key $Archive "${Remote}:/tmp/siku-website.tar.gz"
  if ($LASTEXITCODE -ne 0) { throw 'Failed to upload website' }

  $Command = 'mkdir -p /opt/siku/website && rm -rf /opt/siku/website/* && tar -xzf /tmp/siku-website.tar.gz -C /opt/siku/website && rm -f /tmp/siku-website.tar.gz && nginx -t && systemctl reload nginx'
  & ssh -o BatchMode=yes -i $Key $Remote $Command
  if ($LASTEXITCODE -ne 0) { throw 'Website deployment failed' }
  Write-Host '[Done] Website deployed to https://www.equitick.top/' -ForegroundColor Green
} finally {
  if (Test-Path -LiteralPath $Archive) { Remove-Item -LiteralPath $Archive -Force }
}
