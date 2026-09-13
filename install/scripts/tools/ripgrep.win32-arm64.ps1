# install/scripts/tools/ripgrep.win32-arm64.ps1
# Install/upgrade ripgrep (aarch64-pc-windows-msvc). Referenced from
# install/tools.jsonc as "@script:ripgrep"; resolved by runInstallCommand in
# install/src/installer.ts.
#
# Behavior (matches the former inline one-liner):
#   - rg outside the user profile belongs to another package manager — we
#     refuse to overwrite it and tell the user to update it there.
#   - Otherwise download the latest release and overwrite the resolved rg
#     (or %USERPROFILE%\.local\bin\rg.exe if rg is not on PATH).
#   - OCP_RELEASE_MIRROR, when set, is tried before the official GitHub
#     release asset (mirror outage falls back to the official URL).

$ErrorActionPreference = 'Stop'

$archAsset = 'aarch64-pc-windows-msvc'

$cmd = Get-Command rg -ErrorAction SilentlyContinue
if ($cmd -and $cmd.Source -notlike "$env:USERPROFILE*") {
  $hint = if ($cmd.Source -like '*chocolatey*') { 'Update via `choco upgrade ripgrep -y` (admin terminal)' } elseif ($cmd.Source -like '*scoop*') { 'Update via `scoop update ripgrep`' } else { 'Update it with the tool that installed it' }
  Write-Host "[ocp] rg found at $($cmd.Source) - outside your user profile, so ocp will not touch it. $hint, or uninstall it there and re-run ocp update to manage rg under $env:USERPROFILE/.local/bin."
  exit 2
}
$dst = if ($cmd) { $cmd.Source } else { Join-Path $env:USERPROFILE '.local/bin/rg.exe' }
$dir = Split-Path $dst
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

# Remove a leftover <exe>.old from a previous locked upgrade once its process
# has exited (removal of a still-locked file fails silently and is retried here).
Remove-Item "$dst.old" -Force -ErrorAction SilentlyContinue

# Resolve the latest release tag (pinned fallback: 15.2.0).
$tag = $null
try {
  $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/BurntSushi/ripgrep/releases/latest' -Headers @{ 'User-Agent' = 'ocp' }
  $tag = $rel.tag_name
} catch {
  try {
    $req = [System.Net.HttpWebRequest]::Create('https://github.com/BurntSushi/ripgrep/releases/latest')
    $req.AllowAutoRedirect = $false
    $res = $req.GetResponse()
    $tag = Split-Path $res.GetResponseHeader('Location') -Leaf
    $res.Close()
  } catch {
    $tag = '15.2.0'
  }
}
if (-not $tag) { $tag = '15.2.0' }

$asset = "ripgrep-$tag-$archAsset.zip"
$official = "https://github.com/BurntSushi/ripgrep/releases/download/$tag/$asset"
$mirror = ($env:OCP_RELEASE_MIRROR -replace '/+$', '')
$urls = @($official)
if ($mirror) { $urls = @("$mirror/$official") + $urls }

$tmp = Join-Path $env:TEMP ('ripgrep-' + [Guid]::NewGuid().ToString('N'))
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
  if (-not $downloaded) { Write-Host "error: all download sources failed"; exit 1 }

  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $bin = Get-ChildItem -Path $tmp -Recurse -Filter 'rg.exe' | Select-Object -First 1
  if (-not $bin) { Write-Host "error: rg.exe not found in archive"; exit 1 }
  try {
    Copy-Item -Path $bin.FullName -Destination $dst -Force
  } catch [System.IO.IOException] {
    # The current exe is locked by a running process (Windows cannot
    # overwrite an in-use image - e.g. the agent host using tgrep_search).
    # Renaming a running exe IS allowed: move it aside, drop the new
    # binary under the original name; the leftover .old is removed on the
    # next run (top-of-script cleanup above) once the process has exited.
    Write-Host "[ocp] $dst is locked by a running process - installing the new version under the original name; the old file stays as $dst.old until that process exits."
    try {
      Move-Item -Path $dst -Destination "$dst.old" -Force
    } catch {
      Write-Host "error: $dst is locked and cannot even be renamed - close the process using it and re-run."
      exit 1
    }
    Copy-Item -Path $bin.FullName -Destination $dst -Force
  }
} finally {
  Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
