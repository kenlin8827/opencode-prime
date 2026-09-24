# install/scripts/tools/opencode.ps1 - install/upgrade opencode PINNED TO v2
# on Windows (x64 + arm64; the asset is picked inside). Referenced from
# install/tools.jsonc as "@script:opencode"; resolved by runInstallCommand in
# install/src/installer.ts. Also invoked directly by install/install.ps1
# (the bootstrap opencode auto-install).
#
# Why pinned: OpenCode Prime v2's plugins, @opencode/plugin SDK and V2-native
# config contract target the opencode v2 API surface. A v1 binary cannot load
# them, so this script pins the major explicitly:
#   - it resolves the newest v2 tag (not "latest overall") and downloads
#     exactly that release asset from anomalyco/opencode;
#   - a v1 binary inside the user profile is UPGRADED in place to the newest
#     v2 (the documented V1->V2 transition keeps the same locations);
#   - it re-verifies the binary major after install (TOCTOU guard).
#
# Behavior (mirrors opencode.sh on POSIX):
#   - opencode v2 on PATH inside the profile -> install/upgrade the resolved
#     v2 tag (idempotent when already on it).
#   - opencode on PATH outside the user profile (another manager owns it,
#     e.g. scoop/choco/winget) -> exit 2 (benign refusal; a v1 external binary
#     gets the "upgrade via your manager" hint, same convention as
#     tgrep.win32-x64.ps1: `ocp update` reports it as externally managed).
#   - opencode v3+ (newer than this line knows) -> refuse, exit 1 — never
#     downgrade a user's binary without consent.
#   - Otherwise resolve the newest v2 release (OCP_API_MIRROR-aware, pinned
#     fallback when the API is unreachable) and install it into the existing
#     location, or %USERPROFILE%\.opencode\bin (the official installer's
#     home) when opencode is absent.
#   - Already at the resolved version -> exit 0 without downloading.
#
# NOTE: https://opencode.ai/install.ps1 is not a working endpoint (HTTP 404),
# so this script downloads the release asset directly instead of delegating
# to an official Windows installer. Asset names are verified against the
# release listing (opencode-windows-<arch>.zip containing opencode.exe).

$ErrorActionPreference = 'Stop'

$Repo = 'anomalyco/opencode'
$RequiredMajor = 2
# Known-good v2 release - fallback ONLY when the GitHub API is unreachable.
# Stale-but-v2 beats newest-but-v3 every time; `ocp update` moves it forward
# within v2 afterwards.
$V2Fallback = '2.0.15'

function Get-OpencodeSemver {
  try {
    $out = & opencode --version 2>$null
  } catch {
    return ''
  }
  $m = [regex]::Match("$out", '\d+\.\d+\.\d+')
  if ($m.Success) { return $m.Value } else { return '' }
}

function Get-ApiJson {
  param([string]$Url)
  (Invoke-RestMethod -Uri $Url -Headers @{ 'User-Agent' = 'ocp' } -TimeoutSec 20)
}

# 0. Inspect what's on PATH; refuse a NEWER major, never downgrade.
$cmd = Get-Command opencode -ErrorAction SilentlyContinue
$installed = if ($cmd) { Get-OpencodeSemver } else { '' }
$installedMajor = if ($installed -match '^(\d+)\.') { [int]$Matches[1] } else { 0 }
if ($installedMajor -gt $RequiredMajor) {
  Write-Host "[ocp] REFUSED: opencode v$installed is newer than the major OpenCode Prime pins (v$RequiredMajor.x). This OCP line cannot run on it - see https://github.com/kenlin8827/opencode-prime/releases for a matching release; leaving the v$installed binary untouched."
  exit 1
}
if ($cmd -and $cmd.Source -notlike "$env:USERPROFILE*") {
  if ($installedMajor -lt $RequiredMajor) {
    Write-Host "[ocp] opencode v$installed at $($cmd.Source) is outside your user profile and BELOW the v$RequiredMajor runtime OCP requires. Upgrade it with the manager that owns it (scoop/choco/winget), then re-run."
    exit 2
  }
  Write-Host "[ocp] opencode v$installed found at $($cmd.Source) - outside your user profile, so ocp will not touch it. Update it with the tool that installed it, or uninstall it there and re-run ocp update to manage opencode under $env:USERPROFILE\.opencode\bin."
  exit 2
}

