#requires -Version 5.1
<#
.SYNOPSIS
    bin/opencode-prime.ps1 — global dispatcher for the OpenCode Prime (OCP) repo.

.DESCRIPTION
    Mirrors bin/opencode-prime (bash). Lives in the repo. The global shim at
    ~/.local/bin/opencode-prime.ps1 re-execs this file (created by
    install.ps1's `Register` mode).

    Subcommands:
      install         Open the interactive TUI wizard (dashboard first; matches
                      the help text "(default) Interactive setup wizard").
                      Pass -f / --force / -Force to skip the wizard and run the
                      headless install (force-reapply even when version unchanged)
      update          Check the suite + companion tools (opencode, openchamber) for
                      updates and apply the selected ones in an interactive TTY
                      (-y = apply all without prompting; --check-only = read-only)
      upgrade         Download the latest release tarball, overlay it onto the
                      repo directory, and re-apply the installer (works the
                      same whether you installed via `git clone` or not)
      init            Backup + clear the target for a fresh start
      uninstall       Remove the installed version's manifest files from the target
      status          Show installed vs repo version
      register        Install global shims (opencode-prime, ocp) into ~/.local/bin
      unregister      Remove global shims from ~/.local/bin
      tui             Launch the OpenCode terminal UI (exec opencode).
                      Add --herdr / --luvus / --direct to override tui_mode config for
                     this invocation (forces routing through the TS engine)
                      Add --init to create/activate the OCP project in the
                      current directory before launching
      serve           Launch the headless opencode server (opencode serve; all args pass through)
      web             Launch the OpenChamber web UI (openchamber serve; all extra args pass through,
                      auto-picks a free port starting at 3000 unless --port is given)
      code            Open VS Code and ensure the OpenChamber editor extension is installed
                      (installs `fedaykindev.openchamber` when missing; also probes code-insiders /
                      codium / cursor / windsurf CLIs). --init scaffolds the OCP project first
      desktop | ui    Launch the OpenChamber native desktop app
      session clean   Delete old sessions via `opencode session delete`
      auth open       Open OpenCode's auth.json in the default editor (creates it if missing)
      version         Print the repo's current version
      help            Print this help

    No arguments = launch the OpenCode terminal UI directly (same as `tui --direct`).

.EXAMPLE
    pwsh ./bin/opencode-prime.ps1 install
    pwsh ./bin/opencode-prime.ps1 status
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Subcommand,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)

$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir '..')).Path
$Install = Join-Path $RepoRoot 'install/install.ps1'

function Get-HelpText {
    $in = $false
    foreach ($ln in (Get-Content -LiteralPath $PSCommandPath)) {
        $trim = $ln.TrimStart()
        if ($in) {
            if ($trim -eq '#>') { return }
            if ($trim -match '^\.[A-Z]') { continue }
            $ln
        } else {
            if ($trim -eq '<#') { $in = $true }
        }
    }
}

function Get-ConfigTuiMode {
    # Read tui_mode from options.jsonc without a JSON parser (the files are
    # JSONC with comments). Mirrors loadEffectiveOptions(): repo defaults
    # first, the user's target options.jsonc wins. Returns a supported mode —
    # the colon-anchored regex can't false-match prose comments.
    $mode = 'direct'
    $configDir = if ($env:OPENCODE_CONFIG_DIR) { $env:OPENCODE_CONFIG_DIR } else { Join-Path $HOME '.config/opencode' }
    foreach ($p in @((Join-Path $RepoRoot 'install/options.jsonc'), (Join-Path $configDir 'options.jsonc'))) {
        if (-not (Test-Path -LiteralPath $p)) { continue }
        $raw = Get-Content -Raw -LiteralPath $p
        if ($raw -match '"tui_mode"\s*:\s*"herdr"') { $mode = 'herdr' }
        elseif ($raw -match '"tui_mode"\s*:\s*"luvus"') { $mode = 'luvus' }
        elseif ($raw -match '"tui_mode"\s*:\s*"direct"') { $mode = 'direct' }
    }
    return $mode
}

