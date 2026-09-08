# Run all tests sequentially
# Requires LLM_ROUTER_BASE_URL and LLM_ROUTER_API_KEY in system environment.
#
# Usage:
#   pwsh -ExecutionPolicy Bypass -File tests/test-all.ps1                       # all tests
#   pwsh -ExecutionPolicy Bypass -File tests/test-all.ps1 -IncludePrompts       # include ponytail behavioral
#   pwsh -ExecutionPolicy Bypass -File tests/test-all.ps1 -StructuralOnly       # no API calls; CI-safe, exits non-zero on failure

param(
    [switch]$IncludePrompts,
    [switch]$StructuralOnly
)

Set-Location "$PSScriptRoot\.."

# ============================================================================
# Structural checks (no API calls)
# ============================================================================

$pass = 0
$fail = 0
$results = @()

function Check($name, $condition, $detail = "") {
    if ($condition) {
        $script:pass++
        $script:results += "[PASS] $name"
    } else {
        $script:fail++
        $script:results += "[FAIL] $name $detail"
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Structural: config & protocols" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$config = Get-Content "$PSScriptRoot\..\opencode.template.jsonc" -Raw | ConvertFrom-Json
$scope = Get-Content "$PSScriptRoot\..\plugin-scope.json" -Raw | ConvertFrom-Json
Check "plugin-scope.json: parses with identifiers and plugins sections" (($null -ne $scope.identifiers) -and ($null -ne $scope.plugins))
Check "opencode.template.jsonc: carries native permission policy (global + per-agent)" (($config.permission -eq "allow") -and (@($config.agent.PSObject.Properties | Where-Object { $_.Value.permission }).Count -gt 0))
Check "root remote PowerShell bootstrap exists" (Test-Path "$PSScriptRoot\..\install.ps1")
Check "root remote Bash bootstrap exists" (Test-Path "$PSScriptRoot\..\install.sh")
Check "instructions contains output-protocol.md" `
    ($config.instructions -contains "~/.config/opencode/instructions/output-protocol.md")
Check "plugin includes @dietrichgebert/ponytail" `
    ($config.plugin -contains "@dietrichgebert/ponytail")
# decision-advisor.md was removed in the split-into-plugins refactor — protocol
# now lives embedded in plugins/auto-advisor/auto-advisor-instructions.ts.
# Disclosure-layer rework: L0 (instructions array) keeps only the universal iron
# rules — rfc-keywords + output-protocol + verification-honesty + routing-index
# + git-safety (added v0.18.3).
# Role rules moved to L1 (agent prompt {file:} assembly); sdd-principles moved
# to L2 (skills/sdd-workflow). Removed from L0: test-scope, coding-principles,
# edit-protocol, sdd-principles, comment-strategy, sql-migration.
Check "instructions count = 5 (L0 iron rules only)" ($config.instructions.Count -eq 5)
Check "instructions all use absolute ~/ paths" `
    (($config.instructions | Where-Object { $_ -notlike '~/.config/opencode/*' }).Count -eq 0)
Check "instructions contains routing-index.md" `
    ($config.instructions -contains "~/.config/opencode/instructions/routing-index.md")
Check "L1 rules NOT in L0 array (edit-protocol)" `
    (-not ($config.instructions -contains "~/.config/opencode/instructions/edit-protocol.md"))
Check "L1 rules NOT in L0 array (coding-principles)" `
    (-not ($config.instructions -contains "~/.config/opencode/instructions/coding-principles.md"))
Check "L2 rules NOT in L0 array (sdd-principles)" `
    (-not ($config.instructions -contains "~/.config/opencode/instructions/sdd-principles.md"))
Check "instructions does NOT include context-efficiency.md" `
    (-not ($config.instructions -contains "~/.config/opencode/instructions/context-efficiency.md"))
Check "instructions does NOT include decision-advisor.md" `
    (-not ($config.instructions -contains "~/.config/opencode/instructions/decision-advisor.md"))

# L1 assembly: coding agents carry the coding pack via {file:} markers;
# non-coding agents carry zero additions.
Check "code agent carries coding-principles via {file:}" `
    ($config.agent.code.prompt -match '\{file:~/.config/opencode/instructions/coding-principles\.md\}')
Check "dba agent carries sql-migration via {file:}" `
    ($config.agent.dba.prompt -match '\{file:~/.config/opencode/instructions/sql-migration\.md\}')
Check "code-review agent has NO edit-protocol (edit denied)" `
    (-not ($config.agent.'code-review'.prompt -match 'edit-protocol'))
Check "code-review agent denies source-bearing CodeGraph MCP" `
    ($config.agent.'code-review'.permission.'codegraph_*'.'*' -eq 'deny')
foreach ($reviewAgentName in @('explore', 'code-review', 'code-review-fast')) {
    $reviewPermission = $config.agent.$reviewAgentName.permission.bash
    $rtkGitGaps = @('log', 'show', 'diff', 'status') | Where-Object {
        $reviewPermission.PSObject.Properties["rtk git $($_)*"].Value -ne 'allow'
    }
    Check "$reviewAgentName allows RTK-rewritten read-only git commands" `
        ($rtkGitGaps.Count -eq 0) ($rtkGitGaps -join ', ')
}
Check "codegraph-scout is a bounded graph-only subagent" `
    ($config.agent.'codegraph-scout'.mode -eq 'subagent' -and $config.agent.'codegraph-scout'.steps -eq 6 -and $config.agent.'codegraph-scout'.variant -eq 'medium')
$scoutPermission = $config.agent.'codegraph-scout'.permission
$scoutMcpGaps = @('serena_*', 'headroom_*', 'gitnexus_*', 'dbhub_*', 'idea_*') | Where-Object {
    $rule = $scoutPermission.PSObject.Properties[$_].Value
    $rule.PSObject.Properties['*'].Value -ne 'deny'
}
Check "codegraph-scout exposes only CodeGraph among MCP servers" `
    ($scoutPermission.'codegraph_*'.'*' -eq 'deny' -and $scoutPermission.'codegraph_codegraph_explore'.'*' -eq 'allow' -and $scoutMcpGaps.Count -eq 0)
$scoutNativeGaps = @(@('task', 'bash', 'read', 'glob', 'grep', 'edit', 'write', 'webfetch', 'websearch') | Where-Object {
    $config.agent.'codegraph-scout'.tools.PSObject.Properties[$_].Value -ne $false
})
Check "codegraph-scout has no native source or shell tools" `
    ($scoutNativeGaps.Count -eq 0)
$graphSurfaceDenied = @('advisor', 'architect', 'dba', 'security', 'qa', 'devops', 'fast-coder') | Where-Object {
    $permission = $config.agent.$_.permission
    $permission.'codegraph_*'.'*' -ne 'deny' -or $permission.'gitnexus_*'.'*' -ne 'deny'
}
Check "non-graph roles hide CodeGraph and GitNexus schemas" ($graphSurfaceDenied.Count -eq 0)
Check "codegraph-scout defaults to compact source-free evidence" `
    ((Get-Content "$PSScriptRoot\..\prompts\codegraph-scout.md" -Raw) -match 'Default to 220 tokens' -and (Get-Content "$PSScriptRoot\..\prompts\codegraph-scout.md" -Raw) -match 'up to 360' -and (Get-Content "$PSScriptRoot\..\prompts\codegraph-scout.md" -Raw) -match 'do not quote')
Check "gitnexus-scout uses the same complexity-triggered evidence cap" `
    ((Get-Content "$PSScriptRoot\..\prompts\gitnexus-scout.md" -Raw) -match 'Default to 220 tokens' -and (Get-Content "$PSScriptRoot\..\prompts\gitnexus-scout.md" -Raw) -match 'up to 360' -and (Get-Content "$PSScriptRoot\..\prompts\gitnexus-scout.md" -Raw) -match 'cross-repository')
$gitnexusScout = $config.agent.'gitnexus-scout'
$gitnexusScoutPermission = $gitnexusScout.permission
$gitnexusScoutMcpGaps = @('serena_*', 'codegraph_*', 'headroom_*', 'dbhub_*', 'idea_*') | Where-Object {
    $rule = $gitnexusScoutPermission.PSObject.Properties[$_].Value
    $rule.PSObject.Properties['*'].Value -ne 'deny'
}
Check "gitnexus-scout exposes only the bounded GitNexus query" `
    ($gitnexusScout.mode -eq 'subagent' -and $gitnexusScout.steps -eq 6 -and $gitnexusScoutPermission.'gitnexus_*'.'*' -eq 'deny' -and $gitnexusScoutPermission.'gitnexus_query'.'*' -eq 'allow' -and $gitnexusScoutMcpGaps.Count -eq 0)
$gitnexusScoutNativeGaps = @(@('task', 'bash', 'read', 'glob', 'grep', 'edit', 'write', 'webfetch', 'websearch') | Where-Object {
    $gitnexusScout.tools.PSObject.Properties[$_].Value -ne $false
})
Check "gitnexus-scout has no native source or shell tools" `
    ($gitnexusScoutNativeGaps.Count -eq 0)
Check "code-review-fast agent is registered as a subagent" `
    ($config.agent.'code-review-fast'.mode -eq 'subagent')
Check "code-review-fast agent uses 15-step medium budget" `
    ($config.agent.'code-review-fast'.steps -eq 15 -and $config.agent.'code-review-fast'.variant -eq 'medium')
$fastPermission = $config.agent.'code-review-fast'.permission
$fastMcpGaps = @('serena_*', 'codegraph_*', 'headroom_*', 'gitnexus_*', 'dbhub_*', 'idea_*') | Where-Object {
    $rule = $fastPermission.PSObject.Properties[$_].Value
    $rule.PSObject.Properties['*'].Value -ne 'deny'
}
Check "code-review-fast agent denies all MCP servers" ($fastMcpGaps.Count -eq 0)
Check "code-review-fast reuses shared review body before its override" `
    ($config.agent.'code-review-fast'.prompt -match 'prompts/code-review\.md[\s\S]*prompts/code-review-fast\.md')
Check "code-review-fast prompt has no nested file marker" `
    (-not ((Get-Content "$PSScriptRoot\..\prompts\code-review-fast.md" -Raw) -match '\{file:'))
Check "code-review-fast marker requires dispatcher-selected tier" `
    ((Get-Content "$PSScriptRoot\..\prompts\code-review-fast.md" -Raw) -match 'L<n>.*resolved to 1 or 2')
$buildReviewRouting = Get-Content "$PSScriptRoot\..\prompts\build.md" -Raw
Check "build review routing directly defines L0 through L3" `
    ($buildReviewRouting -match '\| L0 \|' -and $buildReviewRouting -match '\| L0\.5 \|' -and $buildReviewRouting -match '\| L1 \|' -and $buildReviewRouting -match '\| L2 \|' -and $buildReviewRouting -match '\| L3 \|')
Check "build review routing assigns fast to L1/L2 and deep only to L3" `
    ($buildReviewRouting -match '\| L1 \|.*code-review-fast' -and $buildReviewRouting -match '\| L2 \|.*code-review-fast' -and $buildReviewRouting -match '\| L3 \|.*codegraph-scout.*code-review')
Check "build review routing bounds graph evidence and retains source verification" `
    ($buildReviewRouting -match '220 tokens by default' -and $buildReviewRouting -match 'up to 360 only' -and $buildReviewRouting -match 'reviewer verifies source')
Check "build agent has zero L1 additions" `
    ($config.agent.build.prompt -eq '{file:~/.config/opencode/prompts/build.md}')
Check "explore agent has zero L1 additions" `
    ($config.agent.explore.prompt -eq '{file:~/.config/opencode/prompts/explore.md}')
$scout = $config.agent.scout
Check "scout overrides the built-in with compact read-only reconnaissance" `
    ($scout.mode -eq 'subagent' -and $scout.steps -eq 12 -and $scout.variant -eq 'low' -and $scout.tools.task -eq $false -and $scout.permission.edit -eq 'deny')
Check "scout keeps graph tools and review routing out of its surface" `
    ($scout.permission.'codegraph_*'.'*' -eq 'deny' -and $scout.permission.'gitnexus_*'.'*' -eq 'deny' -and (Get-Content "$PSScriptRoot\\..\\prompts\\scout.md" -Raw) -match 'Route: @build' -and (Get-Content "$PSScriptRoot\\..\\prompts\\scout.md" -Raw) -match 'Never edit or review code')

# Ponytail config (official plugin) — environment-dependent: SKIP when the
# config file doesn't exist (fresh machine / CI), only assert when present.
if ($env:APPDATA) {
    $ponytailConfigPath = Join-Path $env:APPDATA "ponytail\config.json"
    if (Test-Path $ponytailConfigPath) {
        $ponytailConfig = Get-Content $ponytailConfigPath -Raw | ConvertFrom-Json
        Check "ponytail config: defaultMode is lite" ($ponytailConfig.defaultMode -eq "lite")
    } else {
        Write-Host "  [SKIP] ponytail config check (config.json not present on this machine)" -ForegroundColor DarkGray
    }
} else {
    Write-Host "  [SKIP] ponytail config check (no APPDATA — non-Windows host)" -ForegroundColor DarkGray
}

# Agent ecosystem library mentions
$trustedAgents = @(
    @{ file = "java-dev.md";   libs = "Spring|HikariCP|Flyway" }
    @{ file = "python-dev.md"; libs = "SQLAlchemy|Pydantic|pytest" }
    @{ file = "node-dev.md";   libs = "Prisma|Zod" }
)
foreach ($agent in $trustedAgents) {
    $content = Get-Content "$PSScriptRoot\..\prompts\$($agent.file)" -Raw
    Check "$($agent.file): mentions ecosystem libs" ($content -match $agent.libs)
}

# Security rules preserved
$javaContent = Get-Content "$PSScriptRoot\..\prompts\java-dev.md" -Raw
$pyContent = Get-Content "$PSScriptRoot\..\prompts\python-dev.md" -Raw
$nodeContent = Get-Content "$PSScriptRoot\..\prompts\node-dev.md" -Raw
Check "java-dev.md: security rules intact" ($javaContent -match "secrets|security|hardcode")
Check "python-dev.md: security rules intact" ($pyContent -match "bare.*except|security")
Check "node-dev.md: security rules intact" ($nodeContent -match "Validate all input|security")

# Non-coding agent isolation
$researcherContent = Get-Content "$PSScriptRoot\..\prompts\researcher.md" -Raw
Check "researcher.md: no ponytail rules (non-coding)" ($researcherContent -notmatch "ponytail|lazy coding")

# Coding agent contract (direct developer: codes itself, no proactive
# delegation, never delegated to; vision is a three-tier cascade)
$codeContent = Get-Content "$PSScriptRoot\..\prompts\code.md" -Raw
Check "opencode.template.jsonc: code agent registered" ($null -ne $config.agent.code)
Check "opencode.template.jsonc: code mode is primary" ($config.agent.code.mode -eq "primary")
Check "opencode.template.jsonc: code prompt references code.md" ($config.agent.code.prompt -match "prompts/code\.md")
Check "code.md: no proactive delegation rule" ($codeContent -match "No proactive delegation")
Check "code.md: never delegated rule" ($codeContent -match "Never delegated")
Check "code.md: core coding stays in-house" ($codeContent -match "NEVER hand the core coding task")
Check "code.md: image three-tier cascade (self first)" ($codeContent -match "Self first")
Check "code.md: image cascade delegates to @vision only" ($codeContent -match "your own model cannot read")
Check "code.md: image fallback to user, no guessing" ($codeContent -match "NEVER guess")
$buildContent = Get-Content "$PSScriptRoot\..\prompts\build.md" -Raw
$planContent = Get-Content "$PSScriptRoot\..\prompts\plan.md" -Raw
Check "build.md: never routes to @code" ($buildContent -notmatch "@code(?=\s|$|[`,)])")
Check "plan.md: never routes to @code" ($planContent -notmatch "@code(?!-)")

