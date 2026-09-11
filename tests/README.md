# Multi-Agent System Tests

Tests for verifying that `opencode.template.jsonc` correctly wires the agent ecosystem: instruction L0 (iron rules), per-agent L1 prompts, optional MCP servers, and the opt-in npm plugin set (no plugin is default-on; OCP ships no `cp-triage`-conflicting third-party framing).

## Prerequisites

Ensure these environment variables are set in your system (PowerShell profile or session):

```powershell
$env:LLM_ROUTER_BASE_URL = "https://router.agent.byteswim.cn/v1"
$env:LLM_ROUTER_API_KEY = "<your-api-key>"
```

## Tests

| Script | What it tests |
|--------|---------------|
| `test-all.ps1` | Runner — structural checks + all prompt tests |
| `test-decisions.ps1` | Decision strategy structural checks (invoked by test-all) |
| `test-profiles.ps1` | profiles/ stress test: every profile applied to a fresh template copy, refs asserted (no API calls) |
| `test-build.ps1` | Primary build agent follows Output Protocol |
| `test-plan.ps1` | Primary plan agent follows Output Protocol |
| `test-subagent.ps1` | Subagent dispatched by build agent follows Output Protocol |
| `test-default.ps1` | Default build agent (no custom prompt) — baseline |
| `test-sdd-unit.ts` | SDD (Specification-Driven Development) unit tests (no API, 49 assertions) — PRD/ADR/Plan scaffolding, Unicode slugs, fuzzy matching, /sdd handoff |
| `test-adr-guard-unit.ts` | ADR Guard unit tests (no API, 96 assertions) — MADR generation, auto-drafting, index sync, supersede, check, Git gate |
| `test-adr-hierarchical-unit.ts` | Hierarchical ADR unit tests (no API, 46 assertions) — 3-layer architecture, migrate flat/hierarchical, auto detection |
| `test-md-to-docx-unit.ts` | Markdown to Word (.docx) export unit tests (no API, 24 assertions) — Pandoc engine, reference docx, styles |
| `test-md-to-pdf-unit.ts` | Markdown to PDF export unit tests (no API, 18 assertions) — Puppeteer/Typst engine, offline Mermaid |
| `test-anchor-unit.ts` | DeepSeek Anchor plugin unit tests (no API, 46 assertions) — verifies anchor injection, idempotency, model detection, tool block/restore |
| `test-anchor-benchmark.ps1` | DeepSeek Anchor benchmark: on vs off comparison (requires API) |
| `test-queue-manager-unit.ts` | Queue Manager TUI plugin unit tests (no API, 23 assertions) |
| `test-project-manager-unit.ts` | Project Manager plugin unit tests (no API, 126 assertions) |
| `test-project-wizard-unit.ts` | Project Wizard TUI plugin unit tests (no API, 48 assertions) |

## Run

```powershell
# Structural checks + prompt tests (requires API)
powershell -ExecutionPolicy Bypass -File tests/test-all.ps1

# Include prompt behavioral tests (requires LLM API access)
powershell -ExecutionPolicy Bypass -File tests/test-all.ps1 -IncludePrompts

# Or run individually
powershell -ExecutionPolicy Bypass -File tests/test-build.ps1

# DeepSeek Anchor unit tests (no API, fast)
npx tsx tests/test-anchor-unit.ts

# Queue Manager unit tests (no API, fast)
npx tsx tests/test-queue-manager-unit.ts

# DeepSeek Anchor benchmark (requires API, ~2 min per prompt × 2 states)
pwsh -ExecutionPolicy Bypass -File tests/test-anchor-benchmark.ps1

# Quick benchmark (only 2 prompts)
pwsh -ExecutionPolicy Bypass -File tests/test-anchor-benchmark.ps1 -Quick
```

## What test-all.ps1 checks

