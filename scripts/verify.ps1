<#
.SYNOPSIS
    Verify release artifacts against the version manifest.

.DESCRIPTION
    Cross-checks dist/opencode-prime-<version>
    archives against install/versions/<version>.manifest.txt:

      1. File-list completeness — every manifest entry plus the bundled
         install/bin companion files must exist in the archive, with no
         unexpected extras.
      2. Content integrity — SHA256 of every manifest file inside the
         archive must match the repository working tree.

    Reads install/version.json (falling back to a legacy install/VERSION) to pick the version, exactly like pack.ps1.
    Run this after scripts/pack.ps1 and before publishing a release.

.PARAMETER DistDir
    Directory containing the archives (default: ./dist).

.EXAMPLE
    pwsh -NoProfile -File scripts/verify.ps1
#>

param(
    [string]$DistDir = ''
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $DistDir) { $DistDir = Join-Path $RepoRoot 'dist' }
$VersionFile = Join-Path $RepoRoot 'install/VERSION'
$InstDir = Join-Path $RepoRoot 'install/versions'

# --- read version ---------------------------------------------------------

function Read-Version {
    # version.json is authoritative; a legacy install/VERSION is tolerated as fallback.
    $versionJson = Join-Path $RepoRoot 'install/version.json'
    if (Test-Path $versionJson) {
        try {
            $v = ((Get-Content $versionJson -Raw) | ConvertFrom-Json).version
            if ($v) { return "$v".Trim() }
        } catch { }
    }
    if (-not (Test-Path $VersionFile)) { throw "missing install/version.json or install/VERSION" }
    ((Get-Content $VersionFile -Raw) -replace '[\r\n\s]', '')
}

$ver = Read-Version
$manifestPath = Join-Path $InstDir "$ver.manifest.txt"
if (-not (Test-Path $manifestPath)) { throw "missing manifest for version $ver : $manifestPath" }

$minVer = $null
try { $minVer = ((Get-Content (Join-Path $RepoRoot 'install/version.json') -Raw) | ConvertFrom-Json).minVersion } catch { }

function Compare-VersionLt([string]$a, [string]$b) {
    $pa = $a.Split('.') | ForEach-Object { [int]$_ }
    $pb = $b.Split('.') | ForEach-Object { [int]$_ }
    for ($i = 0; $i -lt [Math]::Max($pa.Count, $pb.Count); $i++) {
        $x = if ($i -lt $pa.Count) { $pa[$i] } else { 0 }
        $y = if ($i -lt $pb.Count) { $pb[$i] } else { 0 }
        if ($x -ne $y) { return $x -lt $y }
    }
    return $false
}

# --- prompt budget gate (layered disclosure: L0/L1 sizes) ------------------
# Runtime ladder mirrors install/install.ps1: bun when available, otherwise
# node + the repo-local tsx.

$Measure = Join-Path $RepoRoot 'scripts/measure-prompts.ts'
$TsxEntry = Join-Path $RepoRoot 'node_modules/tsx/dist/cli.mjs'
if (Get-Command bun -ErrorAction SilentlyContinue) {
    & bun run $Measure
} elseif ((Get-Command node -ErrorAction SilentlyContinue) -and (Test-Path $TsxEntry)) {
    & node $TsxEntry $Measure
} else {
    throw 'measure-prompts requires bun, or node with repo-local tsx (run: bun install)'
}
if ($LASTEXITCODE -ne 0) { throw 'prompt budget gate failed — slim the prompts before releasing' }

# --- historical manifest immutability gate --------------------------------
# Manifests are per-version historical records: manifest generation MUST only ever
# (re)write the CURRENT version's file. Any modification or deletion of a
# previously committed manifest means generate was run against a stale
# version.json — restore the file from git before releasing.
# Legitimate exceptions: deleting manifests below `minVersion` and rewriting
# history.manifest.txt — that is the intended compaction flow.

if (Get-Command git -ErrorAction SilentlyContinue) {
    git -C $RepoRoot rev-parse --git-dir *> $null
    if ($LASTEXITCODE -eq 0) {
        $touched = git -C $RepoRoot diff --name-only HEAD -- install/versions/ 2>$null
        $deleted = git -C $RepoRoot ls-files --deleted -- install/versions/ 2>$null
        # The current version's manifest is the release in progress — it may
        # legitimately differ from HEAD (or be untracked). Historical ones may not.
        $curRel = "install/versions/$ver.manifest.txt"
        $legalCompaction = {
            param($p)
            $norm = $p -replace '\\', '/'
            if ($norm -eq 'install/versions/history.manifest.txt') { return $true }
            if ($minVer -and $norm -match '^install/versions/(\d+(?:\.\d+)+)\.manifest\.txt$') {
                return (Compare-VersionLt $matches[1] $minVer)
            }
            return $false
        }
        $violations = @($touched) + @($deleted) | Where-Object {
            $_ -and ($_ -replace '\\', '/') -ne $curRel -and (-not (& $legalCompaction $_))
        }
        if ($violations) {
            foreach ($v in $violations) { Write-Host "  IMMUTABILITY VIOLATION: $v" }
            throw 'historical manifest(s) modified relative to HEAD - restore with `git show HEAD:<file> > <file>` and re-run generate only after bumping version.json'
        }
        Write-Host 'historical manifests: immutable (OK)'
    }
}

