[CmdletBinding()]
param(
  [Parameter(Mandatory)][string] $ReleaseDirectory,
  [string] $Repository,
  [string] $TargetCommit
)
. (Join-Path $PSScriptRoot 'Common.ps1')
$config = Get-ReleaseConfig
if (-not $Repository) { $Repository = $config.repository }
Assert-ReleaseRepository $Repository
$directory = Get-WorkspacePath $ReleaseDirectory
$manifest = Get-Content -LiteralPath (Join-Path $directory 'windows-release.json') -Raw | ConvertFrom-Json
Assert-ReleaseVersion $manifest.version
if (-not $TargetCommit) { $TargetCommit = (& git -C $script:WindowsTaskRoot rev-parse HEAD).Trim() }
if ($TargetCommit -notmatch '^[a-fA-F0-9]{40}$' -or $manifest.sourceCommit -ne $TargetCommit -or $manifest.sourceDirty) {
  throw 'Only an installer built from a clean, matching committed revision can be published.'
}
if (-not $env:GH_TOKEN -and -not $env:GITHUB_TOKEN) { throw 'Use GitHub Actions GITHUB_TOKEN or an authenticated gh environment to publish.' }
if ($manifest.autoUpdate.repositoryUrl -ne "https://github.com/$Repository") { throw 'The update repository does not match this release.' }
& (Join-Path $PSScriptRoot 'Test-Release.ps1') -ReleaseDirectory $directory
$gh = (Get-Command gh -ErrorAction Stop).Source
$tag = "windows-v$($manifest.version)"

$existingJson = & $gh release view $tag --repo $Repository --json isDraft 2>$null
if ($LASTEXITCODE -eq 0) {
  $existing = $existingJson | ConvertFrom-Json
  if (-not $existing.isDraft) { throw 'This version is already published. Build a higher version instead of replacing public assets.' }
}
$latestTag = & $gh api "repos/$Repository/releases/latest" --jq '.tag_name' 2>$null
if ($LASTEXITCODE -eq 0 -and $latestTag -match '^windows-v(.+)$') {
  if ([version]$manifest.version -le [version]$Matches[1]) { throw 'A stable release must have a higher version than the current latest release.' }
}
$tagCommit = & $gh api "repos/$Repository/commits/$tag" --jq '.sha' 2>$null
if ($LASTEXITCODE -eq 0 -and $tagCommit -ne $TargetCommit) { throw 'The release tag points to a different source revision.' }

$notesPath = Get-WorkspacePath ('.cache/windows/temp/release-notes-' + $manifest.version + '.md')
$signingNote = if ($manifest.installer.authenticodeSigned) { '설치 파일에 Authenticode 서명이 있습니다.' }
  else { '설치 파일은 미서명입니다. Windows SmartScreen 또는 조직 정책에 따라 차단될 수 있습니다.' }
@"
$($config.title) $($manifest.version) · Windows x64

**Moa-Setup.exe**를 내려받아 설치합니다. .NET이 포함되어 있으며, 필요한 경우 설치 프로그램에서 Microsoft Visual C++ 런타임 설치를 안내합니다.

설치한 앱은 이 저장소에서 새 버전을 확인합니다. 내려받은 업데이트는 앱을 종료하고 다시 실행하면 적용됩니다.

$signingNote

설치 파일과 업데이트 패키지의 해시는 SHA256SUMS.txt에서 확인할 수 있습니다. 소스 커밋은 $TargetCommit 입니다.
"@ | Set-Content -LiteralPath $notesPath -Encoding utf8
if (-not $existingJson) {
  Invoke-Checked $gh @('release', 'create', $tag, '--repo', $Repository, '--target', $TargetCommit, '--draft',
    '--title', "$($config.title) $($manifest.version)", '--notes-file', $notesPath)
}
$assets = @(Get-ChildItem -LiteralPath $directory -File | ForEach-Object { $_.FullName })
Invoke-Checked $gh (@('release', 'upload', $tag, '--repo', $Repository, '--clobber') + $assets)
# Publish only after every validated asset is present. Incomplete uploads stay in a private draft.
Invoke-Checked $gh @('release', 'edit', $tag, '--repo', $Repository, '--draft=false', '--latest', '--notes-file', $notesPath)
Write-Host "Published Windows release $tag."