# lite agent + lite-mode plugin (L2 layer: default agent, near-zero-overhead primary)
$litePlugin = Get-Content "$PSScriptRoot\..\plugins\lite-mode\lite-mode.ts" -Raw
$litePrompt = Get-Content "$PSScriptRoot\..\prompts\lite.md" -Raw
Check "opencode.template.jsonc: default agent is lite" ($config.default_agent -eq "lite")
Check "opencode.template.jsonc: lite agent registered" ($null -ne $config.agent.lite)
Check "opencode.template.jsonc: lite mode is primary" ($config.agent.lite.mode -eq "primary")
Check "opencode.template.jsonc: lite ships without a model preset (inherits default until /profile)" ($null -eq $config.agent.lite.model)
Check "opencode.template.jsonc: lite prompt uses {file:} for lite.md" ($config.agent.lite.prompt -match '\{file:.*lite\.md\}')
Check "opencode.template.jsonc: lite prompt carries lite-mode sentinel" ($config.agent.lite.prompt -match '<!-- lite-mode -->')
Check "template: lite uses wildcard MCP deny" ($config.agent.lite.permission.'*'.'*' -eq "deny")
Check "template: lite tools whitelist carries question (interactive ask for the default primary)" ($config.agent.lite.tools.question -eq $true)
Check "template: lite tools whitelist has 12 tools" (($config.agent.lite.tools.read -eq $true) -and ($config.agent.lite.tools.edit -eq $true) -and ($config.agent.lite.tools.write -eq $true) -and ($config.agent.lite.tools.bash -eq $true) -and ($config.agent.lite.tools.grep -eq $true) -and ($config.agent.lite.tools.glob -eq $true) -and ($config.agent.lite.tools.webfetch -eq $true) -and ($config.agent.lite.tools.websearch -eq $true) -and ($config.agent.lite.tools.todowrite -eq $true) -and ($config.agent.lite.tools.task -eq $true) -and ($config.agent.lite.tools.question -eq $true))
Check "template: lite does not whitelist list (not a real opencode tool)" ($config.agent.lite.tools.PSObject.Properties.Name -notcontains "list")
Check "template: lite tools wildcard false hides everything else" ($config.agent.lite.tools.'*' -eq $false)
Check "template: lite prompt hardcodes the on-demand dispatch policy (vision exception)" ($litePrompt -match 'explicit user request' -and $litePrompt -notmatch 'Boost mode')
Check "lite and code map explicit review requests to the review agents" `
    ($litePrompt -match 'ordinary diff → `@code-review-fast`' -and $litePrompt -match 'sensitive or final → `@code-review`' -and (Get-Content "$PSScriptRoot\\..\\prompts\\code.md" -Raw) -match 'Explicit review/audit request')
Check "plugin-scope: default policy denies lite, utility and all subagent steps" (($scope.plugins.'*'.deny -contains "lite") -and ($scope.plugins.'*'.deny -contains "utility") -and ($scope.plugins.'*'.deny -contains "subagent:*"))
$injectorFiles = @(
  "plugins\project-profiler\project-profiler.ts", "plugins\md-to-pdf\system-inject.ts",
  "plugins\project-manager\project-manager-system-inject.ts", "plugins\adr-guard\adr-guard-system-inject.ts",
  "plugins\auto-advisor\auto-advisor-system-inject.ts", "plugins\deepseek-anchor\index.ts",
  "plugins\md-to-docx\system-inject.ts", "plugins\e2e-guard\e2e-guard-system-inject.ts"
)
$unregisteredInjectors = @($injectorFiles | Where-Object { (Get-Content "$PSScriptRoot\..\$_" -Raw) -notmatch 'await scoped\(input, output\.system, "' })
Check "plugin-scope: all 8 protocol injectors gate through scoped()" ($unregisteredInjectors.Count -eq 0)
$pluginScope = Get-Content "$PSScriptRoot\..\plugins\shared\plugin-scope.ts" -Raw
Check "plugin-scope.ts: reads the policy file and fails open" (($pluginScope -match "plugin-scope\.json") -and ($pluginScope -match "catch"))
Check "lite-mode.ts: exports pure strip function" ($litePlugin -match "export function stripLiteOverhead")
Check "lite-mode.ts: has system.transform hook" ($litePlugin -match "experimental\.chat\.system\.transform")
Check "lite-mode.ts: fail-open try/catch" ($litePlugin -match "try \{" -and $litePlugin -match "catch")
$liteBarrel = Get-Content "$PSScriptRoot\..\plugins\lite-mode.ts" -Raw
Check "lite-mode.ts: barrel re-exports LiteModePlugin" ($liteBarrel -match "export.*LiteModePlugin")
# opencode's getLegacyPlugins drops a file whose exports are not ALL functions —
# the barrel must contain no const/value exports (the bug that killed lite mode).
Check "lite-mode.ts: barrel exports functions only (loader contract)" ($liteBarrel -notmatch "export\s+(const|let|var)\s")
Check "shared/plugin-scope.ts: two-step gate (detectAgent + scoped, no hardcoded match text)" (($pluginScope -match "export function detectAgent") -and ($pluginScope -match "export async function scoped") -and ((Get-Content "$PSScriptRoot\..\plugin-scope.json" -Raw) -match '"identifiers"'))
Check "lite-mode.ts: identifies lite via detectAgent (no hardcoded sentinel)" (($litePlugin -match "detectAgent") -and ($litePlugin -notmatch "lite-mode -->"))
$liteTools = Get-Content "$PSScriptRoot\..\plugins\lite-tools.ts" -Raw
Check "lite-tools.ts: exports functions only (loader contract)" ($liteTools -notmatch "export\s+(const|let|var)\s")
Check "lite-tools.ts: gates rewrite on chat.message agent" ($liteTools -match '"chat\.message"' -and $liteTools -match 'currentAgent !== "lite"')
Check "lite-tools.ts: hooks tool.definition" ($liteTools -match '"tool\.definition"')
Check "routing-index.md: routes lightweight tasks to @lite" ((Get-Content "$PSScriptRoot\..\instructions\routing-index.md" -Raw) -match "@lite")

# File integrity
$allFiles = @(
    "instructions/output-protocol.md",
    "instructions/test-scope.md",
    "prompts/build.md", "prompts/plan.md", "prompts/code.md", "prompts/explore.md",
    "prompts/go-dev.md", "prompts/rust-dev.md", "prompts/java-dev.md",
    "prompts/python-dev.md", "prompts/node-dev.md", "prompts/frontend-dev.md",
    "prompts/researcher.md", "prompts/architect.md", "prompts/code-review.md", "prompts/code-review-fast.md", "prompts/codegraph-scout.md",
    "prompts/advisor.md",
    "prompts/dba.md", "prompts/devops.md", "prompts/qa.md",
    "prompts/security.md", "prompts/tech-writer.md", "prompts/vision.md",
    # Commands — thin slash-command launchers (each loads its L2 skill on demand)
    "commands/goal.md", "commands/handoff.md", "commands/grill-me.md", "commands/grill-with-docs.md",
    "commands/grill-improve-loop.md", "commands/dev.md", "commands/dev-plan.md", "commands/dev-quick.md", "commands/dev-flash.md",
    "commands/dev-review.md", "commands/dev-ultra.md", "commands/review-fix-loop.md",
    "commands/dev-prud.md",
    "commands/git-merge.md",
    "commands/git-pick.md",
    "commands/git-pull.md",
    "commands/git-push.md",
    "commands/git-rebase.md",
    "commands/sdd.md", "commands/prd.md", "commands/plan.md", "commands/impl.md",
    # Skills — L2 workflow protocols (body loads on demand via the skill tool)
    "skills/goal/SKILL.md", "skills/handoff/SKILL.md", "skills/grill-me/SKILL.md", "skills/grill-with-docs/SKILL.md",
    "skills/grill-improve-loop/SKILL.md", "skills/dev/SKILL.md",
    "skills/dev-ultra/SKILL.md", "skills/review-fix-loop/SKILL.md",
    "skills/dev-prud/SKILL.md",
    "skills/git-merge/SKILL.md",
    "skills/git-pick/SKILL.md",
    "skills/git-pull/SKILL.md",
    "skills/git-push/SKILL.md",
    "skills/git-rebase/SKILL.md",
    # Plugins (auto-advisor-mode + helpers + deepseek-anchor)
    "plugins/auto-advisor-mode.ts",
    "plugins/auto-advisor/auto-advisor-config.ts",
    "plugins/auto-advisor/auto-advisor-runtime.ts",
    "plugins/auto-advisor/auto-advisor-instructions.ts",
    "plugins/auto-advisor/auto-advisor-mode-tracker.ts",
    "plugins/auto-advisor/auto-advisor-system-inject.ts",
    "plugins/auto-advisor/auto-advisor-tool-guard.ts",
    "plugins/auto-advisor/auto-advisor-full-inject.ts",
    "plugins/auto-advisor/auto-advisor-announce.ts",
    "plugins/deepseek-anchor.ts",
    "plugins/deepseek-anchor/index.ts",
    "plugins/deepseek-anchor/deepseek-anchor-config.ts",
    "plugins/deepseek-anchor/deepseek-anchor-command.ts",
    "plugins/deepseek-anchor/deepseek-anchor-announce.ts",
    "plugins/project-profiler.ts",
    "plugins/project-profiler/project-profiler.ts",
    "plugins/adr-guard.ts",
    "plugins/adr-guard/adr-guard.ts",
    "plugins/adr-guard/adr-guard-config.ts",
    "plugins/adr-guard/adr-guard-runtime.ts",
    "plugins/adr-guard/adr-guard-protocol.md",
    "plugins/adr-guard/adr-guard-instructions.ts",
    "plugins/adr-guard/adr-guard-system-inject.ts",
    "plugins/adr-guard/adr-guard-tool-guard.ts",
    "plugins/adr-guard/adr-guard-command.ts",
    "plugins/adr-guard/adr-guard-announce.ts",
    "plugins/adr-guard/adr-engine.ts",
    "plugins/env-guard.ts",
    "plugins/env-guard/env-guard.ts",
    "plugins/env-guard/env-guard-config.ts",
    "plugins/env-guard/env-guard-runtime.ts",
    "plugins/env-guard/env-guard-tool-guard.ts",
    "plugins/e2e-guard.ts",
    "plugins/e2e-guard/e2e-guard.ts",
    "plugins/e2e-guard/e2e-guard-protocol.md",
    "plugins/e2e-guard/e2e-guard-instructions.ts",
    "plugins/e2e-guard/e2e-guard-system-inject.ts",
    "plugins/e2e-guard/e2e-guard-command.ts",
    "plugins/e2e-guard/e2e-guard-config.ts",
    "plugins/e2e-guard/README.md",
    "plugins/shared/opencode-prime.ts",
    "plugins/shared/package-manager.ts",
    "plugins/project-manager.ts",
    "plugins/project-manager/project-manager.ts",
    "plugins/project-manager/project-manager-config.ts",
    "plugins/project-manager/project-manager-dprint.ts",
    "plugins/project-manager/project-manager-operations.ts",
    "plugins/project-manager/project-manager-options.ts",
    "plugins/project-manager/project-manager-scaffold.ts",
    "plugins/project-manager/project-manager-command.ts",
    "plugins/project-manager/project-manager-hooks.ts",
    "plugins/project-manager/project-manager-system-inject.ts",
    "plugins/project-manager/project-manager-tool-guard.ts",
    "plugins/project-manager/templates/opencode.jsonc",
    "plugins/project-manager/templates/git-commits.md",
    "plugins/project-manager/templates/AGENTS.md",
    "plugins/project-manager/templates/dbhub.toml",
    "plugins/md-to-pdf.ts",
    "plugins/md-to-pdf/index.ts",
    "plugins/md-to-pdf/engine.ts",
    "plugins/md-to-pdf/command.ts",
    "plugins/md-to-pdf/style.ts",
    "plugins/md-to-pdf/style.css",
    "plugins/md-to-pdf/system-inject.ts",
    "install/src/shared/shell-command.ts",
    "plugins/shared/mermaid-renderer.ts",
    "plugins/md-to-docx.ts",
    "plugins/md-to-docx/index.ts",
    "plugins/md-to-docx/engine.ts",
    "plugins/md-to-docx/command.ts",
    "plugins/md-to-docx/system-inject.ts",
    "plugins/md-to-docx/postprocess.ts",
    "plugins/md-to-docx/style.css",
    "plugins/md-to-docx/style-parser.ts",
    "plugins/md-to-docx/assets/reference.docx",
    "plugins/sdd.ts",
    "plugins/sdd/sdd.ts",
    "plugins/sdd/sdd-engine.ts",
    "plugins/sdd/sdd-command.ts",
    "skills/sdd-workflow/SKILL.md",
    "docs/workflows/sdd.md",
    "docs/zh/workflows/sdd.md",
    "docs/workflows/dev-prud.md",
    "docs/zh/workflows/dev-prud.md",
    "plugins/design-token-guard.ts", "plugins/ai-slop-scanner.ts",
    "plugins/tui/usage.ts", "plugins/auto-format.ts",
    "plugins/tui/queue-manager.ts",
    "plugins/tui/project-wizard.ts",
    "plugins/lite-mode.ts",
    "plugins/lite-mode/lite-mode.ts",
    "plugins/shared/plugin-scope.ts",
    "plugin-scope.json",
    "plugins/lite-tools.ts",
    # Config
    "tsconfig.json", "package.json"
)
foreach ($f in $allFiles) {
    Check "file exists: $f" (Test-Path "$PSScriptRoot\..\$f")
}

# Workflow protocols live at L2 (skills/<name>/SKILL.md) with thin command
# launchers (commands/<name>.md) — the old plugin system-prompt injectors were
# retired in v0.16.0. Content checks below preserve the former protocol anchors.
function CheckWorkflowSkill($name, $patterns, $agent = "build") {
    $skill = Get-Content "$PSScriptRoot\..\skills\$name\SKILL.md" -Raw
    $launcher = Get-Content "$PSScriptRoot\..\commands\$name.md" -Raw
    Check "${name}: SKILL.md frontmatter names the skill" ($skill -match "name: $name")
    Check "${name}: SKILL.md description is on-demand (Load ONLY)" ($skill -match "Load ONLY")
    Check "${name}: launcher loads its skill and forwards arguments" ($launcher -match "Load the $name skill" -and $launcher -match '\$ARGUMENTS')
    if ($agent) {
        Check "${name}: launcher routes to @${agent}" ($launcher -match "agent: $agent")
    } else {
        Check "${name}: launcher has no agent restriction" ($launcher -notmatch "agent:")
    }
    foreach ($p in $patterns) {
        Check "${name}: protocol keeps '$p'" ($skill -match [regex]::Escape($p))
    }
}

# grill protocol was reworked to batch answering (question tool presents all
# questions at once) — assertions anchor on the current normative phrases.
CheckWorkflowSkill "grill-me" @("present all questions to the user at once", "recommended option FIRST", "## State machine", "Stop conditions", "Decision Brief")
CheckWorkflowSkill "grill-with-docs" @("Domain modeling", "CONTEXT.md", "ADR format", "Hard to reverse", "lazily", "Be opinionated", "present all questions to the user at once")
CheckWorkflowSkill "goal" @("golden template", "audit checklist", "Stop conditions", "Hard rules")
CheckWorkflowSkill "handoff" @("Git-safe directory only", "Reference, don't duplicate", "Redact sensitive information", "Suggested agents", "and continue from there") $null

# Remaining workflow skills: structural checks only (protocol bodies migrated
# verbatim; shipping is covered by the file-integrity list above).
# dev-plan/dev-quick/dev-review launchers now route to the dev compositor —
# their protocols live in skills/dev/SKILL.md (checked below).
foreach ($name in @("grill-improve-loop", "dev-ultra", "review-fix-loop", "review-report")) {
    CheckWorkflowSkill $name @()
}
Check "review-report documents durable-report boundaries" `
    ((Get-Content "$PSScriptRoot\\..\\skills\\review-report\\SKILL.md" -Raw) -match 'L2/L3' -and (Get-Content "$PSScriptRoot\\..\\skills\\review-report\\SKILL.md" -Raw) -match 'source, diffs, tool output')
