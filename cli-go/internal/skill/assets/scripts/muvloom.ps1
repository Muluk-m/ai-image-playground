# Zero-dependency Windows launcher bundled inside the Muvloom Agent Skill.
# Uses an installed muvloom.exe (>= 0.2.5) if present; otherwise downloads and SHA-256
# verifies the static binary from Muvloom's CDN (with GitHub Releases fallback) on first run.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq "ARM64" -or $env:PROCESSOR_ARCHITEW6432 -eq "ARM64") {
  throw "muvloom launcher: only Windows x64 is supported"
}

$minVersion = if ($env:MUVLOOM_MIN_VERSION) { $env:MUVLOOM_MIN_VERSION.TrimStart("v") } else { "0.2.5" }
$selfPath = [IO.Path]::GetFullPath($PSCommandPath)

function Test-UsableBinary($candidate) {
  if (-not $candidate -or -not (Test-Path -LiteralPath $candidate)) { return $false }
  if ([IO.Path]::GetFullPath($candidate) -eq $selfPath) { return $false }
  try {
    $out = & $candidate version 2>$null
    if ($out -match 'muvloom (\d+\.\d+\.\d+)') {
      return ([version]$Matches[1] -ge [version]$minVersion)
    }
  } catch { }
  return $false
}

$defaultDir = if ($env:MUVLOOM_INSTALL_DIR) { $env:MUVLOOM_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Programs\muvloom" }
$recoveredTarget = Join-Path $defaultDir "muvloom.exe"
$oldBackup = Join-Path $defaultDir ".muvloom.exe.muvloom-old"
if ((-not (Test-Path $recoveredTarget)) -and (Test-Path $oldBackup)) {
  try { Move-Item -Force $oldBackup $recoveredTarget -ErrorAction Stop } catch { }
}
$pathCmd = Get-Command muvloom.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$candidates = @(
  (Join-Path $defaultDir "muvloom.exe"),
  $(if ($pathCmd) { $pathCmd.Source } else { $null })
)
foreach ($c in $candidates) {
  if (Test-UsableBinary $c) {
    & $c @args
    exit $LASTEXITCODE
  }
}

$origin = if ($env:MUVLOOM_ORIGIN) {
  $trimmed = $env:MUVLOOM_ORIGIN.TrimEnd("/")
  $official = @("https://muvloom.online", "https://image.nainma.online", "https://image-playground.qiliangjia.one", "https://test.muvloom.online")
  if (($official -notcontains $trimmed) -and ($trimmed -cnotmatch '^http://(127\.0\.0\.1|localhost):[0-9]+$')) {
    throw "muvloom launcher: MUVLOOM_ORIGIN must be an official Muvloom origin"
  }
  $trimmed
} elseif ($env:MUVLOOM_API_URL -like "https://test-api.muvloom.online*") {
  "https://test.muvloom.online"
} elseif ($env:MUVLOOM_API_URL -like "https://image-api.qiliangjia.one*") {
  "https://image-playground.qiliangjia.one"
} else {
  "https://muvloom.online"
}

$exe = Join-Path $defaultDir "muvloom.exe"
$mutex = New-Object System.Threading.Mutex($false, "Local\MuvloomCliBootstrap")
$locked = $false
try {
  try { $locked = $mutex.WaitOne(30000) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
  if ((-not (Test-Path $exe)) -and (Test-Path $oldBackup)) {
    try { Move-Item -Force $oldBackup $exe -ErrorAction Stop } catch { }
  }
  if (-not (Test-UsableBinary $exe)) {
    $tmp = New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid()))
    try {
      $asset = "muvloom_windows_amd64.exe"
      $outFile = Join-Path $tmp $asset
      $downloaded = $false
      try {
        $manifest = Invoke-RestMethod "$origin/cli/skill-manifest.json" -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 8
        $cliMeta = $manifest.cli
        $binMeta = if ($cliMeta -and $cliMeta.binaries) { $cliMeta.binaries."windows/amd64" } else { $null }
        if ($cliMeta -and $binMeta -and ([version]$cliMeta.version -ge [version]$minVersion) -and ($binMeta.path -cmatch '^bin/v\d+\.\d+\.\d+/[A-Za-z0-9._-]+$') -and ($binMeta.sha256 -cmatch '^[0-9a-f]{64}$')) {
          Invoke-WebRequest "$origin/cli/$($binMeta.path)" -OutFile $outFile -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 30
          $actual = (Get-FileHash $outFile -Algorithm SHA256).Hash.ToLower()
          if ($actual -eq $binMeta.sha256) { $downloaded = $true }
        }
      } catch { }

      if (-not $downloaded) {
        $repo = "Muluk-m/ai-image-playground"
        $releases = Invoke-RestMethod "https://api.github.com/repos/$repo/releases?per_page=100" -UseBasicParsing -TimeoutSec 20
        $tag = ($releases | Where-Object { -not $_.prerelease -and $_.tag_name -match '^cli-v\d+\.\d+\.\d+$' } | Sort-Object { [version]($_.tag_name -replace '^cli-v', '') } -Descending | Select-Object -First 1).tag_name
        if (-not $tag) { throw "muvloom launcher: could not find a release" }
        $ver = $tag.Substring(5)
        if ([version]$ver -lt [version]$minVersion) { throw "muvloom launcher: latest release $ver < $minVersion" }
        $base = "https://github.com/$repo/releases/download/$tag"
        Invoke-WebRequest "$base/$asset" -OutFile $outFile -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 30
        Invoke-WebRequest "$base/checksums.txt" -OutFile (Join-Path $tmp "checksums.txt") -UseBasicParsing -TimeoutSec 20
        $line = Get-Content (Join-Path $tmp "checksums.txt") | Where-Object { $_ -match " $([regex]::Escape($asset))$" }
        if (-not $line) { throw "muvloom launcher: missing checksum for $asset" }
        $expected = ($line -split " ")[0].ToLower()
        $actual = (Get-FileHash $outFile -Algorithm SHA256).Hash.ToLower()
        if ($actual -ne $expected) { throw "muvloom launcher: checksum mismatch for $asset" }
      }

      New-Item -ItemType Directory -Force -Path $defaultDir | Out-Null
      try {
        Move-Item -Force $outFile $exe -ErrorAction Stop
      } catch {
        if (-not (Test-UsableBinary $exe)) { throw }
      }
    } finally {
      Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
  }
} finally {
  if ($locked) { try { $mutex.ReleaseMutex() } catch { } }
  $mutex.Dispose()
}

& $exe @args
exit $LASTEXITCODE
