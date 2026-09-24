# DeepSeek Anchor Plugin — Benchmark Comparison (on vs off)
#
# Methodology inspired by dsh-anchored-standard:
#   - trajectory: "We need…" (deep reasoning) vs "Let me…" (shallow tool-first)
#   - zero-tool first turn: whether the first reply invokes tools
#   - reasoning depth: first reply length and structure
#
# Test cases:
#   1. Simple inquiry:  "Who are you?"
#   2. Task request:     "Help me create a user login feature"
#   3. Exploration:      "What tech stack does this project use?"
#   4. Complex engineering: "Optimize this system's performance, current QPS is only 100"
#
# Metrics:
#   - First-turn tool call count (on: 0, off: possibly >0)
#   - Reasoning structure (goal/constraints/approach)
#   - Reply length (reasoning depth proxy)
#   - Trajectory style ("We" vs "Let me")
#
# Usage:
#   pwsh -ExecutionPolicy Bypass -File tests/test-anchor-benchmark.ps1
#   pwsh -ExecutionPolicy Bypass -File tests/test-anchor-benchmark.ps1 -Quick   # only 2 cases

param(
    [switch]$Quick
)

# ─── v2 runtime gate ───────────────────────────────────────────────────────
# Spawns the real CLI: requires OpenCode >= 2.0.0 (OCP_TEST_OPENCODE_BIN or
# PATH). No eligible runtime → explicit [SKIP] + exit 0 (CI-friendly). Host
# config traps cleared so the run never reads the live session config.
foreach ($ocGateTrap in @("ORCA_OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_PASSWORD")) { Remove-Item "Env:$ocGateTrap" -ErrorAction SilentlyContinue }
$ocCandidates = @()
if ($env:OCP_TEST_OPENCODE_BIN) { $ocCandidates += $env:OCP_TEST_OPENCODE_BIN }
$ocOnPath = Get-Command opencode -ErrorAction SilentlyContinue
if ($ocOnPath) { $ocCandidates += $ocOnPath.Source }
$script:OC = $null
foreach ($ocCandidate in $ocCandidates) {
    $ocRaw = try { (& $ocCandidate --version 2>&1) -join " " } catch { "" }
    if ($ocRaw -match '(\d+)\.') {
        if ([int]$Matches[1] -ge 2) { $script:OC = $ocCandidate; break }
        Write-Host "[SKIP] opencode $ocRaw at $ocCandidate is below the 2.0.0 runtime floor" -ForegroundColor Yellow
        exit 0
    }
}
if (-not $script:OC) { Write-Host "[SKIP] test-anchor-benchmark: no OpenCode >= 2.0.0 discoverable (set OCP_TEST_OPENCODE_BIN or install on PATH)" -ForegroundColor Yellow; exit 0 }

# Load env vars
$env:LLM_ROUTER_BASE_URL = [System.Environment]::GetEnvironmentVariable("LLM_ROUTER_BASE_URL", "User")
$env:LLM_ROUTER_API_KEY = [System.Environment]::GetEnvironmentVariable("LLM_ROUTER_API_KEY", "User")

if (-not $env:LLM_ROUTER_BASE_URL -or -not $env:LLM_ROUTER_API_KEY) {
    Write-Host "ERROR: LLM_ROUTER_BASE_URL / LLM_ROUTER_API_KEY not set" -ForegroundColor Red
    exit 1
}

Set-Location "$PSScriptRoot\.."

# ─── Test cases ────────────────────────────────────────────────────────────

$testCases = @(
    @{ Name = "Simple inquiry"; Prompt = "Who are you?" }
    @{ Name = "Task request";  Prompt = "Help me create a user login feature" }
)
if (-not $Quick) {
    $testCases += @(
        @{ Name = "Exploration";       Prompt = "What tech stack does this project use?" }
        @{ Name = "Complex engineering"; Prompt = "Optimize this system's performance, current QPS is only 100" }
    )
}

# ─── Helpers ────────────────────────────────────────────────────────────────