Check "review records guide exists" (Test-Path "$PSScriptRoot\\..\\docs\\reviews\\README.md")

# dev-prud: anchors protect the register's core mechanics — surface binding,
# SEVxPROB tiering, blind-spot write-back, test materialization (@qa), and the
# non-exhaustive declaration.
CheckWorkflowSkill "dev-prud" @("Surface model", "SEV", "PROB", "Tier A", "missed-by-enumeration", "not exhaustive", "docs/risk/<topic>.md", "@qa", "test-scope")

# dev compositor: anchors protect flag grammar, preset routing, zero-loss
# passthrough, Safety-First arbitration, and the test-scope tier.
CheckWorkflowSkill "dev" @("--plan-review", "--code-review", "--sdd", "dev-quick", "dev-plan", "dev-review", "Zero-Loss", "Safety-First", "test-scope", "--auto-advisor")

# git-merge: anchors protect the stock-merge model, sync-first baseline,
# baseline-authority resolution, deletion-is-intent, confidence self-check +
# @advisor escalation, and verification.
# No agent frontmatter (3rd arg $null): handoff and git ops are current-session
# work — the launcher follows the current agent (lite by default).
# Coverage anchors (shared by the whole family) protect the ranked verify-command
# inference, the "halt is never a dead end" recovery rule, and the enumerated
# Outcome token that makes the autonomous-landing rate computable from
# .git/ocp-*-reports/*.md instead of being an unfalsifiable claim.
CheckWorkflowSkill "git-merge" @(
    "git merge --continue",
    "git pull --ff-only",
    "git merge-base",
    "authoritative baseline",
    "Never silently remove or undo target",
    "Deletion is intentional",
    "guard/",
    "instructions/verification-honesty.md",
    "modify/delete",
    "global coherence",
    ".git/ocp-merge-reports",
    "every invocation",
    "schema_version: 1",
    "command_start",
    "command_end",
    "prev_event_sha256",
    "argv",
    "exit_code",
    "SHA-256",
    "Confidence self-check",
    "@advisor",
    "FACTUAL + confidence",
    "best-effort",
    "Semantic evidence pass",
    "Repository-level semantic interaction audit",
    "ranked inference",
    "it is the reason to check rank 1",
    "A halt is never a dead end",
    "landed-no-verify-opt-in",
    "handed-over:"
) $null

