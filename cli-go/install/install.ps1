# Installs or upgrades the native muvloom CLI for Windows x64 to the latest stable GitHub release,
# verifying its SHA-256 checksum (skips download if already up to date, never downgrades).
#   $env:MUVLOOM_VERSION = "0.1.0"        pin an exact release (never downgrades a newer install)
#   $env:MUVLOOM_MIN_VERSION = "0.2.5"    require the resolved release to be at least this version
#   $env:MUVLOOM_INSTALL_DIR = "..."      install directory. Default: where muvloom.exe already is (one
#                                          copy, and it is the one that runs), else the per-user
#                                          %LOCALAPPDATA%\Programs\muvloom, which needs no administrator
#   $env:MUVLOOM_NO_MODIFY_PATH = "1"     leave the user PATH, and this session's PATH, unchanged
#   $env:MUVLOOM_DISTRIBUTION_URL = "http://127.0.0.1:PORT/PATH"  local CI only
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
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
$requestOptions = @{ UseBasicParsing = $true }
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
    $batch = Invoke-RestMethod "${api}?per_page=100&page=$page" -TimeoutSec 20 @requestOptions
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
  } elseif ($current -eq $target -and (-not $env:MUVLOOM_VERSION -or $env:MUVLOOM_MIN_VERSION)) {
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
    try {
      Invoke-WebRequest "$base/$asset" -OutFile (Join-Path $tmp $asset) -TimeoutSec 25 @requestOptions
      Invoke-WebRequest "$base/checksums.txt" -OutFile (Join-Path $tmp "checksums.txt") -TimeoutSec 25 @requestOptions
    } catch {
      $directError = $_.Exception.Message
      Write-Host "Direct download failed; trying the official GitHub Release API."
      try {
        $release = Invoke-RestMethod "$api/tags/$tag" -TimeoutSec 20 @requestOptions
        foreach ($name in @($asset, "checksums.txt")) {
          $id = ($release.assets | Where-Object { $_.name -ceq $name } | Select-Object -First 1).id
          if ("$id" -cnotmatch '^[0-9]+$') { throw "No release asset found for $name" }
          # The download query keeps binary responses separate from cached JSON metadata.
          Invoke-WebRequest "$api/assets/${id}?download=1" -Headers @{ Accept = "application/octet-stream" } -OutFile (Join-Path $tmp $name) -TimeoutSec 60 @requestOptions
        }
      } catch {
        throw "muvloom install: direct download failed ($directError); GitHub Release API failed ($($_.Exception.Message))"
      }
    }
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