# 1. Resolve the newest v2 tag (API lists newest-first; first v2 wins).
#    OCP_API_MIRROR (ghproxy-style prefix) is tried first when set.
$apiPath = "https://api.github.com/repos/$Repo/releases?per_page=100"
$mirror = ($env:OCP_API_MIRROR -replace '/+$', '')
$apiUrls = @($apiPath)
if ($mirror) { $apiUrls = @("$mirror/$apiPath") + $apiUrls }
$tag = $null
foreach ($u in $apiUrls) {
  try {
    $rels = Get-ApiJson $u
    $v2 = $rels | Where-Object { $_.tag_name -match '^v2\.' } | Select-Object -First 1
    if ($v2) { $tag = $v2.tag_name; break }
  } catch {
    Write-Host "[ocp] version probe via $u failed: $($_.Exception.Message)"
  }
}
if (-not $tag) {
  $tag = "v$V2Fallback"
  Write-Host "[ocp] Could not reach the GitHub API - falling back to pinned v2 release $tag."
}
$ver = $tag -replace '^v', ''

# 2. Idempotence: already at the resolved v2 -> nothing to do.
if ($installed -and $installed -eq $ver) {
  Write-Host "[ocp] opencode v$installed already installed (newest v2)."
  exit 0
}

# 3. Download exactly the resolved v2 asset (OCP_RELEASE_MIRROR first when set).
$archAsset = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$asset = "opencode-windows-$archAsset.zip"
$official = "https://github.com/$Repo/releases/download/$tag/$asset"
$relMirror = ($env:OCP_RELEASE_MIRROR -replace '/+$', '')
$urls = @($official)
if ($relMirror) { $urls = @("$relMirror/$official") + $urls }

$dst = if ($cmd) { $cmd.Source } else { Join-Path $env:USERPROFILE '.opencode\bin\opencode.exe' }
$dir = Split-Path $dst
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

# Remove a leftover <exe>.old from a previous locked upgrade once its process
# has exited (same rotation as tgrep.win32-x64.ps1).
Remove-Item "$dst.old" -Force -ErrorAction SilentlyContinue

if ($installedMajor -and $installedMajor -lt $RequiredMajor) {
  Write-Host "[ocp] Upgrading opencode v$installed -> v$ver (V1->V2 runtime transition required by OCP v2; config locations are unchanged)."
} else {
  Write-Host "[ocp] Installing opencode v$ver (newest v2; OCP v2 requires the v2 runtime)..."
}
$tmp = Join-Path $env:TEMP ('opencode-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
  $zip = Join-Path $tmp $asset
  $downloaded = $false
  foreach ($u in $urls) {
    try {
      Invoke-WebRequest -Uri $u -OutFile $zip -UseBasicParsing
      $downloaded = $true
      break
    } catch {
      Write-Host "[ocp] download from $u failed: $($_.Exception.Message)"
    }
  }
  if (-not $downloaded) { Write-Host '[ocp] error: all download sources failed'; exit 1 }

  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $bin = Get-ChildItem -Path $tmp -Recurse -Filter 'opencode.exe' | Select-Object -First 1
  if (-not $bin) { Write-Host '[ocp] error: opencode.exe not found in archive'; exit 1 }
  try {
    Copy-Item -Path $bin.FullName -Destination $dst -Force
  } catch [System.IO.IOException] {
    # Destination locked by a running process: renaming a running exe IS
    # allowed - move it aside, drop the new binary under the original name.
    Write-Host "[ocp] $dst is locked by a running process - installing the new version under the original name; the old file stays as $dst.old until that process exits."
    try {
      Move-Item -Path $dst -Destination "$dst.old" -Force
    } catch {
      Write-Host "[ocp] error: $dst is locked and cannot even be renamed - close the process using it and re-run."
      exit 1
    }
    Copy-Item -Path $bin.FullName -Destination $dst -Force
  }
} finally {
  Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# 4. TOCTOU verify: the binary on PATH must be v2 after install.
$now = Get-OpencodeSemver
$nowMajor = if ($now -match '^(\d+)\.') { [int]$Matches[1] } else { 0 }
if ($nowMajor -ne $RequiredMajor) {
  Write-Host "[ocp] Post-install check FAILED: opencode reports '$now', expected v$RequiredMajor."
  exit 1
}
Write-Host "[ocp] opencode v$now installed."