# git-pull: ff-first sync of the current branch with its upstream; diverged →
# guard backup + delegation to the git-merge protocol (--rebase → git-rebase).
# Anchors protect the ff-only policy, the guard backup, both delegations, and
# the no-squash stance. Agent-less like git-merge (3rd arg $null).
CheckWorkflowSkill "git-pull" @(
    "git pull --ff-only",
    "git fetch <remote>",
    "guard/",
    "git-merge",
    "git-rebase",
    "never legitimate",
    "set-upstream-to",
    "Never describe these two orientations as identical",
    ".git/ocp-pull-reports",
    "every invocation",
    "schema_version: 1",
    "command_start",
    "command_end",
    "prev_event_sha256",
    "argv",
    "exit_code",
    "SHA-256",
    "A halt is never a dead end",
    "landed-fast-forward",
    "landed-no-verify-opt-in",
    "handed-over:",
    "token as the report"
) $null

# git-push: safe ordinary push; remote divergence → guarded reconciliation and
# retry; never silently force-push. Agent-less like the other git workflows.
CheckWorkflowSkill "git-push" @(
    "git fetch <remote>",
    "git-merge",
    "git-rebase",
    "non-fast-forward",
    "guard/",
    "force-with-lease",
    'Never use plain `--force`',
    '.git/ocp-push-reports',
    "every halt must name the next concrete action",
    "handed-over:"
) $null

# git-rebase: replay ALL of source's unique commits onto target HEAD, linear.
# Anchors protect the stock-rebase model, sync-first onto-baseline, both-tip
# guard backup, SELF-CONTAINED resolution (no git-merge delegation), whole-file
# coherence review, confidence self-check + @advisor escalation, decision-log
# archive, ff-only landing, force-with-lease rewrite safety. Agent-less like
# git-merge (3rd arg $null).
CheckWorkflowSkill "git-rebase" @(
    "rebase --reapply-cherry-picks --empty=stop",
    "git rebase --continue",
    "git pull --ff-only",
    "git merge --ff-only",
    "authoritative baseline",
    "force-with-lease",
    "guard/",
    "do NOT load another skill",
    "compose both parties",
    "global coherence",
    ".git/ocp-rebase-reports",
    "every invocation",
    "schema_version: 1",
    "command_start",
    "command_end",
    "prev_event_sha256",
    "argv",
    "exit_code",
    "SHA-256",
    "instructions/verification-honesty.md",
    "Confidence self-check",
    "@advisor",
    "FACTUAL + confidence",
    "best-effort",
    "Semantic evidence pass",
    "Repository-level semantic interaction audit",
    "--min-parents=2",
    "ranked inference",
    "it is the reason to check rank 1",
    "A halt is never a dead end",
    "landed-no-verify-opt-in",
    "topology-ambiguous"
) $null