### Structural (no API calls)
- `opencode.template.jsonc` instructions array contains the L0 iron rules
- `opencode.template.jsonc:plugin` is empty by default (no default-on third-party plugins; see ADR-0003)
- java/python/node agents mention ecosystem libraries
- Security rules intact in all coding agents
- researcher.md is coding-rule-free (non-coding isolation)
- All 20 agent files exist (including explore.md)
- `profiles/*.json`: each profile applies cleanly to a fresh template
  copy (agent refs, root model, untouched tiers); every profile must cover
  all five tiers

### Behavioral (opt-in via `-IncludePrompts`, requires LLM API access)
- Prompt with speculative need → agent builds it, then in its report briefly considers a YAGNI-aligned simpler alternative (per `cp-triage` / `code.md` step 4 / `lite.md` Editing-code)
- Prompt with existing utility → agent reuses it

## Expected results

- `test-build.ps1`: Output contains `**Conclusion**: ...` — Protocol is applied.
- `test-plan.ps1`: Output contains `**Conclusion**: ...` and suggests switching to Build mode.
- `test-subagent.ps1`: Subagent output follows Protocol format (dispatched via build agent).
- `test-default.ps1`: Default agent may NOT follow Protocol (no custom prompt, instructions may not inject).

## DeepSeek Anchor Plugin Tests

### Unit tests (`test-anchor-unit.ts`)

Zero-dependency, no API calls. Validates plugin mechanics by directly invoking hooks with mock inputs.

**Test coverage** (mapped to `dsh-anchored-standard` mechanisms):

| Test | What it validates | dsh-anchored equivalent |
|------|-------------------|-------------------------|
| Anchor injection | System prompt gets `[DEEPSEEK REASONING ANCHOR]` marker + 3-step reasoning checklist | `anchor-turn.mjs` — anchor text injection |
| Idempotency | Marker already present → no re-injection (cache-friendly) | `context-gate.mjs` — phase-based suppression |
| Model detection | 3-layer DeepSeek detection (providerID / modelID / api.id), case-insensitive | Issue #11: tool schema is the decisive variable |
| First-turn tool block | All tool calls blocked during anchored turn | `deliberation-gate.mjs` — deny on shallow reasoning |
| Second-turn restore | Tools pass after MARKER detected in system prompt | `context-gate.mjs` — promotion after first assistant message |
| Plugin disabled | `enabled=false` → no injection, no blocking | `context-gate.mjs` — `enabled: false` A/B switch |
| Multi-fragment | Anchor appended to every system string fragment | Multiple system prompt assembly paths |
| Config & command | `parseModeArg`, `getMode/setMode`, `COMMAND_NAME` | Preset row config validation |
| Config hook | `/deepseek-anchor` command registered in `cfg.command` | Preset mount-time registration |
| Event hook | `session.created` announce, subagent skip, non-target skip | `anchor-turn.mjs` — fresh-session detection |

Run:
```bash
npx tsx tests/test-anchor-unit.ts
```

### Benchmark tests (`test-anchor-benchmark.ps1`)

Real API calls comparing DeepSeek V4 Pro behavior with anchor ON vs OFF.

**Test prompts** (from `test-dsh-anchored-validation.md`):

| # | Prompt | Type |
|---|--------|------|
| 1 | "你是谁" | Simple inquiry |
| 2 | "帮我创建一个用户登录功能" | Task request |
| 3 | "这个项目用到了什么技术栈？" | Exploration |
| 4 | "优化这个系统的性能，当前QPS只有100" | Complex engineering |

**Metrics measured:**

- **Reasoning length**: ON should produce longer first replies (deeper reasoning)
- **Trajectory style**: "We need…" (deep) vs "Let me…" (shallow) — per dsh-anchored-standard terminology
- **Reasoning structure**: goal restatement + constraints + approach (0-3 score)
- **Tool suppression**: ON should have fewer tool mentions in first reply

Run:
```powershell
# Full benchmark (4 prompts × 2 states = 8 API calls)
pwsh -ExecutionPolicy Bypass -File tests/test-anchor-benchmark.ps1

# Quick benchmark (2 prompts only)
pwsh -ExecutionPolicy Bypass -File tests/test-anchor-benchmark.ps1 -Quick
```
