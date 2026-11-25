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
$signingNote = if ($manifest.installer.authenticodeSigned) { 'The installer has a trusted Authenticode signature.' }
  else { 'This initial installer is unsigned. Windows SmartScreen or organization policy may block it. No certificate or security-policy changes are required by this release.' }
@"
Moa Capture $($manifest.version) for Windows x64.

Download **Moa-Setup.exe** to install. .NET is included; setup may offer Microsoft's Visual C++ runtime if it is missing.

Installed copies check this repository for updates. Downloaded updates apply on the next launch. Offline startup remains available.

$signingNote

SHA256SUMS.txt contains the installer and update-package hashes. Source revision: $TargetCommit.
"@ | Set-Content -LiteralPath $notesPath -Encoding utf8
if (-not $existingJson) {
  Invoke-Checked $gh @('release', 'create', $tag, '--repo', $Repository, '--target', $TargetCommit, '--draft',
    '--title', "Moa Capture $($manifest.version)", '--notes-file', $notesPath)
}
$assets = @(Get-ChildItem -LiteralPath $directory -File | ForEach-Object { $_.FullName })
Invoke-Checked $gh (@('release', 'upload', $tag, '--repo', $Repository, '--clobber') + $assets)
# Publish only after every validated asset is present. Incomplete uploads stay in a private draft.
Invoke-Checked $gh @('release', 'edit', $tag, '--repo', $Repository, '--draft=false', '--latest', '--notes-file', $notesPath)
Write-Host "Published Windows release $tag."