# git-pick: selected or all source-only non-merge commits, linear ordinary
# cherry-picks, target baseline, conflict handover, and verification.
CheckWorkflowSkill "git-pick" @(
    "git cherry-pick",
    "--all",
    "--no-merges",
    "reverse topological order",
    "new ordinary one-parent commit",
    "authoritative baseline",
    "guard/",
    "git cherry-pick --continue",
    ".git/ocp-pick-reports",
    "every invocation",
    "schema_version: 1",
    "command_start",
    "command_end",
    "prev_event_sha256",
    "argv",
    "exit_code",
    "SHA-256",
    "Confidence",
    "@advisor",
    "FACTUAL",
    "Semantic evidence pass",
    "Repository-level semantic interaction audit",
    "--allow-empty --empty=stop",
    "ranked inference",
    "it is the reason to check rank 1",
    "A halt is never a dead end",
    "landed-no-verify-opt-in",
    "mainline-ambiguous",
    "## Failure catalog"
) $null

# Preset routers: the three dev-flow launchers load the dev skill with their
# preset expansion.
foreach ($preset in @("dev-quick", "dev-plan", "dev-review")) {
    $launcher = Get-Content "$PSScriptRoot\..\commands\$preset.md" -Raw
    Check "${preset}: launcher routes to the dev skill" ($launcher -match "Load the dev skill")
}

# Alias: /dev-flash launches the dev skill with the dev-quick preset
$flashLauncher = Get-Content "$PSScriptRoot\..\commands\dev-flash.md" -Raw
Check "dev-flash: alias launcher loads the dev skill with dev-quick preset" (($flashLauncher -match "dev skill") -and ($flashLauncher -match "dev-quick preset"))

# Shared project-config plumbing (plugins/shared/opencode-prime.ts — used by adr-guard, env-guard, e2e-guard, auto-advisor)
$sharedConfig = Get-Content "$PSScriptRoot\..\plugins\shared\opencode-prime.ts" -Raw
Check "shared/opencode-prime.ts: exports never-throw field writer" ($sharedConfig -match 'export function setConfigField')
Check "shared/opencode-prime.ts: exports field remover" ($sharedConfig -match 'export function clearConfigField')
Check "shared/opencode-prime.ts: exports quote-aware stripJsonc" ($sharedConfig -match 'export function stripJsonc')
Check "shared/opencode-prime.ts: exports project config file resolution" ($sharedConfig -match 'export function projectConfigFiles')

# ADR iron-law plugin checks (plugins/adr-guard/ — project-level switch, hard commit gate)
$adrPlugin = Get-Content "$PSScriptRoot\..\plugins\adr-guard\adr-guard.ts" -Raw
$adrProtocol = Get-Content "$PSScriptRoot\..\plugins\adr-guard\adr-guard-protocol.md" -Raw
$adrGuard = Get-Content "$PSScriptRoot\..\plugins\adr-guard\adr-guard-tool-guard.ts" -Raw
$adrConfig = Get-Content "$PSScriptRoot\..\plugins\adr-guard\adr-guard-config.ts" -Raw
Check "adr-guard.ts: imports Plugin type" ($adrPlugin -match "import type.*Plugin.*from.*@opencode-ai/plugin")
Check "adr-guard.ts: has config hook registering command" ($adrPlugin -match "config:" -and $adrPlugin -match 'COMMAND_NAME')
Check "adr-guard.ts: has command.execute.before hook" ($adrPlugin -match '"command\.execute\.before"')
Check "adr-guard.ts: has system.transform hook" ($adrPlugin -match "experimental.chat.system.transform")
Check "adr-guard.ts: has tool.execute.before hook" ($adrPlugin -match '"tool\.execute\.before"')
Check "adr-guard.ts: injects project directory" ($adrPlugin -match "setProjectDir\(directory\)")
Check "adr-guard-config.ts: switch stored in project opencode.jsonc (no state file)" ($adrConfig -match 'shared/opencode-prime' -and $adrConfig -match 'adrGuard')
Check "adr-guard-config.ts: default state is off" ($adrConfig -match 'DEFAULT_STATE: GuardState = "off"')
Check "adr-guard-config.ts: default ADR dir docs/adr" ($adrConfig -match 'DEFAULT_ADR_DIR = "docs/adr"')
Check "adr-guard-tool-guard.ts: gates feat/refactor only" ($adrGuard -match "requiresAdr")
Check "adr-guard-tool-guard.ts: checks ADR working-tree changes" ($adrGuard -match "hasAdrChanges")
Check "adr-guard-protocol.md: has iron law" ($adrProtocol -match "iron law")
Check "adr-guard-protocol.md: has MADR frontmatter" ($adrProtocol -match "status: accepted" -and $adrProtocol -match "date:")
Check "adr-guard-protocol.md: has sequential numbering" ($adrProtocol -match "NNNN-slug")
Check "adr-guard-protocol.md: forbids type relabeling bypass" ($adrProtocol -match "MUST NOT" -and $adrProtocol -match "relabeling the commit type")

$adrBarrel = Get-Content "$PSScriptRoot\..\plugins\adr-guard.ts" -Raw
Check "adr-guard.ts: barrel re-exports AdrGuardPlugin" ($adrBarrel -match "export.*AdrGuardPlugin")

# Env guard plugin checks (plugins/env-guard/ — project-level switch, secret-file gate)
$egPlugin = Get-Content "$PSScriptRoot\..\plugins\env-guard\env-guard.ts" -Raw
$egConfig = Get-Content "$PSScriptRoot\..\plugins\env-guard\env-guard-config.ts" -Raw
$egRuntime = Get-Content "$PSScriptRoot\..\plugins\env-guard\env-guard-runtime.ts" -Raw
$egGuard = Get-Content "$PSScriptRoot\..\plugins\env-guard\env-guard-tool-guard.ts" -Raw
Check "env-guard.ts: imports Plugin type" ($egPlugin -match "import type.*Plugin.*from.*@opencode-ai/plugin")
Check "env-guard.ts: has tool.execute.before hook" ($egPlugin -match '"tool\.execute\.before"')
Check "env-guard.ts: injects project directory" ($egPlugin -match "setProjectDir\(directory\)")
Check "env-guard-config.ts: switch stored in project opencode.jsonc (no state file)" ($egConfig -match 'shared/opencode-prime' -and $egConfig -match 'envGuard')
Check "env-guard-config.ts: default state is off" ($egConfig -match 'DEFAULT_STATE: GuardState = "off"')
Check "env-guard-config.ts: config field envGuard" ($egConfig -match "envGuard")
Check "env-guard-runtime.ts: exempts .env.example" ($egRuntime -match '\.env\.example')
Check "env-guard-runtime.ts: bash leak detection" ($egRuntime -match "bashLeaksEnv")
Check "env-guard-tool-guard.ts: gates file tools" ($egGuard -match "multiedit")
Check "env-guard-tool-guard.ts: gates grep tool" ($egGuard -match '"grep"')
Check "env-guard-tool-guard.ts: gates bash via leak detection" ($egGuard -match "bashLeaksEnv")
Check "env-guard-tool-guard.ts: reuses adr-guard-runtime parsing" ($egGuard -match "adr-guard/adr-guard-runtime")

$egBarrel = Get-Content "$PSScriptRoot\..\plugins\env-guard.ts" -Raw
Check "env-guard.ts: barrel re-exports EnvGuardPlugin" ($egBarrel -match "export.*EnvGuardPlugin")

# E2E guard plugin checks (plugins/e2e-guard/ — project-level switch, prompt-injected protocol)
$e2ePlugin = Get-Content "$PSScriptRoot\..\plugins\e2e-guard\e2e-guard.ts" -Raw
$e2eConfig = Get-Content "$PSScriptRoot\..\plugins\e2e-guard\e2e-guard-config.ts" -Raw
$e2eProtocol = Get-Content "$PSScriptRoot\..\plugins\e2e-guard\e2e-guard-protocol.md" -Raw
$e2eInstr = Get-Content "$PSScriptRoot\..\plugins\e2e-guard\e2e-guard-instructions.ts" -Raw
$e2eInject = Get-Content "$PSScriptRoot\..\plugins\e2e-guard\e2e-guard-system-inject.ts" -Raw
Check "e2e-guard.ts: imports Plugin type" ($e2ePlugin -match "import type.*Plugin.*from.*@opencode-ai/plugin")
Check "e2e-guard.ts: registers the command via config hook" ($e2ePlugin -match "config:" -and $e2ePlugin -match "COMMAND_NAME" -and $e2ePlugin -match '"command\.execute\.before"')
Check "e2e-guard.ts: has system.transform hook" ($e2ePlugin -match "experimental\.chat\.system\.transform")
Check "e2e-guard.ts: injects project directory" ($e2ePlugin -match "setProjectDir\(directory\)")
Check "e2e-guard-config.ts: switch stored in project opencode.jsonc (no state file)" ($e2eConfig -match 'shared/opencode-prime' -and $e2eConfig -match 'e2eGuard')
Check "e2e-guard-config.ts: default state is off" ($e2eConfig -match 'DEFAULT_STATE: GuardState = "off"')
Check "e2e-guard-protocol.md: specifies feat and fix triggers" ($e2eProtocol -match "feat" -and $e2eProtocol -match "fix")
Check "e2e-guard-protocol.md: includes test gap / case supplement check" ($e2eProtocol -match "Test Gap" -or $e2eProtocol -match "Supplement")
Check "e2e-guard-protocol.md: requires interactive ask with user" ($e2eProtocol -match "ask" -or $e2eProtocol -match "Interactive")
Check "e2e-guard-instructions.ts: exports marker and prompt builder" ($e2eInstr -match "MARKER_ON" -and $e2eInstr -match "getGuardPrompt")
Check "e2e-guard-system-inject.ts: transforms system prompt on/off" ($e2eInject -match "stripMarker" -and $e2eInject -match "appendPrompt")

