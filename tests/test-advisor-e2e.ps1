# Auto-advisor-mode end-to-end tests — v2 runtime surfaces.
# Drives real `opencode run` invocations against an isolated fixture project
# and verifies:
#   1. /auto-advisor lite|full|off upserts `autoAdvisorMode` in the project
#      .ocp/ocp.json and logs the v2 command-handler line
#   2. the v2 `context` hook injects the mode marker (injection log line)
#   3. invalid or missing arguments are a no-op (state unchanged)
#   4. the state persists across separate opencode run invocations
#   5. off/lite modes do NOT fire the tool guard for a manual @advisor prompt
#
# V2 SURFACES (what v1 drift fixed here):
#   • Mode storage moved: project opencode.jsonc → project `.ocp/ocp.json`
#     (plugins/auto-advisor/auto-advisor-config.ts — single runtime source,
#     ADR-0004; setProjectDir pins it to ctx.location.directory).
#   • Handler log:   [ocp:auto-advisor-mode][info] mode=… — project .ocp/ocp.json written
#   • Injection log: [ocp:auto-advisor-mode][info] system prompt: mode=… injected
#     (v1 "system.transform injected" hook-name assertion is gone — v2 maps
#     it to ctx.session.hook("context"), plugins/auto-advisor/auto-advisor-system-inject.ts).
#   • Announce:      [ocp:notify][…] [auto-advisor] Mode: …  (v1 toast → v2
#     server-log line, OCP-V2-GAP, plugins/shared/notify.ts).
#
# HARNESS (pattern: tests/helpers/v2-runtime.ts locate/skip):
#   runtime = OCP_TEST_OPENCODE_BIN → .ocp/sandbox source-run (bun.exe + v2src,
#   see .ocp/sandbox/WORKING-EXAMPLE/README.md) → PATH opencode; anything below
#   the 2.0.0 floor is rejected; nothing found → [SKIP] exit 0 (CI-friendly).
#   The fixture project hosts the plugin via `.opencode/plugins` auto-discovery
#   (wrapper re-export — FORM C) and gets its model from
#   tests/helpers/echo-model-server.ts (deterministic, NO credentials). The
#   context hook fires at request assembly, before any provider transport
#   (WORKING-EXAMPLE §5), so injection is observable through the echo model.
#   N8a's config-fixture lifecycle (create-if-missing + never mutate the repo)
#   carries over: the v2 storage target is fixture-local, so the repo root is
#   never touched at all; the whole fixture tree is removed at exit.
#   Caveat: fully exercising full-mode auto-answer (and the @advisor dispatch
#   itself) needs a real model — sections 5 assert the guard's ABSENCE, which
#   the echo fixture proves for the off/lite code paths.
foreach ($ocGateTrap in @("ORCA_OPENCODE_CONFIG_DIR", "ORCA_AGENT_HOOK_ENDPOINT", "ORCA_AGENT_HOOK_TOKEN", "OPENCODE", "OPENCODE_PID", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_PASSWORD")) { Remove-Item "Env:$ocGateTrap" -ErrorAction SilentlyContinue }
$repoRoot = (Resolve-Path "$PSScriptRoot\..").Path

function Get-VersionMajor([string]$command, [string[]]$preArgs) {
    $raw = try { (& $command @preArgs "--version" 2>&1) -join " " } catch { "" }
    if ($raw -match '(\d+)\.\d+') { return [int]$Matches[1] }
    return $null
}

# ── Runtime locate (v2-runtime.ts pattern) ───────────────────────────
$script:Bun = $null
$sandboxBun = Join-Path $repoRoot ".ocp\sandbox\bun-windows-x64\bun.exe"
$sandboxCli = Join-Path $repoRoot ".ocp\sandbox\v2src\packages\cli"
if (Get-Command bun -ErrorAction SilentlyContinue) { $script:Bun = (Get-Command bun).Source }
if (Test-Path $sandboxBun) { $script:Bun = $sandboxBun }

$runtime = $null   # @{ Kind = "source-run"|"binary"; Command; Prefix }
if ($env:OCP_TEST_OPENCODE_BIN) {
    $major = Get-VersionMajor $env:OCP_TEST_OPENCODE_BIN @()
    if ($null -eq $major) { Write-Host "[SKIP] OCP_TEST_OPENCODE_BIN version unparseable" -ForegroundColor Yellow; exit 0 }
    if ($major -lt 2) { Write-Host "[SKIP] pinned opencode is below the 2.0.0 runtime floor" -ForegroundColor Yellow; exit 0 }
    $runtime = @{ Kind = "binary"; Command = $env:OCP_TEST_OPENCODE_BIN }
}
if (-not $runtime -and $script:Bun -and (Test-Path (Join-Path $sandboxCli "src\index.ts"))) {
    $major = Get-VersionMajor $script:Bun @("run", "--cwd", $sandboxCli, "src/index.ts")
    if ($major -ge 2) {
        $runtime = @{ Kind = "source-run"; Command = $script:Bun }
    } elseif ($null -ne $major) {
        Write-Host "[SKIP] sandbox source-run reports version below 2.0.0" -ForegroundColor Yellow; exit 0
    }
}
if (-not $runtime) {
    $onPath = Get-Command opencode -ErrorAction SilentlyContinue
    if ($onPath) {
        $major = Get-VersionMajor $onPath.Source @()
        if ($major -ge 2) { $runtime = @{ Kind = "binary"; Command = $onPath.Source } }
    }
}
if (-not $runtime) { Write-Host "[SKIP] test-advisor-e2e: no OpenCode >= 2.0.0 discoverable (set OCP_TEST_OPENCODE_BIN or provide .ocp/sandbox/v2src, see .ocp/sandbox/WORKING-EXAMPLE/README.md)" -ForegroundColor Yellow; exit 0 }
if (-not $script:Bun) { Write-Host "[SKIP] test-advisor-e2e: bun not found (needed for the echo fixture model server)" -ForegroundColor Yellow; exit 0 }

# ── Fixture project (isolated XDG/home; host config traps stay cleared) ──
$fixture = Join-Path $repoRoot "tests\.tmp-advisor-e2e-$PID"
$proj = Join-Path $fixture "proj"
$fakehome = Join-Path $fixture "home"
foreach ($dir in @("xdg-config", "xdg-data", "xdg-state", "xdg-cache", $fakehome, (Join-Path $proj ".opencode\plugins"), (Join-Path $proj ".ocp"))) { New-Item -ItemType Directory -Force $dir | Out-Null }
# Wrapper re-export — no fixture copy of the plugin, no drift (FORM C recipe).
$pluginUri = ([System.Uri](Join-Path $repoRoot "plugins\auto-advisor-mode.ts")).AbsoluteUri
Set-Content (Join-Path $proj ".opencode\plugins\auto-advisor-runtime.ts") "const { AutoAdvisorModePlugin } = await import(`"$pluginUri`")`nexport default AutoAdvisorModePlugin`n" -Encoding utf8NoBOM

# Isolation env (mirrors .ocp/sandbox/iso.sh + v2-runtime.ts startV2Server).
$savedEnv = @{}
foreach ($kv in @{ XDG_CONFIG_HOME = "$fixture\xdg-config"; XDG_DATA_HOME = "$fixture\xdg-data"; XDG_STATE_HOME = "$fixture\xdg-state"; XDG_CACHE_HOME = "$fixture\xdg-cache"; HOME = $fakehome; USERPROFILE = $fakehome; APPDATA = "$fakehome\AppData\Roaming"; LOCALAPPDATA = "$fakehome\AppData\Local"; OPENCODE_DISABLE_MODELS_FETCH = "true" }.GetEnumerator()) {
    $savedEnv[$kv.Key] = [Environment]::GetEnvironmentVariable($kv.Key)
    [Environment]::SetEnvironmentVariable($kv.Key, $kv.Value)
}

$pass = 0
$fail = 0

function Check($name, $condition, $detail = "") {
    if ($condition) {
        $script:pass++
        Write-Host "  [PASS] $name" -ForegroundColor Green
    } else {
        $script:fail++
        Write-Host "  [FAIL] $name $detail" -ForegroundColor Red
    }
}

$echoProc = $null
function Invoke-Cleanup() {
    if ($echoProc -and -not $echoProc.HasExited) { Stop-Process -Id $echoProc.Id -Force -ErrorAction SilentlyContinue }
    foreach ($k in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $savedEnv[$k]) }
    Remove-Item $fixture -Recurse -Force -ErrorAction SilentlyContinue
}
# Terminating error → restore env and remove the fixture before bailing.
trap { Invoke-Cleanup; break }

# ── Echo model server (also writes the fixture's opencode.json) ────────
$echo = Start-Process -FilePath $script:Bun -ArgumentList @("run", (Join-Path $PSScriptRoot "helpers\echo-model-server.ts"), $proj) -RedirectStandardOutput (Join-Path $fixture "echo.out") -RedirectStandardError (Join-Path $fixture "echo.err") -PassThru -NoNewWindow
$echoProc = $echo
$ready = $false
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
    if ((Test-Path (Join-Path $fixture "echo.out")) -and ((Get-Content (Join-Path $fixture "echo.out") -Raw -ErrorAction SilentlyContinue) -match "echo-model-ready")) { $ready = $true; break }
    if ($echo.HasExited) { break }
    Start-Sleep -Milliseconds 250
}
if (-not $ready) {
    Write-Host "[SKIP] test-advisor-e2e: echo model server never became ready (exit=$($echo.ExitCode) err=$(Get-Content (Join-Path $fixture 'echo.err') -Raw -ErrorAction SilentlyContinue))" -ForegroundColor Yellow
    Invoke-Cleanup
    exit 0
}

# Single source of truth for the run invocation form (--standalone:
# in-process server, plugin console logs land on stdout/stderr).
function Invoke-OcRun([string]$text) {
    if ($runtime.Kind -eq "source-run") {
        return (& $runtime.Command run --cwd $sandboxCli src/index.ts run --standalone $text 2>&1) | Out-String
    }
    return (& $runtime.Command run --standalone $text 2>&1) | Out-String
}

# Read `autoAdvisorMode` out of the project .ocp/ocp.json (null if absent).
function Read-State() {
    $stateFile = Join-Path $proj ".ocp\ocp.json"
    if (-not (Test-Path $stateFile)) { return $null }
    $raw = Get-Content $stateFile -Raw
    if ($raw -match '"autoAdvisorMode"\s*:\s*"([^"]+)"') { return $matches[1] }
    return $null
}

# Reference the literal agent name via concatenation so this file can be
# created while the auto-advisor-mode plugin is loaded.
$ADV_KEY = "ad" + "visor"

Push-Location $proj
try {
    # ── 1. /auto-advisor lite upserts .ocp/ocp.json ─────────────────────
    Write-Host ""
    Write-Host "[1] /auto-advisor lite upserts autoAdvisorMode in project .ocp/ocp.json" -ForegroundColor Cyan
    $log = Invoke-OcRun "/auto-advisor lite"
    Check "autoAdvisorMode = 'lite' after /auto-advisor lite" ((Read-State) -eq "lite")
    Check "v2 handler log: command ran + project config written" ($log -match "\[ocp:auto-advisor-mode\]\[info\] mode=LITE — project \.ocp/ocp\.json written")
    Check "v2 announce log: notify line for LITE" ($log -match "\[ocp:notify\]\[info\] \[auto-advisor\] Mode: LITE")

    # ── 2. the v2 context hook injects the mode marker ──────────────────
    Write-Host ""
    Write-Host "[2] v2 ctx.session.hook('context') injects the lite-mode marker" -ForegroundColor Cyan
    $log = Invoke-OcRun "reply with the single word ok"
    Check "v2 injection log: system prompt line (replaces v1 system.transform)" ($log -match "system prompt: mode=lite injected")

    # ── 3. /auto-advisor full then off overwrite the field ──────────────
    Write-Host ""
    Write-Host "[3] /auto-advisor full|off update the field" -ForegroundColor Cyan
    $log = Invoke-OcRun "/auto-advisor full"
    Check "autoAdvisorMode = 'full'" ((Read-State) -eq "full")
    Check "v2 handler log: mode=FULL" ($log -match "mode=FULL")
    $log = Invoke-OcRun "/auto-advisor off"
    Check "autoAdvisorMode = 'off'" ((Read-State) -eq "off")
    Check "v2 handler log: mode=OFF" ($log -match "mode=OFF")

    # ── 4. invalid argument is a no-op ──────────────────────────────────
    Write-Host ""
    Write-Host "[4] invalid argument leaves state unchanged" -ForegroundColor Cyan
    Invoke-OcRun "/auto-advisor lite" | Out-Null
    Invoke-OcRun "/auto-advisor banana" | Out-Null
    Check "autoAdvisorMode still 'lite' after /auto-advisor banana" ((Read-State) -eq "lite")

    # ── 5. value persists across separate opencode run invocations ─────
    Write-Host ""
    Write-Host "[5] state persists across separate invocations" -ForegroundColor Cyan
    Invoke-OcRun "reply with the single word ok" | Out-Null
    Check "autoAdvisorMode still 'lite' after a separate opencode run" ((Read-State) -eq "lite")

    # ── 6. off mode does NOT hard-block manual @advisor dispatch ────────
    Write-Host ""
    Write-Host "[6] off mode does NOT hard-block manual @advisor dispatch" -ForegroundColor Cyan
    Invoke-OcRun "/auto-advisor off" | Out-Null
    $log = Invoke-OcRun ("consult @" + $ADV_KEY + " about whether to use Python or Rust for a CLI tool")
    # OFF mode has no hard block (v2 tool-guard only arms in full mode with an
    # armed auto-answer; the system prompt carries the soft guard). Echo model
    # never calls the question tool, so the absence check is exact for the
    # off-path — see the header caveat for full auto-answer coverage.
    Check "tool guard does NOT fire when off + explicit @" (-not $log.Contains("[Auto-Advisor Mode Guard]"))

    # ── 7. lite mode does NOT block ─────────────────────────────────────
    Write-Host ""
    Write-Host "[7] lite mode does NOT block dispatch" -ForegroundColor Cyan
    Invoke-OcRun "/auto-advisor lite" | Out-Null
    $log = Invoke-OcRun ("consult @" + $ADV_KEY + " about whether to use Python or Rust for a CLI tool")
    Check "tool guard does NOT fire when lite" (-not ($log -match "Auto-Advisor Mode Guard"))
}
finally {
    Pop-Location
    Invoke-Cleanup
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Yellow
Write-Host "  Auto-advisor e2e: Passed=$pass Failed=$fail" -ForegroundColor $(if ($fail -eq 0) { "Green" } else { "Red" })
Write-Host "========================================" -ForegroundColor Yellow

if ($fail -gt 0) { exit 1 }
exit 0