$manifest = Get-Content $manifestPath |
    Where-Object { $_ -and $_ -notmatch '^\s*#' } |
    ForEach-Object { $_.Trim() -replace '\\', '/' } |
    Where-Object { $_ -ne '' }

# Dynamically mirror companion directories (install/, bin/, package.json)
$installFiles = @(Get-ChildItem -Path (Join-Path $RepoRoot 'install') -Recurse -File |
    Where-Object { $_.FullName -notmatch '[\/\\](node_modules|\.git|tests|\.tmp)[\/\\]' } |
    ForEach-Object { "install/" + $_.FullName.Substring((Join-Path $RepoRoot 'install').Length + 1).Replace('\', '/') })

$binFiles = @(Get-ChildItem -Path (Join-Path $RepoRoot 'bin') -Recurse -File |
    ForEach-Object { "bin/" + $_.FullName.Substring((Join-Path $RepoRoot 'bin').Length + 1).Replace('\', '/') } |
    # Filter on the bin-relative path — the absolute path may legitimately
    # contain dot-segments (e.g. a checkout under ~\.local\...) that would
    # wrongly exclude every file.
    Where-Object { $_ -notmatch '[\/\\]\.' })

$pkgJson = if (Test-Path (Join-Path $RepoRoot 'package.json')) { @('package.json') } else { @() }

$expected = ($manifest + $installFiles + $binFiles + $pkgJson) | Sort-Object -Unique

$Work = Join-Path $DistDir '.verify-tmp'
if (Test-Path $Work) { Remove-Item $Work -Recurse -Force }
New-Item -ItemType Directory -Path $Work | Out-Null

$failures = 0

# --force-local keeps Windows absolute paths (D:\...) from being parsed as
# GNU tar remote-host syntax; bsdtar (Windows 10+ system32) rejects the flag,
# so probe for support instead of hard-coding it.
$tarCompat = @()
if ((& tar --help 2>&1 | Out-String) -match 'force-local') { $tarCompat += '--force-local' }

function Verify-Archive([string]$archive, [string]$extractDir) {
    $script:failures += 0
    if (-not (Test-Path $archive)) {
        Write-Host ("=== {0} === NOT FOUND" -f (Split-Path $archive -Leaf))
        $script:failures += 1
        return
    }
    if ($archive -match '\.zip$') {
        Expand-Archive -Path $archive -DestinationPath $extractDir -Force
    } else {
        New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
        tar @tarCompat -xzf $archive -C $extractDir
        if ($LASTEXITCODE -ne 0) { throw "failed to extract $archive" }
    }

    # package root is the single top-level directory inside the archive
    $top = Get-ChildItem $extractDir
    $pkgRoot = if ($top.Count -eq 1 -and $top.PSIsContainer) { $top.FullName } else { $extractDir }

    $actual = Get-ChildItem -Path $pkgRoot -Recurse -File -Force | ForEach-Object {
        $_.FullName.Substring($pkgRoot.Length).TrimStart('\', '/') -replace '\\', '/'
    } | Sort-Object -Unique

    $missing = $expected | Where-Object { $_ -notin $actual }
    $extra = $actual | Where-Object { $_ -notin $expected }

    Write-Host ("=== {0} ===" -f (Split-Path $archive -Leaf))
    Write-Host ("expected: {0}, actual: {1}" -f $expected.Count, $actual.Count)
    foreach ($m in $missing) { Write-Host ("  MISSING: {0}" -f $m); $script:failures++ }
    foreach ($x in $extra) { Write-Host ("  UNEXPECTED: {0}" -f $x); $script:failures++ }
    if (-not $missing -and -not $extra) { Write-Host "file list: OK" }

    # content integrity: hash every manifest file against the repo source
    $diffs = 0
    foreach ($rel in $manifest) {
        $src = Join-Path $RepoRoot ($rel -replace '/', '\')
        $dst = Join-Path $pkgRoot ($rel -replace '/', '\')
        if (-not (Test-Path $dst)) { continue } # already reported as missing
        $h1 = (Get-FileHash $src -Algorithm SHA256).Hash
        $h2 = (Get-FileHash $dst -Algorithm SHA256).Hash
        if ($h1 -ne $h2) { Write-Host ("  CONTENT DIFF: {0}" -f $rel); $diffs++; $script:failures++ }
    }
    if ($diffs -eq 0) { Write-Host ("content integrity: OK ({0} files)" -f $manifest.Count) }
    Write-Host ''
}

try {
    Verify-Archive (Join-Path $DistDir "opencode-prime-$ver.zip") (Join-Path $Work 'prime-zip')
    Verify-Archive (Join-Path $DistDir "opencode-prime-$ver.tar.gz") (Join-Path $Work 'prime-tgz')
} finally {
    Remove-Item $Work -Recurse -Force
}

if ($failures -gt 0) {
    Write-Host "verify: FAILED ($failures problem(s))" -ForegroundColor Red
    exit 1
}
Write-Host "verify: OK (version $ver)" -ForegroundColor Green
