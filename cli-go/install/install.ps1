# Installs the native muvloom CLI for Windows x64 from GitHub releases, verifying its SHA-256 checksum.
#   $env:MUVLOOM_VERSION = "0.1.0"   pin a release (default: latest cli-v* release)
#   $env:MUVLOOM_INSTALL_DIR = "..."  install directory (default: %LOCALAPPDATA%\Programs\muvloom)
#   $env:MUVLOOM_NO_MODIFY_PATH = "1"  leave the user PATH unchanged
#   $env:MUVLOOM_DISTRIBUTION_URL = "http://127.0.0.1:PORT/PATH"  local CI only
$ErrorActionPreference = "Stop"
$repo = "Muluk-m/ai-image-playground"

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq "ARM64" -or $env:PROCESSOR_ARCHITEW6432 -eq "ARM64") {
  throw "muvloom install: only Windows x64 is supported"
}
$installDir = if ($env:MUVLOOM_INSTALL_DIR) { $env:MUVLOOM_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\muvloom" }
$api = "https://api.github.com/repos/$repo/releases"
$download = "https://github.com/$repo/releases/download"
$requestOptions = @{}
if ($env:MUVLOOM_DISTRIBUTION_URL) {
  if ($env:MUVLOOM_DISTRIBUTION_URL -cnotmatch '^http://127\.0\.0\.1:[0-9]+(/[A-Za-z0-9_-]+)+$') {
    throw "muvloom install: distribution override must be a loopback URL with a port and path"
  }
  $api = "$env:MUVLOOM_DISTRIBUTION_URL/releases"
  $download = $env:MUVLOOM_DISTRIBUTION_URL
  # No redirect can turn the local fixture into an external download.
  $requestOptions.MaximumRedirection = 0
}

if ($env:MUVLOOM_VERSION) {
  $tag = "cli-v" + $env:MUVLOOM_VERSION.TrimStart("v")
} else {
  # Highest stable cli-vX.Y.Z by version, not API order.
  $releases = @()
  for ($page = 1; $page -le 20; $page++) {
    $batch = @(Invoke-RestMethod "${api}?per_page=100&page=$page" @requestOptions)
    if ($batch.Count -eq 0) { break }
    $releases += $batch
  }
  $tag = ($releases |
    Where-Object { -not $_.prerelease -and $_.tag_name -match '^cli-v\d+\.\d+\.\d+$' } |
    Sort-Object { [version]($_.tag_name -replace '^cli-v', '') } -Descending |
    Select-Object -First 1).tag_name
  if (-not $tag) { throw "muvloom install: could not find a muvloom release" }
}

$asset = "muvloom_windows_amd64.exe"
$base = "$download/$tag"
$tmp = New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid()))
try {
  Write-Host "Downloading $asset ($tag)"
  Invoke-WebRequest "$base/$asset" -OutFile (Join-Path $tmp $asset) @requestOptions
  Invoke-WebRequest "$base/checksums.txt" -OutFile (Join-Path $tmp "checksums.txt") @requestOptions
  $line = Get-Content (Join-Path $tmp "checksums.txt") | Where-Object { $_ -match " $([regex]::Escape($asset))$" }
  if (-not $line) { throw "muvloom install: no checksum published for $asset" }
  $expected = ($line -split " ")[0].ToLower()
  $actual = (Get-FileHash (Join-Path $tmp $asset) -Algorithm SHA256).Hash.ToLower()
  if ($expected -ne $actual) { throw "muvloom install: checksum mismatch for $asset" }
  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  Move-Item -Force (Join-Path $tmp $asset) (Join-Path $installDir "muvloom.exe")
} finally {
  Remove-Item -Recurse -Force $tmp
}

Write-Host "muvloom installed at $installDir\muvloom.exe"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($env:MUVLOOM_NO_MODIFY_PATH -ne "1" -and -not ($userPath -split ";" -contains $installDir)) {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$installDir", "User")
  Write-Host "Added $installDir to your user PATH; open a new terminal to use it."
}
& (Join-Path $installDir "muvloom.exe") version
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