$e2eCmd = Get-Content "$PSScriptRoot\..\plugins\e2e-guard\e2e-guard-command.ts" -Raw
Check "e2e-guard-command.ts: status subcommand" ($e2eCmd -match "SUBCOMMAND_STATUS" -and $e2eCmd -match "statusText")
Check "e2e-guard-command.ts: on/off writes the project switch" ($e2eCmd -match "SUBCOMMAND_ON" -and $e2eCmd -match "SUBCOMMAND_OFF" -and $e2eCmd -match "setState")
Check "e2e-guard-command.ts: visible response via output.parts" ($e2eCmd -match "output\.parts =")

$e2eBarrel = Get-Content "$PSScriptRoot\..\plugins\e2e-guard.ts" -Raw
Check "e2e-guard.ts: barrel re-exports E2eGuardPlugin" ($e2eBarrel -match "export.*E2eGuardPlugin")

# Project manager plugin checks (plugins/project-manager/ — file-as-switch commit discipline)
$pmPlugin = Get-Content "$PSScriptRoot\..\plugins\project-manager\project-manager.ts" -Raw
$pmConfig = Get-Content "$PSScriptRoot\..\plugins\project-manager\project-manager-config.ts" -Raw
$pmScaffold = Get-Content "$PSScriptRoot\..\plugins\project-manager\project-manager-scaffold.ts" -Raw
$pmGitTemplate = Get-Content "$PSScriptRoot\..\plugins\project-manager\templates\git-commits.md" -Raw
$pmInject = Get-Content "$PSScriptRoot\..\plugins\project-manager\project-manager-system-inject.ts" -Raw
$pmGuard = Get-Content "$PSScriptRoot\..\plugins\project-manager\project-manager-tool-guard.ts" -Raw
Check "project-manager.ts: imports Plugin type" ($pmPlugin -match "import type.*Plugin.*from.*@opencode-ai/plugin")
Check "project-manager.ts: has config hook registering command" ($pmPlugin -match "config:" -and $pmPlugin -match 'COMMAND_NAME')
Check "project-manager.ts: has command.execute.before hook" ($pmPlugin -match '"command\.execute\.before"')
Check "project-manager.ts: has system.transform hook" ($pmPlugin -match "experimental.chat.system.transform")
Check "project-manager.ts: has tool.execute.before hook" ($pmPlugin -match '"tool\.execute\.before"')
Check "project-manager.ts: injects project directory" ($pmPlugin -match "setProjectDir\(directory\)")
Check "project-manager-config.ts: file-as-switch predicate" ($pmConfig -match "hasConventionFile")
Check "project-manager-config.ts: GIT_COMMITS_REL = docs/git-commits.md" ($pmConfig -match 'GIT_COMMITS_REL = "docs/git-commits\.md"')
Check "project-manager-scaffold.ts: existence check before write" ($pmScaffold -match "existsSync")
Check "project-manager-scaffold.ts: templates loaded from templates/ dir" ($pmScaffold -match "readTemplate" -and $pmScaffold -match "templates")
Check "project-manager-scaffold.ts: append-only config sync" ($pmScaffold -match "mergeSwitchLines" -and $pmScaffold -match "runSync")
Check "templates/git-commits.md: documents mechanical enforcement" ($pmGitTemplate -match "mechanically enforced")
Check "project-manager-system-inject.ts: progressive disclosure (no full-content injection)" ($pmInject -match "progressive" -and $pmInject -notmatch "readFileSync")
Check "project-manager-system-inject.ts: line-start marker dedup" ($pmInject -match "MARKER_RE")
Check "project-manager-system-inject.ts: appends to last entry only" ($pmInject -match "system\.length - 1")
Check "project-manager-tool-guard.ts: structural validator" ($pmGuard -match "validateMessage")
Check "project-manager-tool-guard.ts: 72-char first-line cap" ($pmGuard -match "MAX_FIRST_LINE = 72")
Check "project-manager-tool-guard.ts: reuses adr-guard-runtime parsing" ($pmGuard -match "adr-guard/adr-guard-runtime")
Check "project-manager-tool-guard.ts: --amend exempt per invocation" ($pmGuard -match "--amend")
Check "project-manager-tool-guard.ts: merge/revert/fixup/squash exempt" ($pmGuard -match "Merge.*Revert.*fixup.*squash" -or $pmGuard -match "EXEMPT_PREFIX_RE")

$pmBarrel = Get-Content "$PSScriptRoot\..\plugins\project-manager.ts" -Raw
Check "project-manager.ts: barrel re-exports ProjectManagerPlugin" ($pmBarrel -match "export.*ProjectManagerPlugin")

# Queue manager plugin checks (plugins/tui/queue-manager.ts — TUI-only, registered via tui.template.jsonc)
$qmPlugin = Get-Content "$PSScriptRoot\..\plugins\tui\queue-manager.ts" -Raw
Check "queue-manager.ts: imports TuiPlugin from plugin/tui" ($qmPlugin -match "@opencode-ai/plugin/tui")
Check "queue-manager.ts: slash command name is queued" ($qmPlugin -match 'SLASH_NAME = "queued"')
Check "queue-manager.ts: registers palette command with slashName" ($qmPlugin -match "slashName: SLASH_NAME" -and $qmPlugin -match 'namespace: "palette"')
Check "queue-manager.ts: cancel uses session.deleteMessage" ($qmPlugin -match "session\.deleteMessage")
Check "queue-manager.ts: busy fallback strips via part.update" ($qmPlugin -match "part\.update")
Check "queue-manager.ts: tombstone for busy-cancelled messages" ($qmPlugin -match "TOMBSTONE")
Check "queue-manager.ts: exports pure helpers for unit tests" ($qmPlugin -match "export function computeQueued")
$tuiTemplateRaw = Get-Content "$PSScriptRoot\..\tui.template.jsonc" -Raw
# TUI plugin registration paths carry a leading ./ (opencode resolves them
# relative to the config dir).
Check "tui.template.jsonc: queue-manager registered in plugin array" ($tuiTemplateRaw -match '"\./plugins/tui/queue-manager\.ts"')

# Usage plugin checks (plugins/tui/usage.ts — TUI-only, registered via tui.template.jsonc)
$mtPlugin = Get-Content "$PSScriptRoot\..\plugins\tui\usage.ts" -Raw
Check "usage.ts: imports TuiPlugin from plugin/tui" ($mtPlugin -match "@opencode-ai/plugin/tui")
Check "usage.ts: slash command name is usage (bare, TUI prepends /)" ($mtPlugin -match 'SLASH_NAME = "usage"')
Check "usage.ts: registers palette command with slashName" ($mtPlugin -match "slashName: SLASH_NAME" -and $mtPlugin -match 'namespace: "palette"')
Check "usage.ts: exports default TuiPluginModule with id" ($mtPlugin -match "export default plugin")
Check "tui.template.jsonc: usage registered in plugin array" ($tuiTemplateRaw -match '"\.\/plugins\/tui\/usage\.ts"')

# Project wizard plugin checks (plugins/tui/project-wizard.ts — TUI-only, registered via tui.template.jsonc)
$pwPlugin = Get-Content "$PSScriptRoot\..\plugins\tui\project-wizard.ts" -Raw
Check "project-wizard.ts: imports TuiPlugin from plugin/tui" ($pwPlugin -match "@opencode-ai/plugin/tui")
Check "project-wizard.ts: registers palette command with slashName project-wizard" ($pwPlugin -match 'slashName: "project-wizard"' -and $pwPlugin -match 'namespace: "palette"')
Check "project-wizard.ts: supports re-entrant switch detection" ($pwPlugin -match "detectCurrentSwitches")
Check "tui.template.jsonc: project-wizard registered in plugin array" ($tuiTemplateRaw -match '"\./plugins/tui/project-wizard\.ts"')

