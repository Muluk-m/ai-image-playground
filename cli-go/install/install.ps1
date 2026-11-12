# Installs the native muvloom CLI for Windows x64 from GitHub releases, verifying its SHA-256 checksum.
#   $env:MUVLOOM_VERSION = "0.1.0"        pin an exact release (never downgrades a newer install)
#   $env:MUVLOOM_MIN_VERSION = "0.2.5"    install the latest release that is at least this version
#   $env:MUVLOOM_INSTALL_DIR = "..."      install directory. Default: where muvloom.exe already is (one
#                                          copy, and it is the one that runs), else the per-user
#                                          %LOCALAPPDATA%\Programs\muvloom, which needs no administrator
#   $env:MUVLOOM_NO_MODIFY_PATH = "1"     leave the user PATH, and this session's PATH, unchanged
#   $env:MUVLOOM_DISTRIBUTION_URL = "http://127.0.0.1:PORT/PATH"  local CI only
$ErrorActionPreference = "Stop"
$repo = "Muluk-m/ai-image-playground"

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq "ARM64" -or $env:PROCESSOR_ARCHITEW6432 -eq "ARM64") {
  throw "muvloom install: only Windows x64 is supported"
}
function Test-WritableDirectory($dir) {
  try {
    $probe = Join-Path $dir ([Guid]::NewGuid().ToString() + ".tmp")
    [IO.File]::WriteAllText($probe, "")
    Remove-Item -Force $probe
    return $true
  } catch {
    return $false
  }
}
function Test-StableVersion($value) {
  return $value -match '^\d+\.\d+\.\d+$'
}
function Get-InstalledVersion($exe) {
  if (-not (Test-Path -LiteralPath $exe)) { return $null }
  try {
    $out = & $exe version 2>$null
    if ($out -match 'muvloom (\d+\.\d+\.\d+)') { return $Matches[1] }
  } catch { }
  return $null
}
# Where to install when MUVLOOM_INSTALL_DIR is not given: replace the copy already installed, so an
# upgrade does not leave the old one running; otherwise the per-user directory.
$installDir = $env:MUVLOOM_INSTALL_DIR
if (-not $installDir) {
  $existing = Get-Command muvloom.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  $existingDir = if ($existing) { Split-Path -Parent $existing.Source } else { $null }
  $installDir = if ($existingDir -and (Test-WritableDirectory $existingDir)) { $existingDir } else { Join-Path $env:LOCALAPPDATA "Programs\muvloom" }
}
$exe = Join-Path $installDir "muvloom.exe"
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

function Get-LatestVersion {
  # Highest stable cli-vX.Y.Z by version, not API order.
  $releases = @()
  for ($page = 1; $page -le 20; $page++) {
    # Assign the response directly: @() around the cmdlet nests its JSON array as one item.
    $batch = Invoke-RestMethod "${api}?per_page=100&page=$page" @requestOptions
    if ($batch.Count -eq 0) { break }
    $releases += $batch
  }
  $tag = ($releases |
    Where-Object { -not $_.prerelease -and $_.tag_name -match '^cli-v\d+\.\d+\.\d+$' } |
    Sort-Object { [version]($_.tag_name -replace '^cli-v', '') } -Descending |
    Select-Object -First 1).tag_name
  if (-not $tag) { throw "muvloom install: could not find a muvloom release" }
  return $tag.Substring(5)
}

if ($env:MUVLOOM_VERSION) {
  $target = $env:MUVLOOM_VERSION.TrimStart("v")
  if (-not (Test-StableVersion $target)) { throw "muvloom install: MUVLOOM_VERSION must be an exact X.Y.Z version" }
} else {
  $target = Get-LatestVersion
}

if ($env:MUVLOOM_MIN_VERSION) {
  $min = $env:MUVLOOM_MIN_VERSION.TrimStart("v")
  if (-not (Test-StableVersion $min)) { throw "muvloom install: MUVLOOM_MIN_VERSION must be an exact X.Y.Z version" }
  if ([version]$target -lt [version]$min) {
    throw "muvloom install: latest or pinned release $target is older than MUVLOOM_MIN_VERSION $min"
  }
}

$current = Get-InstalledVersion $exe
$skipDownload = $false
if ($current -and (Test-StableVersion $current)) {
  if ([version]$current -gt [version]$target) {
    Write-Host "muvloom $current is already installed at $exe; not downgrading to $target"
    $skipDownload = $true
  } elseif ($env:MUVLOOM_MIN_VERSION -and [version]$current -ge [version]$env:MUVLOOM_MIN_VERSION.TrimStart("v") -and $current -eq $target) {
    Write-Host "muvloom $current is already installed at $exe"
    $skipDownload = $true
  }
}

if (-not $skipDownload) {
  $tag = "cli-v$target"
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
    Move-Item -Force (Join-Path $tmp $asset) $exe
  } finally {
    Remove-Item -Recurse -Force $tmp
  }
}

Write-Host "muvloom installed at $exe"
if ($env:MUVLOOM_NO_MODIFY_PATH -ne "1") {
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not ($userPath -split ";" -contains $installDir)) {
    $newUserPath = if ($userPath) { "$userPath;$installDir" } else { $installDir }
    [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
    Write-Host "Added $installDir to your user PATH; new terminals will find muvloom."
  }
  # `irm ... | iex` runs in the caller's session, so this also makes muvloom usable right now.
  if (-not (($env:Path -split ";") -contains $installDir)) { $env:Path = "$env:Path;$installDir" }
}
# Another copy earlier on PATH would keep running instead of this one. Say so.
$other = Get-Command muvloom.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($other -and ([IO.Path]::GetFullPath($other.Source) -ne [IO.Path]::GetFullPath($exe))) {
  Write-Host "Note: $($other.Source) is earlier on PATH and will keep running instead; remove it, or put $installDir first."
}
& $exe version
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
