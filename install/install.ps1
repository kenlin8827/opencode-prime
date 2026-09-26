#requires -Version 5.1
<#
.SYNOPSIS
    Lightweight bootstrap launcher for OpenCode Prime installer.
#>

$ScriptDir = $PSScriptRoot
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir '..')).Path
$EntryFile = Join-Path $ScriptDir 'src/index.ts'

function Find-WorkingBun {
    # `Get-Command bun` can return a stale first PATH entry after a Windows
    # Bun upgrade. Prefer the first executable that actually exists, including
    # the current user's standard Bun install location.
    $candidates = @()
    if ($env:BUN_INSTALL) { $candidates += (Join-Path $env:BUN_INSTALL 'bin\bun.exe') }
    $candidates += (Join-Path $HOME '.bun\bin\bun.exe')
    foreach ($command in @(Get-Command bun -All -ErrorAction SilentlyContinue)) {
        if ($command.Path) { $candidates += $command.Path }
    }
    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

function Invoke-RemoteInstaller {
    param([string]$Url)
    # PS 5.1 on old .NET may default below TLS 1.2; bun.sh/opencode.ai reject it.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    # ScriptBlock child scope on purpose: these vendors' scripts contain
    # top-level `return` and set `$ErrorActionPreference` — iex in our scope
    # would abort the OCP installer and leak the preference change.
    & ([scriptblock]::Create((Invoke-RestMethod $Url)))
}

function Update-SessionPath {
    # Machine first (standard precedence), drop empties — a leading '' in PATH
    # resolves to the current directory.
    $parts = @([System.Environment]::GetEnvironmentVariable('Path', 'Machine'),
               [System.Environment]::GetEnvironmentVariable('Path', 'User')) |
        Where-Object { $_ }
    $env:Path = $parts -join ';'
}

$BunExe = Find-WorkingBun
$isInfoCmd = $args -contains "status" -or $args -contains "version" -or $args -contains "--help" -or $args -contains "-h" -or $args -contains "help" -or $args -contains "unregister" -or $args -contains "session" -or $args -contains "auth" -or $args -contains "desktop" -or $args -contains "code" -or $args -contains "project" -or $args -contains "provider"

# 0. Check for OpenCode CLI and offer automated install if missing (only for installation workflows)
if (-not $isInfoCmd -and -not (Get-Command opencode -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Yellow
    Write-Host "  ⚠️  OpenCode CLI was not found in your PATH"                -ForegroundColor Yellow
    Write-Host "============================================================" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "OpenCode is required to run agents, commands, and workflows."
    
    $installOpencode = $false
    if ($args -contains "-Yes" -or $args -contains "--yes" -or $args -contains "-y") {
        $installOpencode = $true
    }
    elseif ([Environment]::UserInteractive) {
        $choice = Read-Host "Would you like to install OpenCode CLI automatically now? [Y/n]"
        if ([string]::IsNullOrWhiteSpace($choice) -or $choice.Trim().ToLower() -eq 'y' -or $choice.Trim().ToLower() -eq 'yes') {
            $installOpencode = $true
        }
    }
    
    if ($installOpencode) {
        # OCP v2 requires the opencode v2 runtime (V2 config/plugin contract).
        # The pinned installer resolves the newest v2 release and upgrades a
        # v1 binary in the user profile; a v3+ binary is refused. (The
        # official install.ps1 endpoint is HTTP 404, so there is no official
        # script to delegate to — the asset is downloaded directly.)
        # Runs in a CHILD PowerShell process on purpose: the tool script
        # uses `exit <code>` (0 = installed/upgraded, 2 = present but managed
        # outside ocp, else failure), and in-process invocation would let
        # that exit terminate this installer instead of landing in $LASTEXITCODE.
        Write-Host "`n🚀 Installing OpenCode CLI (pinned to major v2)..." -ForegroundColor Cyan
        try {
            $toolScript = Join-Path $ScriptDir 'scripts/tools/opencode.ps1'
            $psBin = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell.exe' }
            & $psBin -NoProfile -ExecutionPolicy Bypass -File $toolScript
            if ($LASTEXITCODE -eq 0) {
                Update-SessionPath
                Write-Host "✔ OpenCode CLI installed successfully!`n" -ForegroundColor Green
            }
            elseif ($LASTEXITCODE -eq 2) {
                Update-SessionPath
                Write-Host "✔ OpenCode CLI already present (managed outside ocp).`n" -ForegroundColor Green
            }
            else {
                throw "opencode v2 installer exited with code $LASTEXITCODE"
            }
        }
        catch {
            Write-Host "⚠️ Automatic installation encountered an issue. Install the newest opencode v2 manually from https://github.com/anomalyco/opencode/releases (v1 cannot load OCP v2)" -ForegroundColor Yellow
        }
    }
    else {
        Write-Host "ℹ️ Skipping OpenCode CLI installation. You can install it later from https://opencode.ai`n" -ForegroundColor DarkGray
    }
}

# 0b. A v3+ opencode on PATH is refused outright: OCP v2 pins the v2 runtime
# contract and cannot promise v3 compatibility. A v1 binary is NOT refused
# here — it is the upgrade target of the pinned installer above (and of the
# TS installer's provisionTools phase). Never auto-downgrade a user's binary.
if (-not $isInfoCmd -and (Get-Command opencode -ErrorAction SilentlyContinue)) {
    $ocpVer = try { ((& opencode --version 2>$null) | Select-String -Pattern '\d+\.\d+\.\d+' | Select-Object -First 1).Matches.Value } catch { '' }
    $ocpMajor = if ($ocpVer -match '^(\d+)\.') { [int]$Matches[1] } else { 0 }
    if ($ocpMajor -gt 2) {
        Write-Host ""
        Write-Host "============================================================" -ForegroundColor Yellow
        Write-Host "  ⚠️  opencode v$ocpVer detected — OCP v2 requires opencode v2.x" -ForegroundColor Yellow
        Write-Host "============================================================" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "OpenCode Prime v2 targets the opencode v2 runtime contract and cannot run on v$ocpMajor."
        Write-Host "Install the newest opencode v2 from https://github.com/anomalyco/opencode/releases (or run ocp update), then re-run."
        Write-Host ""
    }
}

# 0.5 Check for Bun runtime and offer automated install if missing — the
# interactive TUI (ocp dashboard / wizard) can only be hosted by Bun.
if (-not $isInfoCmd -and -not $BunExe) {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Yellow
    Write-Host "  ⚠️  Bun runtime was not found in your PATH"                 -ForegroundColor Yellow
    Write-Host "============================================================" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Bun hosts the interactive TUI (ocp dashboard / wizard). Everything else also works with Node.js."

    $installBun = $false
    if ($args -contains "-Yes" -or $args -contains "--yes" -or $args -contains "-y") {
        $installBun = $true
    }
    elseif ([Environment]::UserInteractive) {
        $choice = Read-Host "Would you like to install Bun automatically now? [Y/n]"
        if ([string]::IsNullOrWhiteSpace($choice) -or $choice.Trim().ToLower() -eq 'y' -or $choice.Trim().ToLower() -eq 'yes') {
            $installBun = $true
        }
    }

    if ($installBun) {
        Write-Host "`n🚀 Installing Bun via official installer..." -ForegroundColor Cyan
        try {
            Invoke-RemoteInstaller "https://bun.sh/install.ps1"
            Update-SessionPath
            $BunExe = Find-WorkingBun
        }
        catch {
            $BunExe = $null
            Write-Host "⚠️ Automatic installation encountered an issue: $($_.Exception.Message)" -ForegroundColor Yellow
        }
        if ($BunExe) {
            Write-Host "✔ Bun installed successfully!`n" -ForegroundColor Green
        }
        else {
            Write-Host "⚠️ Automatic installation encountered an issue. Install Bun manually: powershell -c `"irm bun.sh/install.ps1 | iex`"" -ForegroundColor Yellow
        }
    }
    else {
        Write-Host "ℹ️ Skipping Bun installation. The TUI dashboard/wizard will stay unavailable; run this installer again to install it later.`n" -ForegroundColor DarkGray
    }
}

# 1. In a git/dev checkout, prefer source whenever TypeScript/plugin files are
# newer than the bundled engine; otherwise a stale ignored install/dist/index.js
# can hide fixes. Release installs still use the bundle for instant startup.
$BundledFile = Join-Path $ScriptDir 'dist/index.js'
$SrcFile = Join-Path $ScriptDir 'src/index.ts'
$isDevCheckout = Test-Path -LiteralPath (Join-Path $RepoRoot '.git')
$sourceRoots = if ($isDevCheckout) { @((Join-Path $RepoRoot 'install/src'), (Join-Path $RepoRoot 'plugins')) | Where-Object { Test-Path $_ } } else { @() }
$newestSource = $null
if ($sourceRoots.Count -gt 0) {
    $newestSource = Get-ChildItem -Path $sourceRoots -Recurse -File -Include *.ts, *.tsx -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
}
$useSource = $isDevCheckout -and (Test-Path $SrcFile) -and ((-not (Test-Path $BundledFile)) -or ($newestSource -and $newestSource.LastWriteTimeUtc -gt (Get-Item $BundledFile).LastWriteTimeUtc))

if ($useSource -and $BunExe) {
    & $BunExe run "$SrcFile" @args
    exit $LASTEXITCODE
}

if ($useSource -and (Get-Command node -ErrorAction SilentlyContinue)) {
    $NodeModules = Join-Path $RepoRoot 'node_modules'
    if (-not (Test-Path $NodeModules)) {
        Write-Host "Installing installer dependencies via npm..." -ForegroundColor Cyan
        & npm install --prefix "$RepoRoot"
    }
    & npx --prefix "$RepoRoot" tsx "$SrcFile" @args
    exit $LASTEXITCODE
}

if (Test-Path $BundledFile) {
    if ($BunExe) {
        & $BunExe "$BundledFile" @args
        exit $LASTEXITCODE
    }
    if (Get-Command node -ErrorAction SilentlyContinue) {
        & node "$BundledFile" @args
        exit $LASTEXITCODE
    }
}

# 2. Try Bun with source files
if ($BunExe) {
    & $BunExe run "$SrcFile" @args
    exit $LASTEXITCODE
}

# 3. Try Node.js + tsx
if (Get-Command node -ErrorAction SilentlyContinue) {
    # Ensure dependencies installed if node_modules is missing
    $NodeModules = Join-Path $RepoRoot 'node_modules'
    if (-not (Test-Path $NodeModules)) {
        Write-Host "Installing installer dependencies via npm..." -ForegroundColor Cyan
        & npm install --prefix "$RepoRoot"
    }
    & npx --prefix "$RepoRoot" tsx "$SrcFile" @args
    exit $LASTEXITCODE
}

# 3. Neither found — print friendly instructions
Write-Host ""
Write-Host "============================================================" -ForegroundColor Yellow
Write-Host "  Runtime Missing: Bun or Node.js is required to install"     -ForegroundColor Yellow
Write-Host "============================================================" -ForegroundColor Yellow
Write-Host ""
Write-Host "Please install Bun (recommended) or Node.js:"
Write-Host "  • Bun: powershell -c `"irm bun.sh/install.ps1 | iex`""
Write-Host "  • Node: https://nodejs.org/"
Write-Host ""
exit 1
