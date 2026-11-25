[CmdletBinding()]
param()
. (Join-Path $PSScriptRoot 'Common.ps1')
$previousEnvironment = Initialize-WindowsBuildEnvironment
try {
  $config = Get-ReleaseConfig
  $destination = Get-WorkspacePath 'windows/MoaCapture/Assets/tessdata'
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  foreach ($file in $config.tessdata.files) {
    $path = Join-Path $destination $file.name
    if ((Test-Path -LiteralPath $path) -and (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -eq $file.sha256) { continue }
    $download = Get-WorkspacePath ('.cache/windows/temp/' + [guid]::NewGuid().ToString('N') + '-' + $file.name)
    $uri = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/{0}/{1}' -f $config.tessdata.commit, $file.name
    Invoke-WebRequest -Uri $uri -OutFile $download
    if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $file.sha256) { throw "OCR dependency checksum failed: $($file.name)." }
    Copy-Item -LiteralPath $download -Destination $path -Force
  }
  Write-Host 'Verified English/Korean OCR models and their license.'
} finally { Restore-WindowsBuildEnvironment $previousEnvironment }
