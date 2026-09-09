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
        Write-Host "`n🚀 Installing OpenCode CLI via official installer..." -ForegroundColor Cyan
        try {
            Invoke-Expression (Invoke-RestMethod "https://opencode.ai/install.ps1")
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "Machine")
            Write-Host "✔ OpenCode CLI installed successfully!`n" -ForegroundColor Green
        }
        catch {
            Write-Host "⚠️ Automatic installation encountered an issue. You can install it manually from https://opencode.ai" -ForegroundColor Yellow
        }
    }
    else {
        Write-Host "ℹ️ Skipping OpenCode CLI installation. You can install it later from https://opencode.ai`n" -ForegroundColor DarkGray
    }
}

# 1. In a git/dev checkout, prefer source whenever TypeScript/plugin files are
# newer than the bundled engine; otherwise a stale ignored install/dist/index.js
# can hide fixes. Release installs still use the bundle for instant startup.
$BundledFile = Join-Path $ScriptDir 'dist/index.js'
$SrcFile = Join-Path $ScriptDir 'src/index.ts'
$sourceRoots = @((Join-Path $RepoRoot 'install/src'), (Join-Path $RepoRoot 'plugins')) | Where-Object { Test-Path $_ }
$newestSource = $null
if ($sourceRoots.Count -gt 0) {
    $newestSource = Get-ChildItem -Path $sourceRoots -Recurse -File -Include *.ts, *.tsx -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
}
$useSource = (Test-Path $SrcFile) -and ((-not (Test-Path $BundledFile)) -or ($newestSource -and $newestSource.LastWriteTimeUtc -gt (Get-Item $BundledFile).LastWriteTimeUtc))

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
