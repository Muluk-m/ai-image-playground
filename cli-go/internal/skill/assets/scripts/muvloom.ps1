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
$exe = Join-Path $defaultDir "muvloom.exe"
$oldBackup = Join-Path $defaultDir ".muvloom.exe.muvloom-old"
$pathCmd = Get-Command muvloom.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$candidates = @(
  $exe,
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

$mutex = New-Object System.Threading.Mutex($false, "Local\MuvloomCliBootstrap")
$locked = $false
try {
  try { $locked = $mutex.WaitOne(120000) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) {
    if (Test-UsableBinary $exe) {
      & $exe @args
      exit $LASTEXITCODE
    }
    throw "muvloom launcher: timed out waiting for another muvloom bootstrap process"
  }
  if ((-not (Test-Path -LiteralPath $exe)) -and (Test-Path -LiteralPath $oldBackup)) {
    try { Move-Item -Force $oldBackup $exe -ErrorAction Stop } catch { }
  }
  if (-not (Test-UsableBinary $exe)) {
    New-Item -ItemType Directory -Force -Path $defaultDir | Out-Null
    $stageFile = Join-Path $defaultDir (".muvloom-bootstrap-" + [Guid]::NewGuid().ToString("N") + ".exe")
    $tmp = New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid()))
    try {
      $asset = "muvloom_windows_amd64.exe"
      $downloaded = $false
      for ($attempt = 0; $attempt -lt 2 -and -not $downloaded; $attempt++) {
        try {
          $manifest = Invoke-RestMethod "$origin/cli/skill-manifest.json" -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 8
          $cliMeta = $manifest.cli
          $binMeta = if ($cliMeta -and $cliMeta.binaries) { $cliMeta.binaries."windows/amd64" } else { $null }
          if ($cliMeta -and $binMeta -and ([version]$cliMeta.version -ge [version]$minVersion) -and ($binMeta.path -cmatch '^bin/v\d+\.\d+\.\d+/[A-Za-z0-9._-]+$') -and ($binMeta.sha256 -cmatch '^[0-9a-f]{64}$')) {
            Invoke-WebRequest "$origin/cli/$($binMeta.path)" -OutFile $stageFile -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 30
            $actual = (Get-FileHash $stageFile -Algorithm SHA256).Hash.ToLower()
            if ($actual -eq $binMeta.sha256) { $downloaded = $true }
          }
        } catch { }
      }

      if (-not $downloaded) {
        $ghReleaseUrl = if ($env:MUVLOOM_GITHUB_RELEASES_URL -and ($env:MUVLOOM_GITHUB_RELEASES_URL -cmatch '^http://127\.0\.0\.1:[0-9]+/')) {
          $env:MUVLOOM_GITHUB_RELEASES_URL.TrimEnd("/")
        } else {
          "https://api.github.com/repos/Muluk-m/ai-image-playground/releases"
        }
        $ghDownloadBase = if ($env:MUVLOOM_GITHUB_DOWNLOAD_URL -and ($env:MUVLOOM_GITHUB_DOWNLOAD_URL -cmatch '^http://127\.0\.0\.1:[0-9]+/')) {
          $env:MUVLOOM_GITHUB_DOWNLOAD_URL.TrimEnd("/")
        } else {
          "https://github.com/Muluk-m/ai-image-playground/releases/download"
        }
        $releases = Invoke-RestMethod "${ghReleaseUrl}?per_page=100" -UseBasicParsing -TimeoutSec 20
        $tag = ($releases | Where-Object { -not $_.prerelease -and -not $_.draft -and $_.tag_name -match '^cli-v\d+\.\d+\.\d+$' } | Sort-Object { [version]($_.tag_name -replace '^cli-v', '') } -Descending | Select-Object -First 1).tag_name
        if (-not $tag) { throw "muvloom launcher: could not find a release" }
        $ver = $tag.Substring(5)
        if ([version]$ver -lt [version]$minVersion) { throw "muvloom launcher: latest release $ver < $minVersion" }
        $base = "$ghDownloadBase/$tag"
        Invoke-WebRequest "$base/$asset" -OutFile $stageFile -UseBasicParsing -MaximumRedirection 5 -TimeoutSec 45
        Invoke-WebRequest "$base/checksums.txt" -OutFile (Join-Path $tmp "checksums.txt") -UseBasicParsing -MaximumRedirection 5 -TimeoutSec 25
        $line = Get-Content (Join-Path $tmp "checksums.txt") | Where-Object { $_ -match " $([regex]::Escape($asset))$" }
        if (-not $line) { throw "muvloom launcher: missing checksum for $asset" }
        $expected = ($line -split " ")[0].ToLower()
        $actual = (Get-FileHash $stageFile -Algorithm SHA256).Hash.ToLower()
        if ($actual -ne $expected) { throw "muvloom launcher: checksum mismatch for $asset" }
      }

      Move-Item -Force $stageFile $exe -ErrorAction Stop
    } finally {
      Remove-Item -Force $stageFile -ErrorAction SilentlyContinue
      Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
  }
} finally {
  if ($locked) { try { $mutex.ReleaseMutex() } catch { } }
  $mutex.Dispose()
}

& $exe @args
exit $LASTEXITCODE
