Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$script:WindowsTaskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))

function Get-WorkspacePath([string] $Path) {
  $resolved = if ([IO.Path]::IsPathRooted($Path)) { [IO.Path]::GetFullPath($Path) }
    else { [IO.Path]::GetFullPath((Join-Path $script:WindowsTaskRoot $Path)) }
  $prefix = $script:WindowsTaskRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Windows build paths must stay inside this repository.'
  }
  return $resolved
}

function Get-ReleaseConfig {
  return Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release-config.json') -Raw | ConvertFrom-Json
}

function Assert-ReleaseVersion([string] $Version) {
  if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    throw 'Use a stable three-part version such as 0.1.0.'
  }
  foreach ($part in $Version.Split('.')) {
    if ([long]$part -gt 65534) { throw 'Version components must be at most 65534.' }
  }
}

function Assert-ReleaseRepository([string] $Repository) {
  if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Use a GitHub owner/repository name.' }
}

function Initialize-WindowsBuildEnvironment {
  $locations = @{
    DOTNET_CLI_HOME = '.cache/dotnet-home'
    NUGET_PACKAGES = '.cache/nuget/packages'
    NUGET_HTTP_CACHE_PATH = '.cache/nuget/http'
    NUGET_PLUGINS_CACHE_PATH = '.cache/nuget/plugins'
    TEMP = '.cache/windows/temp'
    TMP = '.cache/windows/temp'
    VELOPACK_TEMP = '.cache/windows/velopack-temp'
  }
  $previous = @{}
  foreach ($name in $locations.Keys) {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    $path = Get-WorkspacePath $locations[$name]
    New-Item -ItemType Directory -Path $path -Force | Out-Null
    [Environment]::SetEnvironmentVariable($name, $path, 'Process')
  }
  foreach ($name in @('DOTNET_CLI_TELEMETRY_OPTOUT', 'DOTNET_SKIP_FIRST_TIME_EXPERIENCE', 'DOTNET_NOLOGO')) {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, '1', 'Process')
  }
  return $previous
}

function Restore-WindowsBuildEnvironment([hashtable] $Previous) {
  foreach ($name in $Previous.Keys) { [Environment]::SetEnvironmentVariable($name, $Previous[$name], 'Process') }
}

function Get-DotnetCommand {
  $local = Get-WorkspacePath '.tools/dotnet/dotnet.exe'
  if (Test-Path -LiteralPath $local) { return $local }
  $command = Get-Command dotnet -ErrorAction Stop
  return $command.Source
}

function Invoke-Checked([string] $Executable, [string[]] $Arguments) {
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Build command failed with exit code $LASTEXITCODE." }
}