# Profile wizard plugin checks (plugins/tui/profile-wizard.ts — TUI-only, registered via tui.template.jsonc)
$pfPlugin = Get-Content "$PSScriptRoot\..\plugins\tui\profile-wizard.ts" -Raw
$i18nContent = Get-Content "$PSScriptRoot\..\plugins\tui\i18n.ts" -Raw
Check "profile-wizard.ts: imports TuiPlugin from plugin/tui" ($pfPlugin -match "@opencode-ai/plugin/tui")
Check "profile-wizard.ts: slash command name is profile" ($pfPlugin -match 'slashName: "profile"')
Check "profile-wizard.ts: registers palette command" ($pfPlugin -match 'namespace: "palette"')
Check "profile-wizard.ts: has Edit agent→tier mapping sub-menu" ($pfPlugin -match "EDIT_TIERS")
Check "profile-wizard.ts: has editAgentTier function" ($pfPlugin -match "function editAgentTier")
Check "profile-wizard.ts: has Edit tier→model live sub-menu" ($pfPlugin -match "EDIT_TIER_MODELS")
Check "profile-wizard.ts: has editTierModels function" ($pfPlugin -match "function editTierModels")
Check "profile-wizard.ts: has applyTierModelChanges function" ($pfPlugin -match "async function applyTierModelChanges")
Check "profile-wizard.ts: live tier→model syncs active profile file" ($pfPlugin -match "writeProfileAtomic\(activeName")
Check "profile-wizard.ts: profile selection has confirm gate showing tier→model" ($pfPlugin -match "function confirmApplyProfile")
Check "profile-wizard.ts: delete lives in tier review, goes straight to confirm dialog" (($pfPlugin -match "confirmDeleteProfile\(api, name, profile, overrides\)") -and ($pfPlugin -notmatch "promptDeleteProfile"))
Check "profile-wizard.ts: dialogs group data vs actions via category headers, no fake divider rows" (($pfPlugin -match "profile\.actionsHeader") -and ($pfPlugin -notmatch 'option\.value === SEP') -and ($i18nContent -notmatch "function sepItem"))
Check "profile-wizard.ts: has pickAgentTier function" ($pfPlugin -match "function pickAgentTier")
Check "profile-wizard.ts: has applyAgentTierChanges function" ($pfPlugin -match "async function applyAgentTierChanges")
Check "profile-wizard.ts: has writeTiersFileAtomic function" ($pfPlugin -match "function writeTiersFileAtomic")
Check "profile-wizard.ts: has VALID_TIERS constant" ($pfPlugin -match "VALID_TIERS")
Check "profile-wizard.ts: tier editor writes tiers.json atomically" ($pfPlugin -match "writeTiersFileAtomic")
Check "profile-wizard.ts: tier editor live-applies via global config API" ($pfPlugin -match "applyLive")
Check "profile-wizard.ts: reset strips model refs and deactivates profile" (($pfPlugin -match "function resetModels") -and ($pfPlugin -match "export function stripModelRefs") -and ($pfPlugin -match "confirmReset"))
Check "profile-wizard.ts: /profile reset subcommand parses via ctx" ($pfPlugin -match "export function parseProfileSubcommand")
Check "profile-wizard.ts: reset keeps profiles and tiers.json (confirm gate)" ($pfPlugin -match "profile\.resetMsg")
Check "profile-wizard.ts: no explicit back items, Esc is the only back nav" (($pfPlugin -notmatch '"__back__"') -and ($pfPlugin -match 'navigated'))
Check "tui.template.jsonc: profile-wizard registered in plugin array" ($tuiTemplateRaw -match '"\./plugins/tui/profile-wizard\.ts"')

# SDD plugin checks (plugins/sdd/ — engine-only; commands live in commands/*.md,
# the protocol lives at L2 in skills/sdd-workflow/SKILL.md)
$sddPlugin = Get-Content "$PSScriptRoot\..\plugins\sdd\sdd.ts" -Raw
$sddSkill = Get-Content "$PSScriptRoot\..\skills\sdd-workflow\SKILL.md" -Raw
$sddEngine = Get-Content "$PSScriptRoot\..\plugins\sdd\sdd-engine.ts" -Raw
$sddCommand = Get-Content "$PSScriptRoot\..\plugins\sdd\sdd-command.ts" -Raw
Check "sdd.ts: imports Plugin type" ($sddPlugin -match "import type.*Plugin.*from.*@opencode-ai/plugin")
Check "sdd.ts: has command.execute.before hook" ($sddPlugin -match '"command\.execute\.before"')
Check "sdd.ts: engine-only (no config hook, no system injection)" (($sddPlugin -notmatch "config:") -and ($sddPlugin -notmatch "experimental\.chat\.system\.transform"))
Check "sdd-workflow SKILL.md: specifies PRD -> ADR -> PLAN -> IMPL lifecycle" ($sddSkill -match "PRD" -and $sddSkill -match "ADR" -and $sddSkill -match "PLAN" -and $sddSkill -match "IMPL")
Check "sdd-engine.ts: has slugify helper" ($sddEngine -match "export function slugify")
Check "sdd-engine.ts: has scaffoldPrd" ($sddEngine -match "export function scaffoldPrd")
Check "sdd-engine.ts: has scaffoldPlan" ($sddEngine -match "export function scaffoldPlan")
Check "sdd-engine.ts: has listSddArtifacts" ($sddEngine -match "export function listSddArtifacts")
Check "sdd-command.ts: supports prd, adr, plan, impl, handoff" ($sddCommand -match "prd" -and $sddCommand -match "adr" -and $sddCommand -match "plan" -and $sddCommand -match "impl" -and $sddCommand -match "handoff")

$sddBarrel = Get-Content "$PSScriptRoot\..\plugins\sdd.ts" -Raw
Check "sdd.ts: barrel re-exports SddPlugin" ($sddBarrel -match "export.*SddPlugin")

# Advisor command checks (via auto-advisor plugin)
$advisorCmd = Get-Content "$PSScriptRoot\..\plugins\auto-advisor\auto-advisor-instructions.ts" -Raw
Check "auto-advisor: has advisor protocol text" ($advisorCmd.Length -gt 0)
Check "auto-advisor: lists all 3 modes (off/lite/full)" `
    (($advisorCmd -match "lite") -and ($advisorCmd -match "full") -and ($advisorCmd -match "off"))
Check "auto-advisor: references @advisor dispatch" ($advisorCmd -match "@advisor")
Check "auto-advisor: mentions blocking decisions" ($advisorCmd -match "blocking")
Check "auto-advisor: references confidence score" ($advisorCmd -match "confidence")
Check "auto-advisor: mentions threshold 8" ($advisorCmd -match "8")
Check "auto-advisor: mentions auto-execute or direct" ($advisorCmd -match "auto-execute" -or $advisorCmd -match "directly")

# Advisor agent checks (frontmatter-free prompts/: mode/permission live in the
# template — the single source of truth, verified v1.18.25)
$advisorAgent = Get-Content "$PSScriptRoot\..\prompts\advisor.md" -Raw
Check "template: advisor mode is subagent" ($config.agent.advisor.mode -eq "subagent")
# Model binding: the template ships no model presets (fresh installs use opencode's
# default until /profile apply materializes tiers.json). Tier mapping lives in tiers.json.
Check "opencode.template.jsonc: advisor ships without a model preset (inherits default until /profile)" ($null -eq $config.agent.advisor.model)
Check "template: advisor is read-only (edit deny)" ($config.agent.advisor.permission.edit -eq "deny")
Check "advisor.md: no ask-user language" (-not ($advisorAgent -match "ask the user" -or $advisorAgent -match "ask a focused question"))
Check "advisor.md: has output format" ($advisorAgent -match "Output format")
Check "advisor.md: states recommendation requirement" ($advisorAgent -match "ALWAYS state your recommendation")
Check "advisor.md: has confidence score" ($advisorAgent -match "confidence score")
Check "advisor.md: has confidence in output format" ($advisorAgent -match "Confidence.*1-10")

# Auto-advisor mode plugin checks (split into multiple files under plugins/auto-advisor/)
$advisorPlugin = Get-Content "$PSScriptRoot\..\plugins\auto-advisor-mode.ts" -Raw
Check "auto-advisor-mode.ts: imports Plugin type" ($advisorPlugin -match "import type.*Plugin.*from.*@opencode-ai/plugin")
Check "auto-advisor-mode.ts: has command.execute.before hook" ($advisorPlugin -match "command.execute.before")
Check "auto-advisor-mode.ts: has system.transform hook" ($advisorPlugin -match "experimental.chat.system.transform")
Check "auto-advisor-mode.ts: has tool.execute.before hook" ($advisorPlugin -match "tool.execute.before")
Check "auto-advisor-mode.ts: has tool.execute.after hook" ($advisorPlugin -match "tool.execute.after")
Check "auto-advisor-mode.ts: no event hook (session announce moved to sidebar-status slot)" ($advisorPlugin -notmatch "event: makeAnnounceHook")
Check "auto-advisor-mode.ts: thin glue (<70 lines)" (($advisorPlugin -split "`n").Count -lt 70)

$advisorConfig = Get-Content "$PSScriptRoot\..\plugins\auto-advisor\auto-advisor-config.ts" -Raw
Check "auto-advisor-config.ts: has COMMAND_NAME constant" ($advisorConfig -match "COMMAND_NAME")
Check "auto-advisor-config.ts: has getMode function" ($advisorConfig -match "getMode")
Check "auto-advisor-config.ts: has setMode function" ($advisorConfig -match "setMode")
Check "auto-advisor-config.ts: has isOn function" ($advisorConfig -match "isOn")
Check "auto-advisor-config.ts: defaults to off" ($advisorConfig -match "DEFAULT_MODE.*off")
Check "auto-advisor-config.ts: has parseModeArg" ($advisorConfig -match "parseModeArg")

$advisorToolGuard = Get-Content "$PSScriptRoot\..\plugins\auto-advisor\auto-advisor-tool-guard.ts" -Raw
Check "auto-advisor-tool-guard.ts: no hard block for advisor when off" `
    (-not ($advisorToolGuard -match "isOn" -and $advisorToolGuard -match "isAdvisorDispatch.*throw"))
Check "auto-advisor-tool-guard.ts: has makeToolGuardHook" ($advisorToolGuard -match "makeToolGuardHook")

$advisorInstructions = Get-Content "$PSScriptRoot\..\plugins\auto-advisor\auto-advisor-instructions.ts" -Raw
Check "auto-advisor-instructions.ts: embeds PROTOCOL string" ($advisorInstructions -match "PROTOCOL")
Check "auto-advisor-instructions.ts: has MODE_MARKER for 3 modes (off/lite/full)" `
    (($advisorInstructions -match "lite") -and ($advisorInstructions -match "full") -and ($advisorInstructions -match "off"))
