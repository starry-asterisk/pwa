[CmdletBinding()]
param(
  [Parameter(Mandatory)][string] $Version,
  [string] $Repository,
  [string] $OutputDirectory
)
. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-ReleaseVersion $Version
$config = Get-ReleaseConfig
if (-not $Repository) { $Repository = $config.repository }
Assert-ReleaseRepository $Repository
if (-not $OutputDirectory) { $OutputDirectory = ".cache/windows/releases/$Version" }
$destination = Get-WorkspacePath $OutputDirectory
if ((Test-Path -LiteralPath $destination) -and @(Get-ChildItem -LiteralPath $destination -Force).Count -gt 0) {
  throw 'The release output already contains files. Use a new output directory to preserve existing artifacts.'
}
$previousEnvironment = Initialize-WindowsBuildEnvironment
$previousSigningFile = [Environment]::GetEnvironmentVariable('VPK_AZURE_TRUSTED_SIGN_FILE', 'Process')
Push-Location $script:WindowsTaskRoot
try {
  $dotnet = Get-DotnetCommand
  $sourceCommit = (& git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Unable to read source revision.' }
  $sourceDirty = [bool](& git status --porcelain --untracked-files=normal)
  $project = Get-WorkspacePath $config.project
  if (-not (Test-Path -LiteralPath $project)) { throw 'The Windows app project is not available yet.' }
  $stage = Get-WorkspacePath ('.cache/windows/staging/' + $Version + '-' + [guid]::NewGuid().ToString('N'))
  $publish = Join-Path $stage 'publish'
  $package = Join-Path $stage 'package'
  New-Item -ItemType Directory -Path $publish, $package -Force | Out-Null

  # Optional Azure signing uses environment credentials. No certificate is imported or made trusted here.
  $signingMetadata = [Environment]::GetEnvironmentVariable('WINDOWS_SIGNING_METADATA_JSON', 'Process')
  if ($signingMetadata) {
    $metadata = $signingMetadata | ConvertFrom-Json
    foreach ($required in @('Endpoint', 'CodeSigningAccountName', 'CertificateProfileName')) {
      if (-not $metadata.PSObject.Properties[$required] -or -not $metadata.$required) { throw 'Signing metadata is incomplete.' }
    }
    if ($metadata.PSObject.Properties['AccessToken']) { throw 'Supply signing credentials through secure environment variables.' }
    $metadataPath = Join-Path $stage 'signing-metadata.json'
    $signingMetadata | Set-Content -LiteralPath $metadataPath -Encoding utf8
    [Environment]::SetEnvironmentVariable('VPK_AZURE_TRUSTED_SIGN_FILE', $metadataPath, 'Process')
  }
  if ($env:VPK_SKIP_VELO_APP_CHECK -and $env:VPK_SKIP_VELO_APP_CHECK -ne 'false') { throw 'The Velopack startup verification must remain enabled.' }
  & (Join-Path $PSScriptRoot 'Provision-Models.ps1')
  Invoke-Checked $dotnet @('tool', 'restore', '--tool-manifest', (Get-WorkspacePath '.config/dotnet-tools.json'), '--configfile', (Get-WorkspacePath '.config/NuGet.Config'))
  Invoke-Checked $dotnet @('publish', $project, '-c', 'Release', '-r', $config.runtime, '--self-contained', 'true', '--artifacts-path', (Join-Path $stage 'build'),
    '-p:PublishSingleFile=false', '-p:PublishTrimmed=false', "-p:Version=$Version", "-p:AssemblyVersion=$Version.0",
    "-p:FileVersion=$Version.0", ('-p:RestoreConfigFile=' + (Get-WorkspacePath '.config/NuGet.Config')), '-p:ContinuousIntegrationBuild=true', '-o', $publish)
  $mainExecutable = Join-Path $publish $config.mainExe
  if (-not (Test-Path -LiteralPath $mainExecutable)) { throw 'The app executable was not published.' }
  foreach ($model in $config.tessdata.files) {
    $modelPath = Join-Path $publish ('Assets/tessdata/' + $model.name)
    if (-not (Test-Path -LiteralPath $modelPath) -or (Get-FileHash -LiteralPath $modelPath -Algorithm SHA256).Hash -ne $model.sha256) {
      throw 'The published app must contain the verified OCR models and license.'
    }
  }
  Invoke-Checked $dotnet @('tool', 'run', 'vpk', '--', '--skip-updates', 'pack', '--packId', $config.packageId,
    '--packVersion', $Version, '--packDir', $publish, '--mainExe', $config.mainExe, '--packTitle', $config.title,
    '--packAuthors', 'starry-asterisk', '--runtime', $config.runtime, '--channel', $config.channel,
    '--framework', 'vcredist143-x64', '--noPortable', '--outputDir', $package)

  $installers = @(Get-ChildItem -LiteralPath $package -Filter '*Setup.exe' -File)
  $fullPackages = @(Get-ChildItem -LiteralPath $package -Filter '*-full.nupkg' -File)
  if ($installers.Count -ne 1 -or $fullPackages.Count -ne 1) { throw 'Expected one installer and one complete update package.' }
  $feed = Join-Path $package ('releases.' + $config.channel + '.json')
  if (-not (Test-Path -LiteralPath $feed)) { throw 'The update feed is missing.' }
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  $installerPath = Join-Path $destination $config.installerFileName
  Copy-Item -LiteralPath $installers[0].FullName -Destination $installerPath
  Copy-Item -LiteralPath $fullPackages[0].FullName, $feed -Destination $destination
  $signature = Get-AuthenticodeSignature -LiteralPath $installerPath
  $signed = $signature.Status -eq 'Valid'
  if (($signingMetadata -or $previousSigningFile -or $env:VPK_SIGN_PARAMS -or $env:VPK_SIGN_TEMPLATE) -and -not $signed) {
    throw 'Configured signing did not produce a trusted installer signature.'
  }
  $tag = "windows-v$Version"
  $release = [ordered]@{
    schemaVersion = 1; version = $Version; tag = $tag
    sourceCommit = $sourceCommit; sourceDirty = $sourceDirty
    builtAt = [DateTime]::UtcNow.ToString('o')
    platform = 'windows'; architecture = 'x64'; minimumWindowsVersion = $config.minimumWindowsVersion
    installer = [ordered]@{
      fileName = $config.installerFileName
      downloadUrl = "https://github.com/$Repository/releases/download/$tag/$($config.installerFileName)"
      sha256 = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
      sizeBytes = (Get-Item -LiteralPath $installerPath).Length
      authenticodeSigned = $signed
    }
    autoUpdate = [ordered]@{
      provider = 'velopack-github'; repositoryUrl = "https://github.com/$Repository"
      packageId = $config.packageId; channel = $config.channel; feedFile = ('releases.' + $config.channel + '.json')
    }
  }
  $release | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $destination 'windows-release.json') -Encoding utf8
  $checksums = foreach ($asset in Get-ChildItem -LiteralPath $destination -File | Sort-Object Name) {
    '{0}  {1}' -f (Get-FileHash -LiteralPath $asset.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $asset.Name
  }
  $checksums | Set-Content -LiteralPath (Join-Path $destination 'SHA256SUMS.txt') -Encoding utf8
  & (Join-Path $PSScriptRoot 'Test-Release.ps1') -ReleaseDirectory $destination
  Write-Host "Windows release built and verified: $destination"
  Write-Host "Trusted installer signature: $signed"
} finally {
  Pop-Location
  [Environment]::SetEnvironmentVariable('VPK_AZURE_TRUSTED_SIGN_FILE', $previousSigningFile, 'Process')
  Restore-WindowsBuildEnvironment $previousEnvironment
}
