[CmdletBinding()]
param([Parameter(Mandatory)][string] $ReleaseDirectory)
. (Join-Path $PSScriptRoot 'Common.ps1')
$directory = Get-WorkspacePath $ReleaseDirectory
$previousEnvironment = Initialize-WindowsBuildEnvironment
try {
  $config = Get-ReleaseConfig
  $manifest = Get-Content -LiteralPath (Join-Path $directory 'windows-release.json') -Raw | ConvertFrom-Json
  Assert-ReleaseVersion $manifest.version
  if ($manifest.schemaVersion -ne 1 -or $manifest.installer.fileName -ne $config.installerFileName -or
    $manifest.autoUpdate.packageId -ne $config.packageId -or $manifest.autoUpdate.channel -ne $config.channel) {
    throw 'The release manifest does not match the installed app contract.'
  }
  $installer = Join-Path $directory $manifest.installer.fileName
  $fullPackages = @(Get-ChildItem -LiteralPath $directory -Filter '*-full.nupkg' -File)
  $expectedFiles = @($config.installerFileName, $manifest.autoUpdate.feedFile, 'windows-release.json', 'SHA256SUMS.txt')
  if ($fullPackages.Count -ne 1) { throw 'A release must contain exactly one complete update package.' }
  $expectedFiles += $fullPackages[0].Name
  $actualFiles = @(Get-ChildItem -LiteralPath $directory -Force -File)
  if ($actualFiles.Count -ne $expectedFiles.Count -or @($actualFiles | Where-Object { $_.Name -notin $expectedFiles }).Count) {
    throw 'Only the installer, update package, feed, manifest, and checksums may be published.'
  }
  if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $manifest.installer.sha256) { throw 'Installer checksum mismatch.' }
  if ((Get-Item -LiteralPath $installer).Length -ne $manifest.installer.sizeBytes) { throw 'Installer size mismatch.' }
  $checksumLines = @(Get-Content -LiteralPath (Join-Path $directory 'SHA256SUMS.txt'))
  if ($checksumLines.Count -ne ($expectedFiles.Count - 1)) { throw 'The checksum list is incomplete.' }
  $seenNames = @{}
  foreach ($line in $checksumLines) {
    if ($line -notmatch '^([a-fA-F0-9]{64})  ([A-Za-z0-9._-]+)$') { throw 'Invalid release checksum list.' }
    $hash = $Matches[1]; $name = $Matches[2]
    if ($name -notin $expectedFiles -or $name -eq 'SHA256SUMS.txt' -or $seenNames.ContainsKey($name)) { throw 'Unexpected or duplicate checksum entry.' }
    $seenNames[$name] = $true
    $asset = Get-WorkspacePath (Join-Path $directory $name)
    if ((Get-FileHash -LiteralPath $asset -Algorithm SHA256).Hash -ne $hash) { throw "Release asset checksum mismatch: $name." }
  }
  $dotnet = Get-DotnetCommand
  $probe = Get-WorkspacePath 'scripts/windows/ReleaseProbe/ReleaseProbe.csproj'
  $probeArtifacts = Get-WorkspacePath '.cache/windows/probe-build'
  $probeWork = Get-WorkspacePath ('.cache/windows/update-probes/' + [guid]::NewGuid().ToString('N'))
  Invoke-Checked $dotnet @('run', '--project', $probe, '-c', 'Release', '--no-launch-profile', '--artifacts-path', $probeArtifacts,
    ('-p:RestoreConfigFile=' + (Get-WorkspacePath '.config/NuGet.Config')),
    '--', $directory, $probeWork)
} finally { Restore-WindowsBuildEnvironment $previousEnvironment }