if ([string]::IsNullOrWhiteSpace($Subcommand)) {
    $Subcommand = 'tui'
    $Rest = @('--direct')
}

function Find-OpenChamberDesktop {
    # The native desktop app (Tauri) is not registered on PATH — probe the
    # common per-user / system install locations for an OpenChamber dir and
    # return the first launcher exe inside it.
    $roots = @()
    if ($env:LOCALAPPDATA) {
        $roots += (Join-Path $env:LOCALAPPDATA 'Programs')
        $roots += $env:LOCALAPPDATA
    }
    if ($env:ProgramFiles) { $roots += $env:ProgramFiles }
    if (${env:ProgramFiles(x86)}) { $roots += ${env:ProgramFiles(x86)} }
    foreach ($root in $roots) {
        $dirs = @(Get-ChildItem -LiteralPath $root -Directory -Filter '*OpenChamber*' -ErrorAction SilentlyContinue)
        foreach ($dir in $dirs) {
            $exe = Get-ChildItem -LiteralPath $dir.FullName -Filter '*.exe' -Recurse -Depth 2 -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -notmatch '^unins' } |
                Select-Object -First 1
            if ($exe) { return $exe.FullName }
        }
    }
    return $null
}

function Get-WebPort([string[]]$cliArgs) {
    for ($i = 0; $i -lt $cliArgs.Count; $i++) {
        if ($cliArgs[$i] -in @('--port', '-p') -and $i + 1 -lt $cliArgs.Count -and $cliArgs[$i + 1] -match '^\d+$') {
            return [int]$cliArgs[$i + 1]
        }
        if ($cliArgs[$i] -match '^--port=(\d+)$') { return [int]$Matches[1] }
    }
    return $null
}

function Test-PortBusy([int]$port) {
    $null -ne (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

# First free port at or above the base — the `--port 0` (random) resolver
# and the fallback for ports that could not be reclaimed.
function Get-FreeWebPort([int]$base = 3000) {
    for ($p = $base; $p -lt $base + 200; $p++) {
        if (-not (Test-PortBusy $p)) { return $p }
    }
    return -1
}

# Drop any port selector (--port N / -p N / --port=N) before re-injecting one.
function Remove-WebPortArgs([string[]]$cliArgs) {
    $out = [System.Collections.Generic.List[string]]::new()
    for ($i = 0; $i -lt $cliArgs.Count; $i++) {
        if ($cliArgs[$i] -in @('--port', '-p')) {
            if ($i + 1 -lt $cliArgs.Count -and $cliArgs[$i + 1] -match '^\d+$') { $i++ }
            continue
        }
        if ($cliArgs[$i] -match '^--port=\d+$') { continue }
        $out.Add($cliArgs[$i])
    }
    return ,@($out)
}

function Wait-PortFree([int]$port, [int]$seconds = 5) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-PortBusy $port)) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return -not (Test-PortBusy $port)
}

# A zombie daemon can keep its listen socket even after `openchamber stop`
# (pid file gone, HTTP shutdown unresponsive). Force-kill the listener — but
# ONLY when its command line proves it is an OpenChamber process.
function Stop-OpenChamberOrphan([int]$port) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $conn) { return $true }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($conn.OwningProcess)" -ErrorAction SilentlyContinue
    if (-not $proc -or $proc.CommandLine -notmatch 'openchamber') { return $false }
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    return (Wait-PortFree $port 5)
}