Check "auto-advisor-instructions.ts: has getAdvisorPrompt" ($advisorInstructions -match "getAdvisorPrompt")
Check "auto-advisor-instructions.ts: has fullDirective" ($advisorInstructions -match "fullDirective")
# Recommended-option-first now lives in output-protocol.md (covered by
# test-decisions.ps1); instructions.ts keeps the PREFERENCE gate instead.
Check "auto-advisor-instructions.ts: PREFERENCE routes to lite flow" ($advisorInstructions -match "PREFERENCE or < 8")

# Red-team stance (optional adversarial mode on @advisor). The stance rules
# live in prompts/advisor.md; auto-advisor-runtime.ts keeps the code-level guard.
Check "advisor.md: has red-team stance section" ($advisorAgent -match "Stance: red-team")
Check "advisor.md: red-team forbids confidence score" ($advisorAgent -match "NEVER output a confidence score in red-team")
Check "advisor.md: has verdict vocabulary" `
    (($advisorAgent -match "HOLDS") -and ($advisorAgent -match "FAILS"))
Check "advisor.md: red-team never auto-executes" ($advisorAgent -match "Adversarial output must never trigger auto-execution")
Check "advisor.md: FAILS verdict goes back to user" ($advisorAgent -match "only they can override a FAILS")
Check "advisor.md: FAILS routes rebuttal to design owner" ($advisorAgent -match "Route the rebuttal to the design owner")
Check "advisor.md: no blue team rule" ($advisorAgent -match "no blue team")

# Red-team auto-execute hard guard (code-level, not prompt-level)
$advisorRuntime = Get-Content "$PSScriptRoot\..\plugins\auto-advisor\auto-advisor-runtime.ts" -Raw
Check "auto-advisor-runtime.ts: has isRedTeamOutput guard" ($advisorRuntime -match "isRedTeamOutput")
Check "auto-advisor-runtime.ts: detects verdict marker" ($advisorRuntime -match "Verdict")

# Question-class gate: full-mode auto-answer requires FACTUAL classification;
# PREFERENCE questions always return to the user, in any mode.
Check "auto-advisor-runtime.ts: has detectQuestionClass gate" ($advisorRuntime -match "detectQuestionClass")
Check "auto-advisor-instructions.ts: defines question class" ($advisorInstructions -match "FACTUAL")
Check "auto-advisor-instructions.ts: PREFERENCE never auto-answered" ($advisorInstructions -match "PREFERENCE")
Check "auto-advisor-instructions.ts: lite never answers for user" ($advisorInstructions -match "NEVER answers on the user's behalf")
Check "advisor.md: outputs question class" ($advisorAgent -match "Question class")
Check "advisor.md: classifies every question" ($advisorAgent -match "ALWAYS classify the question")

$advisorFullInject = Get-Content "$PSScriptRoot\..\plugins\auto-advisor\auto-advisor-full-inject.ts" -Raw
Check "auto-advisor-full-inject.ts: suppresses red-team output" ($advisorFullInject -match "isRedTeamOutput")
Check "auto-advisor-full-inject.ts: has fallback warning path" ($advisorFullInject -match "fallbackWarning")
Check "auto-advisor-full-inject.ts: requires FACTUAL class for auto-answer" ($advisorFullInject -match "detectQuestionClass")

# Session-created announce + /auto-advisor switch feedback (user visibility)
$advisorAnnounce = Get-Content "$PSScriptRoot\..\plugins\auto-advisor\auto-advisor-announce.ts" -Raw
# Session announce moved to the TUI sidebar-status slot; announce.ts is now
# toast-only feedback for /auto-advisor switches.
Check "auto-advisor-announce.ts: has announceSwitch for /auto-advisor" ($advisorAnnounce -match "announceSwitch")
Check "auto-advisor-announce.ts: sidebar-status slot replaces session announce" ($advisorAnnounce -match "sidebar-status")
Check "auto-advisor-announce.ts: full-mode message names auto-answer risk" ($advisorAnnounce -match "answer blocking questions on your")
Check "auto-advisor-announce.ts: toast via tui.showToast" ($advisorAnnounce -match "showToast")
Check "auto-advisor-announce.ts: degrades to log without TUI" ($advisorAnnounce -match "no TUI")
$advisorTracker = Get-Content "$PSScriptRoot\..\plugins\auto-advisor\auto-advisor-mode-tracker.ts" -Raw
Check "auto-advisor-mode-tracker.ts: switch gives user-visible feedback" ($advisorTracker -match "announceSwitch")

# Advisor e2e test aligns with the current command surface
$advisorE2e = Get-Content "$PSScriptRoot\test-advisor-e2e.ps1" -Raw
Check "test-advisor-e2e.ps1: uses /auto-advisor <mode> form" ($advisorE2e -match "/auto-advisor ")
Check "test-advisor-e2e.ps1: uses only auto-advisor command" `
    (($advisorE2e -notmatch "advisor-on") -and ($advisorE2e -notmatch "advisor-decisive") -and ($advisorE2e -notmatch "--command advisor-"))
Check "test-advisor-e2e.ps1: covers invalid-argument no-op" ($advisorE2e -match "banana")

Write-Host ""
Write-Host "========================================" -ForegroundColor Yellow
foreach ($r in $results) {
    if ($r -match "PASS") { Write-Host "  $r" -ForegroundColor Green }
    else { Write-Host "  $r" -ForegroundColor Red }
}
Write-Host "========================================" -ForegroundColor Yellow
Write-Host "  Structural: Passed=$pass Failed=$fail" -ForegroundColor $(if ($fail -eq 0) { "Green" } else { "Red" })
Write-Host "========================================" -ForegroundColor Yellow

# ============================================================================

# Decision strategy structural checks
pwsh -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\test-decisions.ps1"
if ($LASTEXITCODE -ne 0) { $fail++ }

# Profile presets: apply each to a fresh template copy and assert refs
# (no API calls; model existence check auto-skips without the opencode CLI)
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Profiles: profiles/ stress test" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
pwsh -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\test-profiles.ps1"
if ($LASTEXITCODE -ne 0) { $fail++ }

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Unit Tests: SDD & Plugin Ecosystem" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
& bun "$PSScriptRoot\test-sdd-unit.ts"
if ($LASTEXITCODE -ne 0) { $fail++ }
& bun "$PSScriptRoot\test-adr-guard-unit.ts"
if ($LASTEXITCODE -ne 0) { $fail++ }
& bun "$PSScriptRoot\test-adr-hierarchical-unit.ts"
if ($LASTEXITCODE -ne 0) { $fail++ }
& bun "$PSScriptRoot\test-lite-mode-unit.ts"
if ($LASTEXITCODE -ne 0) { $fail++ }
& bun "$PSScriptRoot\test-plugin-scope-unit.ts"
if ($LASTEXITCODE -ne 0) { $fail++ }
& bun "$PSScriptRoot\test-project-profiler-unit.ts"
if ($LASTEXITCODE -ne 0) { $fail++ }
& bun "$PSScriptRoot\test-project-dprint-unit.ts"
if ($LASTEXITCODE -ne 0) { $fail++ }
& bun "$PSScriptRoot\test-package-manager-unit.ts"
if ($LASTEXITCODE -ne 0) { $fail++ }
& bun "$PSScriptRoot\test-shell-command-unit.ts"
if ($LASTEXITCODE -ne 0) { $fail++ }
& bun "$PSScriptRoot\test-session-clean-flags-unit.ts"
if ($LASTEXITCODE -ne 0) { $fail++ }
& bun "$PSScriptRoot\test-auto-format-unit.ts"
if ($LASTEXITCODE -ne 0) { $fail++ }
& bun "$PSScriptRoot\test-lite-tools-unit.ts"
if ($LASTEXITCODE -ne 0) { $fail++ }
& bun "$PSScriptRoot\test-model-preserve-unit.ts"
if ($LASTEXITCODE -ne 0) { $fail++ }
& bun "$PSScriptRoot\test-profile-reset-unit.ts"
if ($LASTEXITCODE -ne 0) { $fail++ }

# Prompt tests (API calls) — skipped under -StructuralOnly (CI mode)
# ============================================================================

if (-not $StructuralOnly) {

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Test 1: build agent (custom prompt)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
pwsh -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\test-build.ps1"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Test 2: plan orchestrator (custom prompt)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
pwsh -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\test-plan.ps1"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Test 3: subagent via build agent dispatch" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
pwsh -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\test-subagent.ps1"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Test 4: default agent (no custom prompt)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
pwsh -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\test-default.ps1"

Write-Host ""
Write-Host "========================================" -ForegroundColor Yellow
Write-Host "  ALL TESTS COMPLETE" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow

} else {
    Write-Host ""
    Write-Host "  StructuralOnly: API-based prompt tests skipped" -ForegroundColor DarkGray
}

# Exit code reflects structural + decision check results (API prompt tests
# run as child scripts and report their own output).
if ($fail -gt 0) { exit 1 }
exit 0