function Run-OpenCode([string]$prompt, [string]$anchorState) {
    # ADR 0004: deepseek-anchor reads OCP-owned config only. Project
    # `<cwd>/.ocp/ocp.json` is the canonical switch location (the
    # `cd` below pins the opencode run to this checkout so writes hit
    # its .ocp/). Global fallback (cross-project default) lives at
    # `~/.config/opencode/ocp.json` — we write that here so the
    # benchmark applies regardless of project state.
    $ocpCfg = Join-Path $env:USERPROFILE ".config\opencode\ocp.json"
    $ocpDir = Split-Path $ocpCfg -Parent
    if (-not (Test-Path $ocpDir)) { New-Item -ItemType Directory -Force -Path $ocpDir | Out-Null }
    # Round-trip via ConvertFrom-Json / ConvertTo-Json to avoid the
    # dangling-comma risk that targeted regex would introduce when the
    # file is exactly "{}" (then -replace '{' produced "{ ..., }").
    # Mirrors the cleanup path at the bottom of the file. Only writes
    # when the value actually changes.
    $cfg = if (Test-Path $ocpCfg) { Get-Content $ocpCfg -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
    if ($null -eq $cfg) { $cfg = [pscustomobject]@{} }
    $current = $cfg.PSObject.Properties["deepSeekAnchor"]
    if (-not $current -or $current.Value -ne $anchorState) {
        Add-Member -InputObject $cfg -MemberType NoteProperty -Name deepSeekAnchor -Value $anchorState -Force
        $cfg | ConvertTo-Json -Depth 10 | Set-Content $ocpCfg
    }

    # Run opencode
    $output = & $script:OC run --agent build --model llm-router/default $prompt 2>&1
    return ($output -join "`n")
}

function Measure-Reasoning([string]$output) {
    $metrics = @{
        Length          = $output.Length
        HasGoal        = $output -match "(?i)(goal|target|restate|what)"
        HasConstraints = $output -match "(?i)(constraint|limitation|assumption|boundary)"
        HasApproach    = $output -match "(?i)(approach|method|strategy|step|plan)"
        HasWe          = $output -match "(?i)^.*\bwe\b"
        HasLetMe       = $output -match "(?i)(let me|allow me)"
        ToolCallCount  = ([regex]::Matches($output, "(?i)(tool|bash|str_replace|read_file|write_file|grep)")).Count
    }
    return $metrics
}

# ─── Main test flow ─────────────────────────────────────────────────────────

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  DeepSeek Anchor — Benchmark (on vs off)                 ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════════╝" -ForegroundColor Cyan

$results = @()

foreach ($tc in $testCases) {
    Write-Host ""
    Write-Host "──────────────────────────────────────────────────────────" -ForegroundColor Yellow
    Write-Host "  Case: $($tc.Name)" -ForegroundColor Yellow
    Write-Host "  Prompt: $($tc.Prompt)" -ForegroundColor Gray
    Write-Host "──────────────────────────────────────────────────────────" -ForegroundColor Yellow

    # ── OFF (anchor disabled) ──
    Write-Host ""
    Write-Host "  [OFF] Running..." -ForegroundColor Gray
    $offOutput = Run-OpenCode $tc.Prompt "off"
    $offMetrics = Measure-Reasoning $offOutput

    Write-Host "  [OFF] Length: $($offMetrics.Length)" -ForegroundColor Gray
    Write-Host "  [OFF] 'We' style: $($offMetrics.HasWe)" -ForegroundColor Gray
    Write-Host "  [OFF] 'Let me' style: $($offMetrics.HasLetMe)" -ForegroundColor Gray
    Write-Host "  [OFF] Tool mentions: $($offMetrics.ToolCallCount)" -ForegroundColor Gray
    Write-Host "  [OFF] Preview: $($offOutput.Substring(0, [Math]::Min(200, $offOutput.Length)))..." -ForegroundColor DarkGray

    # ── ON (anchor enabled) ──
    Write-Host ""
    Write-Host "  [ON] Running..." -ForegroundColor Gray
    $onOutput = Run-OpenCode $tc.Prompt "on"
    $onMetrics = Measure-Reasoning $onOutput

    Write-Host "  [ON] Length: $($onMetrics.Length)" -ForegroundColor Gray
    Write-Host "  [ON] 'We' style: $($onMetrics.HasWe)" -ForegroundColor Gray
    Write-Host "  [ON] 'Let me' style: $($onMetrics.HasLetMe)" -ForegroundColor Gray
    Write-Host "  [ON] Tool mentions: $($onMetrics.ToolCallCount)" -ForegroundColor Gray
    Write-Host "  [ON] Preview: $($onOutput.Substring(0, [Math]::Min(200, $onOutput.Length)))..." -ForegroundColor DarkGray

    # ── Comparison ──
    Write-Host ""
    Write-Host "  📊 Comparison:" -ForegroundColor Cyan

    # Reasoning length: ON should be longer
    $lengthDelta = $onMetrics.Length - $offMetrics.Length
    $lengthVerdict = if ($lengthDelta > 0) { "✅ ON deeper (+$lengthDelta chars)" } else { "⚠️ OFF longer ($lengthDelta chars)" }
    Write-Host "    Reasoning length: $lengthVerdict" -ForegroundColor $(if ($lengthDelta -gt 0) { "Green" } else { "Yellow" })

    # Trajectory style
    $trajectoryNote = ""
    if ($onMetrics.HasWe -and -not $offMetrics.HasWe) {
        $trajectoryNote = "✅ ON shifted to 'We' deep-reasoning style"
    } elseif ($offMetrics.HasLetMe -and -not $onMetrics.HasLetMe) {
        $trajectoryNote = "✅ ON escaped 'Let me' shallow style"
    } elseif ($onMetrics.HasWe) {
        $trajectoryNote = "✅ ON maintains 'We' style"
    } else {
        $trajectoryNote = "⚠️ trajectory difference not significant"
    }
    Write-Host "    Trajectory: $trajectoryNote" -ForegroundColor Cyan

    # Reasoning structure
    $onScore = 0
    if ($onMetrics.HasGoal) { $onScore++ }
    if ($onMetrics.HasConstraints) { $onScore++ }
    if ($onMetrics.HasApproach) { $onScore++ }
    $offScore = 0
    if ($offMetrics.HasGoal) { $offScore++ }
    if ($offMetrics.HasConstraints) { $offScore++ }
    if ($offMetrics.HasApproach) { $offScore++ }
    Write-Host "    Structure: ON=$onScore/3 vs OFF=$offScore/3 (goal+constraints+approach)" -ForegroundColor $(if ($onScore -ge $offScore) { "Green" } else { "Yellow" })

    # Tool calls
    $toolNote = if ($onMetrics.ToolCallCount -lt $offMetrics.ToolCallCount) {
        "✅ ON fewer tool calls (reason-before-action)"
    } elseif ($onMetrics.ToolCallCount -eq 0 -and $offMetrics.ToolCallCount -eq 0) {
        "✅ Neither has tool calls"
    } else {
        "⚠️ ON tool calls not significantly reduced"
    }
    Write-Host "    Tool tendency: $toolNote" -ForegroundColor Cyan

    $results += @{
        Name = $tc.Name
        OnLength = $onMetrics.Length
        OffLength = $offMetrics.Length
        OnWe = $onMetrics.HasWe
        OffWe = $offMetrics.HasWe
        OnLetMe = $onMetrics.HasLetMe
        OffLetMe = $offMetrics.HasLetMe
        OnStructureScore = $onScore
        OffStructureScore = $offScore
        OnTools = $onMetrics.ToolCallCount
        OffTools = $offMetrics.ToolCallCount
    }
}

# ─── Summary report ─────────────────────────────────────────────────────────

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  📋 Summary                                             ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════════╝" -ForegroundColor Cyan

Write-Host ""
Write-Host "Case               | ON Len  | OFF Len | ON We | OFF We | ON LetMe | OFF LetMe | ON Str | OFF Str | ON Tools | OFF Tools"
Write-Host "─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"

foreach ($r in $results) {
    $line = "{0,-18}| {1,7} | {2,7} | {3,5} | {4,5} | {5,8} | {6,8} | {7,6} | {8,6} | {9,8} | {10,8}" -f `
        $r.Name, $r.OnLength, $r.OffLength, $r.OnWe, $r.OffWe, $r.OnLetMe, $r.OffLetMe, $r.OnStructureScore, $r.OffStructureScore, $r.OnTools, $r.OffTools
    Write-Host $line
}

# ─── Conclusion ──────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "═════════════════════════════════════════════════════════════" -ForegroundColor Magenta

$onLonger = ($results | Where-Object { $_.OnLength -gt $_.OffLength }).Count
$onMoreStructured = ($results | Where-Object { $_.OnStructureScore -gt $_.OffStructureScore }).Count
$onFewerTools = ($results | Where-Object { $_.OnTools -lt $_.OffTools }).Count
$total = $results.Count

Write-Host "  Reasoning length: ON longer in $onLonger/$total cases" -ForegroundColor $(if ($onLonger -gt $total/2) { "Green" } else { "Yellow" })
Write-Host "  Reasoning structure: ON more complete in $onMoreStructured/$total cases" -ForegroundColor $(if ($onMoreStructured -gt $total/2) { "Green" } else { "Yellow" })
Write-Host "  Tool suppression: ON fewer tools in $onFewerTools/$total cases" -ForegroundColor $(if ($onFewerTools -gt 0) { "Green" } else { "Yellow" })

if ($onLonger -gt $total/2 -or $onMoreStructured -gt $total/2) {
    Write-Host ""
    Write-Host "  ✅ Anchor plugin effectively improved reasoning depth in most cases" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "  ⚠️ Anchor effect not significant — may need more cases or different prompts" -ForegroundColor Yellow
}

Write-Host "═════════════════════════════════════════════════════════════" -ForegroundColor Magenta

# Restore default state (off — opt-in). Strip the global deepSeekAnchor
# key from ocp.json so the benchmark leaves no residue in the user's
# cross-project config. Round-trip via ConvertFrom-Json / ConvertTo-Json
# to avoid corrupting sibling keys with dangling commas — ocp.json is
# JSON-only per the ocp-config.ts write path, so comments aren't a concern.
$ocpCfg = Join-Path $env:USERPROFILE ".config\opencode\ocp.json"
if (Test-Path $ocpCfg) {
    $cfg = Get-Content $ocpCfg -Raw | ConvertFrom-Json
    if ($cfg.PSObject.Properties["deepSeekAnchor"]) {
        $cfg.PSObject.Properties.Remove("deepSeekAnchor")
        $cfg | ConvertTo-Json -Depth 10 | Set-Content $ocpCfg
    }
}
