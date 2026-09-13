# install/scripts/tools/tgrep.win32-x64.ps1
# Install/upgrade tgrep (x86_64-pc-windows-msvc). Referenced from
# install/tools.jsonc as "@script:tgrep"; resolved by runInstallCommand in
# install/src/installer.ts. See ripgrep.win32-x64.ps1 for the full behavior
# notes (user-profile guard, OCP_RELEASE_MIRROR fallback).

$ErrorActionPreference = 'Stop'

$archAsset = 'x86_64-pc-windows-msvc'

$cmd = Get-Command tgrep -ErrorAction SilentlyContinue
if ($cmd -and $cmd.Source -notlike "$env:USERPROFILE*") {
  $hint = if ($cmd.Source -like '*chocolatey*') { 'Update via `choco upgrade tgrep -y` (admin terminal)' } elseif ($cmd.Source -like '*scoop*') { 'Update via `scoop update tgrep`' } else { 'Update it with the tool that installed it' }
  Write-Host "[ocp] tgrep found at $($cmd.Source) - outside your user profile, so ocp will not touch it. $hint, or uninstall it there and re-run ocp update to manage tgrep under $env:USERPROFILE/.local/bin."
  exit 2
}
$dst = if ($cmd) { $cmd.Source } else { Join-Path $env:USERPROFILE '.local/bin/tgrep.exe' }
$dir = Split-Path $dst
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

# Remove a leftover <exe>.old from a previous locked upgrade once its process
# has exited (removal of a still-locked file fails silently and is retried here).
Remove-Item "$dst.old" -Force -ErrorAction SilentlyContinue

# Resolve the latest release tag (pinned fallback: v1.0.5).
$tag = $null
try {
  $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/microsoft/tgrep/releases/latest' -Headers @{ 'User-Agent' = 'ocp' }
  $tag = $rel.tag_name
} catch {
  try {
    $req = [System.Net.HttpWebRequest]::Create('https://github.com/microsoft/tgrep/releases/latest')
    $req.AllowAutoRedirect = $false
    $res = $req.GetResponse()
    $tag = Split-Path $res.GetResponseHeader('Location') -Leaf
    $res.Close()
  } catch {
    $tag = 'v1.0.5'
  }
}
if (-not $tag) { $tag = 'v1.0.5' }

$asset = "tgrep-$tag-$archAsset.zip"
$official = "https://github.com/microsoft/tgrep/releases/download/$tag/$asset"
$mirror = ($env:OCP_RELEASE_MIRROR -replace '/+$', '')
$urls = @($official)
if ($mirror) { $urls = @("$mirror/$official") + $urls }

$tmp = Join-Path $env:TEMP ('tgrep-' + [Guid]::NewGuid().ToString('N'))
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
  $bin = Get-ChildItem -Path $tmp -Recurse -Filter 'tgrep.exe' | Select-Object -First 1
  if (-not $bin) { Write-Host "error: tgrep.exe not found in archive"; exit 1 }
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
