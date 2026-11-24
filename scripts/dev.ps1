$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$localNodePath = Join-Path $projectRoot '.cache\node-directory.txt'
if (Test-Path -LiteralPath $localNodePath) {
    $nodeDirectory = (Get-Content -LiteralPath $localNodePath -Raw).Trim()
    if (Test-Path -LiteralPath (Join-Path $nodeDirectory 'node.exe')) { $env:PATH = $nodeDirectory + ';' + $env:PATH }
}
$env:NPM_CONFIG_CACHE = Join-Path $projectRoot '.cache\npm'
$nodeVersion = [version]((node --version).TrimStart('v'))
if ($nodeVersion -lt [version]'22.12.0') { throw 'Node.js 22.12 이상이 필요합니다. README의 개발 환경 항목을 확인해 주세요.' }
if (!(Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw '의존성을 설치하지 못했습니다.' }
}
npm run dev