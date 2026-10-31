# Installs the native muvloom CLI for Windows x64 from GitHub releases, verifying its SHA-256 checksum.
#   $env:MUVLOOM_VERSION = "0.1.0"   pin a release (default: latest cli-v* release)
#   $env:MUVLOOM_INSTALL_DIR = "..."  install directory (default: %LOCALAPPDATA%\Programs\muvloom)
$ErrorActionPreference = "Stop"
$repo = "Muluk-m/ai-image-playground"

if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq "ARM64") {
  throw "muvloom install: only Windows x64 is supported"
}
$installDir = if ($env:MUVLOOM_INSTALL_DIR) { $env:MUVLOOM_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\muvloom" }

if ($env:MUVLOOM_VERSION) {
  $tag = "cli-v" + $env:MUVLOOM_VERSION.TrimStart("v")
} else {
  $releases = Invoke-RestMethod "https://api.github.com/repos/$repo/releases?per_page=50"
  $tag = ($releases | Where-Object { $_.tag_name -like "cli-v*" } | Select-Object -First 1).tag_name
  if (-not $tag) { throw "muvloom install: could not find a muvloom release" }
}

$asset = "muvloom_windows_amd64.exe"
$base = "https://github.com/$repo/releases/download/$tag"
$tmp = New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid()))
try {
  Write-Host "Downloading $asset ($tag)"
  Invoke-WebRequest "$base/$asset" -OutFile (Join-Path $tmp $asset)
  Invoke-WebRequest "$base/checksums.txt" -OutFile (Join-Path $tmp "checksums.txt")
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
if (-not ($userPath -split ";" -contains $installDir)) {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$installDir", "User")
  Write-Host "Added $installDir to your user PATH; open a new terminal to use it."
}
& (Join-Path $installDir "muvloom.exe") version