switch ($Subcommand.ToLowerInvariant()) {
    { $_ -in @('-h', '--help', 'help') } {
        Get-HelpText
        break
    }
    'install' {
        # Without -f/--force: open the interactive wizard (dashboard first).
        # With -f/--force: skip the wizard, run the headless install.
        # Matches the help text "(default) Interactive setup wizard (in TTY)
        # or install (in non-interactive)" and the user mental model that -f
        # means headless.
        $hasForce = $false
        foreach ($a in $Rest) {
            if ($a -in @('-f', '--force', '-Force')) { $hasForce = $true; break }
        }
        if ($hasForce) {
            & $Install install @Rest
        } else {
            & $Install wizard @Rest
        }
        break
    }
    'update' {
        & $Install update @Rest
        break
    }
    'upgrade' {
        & $Install upgrade @Rest
        break
    }
    'init' {
        & $Install init @Rest
        break
    }
    'uninstall' {
        & $Install uninstall @Rest
        break
    }
    'status' {
        & $Install status @Rest
        break
    }
    { $_ -in @('provider', 'profile') } {
        & $Install $Subcommand @Rest
        exit $LASTEXITCODE
    }
    'register' {
        & $Install register @Rest
        break
    }
    'unregister' {
        & $Install unregister @Rest
        break
    }
    'tui' {
        # Init semantics live in ONE place: the TS engine's tui branch
        # (normalizeTuiPassthrough → headless project init → launcher).
        # ONLY an explicit --init initializes; delegate the whole invocation
        # when it is present so init + mode resolution stay in the engine.
        # A bare `.` is a no-op (stripped engine-side too) — but it must not
        # reach the direct `opencode` fast path below, so drop it here.
        if ($Rest -contains '--init') {
            & $Install tui @Rest
            exit $LASTEXITCODE
        }
        $Rest = @($Rest | Where-Object { $_ -ne '.' })

        # Explicit mode flags override `tui_mode` from options.jsonc. When
        # either is present, hand off to the TS engine so it can decide
        # which launcher to run. Workspace modes route to the TS engine; an
        # unavailable provider falls back to the direct opencode fast path.
        if (($Rest -contains '--herdr') -or ($Rest -contains '--luvus') -or ($Rest -contains '--direct')) {
            & $Install tui @Rest
            exit $LASTEXITCODE
        }
        if ((Get-ConfigTuiMode) -eq 'herdr') {
            if (Get-Command herdr -ErrorAction SilentlyContinue) {
                & $Install tui @Rest
                exit $LASTEXITCODE
            }
            Write-Host '[ocp] tui_mode=herdr, but herdr was not found on PATH — falling back to direct opencode.' -ForegroundColor Yellow
        }
        if ((Get-ConfigTuiMode) -eq 'luvus') {
            if (Get-Command luvus -ErrorAction SilentlyContinue) {
                & $Install tui @Rest
                exit $LASTEXITCODE
            }
            Write-Host '[ocp] tui_mode=luvus, but luvus was not found on PATH — falling back to direct opencode.' -ForegroundColor Yellow
        }
        if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) {
            Write-Host '✗ opencode was not found on PATH.' -ForegroundColor Red
            Write-Host '  Install OpenCode first: https://opencode.ai (or re-run `ocp install`).'
            exit 1
        }
        & opencode @Rest
        exit $LASTEXITCODE
    }
    'serve' {
        if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) {
            Write-Host '✗ opencode was not found on PATH.' -ForegroundColor Red
            Write-Host '  Install OpenCode first: https://opencode.ai (or re-run `ocp install`).'
            exit 1
        }
        # Headless opencode server — pure passthrough; opencode's own
        # --port defaults to 0 (auto-assigned random port).
        & opencode serve @Rest
        exit $LASTEXITCODE
    }
    'web' {
        if (-not (Get-Command openchamber -ErrorAction SilentlyContinue)) {
            Write-Host '✗ openchamber was not found on PATH.' -ForegroundColor Red
            Write-Host '  Install OpenChamber first: npm install -g @openchamber/web'
            Write-Host '  or download the native app from https://openchamber.dev/download'
            exit 1
        }
        # `openchamber status --quiet` prints a `port <n> ...` line per
        # running instance and the single word `stopped` when idle. If
        # anything is up, stop it first — a fresh --ui-password launch
        # would fail on the occupied port and leak a useless password.
        $statusOut = ''
        try { $statusOut = (& openchamber status --quiet 2>&1 | Out-String) } catch {}
        if ($statusOut -match '(?im)^port \d+') {
            Write-Host '  OpenChamber instance(s) already running — stopping for a fresh web session:'
            Write-Host ($statusOut.Trim() -replace '(?m)^', '    ')
            try { & openchamber stop 2>&1 | Out-Null } catch {}
        }
        # Port policy: an explicit --port passes through as-is (we only try
        # to reclaim it from zombie daemons); without one, pick the first
        # free port starting at 3000 so stale listeners never block startup.
        $port = Get-WebPort $Rest
        if ($null -eq $port -or $port -eq 0) {
            $port = Get-FreeWebPort
            if ($port -lt 0) {
                Write-Host '✗ No free port found in range 3000-3199.' -ForegroundColor Red
                exit 1
            }
            Write-Host "  Using free port $port"
            $Rest = (Remove-WebPortArgs $Rest) + @('--port', "$port")
        } elseif (Test-PortBusy $port) {
            # Zombie / orphan daemons keep holding the port even after stop
            # (pid file gone, HTTP shutdown unresponsive) — reclaim it
            # before launching, or the fresh daemon dies with EADDRINUSE.
            Write-Host "  Port $port is still occupied — reclaiming it for the new session..."
            try { & openchamber stop --port $port 2>&1 | Out-Null } catch {}
            if (-not (Wait-PortFree $port 5) -and -not (Stop-OpenChamberOrphan $port)) {
                $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
                Write-Host "✗ Port $port is still occupied (PID: $($conn.OwningProcess)) and could not be reclaimed." -ForegroundColor Red
                Write-Host "  Kill the listener manually (taskkill /PID $($conn.OwningProcess) /F) or let OCP pick a free port: ocp web (no --port)"
                exit 1
            }
        }
        # Web mode: protect browser access with a UI password unless the
        # caller already supplied one (official quick-start pattern).
        # All remaining args pass straight through to openchamber serve.
        if ($Rest -contains '--ui-password') {
            & openchamber serve @Rest
            exit $LASTEXITCODE
        }
        $pw = -join (1..24 | ForEach-Object { 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[(Get-Random -Maximum 62)] })
        Write-Host "🔑 OpenChamber web UI password: $pw"
        & openchamber serve --ui-password $pw @Rest
        exit $LASTEXITCODE
    }
    'code' {
        # Open VS Code (or the first of code-insiders/codium/cursor/windsurf
        # found) with the OpenChamber editor extension guaranteed — the TS
        # engine checks `--list-extensions` and installs
        # `fedaykindev.openchamber` when missing before launching.
        # `--init` scaffolds/activates the OCP project first; `.` passes
        # through so VS Code opens the current folder.
        & $Install code @Rest
        exit $LASTEXITCODE
    }
    { $_ -in @('desktop', 'ui') } {
        # ONLY an explicit --init triggers project init/registration — it
        # passes through verbatim (the TS launchDesktop reads it). A bare
        # `.` is no longer an init alias — drop it.
        $Rest = @($Rest | Where-Object { $_ -ne '.' })
        & $Install desktop @Rest
        exit $LASTEXITCODE
    }
    'session' {
        & $Install session @Rest
        exit $LASTEXITCODE
    }
    { $_ -in @('version', '--version', '-v') } {
        $versionJson = Join-Path $RepoRoot 'install/version.json'
        if (Test-Path $versionJson) {
            ((Get-Content $versionJson -Raw) | ConvertFrom-Json).version
        } else {
            Get-Content (Join-Path $RepoRoot 'install/VERSION')
        }
        break
    }
    default {
        & $Install $Subcommand @Rest
        break
    }
}
