#requires -Version 7.0
<#
.SYNOPSIS
    scripts/pack.ps1 — build a release archive from the current repo state.

.DESCRIPTION
    PowerShell equivalent of scripts/pack.sh. Produces release archives in dist/:
      opencode-prime-<version>.tar.gz   (for macOS / Linux / WSL)
      opencode-prime-<version>.zip       (for Windows)

    Each archive contains:
      install/version.json
      install/options.jsonc
      install/install.sh
      install/install.ps1
      install/versions/<ver>.manifest.txt   (auto-generated if missing)
      bin/*                                 (dispatchers: opencode-prime, ocp)
      <every file listed in the manifest>    (prompts/, plugins/, etc.)

.PARAMETER OutDir
    Output directory for archives (default: ./dist).

.PARAMETER TarOnly
    Build only the tar.gz archive.

.PARAMETER ZipOnly
    Build only the zip archive.

.EXAMPLE
    pwsh scripts/pack.ps1
    pwsh scripts/pack.ps1 -OutDir C:\temp\dist
    pwsh scripts/pack.ps1 -TarOnly
#>
[CmdletBinding()]
param(
    [string]$OutDir,
    [switch]$TarOnly,
    [switch]$ZipOnly,
    [Alias('h')][switch]$Help
)

$ErrorActionPreference = 'Stop'

if ($Help) { Get-Help $PSCommandPath -Detailed; exit 0 }

$ScriptDir = $PSScriptRoot
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir '..')).Path
$VersionFile = Join-Path $RepoRoot 'install/VERSION'
$InstDir = Join-Path $RepoRoot 'install/versions'

# --- read version --------------------------------------------------------

function Read-Version {
    # version.json is authoritative; a legacy install/VERSION is tolerated as fallback.
    $versionJson = Join-Path $RepoRoot 'install/version.json'
    if (Test-Path $versionJson) {
        try {
            $v = ((Get-Content $versionJson -Raw) | ConvertFrom-Json).version
            if ($v) { return "$v".Trim() }
        } catch { }
    }
    if (Test-Path $VersionFile) {
        return (Get-Content $VersionFile -TotalCount 1).Trim()
    }
    $sha = (git -C $RepoRoot rev-parse --short HEAD 2>$null)
    if ($sha) { return $sha.Trim() } else { return 'unknown' }
}

# --- read manifest -------------------------------------------------------

function Read-Manifest([string]$path) {
    if (-not (Test-Path $path)) { return @() }
    Get-Content $path |
        Where-Object { $_ -and $_ -notmatch '^\s*#' } |
        ForEach-Object { $_.Trim() -replace '\\', '/' } |
        Where-Object { $_ -ne '' }
}

# --- generate manifest if missing ----------------------------------------

$includePrefixes = @('commands/', 'plugins/', 'instructions/', 'opencode.template.jsonc', 'tui.template.jsonc', 'tiers.json', 'profiles/', 'prompts/', 'providers/', 'scripts/')
$excludePatterns = @('^scripts/pack\.', '^scripts/verify\.')

function Generate-Manifest([string]$ver) {
    $out = Join-Path $InstDir "$ver.manifest.txt"
    $lines = @()
    Get-ChildItem -Path $RepoRoot -Recurse -File -Force | ForEach-Object {
        $rel = $_.FullName.Substring($RepoRoot.Length).TrimStart('\','/') -replace '\\','/'
        $include = $false
        foreach ($p in $includePrefixes) {
            if ($rel -eq $p.TrimEnd('/') -or $rel.StartsWith($p)) { $include = $true; break }
        }
        if ($include) {
            foreach ($ex in $excludePatterns) {
                if ($rel -match $ex) { $include = $false; break }
            }
        }
        if ($include) { $lines += $rel }
    }
    $lines | Sort-Object | Set-Content -Path $out -Encoding UTF8
    Write-Host ("wrote install/versions/{0}.manifest.txt ({1} files)" -f $ver, $lines.Count)
}

# --- main ----------------------------------------------------------------

$ver = Read-Version
$manifestPath = Join-Path $InstDir "$ver.manifest.txt"

# Ensure manifest exists
if (-not (Test-Path $manifestPath)) {
    Write-Host "manifest missing for version $ver, generating..."
    if (-not (Test-Path $InstDir)) { New-Item -ItemType Directory -Path $InstDir -Force | Out-Null }
    Generate-Manifest $ver
}

if (-not $OutDir) { $OutDir = Join-Path $RepoRoot 'dist' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

# Build staging directory
$stage = New-Item -ItemType Directory -Path ([IO.Path]::Combine([IO.Path]::GetTempPath(), "oc-pack-$(Get-Random)")) -Force
$pkgDir = Join-Path $stage.FullName "opencode-prime-$ver"
New-Item -ItemType Directory -Path $pkgDir -Force | Out-Null

# Pre-build zero-dependency bundled installer if bun is available
$distSrc = Join-Path $RepoRoot 'install/dist'
if (Get-Command bun -ErrorAction SilentlyContinue) {
    Write-Host "Building zero-dependency bundled installer..."
    & bun build (Join-Path $RepoRoot 'install/src/index.ts') --outdir $distSrc --target bun --external '@opentui/core-*'
    if ($LASTEXITCODE -ne 0) { throw "installer bundle failed (exit $LASTEXITCODE)" }
}

# 1. Fully mirror install/ directory (excluding node_modules or temp files)
$installDest = Join-Path $pkgDir 'install'
New-Item -ItemType Directory -Path $installDest -Force | Out-Null
Get-ChildItem -Path (Join-Path $RepoRoot 'install') -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring((Join-Path $RepoRoot 'install').Length + 1)
    if ($rel -notmatch '^(node_modules|\.git|tests|\.tmp)') {
        $target = Join-Path $installDest $rel
        $targetDir = Split-Path $target -Parent
        if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }
        Copy-Item $_.FullName $target -Force
    }
}

# 2. Fully mirror bin/ directory
$binDest = Join-Path $pkgDir 'bin'
New-Item -ItemType Directory -Path $binDest -Force | Out-Null
Get-ChildItem -Path (Join-Path $RepoRoot 'bin') -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring((Join-Path $RepoRoot 'bin').Length + 1)
    $target = Join-Path $binDest $rel
    $targetDir = Split-Path $target -Parent
    if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }
    Copy-Item $_.FullName $target -Force
}

# 3. Mirror package.json if present
if (Test-Path (Join-Path $RepoRoot 'package.json')) {
    Copy-Item (Join-Path $RepoRoot 'package.json') $pkgDir -Force
}

# 2. Copy all bin dispatchers
$binDest = Join-Path $pkgDir 'bin'
New-Item -ItemType Directory -Path $binDest -Force | Out-Null
Copy-Item (Join-Path $RepoRoot 'bin/*') $binDest -Force

# 3. Copy every file listed in the manifest
$manifestFiles = Read-Manifest $manifestPath
$fileCount = 0
foreach ($f in $manifestFiles) {
    $src = Join-Path $RepoRoot $f
    $dst = Join-Path $pkgDir $f
    if (-not (Test-Path $src)) {
        Write-Warning "missing source: $f"
        continue
    }
    $dstDir = Split-Path $dst -Parent
    if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }
    Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force
    $fileCount++
}

Write-Host "staged $fileCount manifest file(s) + install scripts + bin dispatchers"

# 4. Build archives (opencode-prime)
$buildTar = -not $ZipOnly
$buildZip = -not $TarOnly

$primeTarName = "opencode-prime-$ver.tar.gz"
$primeZipName = "opencode-prime-$ver.zip"

# --force-local keeps Windows absolute paths (D:\...) from being parsed as
# GNU tar remote-host syntax; bsdtar (Windows 10+ system32) rejects the flag,
# so probe for support instead of hard-coding it.
$tarCompat = @()
if ((& tar --help 2>&1 | Out-String) -match 'force-local') { $tarCompat += '--force-local' }

if ($buildTar) {
    $tarPath = Join-Path $OutDir $primeTarName
    & tar @tarCompat -czf $tarPath -C $stage.FullName "opencode-prime-$ver"
    if ($LASTEXITCODE -ne 0) { throw "tar failed (exit $LASTEXITCODE)" }
    Write-Host "built: $tarPath"
}

if ($buildZip) {
    $zipPath = Join-Path $OutDir $primeZipName
    Compress-Archive -Path $pkgDir -DestinationPath $zipPath -Force
    Write-Host "built: $zipPath"
}

# Clean up staging directory
Remove-Item -Recurse -Force $stage.FullName -ErrorAction SilentlyContinue

Write-Host "done (version: $ver, files: $fileCount)"
