# Developing Guide

Everything you need to modify this repo: architecture, prompt conventions, plugin internals, tests, and the release workflow.

> **Audience**: contributors and maintainers of this repo.
> If you only want to *use* the configuration, read the user manual: **[README.md](README.md)** (English) / **[README.zh-CN.md](README.zh-CN.md)** (中文).
> For AI agent behaviors, language conventions, and coding disciplines, see **[AGENTS.md](AGENTS.md)**.

---

## Repository layout

```
prompts/         # Agent prompt fragments: 3 primaries + 17 specialists (pure bodies, no frontmatter; loaded via {file:} — must NOT live under agents/ or opencode auto-discovers them as agent definitions that override the jsonc agent block)
instructions/    # Rule files layered by disclosure: L0 (opencode.jsonc:instructions) vs L1 (agent prompt {file:} assembly)
skills/          # L2 on-demand skills (opencode skill tool loads them when relevant)
plugins/         # TypeScript plugins (barrel entries at root default-exporting the `{ id, setup }` plugin object; logic in subdirs; TUI plugins in plugins/tui/)
profiles/        # Model profiles: provider + per-tier model picks
providers/       # Custom provider preset definitions (seeded once, then user-owned; /provider → "Add preset" imports them into the config's provider block)
install/         # Self-installing engine (TypeScript), manifests, version.json, options
bin/             # OCP CLI dispatchers (opencode-prime, ocp) — installer wrapper + runtime launcher
tests/           # Structural + prompt test suites (see tests/README.md)
scripts/         # Packaging scripts for releases
opencode.template.jsonc  # Root config template merged into ~/.config/opencode/opencode.jsonc (V2-native keys: agents / permissions[] / providers / plugins / mcp.servers)
cli.template.jsonc  # Terminal-client template merged into the ONE global ~/.config/opencode/cli.json (registers TUI plugins; replaces v1's layered tui.json(c); a legacy v1 tui.jsonc plugin list is migrated on upgrade)
tiers.json       # Tier definitions sidecar (consumed by profile-wizard)
```

## Architecture

```
User
 │
 ├── @build (primary) ── routes to ──┐
 │                                            ├── @explore       (read-only explorer, efficient model)
 │                                            ├── @researcher    (tech evaluation)
 │                                            ├── @architect     (system design, ADR)
 │                                            ├── @dba           (schema, SQL, migrations)
 │                                            ├── @security      (OWASP, vulnerability assessment)
 │                                            ├── @java-dev      (Java/Spring)
 │                                            ├── @python-dev    (Python/FastAPI/Django)
 │                                            ├── @go-dev        (Go/gRPC)
 │                                            ├── @rust-dev      (Rust/Axum/Tokio)
 │                                            ├── @node-dev      (Node.js/NestJS/Prisma)
 │                                            ├── @frontend-dev  (React/Vue, Design System)
 │                                            ├── @qa            (test strategy, coverage)
 │                                            ├── @code-review-fast (routine diff triage)
 │                                            ├── @codegraph-scout (bounded CodeGraph relationship evidence)
 │                                            ├── @gitnexus-scout (bounded GitNexus process/cross-repo evidence)
 │                                            ├── @code-review   (deep/final diff review)
 │                                            ├── @advisor       (second opinion; red-team stance for design review)
 │                                            ├── @devops        (Docker/K8s/CI-CD)
 │                                            ├── @tech-writer   (docs, README, ADR)
 │                                            └── @vision        (image/screenshot analysis)
 │
 ├── @plan (primary) ── read-only analysis coordinator
 │
 ├── @code (primary, default) ── direct developer, delegation only on request
 │                                (advisor/explore/code-review-fast/code-review/vision)
 │
│   (default agent is set by install/options.jsonc:default_agent —
   │    the installer applies it to opencode.jsonc's root `default_agent`
   │    on every install (any name defined in the `agents` block; unknown
   │    names keep the template value, which ships as `lite`)
 │
 ├── Disclosure layers (see docs/core/prompt-layers.md)
 │   ├── L0 `opencode.jsonc:instructions` — every step × every agent:
 │   │     rfc-keywords, output-protocol, verification-honesty, routing-index
 │   ├── L1 agent prompt {file:} assembly — role rules:
 │   │     coding pack (coding-principles, comment-strategy, edit-protocol,
 │   │     test-scope), sql-migration (dba only)
 │   └── L2 skills/sdd-workflow — loaded on demand via the skill tool
 │
  ├── Per-step visibility gating (agents.<name>.permissions[] rules in the template)
  │     skills block: sdd-workflow visible only to build/plan/code (open
  │     roster) and architect (explicit `sdd-workflow` + `adr-*` allows);
  │     MCP tool surface (serena_* / codegraph_*, ~10.9k tok/step of tool
  │     definitions) only to code-querying agents; tiered review confines
  │     graph backends to their selected Scout. Quantified by
  │     scripts/measure-prompts.ts (real MCP handshake snapshot in
  │     scripts/mcp-instructions.snapshot.json)
 │
  └── Plugins (runtime enforcement & workflows — see "Plugin system")
      ├── npm package plugins via `opencode.jsonc:plugins` (qoder-bridge, …)
      ├── auto-discovered entries in `plugins/*.ts` barrels + directories (guards, collectors)
      ├── injection gate: plugin-scope.json → plugins/shared/plugin-scope.ts,
      │     enforced per-agent by plugins/shared/agent-scope.ts on v2 hook events
      │     (protocol injections denied for lite/utility identities and all
      │     subagent steps; per-plugin overrides allowed; fail-open)
      └── TUI plugins via `cli.template.jsonc:plugins` → global cli.json (provider-wizard, profile-wizard, project-wizard, sidebar-status, usage)
```

Design invariants:

- **build** = multi-domain orchestrator (full tools/skills; defaults to dispatch, bounded direct work allowed); **plan** = read-only analysis coordinator. Separation keeps analysis from mutating code; build's limiter is discipline, not missing tools.
- Specialist agents get only their relevant domain knowledge — no mega-prompt (token cost + context dilution).
- Cross-cutting protocols live in `instructions/` and attach at the cheapest disclosure layer (L0 array or L1 `{file:}` assembly in `opencode.template.jsonc`) — never duplicated in agent files.

---

## Prompt design conventions

### 1. RFC 2119 keyword usage

All **tactical rules** (Hard rules sections) use RFC 2119 keywords:

| Keyword | Meaning | Example |
|---------|---------|---------|
| **MUST** | Absolute requirement | "MUST pass before reporting" |
| **NEVER** | Absolute prohibition | "NEVER `@Autowired` on fields" |
| **SHOULD** | Strong recommendation | "SHOULD use design tokens" |
| **AVOID** | Weak recommendation | "AVOID `any` without comment" |
| **MAY** | Optional | "MAY use `@PreAuthorize`" |

**Density target**: 5-12 words per bullet in Hard rules sections.

```markdown
## Hard rules

- **Constructor injection only.** NEVER `@Autowired` on fields.
- **NEVER swallow exceptions** — `catch (Exception e) {}` is a bug.
- **Validate all input** — `@Valid` on request bodies.
```

### 2. Two-layer prompt structure

Each agent prompt has two distinct layers:

| Layer | Purpose | Style | Compression |
|-------|---------|-------|-------------|
| **Core competencies** | Domain knowledge for LLM routing & context | Short prose, bullet lists | NOT compressed — semantic context needed |
| **Hard rules** | Tactical constraints, prohibitions, mandates | RFC 2119 keywords, 5-12 words/bullet | Fully compressed |

**Do NOT compress competencies into RFC 2119 style.** `MAY use records` is worse than `records, sealed classes, pattern matching, virtual threads. Use modern features.` — the latter gives the LLM semantic context for decision-making.

### 3. Structural tags

Agent *definitions* live in the `agents` block of `opencode.template.jsonc` (mode, model, request, permissions — the v2-native surface); the prompt bodies in `prompts/*.md` carry **no frontmatter**. Each body follows this structure:

```markdown
You are a **senior <role>**. <one-line scope>.

## Operating loop
<3-5 step sequential workflow>

## Core competencies      ← domain knowledge, NOT compressed
<framework-specific knowledge, bullet lists>

## Hard rules              ← RFC 2119, 5-12 words/bullet
<MUST / NEVER / SHOULD rules>

## Output format (mandatory — structured)
<markdown template with placeholders>

Invoke via `@<agent-name>` or <keywords>.
```

Note: agent→tier mapping is **not** a field in the config — `tiers.json` (repo root, shipped beside the template) is the single source, consumed by profile-wizard and the installer preserve/restore logic. opencode forwards every unknown agent field to the provider as a model option and strict upstream gateways reject it, so the tier metadata deliberately lives outside `opencode.jsonc`.

### 4. Output protocol (shared)

All agents follow `instructions/output-protocol.md`:
- **Conclusion first** — one sentence + confidence
- **Visual mandatory** — diagrams for structure/flow (ASCII in terminal, Mermaid in .md)
- **Layered exposition** — Summary → Key points → Details
- **Content labeling** — [Fact] / [Inference] / [Assumption]
- **Decision confirmation** — two-tier: non-blocking (state assumption, proceed) vs blocking (STOP, output options)
- **Decision mode** — advisor modes `off (default) | lite | full` control `@advisor` consultation on blocking decisions
- **Verifiable data** — cite `file:line`, show calculation steps

### 5. YAGNI-aligned self-review forcing function

The "after non-trivial work, name a YAGNI-aligned simpler alternative in the report" forcing function lives in the agent prompts themselves (`prompts/code.md` step 4 Implement; `prompts/lite.md` Editing-code line), not in any plugin. The agent applies the check inline; `cp-triage`'s top-tier floor still applies — simplifications that drop only work genuinely unneeded for the stated goal are welcome; simplifications that bypass error handling, test coverage, edge cases, or platform-native design are quality regressions and MUST NOT be accepted under a YAGNI label.

Triggers (must apply the check): new function, new public API, new file, or >20 added lines. Skip for typo fixes, renames, single-line edits. The threshold is the guardrail that keeps the forcing function from being silently skipped — agents that route every change through "trivial" defeat the point.

`@dietrichgebert/ponytail` was previously shipped as a third-party npm package doing this same job; it was removed entirely (ADR-0003) because (a) its "lazy coding" framing conflicted with `cp-triage`, (b) our own prompt stack already covers YAGNI / SOLID / KISS via `cp-triage`, `cp-abstract`, `prompts/architect.md`, and `prompts/code-review.md`, and (c) architectural decisions should not be limited by an external plugin. No replacement plugin is needed.

Non-coding agents ignore this entirely. No token-cost ruleset block is injected into any session, lite or otherwise.

---

## Model routing design

Five tiers, each mapped per active profile (`profiles/*.json`):

| Tier | Use case | Variant | Agents |
|----------|----------|---------|--------|
| `max` | Deep reasoning, analysis | `high` | architect, security, advisor, code-review |
| `standard` | Orchestration, high-traffic | `medium` | build, plan, researcher, tech-writer |
| `standard` | Daily primary (no pin) | inherited | lite |
| `pro` | Code generation, implementation, routine review triage | `medium` | code, code-review-fast, codegraph-scout, gitnexus-scout, java/python/go/rust/node-dev, frontend-dev, qa, dba, devops |
| `flash` | Fast retrieval, high-volume | `low` | explore |
| `flash` | Rapid coding (zero-review paths) | `medium` | fast-coder |
| `vision` | Image understanding | `medium` | vision |

**Variant** controls thinking/reasoning effort and must be considered alongside the tier's model strength:
- `high` = deep reasoning. Use when the model is strong AND the task needs it (architecture, security, review, decision analysis).
- `medium` = balanced. Default for strong coding models doing routine work (coding, testing, docs, visual analysis, orchestration, research). Also the floor for any coding agent — `low` on a flash-tier model producing production code silently degrades quality (fast-coder lesson).
- `low` = fast/lightweight. Only for the cheapest tier doing pure retrieval tasks (explore). Applying `low` to a weak model on a complex task is a disaster — the matrix ensures this never happens.
- `inherited` (no pin) = follow the model's native default. Reserved for lite — its slimness comes from prompt surgery, not model quality.

If the backend model doesn't support a variant, it's silently ignored.

Profile mechanics (tier→model rewrite, live apply vs fallback, validation) are user-facing behavior documented in the [user manual](README.md#profiles); the TUI wizard lives in `plugins/tui/profile-wizard/tui.ts` with its apply/reset core in `plugins/shared/profile-core.ts`, and tier definitions in `tiers.json` (sidecar — upstream OpenCode rejects unknown schema fields in `opencode.jsonc`, so tiers live outside it).

## Test scope policy (default — lazy)

> **Top principle**: minimize wasted time and resources, find the best balance point with quality. Test depth is matched to change size — full suite and E2E are exceptions, not the baseline.

**Single source of truth**: [`instructions/test-scope.md`](instructions/test-scope.md) — attached to coding/deep-review agent prompts at L1 (agent `prompt` `{file:}` assembly). Fast review is deliberately P0/P1-only and does not run the full test-scope policy. Applies to `@build` dispatch, `@qa` execution, and `@code-review` reporting. Don't duplicate the table in agent files — they reference the policy file.

### Quick reference (tier table)

| Change size | Default tests to run |
|---|---|
| Docs / config comments only (no code change) | none — no code run |
| ≤ 1 file (tweak / rename / comment) | `compile` + `lint`/`type-check` |
| 2–5 files in one module | unit tests for changed files + direct callers |
| > 5 files OR cross-module | + integration tests for touched modules |
| Schema / contract / shared infra / cross-service | + E2E on the boundary |

Full table including the "User explicitly asks run all tests" row, escalation rules, skip rules, transparency rule, and coverage tiering: see the policy file.

### Usage notes

- **Default to the smallest tier.** If you only changed one line in one file, `compile` + `lint`/`type-check` is the run — not the full suite.
- **E2E is a last resort.** Slow, flaky, expensive. Only when the user asked, or the diff crosses a service boundary / critical user journey / auth / payment / data-mutation.
- **Full suite is opt-in.** Only when the user asked, on release branches, or when the change is genuinely cross-cutting and module-scoped tests give no confidence.
- **Bug fixes start at the 2–5-file tier**, regardless of file count. A bug fix with zero tests is not a real bug fix.
- **Flaky failures → root cause, not retry.** Mock time/random/network; find the order-dependence. Escalating tier on a flake is retry-in-disguise.
- **Public API / schema / shared infra changes** auto-promote one tier, even if the diff is small.
- **The agent decides the tier from the diff, not you.** Pass `diff size + touched modules` in the dispatch; the agent looks up the tier. Don't prescribe.
- **Transparency rule.** `@qa` and `@code-review` reports must state which tier they ran and why. Silent "all green" is a bug in the report.

### What this policy is NOT

- **Not a replacement for CI.** CI still runs the full suite on PR/merge. This policy is for **local / per-change** execution.
- **Not a coverage waiver.** Coverage targets are **tiered**, not removed: critical paths 100%, business core ≥80%, other code ≥60% recommended. Tiering is about *when* tests run, not *whether* they exist.
- **Not agent discretion on bug fixes.** Bug fixes have a floor (2–5-file tier). Discretion applies to other tiers.

---

## Adding a new agent

1. **Create `prompts/<name>.md`** — pure prompt body, NO frontmatter (follow the structural template above).
2. **Add to `build.md` routing table** — add row to `## Your team` and trigger words table.
3. **Add to `plan.md` team table** — if analysis-capable.
4. **Add to `opencode.template.jsonc`** — `agents.<name>` block with model, mode, permissions[], etc. (tier lives in `tiers.json`, not the block).
5. **Add to `tests/test-all.ps1`** — add to `$allFiles` array and relevant content checks.
6. **Generate manifest** — bump `version` in `install/version.json`, then `bun run manifest:generate`. See `AGENTS.md` §4 for the full shipping rules — files in `prompts/`, `instructions/`, `plugins/`, `profiles/`, `providers/`, `skills/` are auto-discovered; standalone files and `scripts/` runtime scripts must be added to `SHIPPED_FILES` in `install/src/manifest.ts`.
7. **Test** — run `pwsh -ExecutionPolicy Bypass -File tests/test-all.ps1 -StructuralOnly`.

### Checklist for new agent

- [ ] jsonc agent block complete (description, mode, model, variant, temperature, steps, permission, tools) — md files carry NO frontmatter
- [ ] `description` field covers trigger keywords for routing
- [ ] Operating loop (3-5 steps)
- [ ] Core competencies (domain knowledge)
- [ ] Hard rules (RFC 2119, 5-12 words/bullet)
- [ ] Output format (structured markdown template)
- [ ] `Invoke via @<name>` closing line
- [ ] Added to build.md routing table
- [ ] Added to opencode.template.jsonc agent block
- [ ] Added to test-all.ps1 file integrity list
- [ ] Structural tests pass

Agent naming convention: mode verbs for primaries (`build`, `plan`, `code`), role nouns for specialists (`architect`, `dba`, …).

---

## Adding a new skill or command

Workflow slash commands (`/dev`, `/goal`, `/handoff`, …) are native opencode command files in `commands/*.md`. Each is a thin launcher that loads a matching L2 skill protocol from `skills/<name>/SKILL.md` on demand — paid once per invocation, never resident. Compared to plugins (which register hooks), skills are **prompt body only**: zero runtime code, zero system-prompt injection outside the loaded conversation.

### Steps

1. **Plan the protocol body first** — write the SKILL.md outline on paper (Phase graph, hard rules, failure modes, output template) before any code. If the protocol is just a thin preset over an existing skill (e.g. `/dev-quick` over `/dev`), the launcher command is trivial and the skill body may not need a new file — only a new entry in `commands/`.
2. **Create `skills/<name>/SKILL.md`** if a new protocol is needed:
   - YAML frontmatter with **only** `name:` and `description:` (no version, no author — convention: 10 existing skills follow this)
   - `description` field MUST end with `Load ONLY when the user invokes /<name>.` so `@lite` doesn't load it speculatively
   - Body structure mirrors existing skills: `# <Protocol Name>` intro → `## What this is NOT` (where relevant) → `## Arguments` → Phase/Step sections → `## Hard rules` → `## Output format` → `## Failure catalog`
   - Reference `instructions/git-safety.md`, `instructions/verification-honesty.md`, `instructions/output-protocol.md` by relative path when their policy applies — don't duplicate the policy text
3. **Create `commands/<name>.md`** as the launcher:
   - YAML frontmatter: `description:` (one line, ≤ ~300 chars), plus `agent: build` for orchestration commands, `agent: plan` / `agent: code` for dedicated SDD phases, or no `agent:` when the command must follow the current session (for example, `/handoff` and the Git workflow family)
   - Body: exactly `Load the <name> skill and follow it strictly.\n\nUser request: $ARGUMENTS`
4. **Update `docs/workflows/commands.md`** (English) and **`docs/zh/workflows/commands.md`** (Chinese) — add one row to the command overview table. The row description is the user-facing summary; keep it short (≤ ~250 chars) and link related docs where useful.
5. **Update `DEVELOPING.md` repository layout** (this file, around line 495) — add the new files to the `commands/` and `skills/` directory tree so the listing stays truthful. Don't list every file; list the new *category* entry.
6. **Bump version and regenerate manifest**:
   - `install/version.json` + `package.json` + `install/README.md` title — bump minor for new features (e.g. `2.1.0 → 2.2.0`); a purely additive command+skill MAY ship as a patch bump at the maintainer's discretion, with the reason recorded in that version's notes file.
    - `bun run manifest:generate` — `commands/` and `skills/` are in `SHIPPED_DIRS` (see `install/src/manifest.ts`), so new files appear automatically in `install/versions/<version>.manifest.txt`
   - If a custom protocol needs a self-check script (recommended for safety-critical skills), add it to the skill's `## Protocol self-check` section **using shell variables to assemble forbidden-pattern literals** — otherwise grep in the check will false-positive on the literals themselves.
7. **Run structural tests** — `pwsh -ExecutionPolicy Bypass -File tests/test-all.ps1 -StructuralOnly`. Verify the test suite accepts the new files and frontmatter.
8. **Commit** — `feat: add /<name> command and skill` (no need to bump versions in the commit; version bump is a separate release commit).

### Checklist for new skill/command

- [ ] `commands/<name>.md` exists with standard launcher body and `description:` ≤ ~300 chars
- [ ] `skills/<name>/SKILL.md` exists with `name:` + `description:` frontmatter only (no `version:` field — convention)
- [ ] `description` ends with `Load ONLY when the user invokes /<name>.`
- [ ] Body references existing `instructions/*` policy files by relative path; doesn't duplicate them
- [ ] Hard rules list is enumerable (numbered, no overlapping scope)
- [ ] Failure catalog covers at least: not-a-git-repo / pathspec-mismatch / dirty-checkout / empty-patch / leftover-state
- [ ] For safety-critical skills (modify history, push, force ops): has a `## Protocol self-check` section with bash-variable-protected greps
- [ ] `docs/workflows/commands.md` EN table updated (one row)
- [ ] `docs/zh/workflows/commands.md` ZH table updated (one row, mirror of EN)
- [ ] `DEVELOPING.md` repository layout updated
- [ ] `install/version.json` + `package.json` + `install/README.md` bumped
- [ ] `bun run manifest:generate` ran and produced `install/versions/<version>.manifest.txt`
- [ ] Manifest contains the new command + skill files (auto-discovery since both are in `SHIPPED_DIRS`)
- [ ] `tests/test-all.ps1 -StructuralOnly` passes

### Naming convention

- `<name>.md` matches the command and skill (`/git-merge` → `commands/git-merge.md` + `skills/git-merge/SKILL.md`)
- `<name>` is kebab-case, short, action-or-subject noun (`goal`, `handoff`, `review-fix-loop`, `git-merge`)
- For preset commands over an existing skill (`/dev-quick` over `/dev`), the command file is in `commands/` but **no new skill folder** — just a thin preset launcher

### Git workflow skill family (shared doctrine)

`/git-merge`, `/git-pick`, `/git-pull`, `/git-push`, and `/git-rebase` are one family: five thin launchers over five L2 protocols that share a single doctrine. They are **agent-less** (no `agent:` frontmatter), so they follow the current agent — which is why `lite`'s `permissions[]` block in `opencode.template.jsonc` (under `agents`) allow-lists these five names plus `/handoff` and `/memory-summarize` (`agent: lite`) and denies every other skill (`{ action: "skill", resource: "*", effect: "deny" }` first, then explicit allows — last match wins).

**Edit-together invariant.** These blocks are structurally identical across the family; changing one file alone is a defect, not a style choice:

| Shared block | Present in | Only permitted difference |
|---|---|---|
| `## Audit trail — every invocation` | all 4 | `operation-id` prefix (`git-<op>-`) + report dir (`.git/ocp-<op>-reports/`) |
| Step 1 preflight table | all 4 | op-specific rows (rebase adds topology + signing checks, pick adds empty-commit option checks) |
| Baseline principle + conflict-shape table | merge, pick, rebase | side labels (`ours`/`theirs` vs `:1:`/`:2:`/`:3:`) |
| Confidence self-check → `@advisor` → human handover | merge, pick, rebase | the paused unit (hunk vs commit) |
| Verify once; `--no-verify` is user opt-in only, never inferred | all 4 | — |
| Ranked verify-command inference (CI → manifest script → implied runner → repo-local entrypoint → documented) | merge, pick, rebase | — (git-pull delegates it) |
| `A halt is never a dead end` hard rule | all 4 | op-specific recovery commands |
| `Outcome:` enum in report + `.md` summary | all 4 | op-specific `handed-over:` reasons |
| Hard rules / Flags | all 4 | op-specific entries |
| `## Failure catalog` | all 4 | op-specific entries |

`git-pull` **delegates instead of duplicating**: its Step 3 loads the `git-merge` skill (source = `@{u}`, target = the local branch), or `git-rebase` under `--rebase` — skipping rebase Step 1.3 (tip already guarded) and Step 3.3 (the checked-out branch *is* the landed result), with both exemptions justified inline. Never re-implement conflict resolution in `git-pull`.

**Layer rule.** This doctrine belongs at **L2** (`skills/*/SKILL.md`, paid only when a command loads it). Do NOT hoist it into `instructions/git-*.md` — that makes it L1 and charges every git invocation for text the skill already carries. The user-facing explanation lives in `docs/workflows/git.md` + `docs/zh/workflows/git.md`, which cost zero shipped tokens (`docs/` is not in `SHIPPED_DIRS`).

**Coverage invariants** (added v0.27.0) — the doctrine was already safe, but it bailed too often to be a daily driver. These three shrank the hand-back surface without weakening a single red line:

- **Ranked verify-command inference** — CI gate → manifest `test`/`check`/`verify` script → implied runner → repo-local entrypoint → documented command; "not inferable" means all five ranks missed. This closed the largest single hand-back source: a repo whose manifest has no `test` script used to be handed back `resolved-but-unverified` despite a correct resolution. **This repo is exactly that case** — its gate is `scripts/verify.sh` (declared in `.github/workflows/release.yml`) plus `tests/test-all.ps1`, and `package.json` has no `test` script, which is why CI is rank 1.
- **`A halt is never a dead end`** — every halt names the exact recovery command for that failure. Preflight rows were normalised to git-pick's decisive form; merge/pull previously said only "finish or abort first", which is a dead end.
- **Enumerated `Outcome:` token** — `landed-*` is the autonomous-success class, `no-op`/`dry-run` stay out of the rate's denominator, and `handed-over:<reason>` turns the next friction source into a histogram instead of a vibe. Aggregation one-liner is documented in `docs/workflows/git.md` §Reports.

**Drift closed**: `skills/git-pick/SKILL.md` now carries `## Failure catalog`. The previously suspected `git-pull` never-guess gap was a **false positive from literal string matching** — its Hard rule 3 already states "advisor failure degrades to handover, never a guess". Because git-pull delegates resolution entirely, restating the full rule inline would be redundant L2 tokens: the family is consistent here by design, not by duplication.

## Plugin authoring — injection mechanism

Match the LLM-native mechanism to **what the content IS**, not what's most convenient. Every plugin that needs to put text in front of the model asks the same question; the table below is the canonical answer.

| Content | Mechanism | Why |
|---|---|---|
| Declarative capability ("I exist", "I can do X", availability/state) | the registered tool's `description` (`ctx.tool.transform(editor.add)`) | LLM-native; zero fixed per-step cost; the runtime sends the tool list per call |
| Workflow / on-demand guidance ("when the user says X, do Y") | `skill` at `skills/<name>/SKILL.md` (L2) | Body loads only when the skill is invoked; the skill list only carries name + description otherwise |
| Imperative policy / protocol / rulebook the model must internalize for the session | `ctx.session.hook("context")` injection (append to `event.system` — `SystemPart[]`) | Cannot be expressed declaratively; the model must read the rule to follow it. The v2 context hook also carries `agent`/`model` for scoping (v1's `experimental.chat.system.transform` is retired). |

**OCP canonical examples** (use as references when adding a new plugin):

| Plugin | What it injects | Why that mechanism |
|---|---|---|
| `project-profiler` | `[PROJECT CAPABILITIES]` block with backend state | Capability advertisement — declarative state the model reads per turn. Track changes via content-keyed cache (ADR 0002) so a stable profile does not re-inject. |
| `auto-advisor` | `[AUTO-ADVISOR MODE: ...]` + `auto-advisor-protocol.md` | Imperative policy — protocol body cannot live in a tool description. Track mode in project config (`autoAdvisorMode`); the system-inject hook re-renders on mode change. |
| `adr` / `env-guard` | `[GUARD: ...]` block + protocol markdown | Imperative rulebook. Switches share `plugins/shared/plugin-switch.ts`. |
| `deepseek-anchor` | `[DEEPSEEK REASONING ANCHOR]` + HARD RULE | One-shot tactical directive — must be in the prompt for the first turn, then lifted. In-memory session tracking, not config-driven. |
| `lite-mode` | (no injection — strips only) | The strip gates every other injector; runs early in the hook chain. |
| `project-manager` | `[PROJECT COMMIT CONVENTION]` block pointer | Progressive disclosure pointer — names the doc the model should read for the rule; not a workflow step in itself. |
| `md-to-pdf` / `md-to-docx` | `skills/md-to-pdf/SKILL.md` + `skills/md-to-docx/SKILL.md` (L2) | Workflow, not imperative policy. Tool description advertises the capability; skill body loads on demand when the user signals intent (`@file.md 转PDF`, `/md-to-docx <path>`, etc.). Fixed context-hook injection removed. |

**Anti-patterns to refuse in review**:

- Tool steering text duplicated in a fixed `context`-hook injection — put it in the tool `description` instead, or move the workflow to a skill.
- A workflow guide (multi-step "when user says X do Y do Z") in fixed system-prompt text — make it a skill.
- Re-injecting unchanged content on every model request — use a content-keyed cache (`profileKey` / `plugin-switch` / similar) so the hook is a no-op when state is stable.
- A `context` hook whose only purpose is to advertise a tool's existence — the runtime already sends the tool list per call; the extra block is dead weight.

When uncertain which mechanism applies: read the content as if you were the model. If the text tells the model *what the system can do* (declarative), the tool list already covers it. If the text tells the model *how to behave* (imperative), system prompt is the only place. If the text tells the model *what to do in a specific situation* (workflow), make it a skill.

## Plugin system

OpenCode plugin hooks provide runtime guarantees that prompts alone cannot achieve.

### Discovery & layout

- **Auto-discovered**: OpenCode loads bare `.ts`/`.js` files and immediate plugin package directories from every discovered `plugins/` directory (global `~/.config/opencode/plugins/` and project `.opencode/plugins/`). Multi-file plugins therefore use the **barrel pattern**: `plugins/<name>.ts` re-exports from `plugins/<name>/<name>.ts`, keeping implementation, protocol markdown, and helpers in the subdirectory. V2 loader contract: each root barrel DEFAULT-exports the `{ id, setup }` plugin object (typed via `import type { Plugin } from "@opencode/plugin"` — never a runtime import, see the API paragraph below) — v1 `server()`-function exports are gone (hard cutover, no shim). A `plugins[]` config entry must be a package or DIRECTORY (not a bare file); the dir needs a `server.ts`/`index.ts` entry. **Pitfall**: never combine a root barrel with an `index.ts` inside the subdir — the loader discovers BOTH and the plugin's `setup` runs twice (duplicate hooks/commands). The subdir entry module must be named `<name>.ts` (e.g. `plugins/adr/adr.ts`); `index.ts` is reserved for barrel-less directory plugins like `rtk-write/`. Corollary: `plugins/shared/` and `plugins/tui/` deliberately have NO `index.ts`/`tui.ts` (helper modules and explicit-`cli.json` TUI plugins respectively) — do not "complete" them into package dirs, or they become auto-discovered. TUI plugins live one level deeper as `plugins/tui/<name>/tui.ts` and are registered in `cli.template.jsonc` as DIRECTORY entries (`./plugins/tui/<name>`) — the v2 TUI reconcile silently skips file entries (stat().isFile() → continue), and `Host.resolve` probes `<dir>/tui` for the entrypoint. Discovered-entry scope is `plugins/` immediate children only; nested paths (e.g. `plugins/tui/i18n.ts`, the `plugins/tui/i18n/locales/` tree, `plugins/tui/_wizard-helpers.ts`) are never loaded as plugins. Slash-command contract: NO `slash.arguments: true` under `plugins/tui/` — menu Enter executes immediately (decision record: `plugins/tui/_keymap-app.ts` header); the server `/project` twin is intentional, do not remove it. Known accepted deviation: barrels keep named re-exports (`export { XPlugin, XPlugin as default }`) consumed by unit tests; V2's loader reads only the default export, so these are runtime-inert — slim them opportunistically when touching a barrel, never in a dedicated churn commit.
- **TUI plugins**: registered explicitly in `cli.template.jsonc:plugins` (`provider-wizard.ts`, `profile-wizard.ts`, `project-wizard.ts`, `sidebar-status.ts`, `usage.ts` under `plugins/tui/`) — CLI-only (terminal-client) plugins on the `@opencode/plugin/tui` slot/keymap API, loaded by the TUI process from the ONE global `cli.json` (the background service never loads it). `provider-wizard.ts` and `profile-wizard.ts` are dual-hosted: opencode loads them for the `/provider` and `/profile` slash commands, and the standalone OpenTUI app behind `ocp provider` / `ocp profile` loads the SAME modules through a `TuiPluginApi`-compatible host (`install/src/ui/app.tsx` + `tui-host.ts`). One wizard, two hosts — never re-implement wizard flows in `install/src/`.
- **JSX in TUI plugins — dual `@opentui/solid` instance trap**: when opencode loads our plugin files from `~/.config/opencode/plugins/tui/*.ts`, every `import { jsx } from "@opentui/solid/jsx-runtime"` resolves to a separate physical module from the host's bundled copy (`install/src/installer.ts:402-405` pins `@opentui/solid` in `~/.config/opencode/node_modules` so the imports resolve, but pinning the same version is not enough — SolidJS resolves contexts by `Symbol` identity, so the plugin's `RendererContext` symbol does not match the host's, and `useContext(RendererContext)` inside `createElement` returns `undefined`, throwing `Error: No renderer found` on the host's render loop and killing the TUI; see opencode issues #27447 and #33884). The same dual-instance trap fires in the standalone OCP host (`install/src/ui/app.tsx` mounts `kind: 'custom'` frames through the plugin's `jsx()`, and the plugin's `@opentui/solid` resolves from the repo-root `node_modules/`, not from `install/node_modules/`). The OCP fix is **never to put plugin JSX on a transient busy indicator** — `showBusyModal` (`plugins/tui/_wizard-helpers.ts`) and `showBusyFetch` (`plugins/tui/provider-wizard/tui.ts`) route through `ctx.ui.toast.show` instead, which uses the host's own renderer and bypasses the trap entirely. Result dialogs (`dialog.alert` / `select` / `prompt`) are unaffected because they take plain options. The interactive `UsageDialog` (`plugins/tui/usage/tui.ts`) still uses `dialog.show(() => jsx(...))` because a toast cannot carry its reactive scroll/tab content; if a future opencode release unifies the `RendererContext` symbol across instances, that path can drop its workaround too.
- **npm plugins**: the default `opencode.template.jsonc:plugins` array is empty — OCP does not ship any default npm plugin. Optional plugins (`opencode-qoder-bridge`, `opencode-mem@2.24.3`) remain opt-in via `install/options.jsonc`; the `plugin` block controls membership in the `plugins` array at merge time, and the v2 runtime installs package plugins in the background at server startup. `@dietrichgebert/ponytail` was removed entirely (ADR-0003).
- **User-level plugin config**: `~/.config/opencode/ocp.json` (`plugins/shared/ocp-config.ts`) — one JSON file for cross-session user preferences shared by all ocp plugins (currently `language`, written by i18n). Plugins add their own namespaced keys via `readOcpField`/`writeOcpField`; unknown keys survive every write. Writes are pure JSON; reads are JSONC-tolerant (hand-edited comments keep working). `OCP_CONFIG_PATH` overrides the location (tests). The legacy `ocp.jsonc` rename is a one-shot performed by the installer (ADR 0004).
- **Shared plumbing**: `plugins/shared/opencode-prime.ts` — project-dir resolution, JSONC parsing, field upsert, never-throw writes; used by auto-advisor, adr, env-guard, project-manager. `plugins/shared/plugin-scope.ts` — the scope POLICY: `identifiers` (text detection) plus per-plugin `deny`/`allow` lists with scope grammar `x` / `x:*`; the `"*"` entry is the inherited default (deny `lite`, `utility`, `subagent:*`). `plugins/shared/agent-scope.ts` — the v2 GATE on top of that policy: v2 has no per-agent hook scoping, so every injector registers its `ctx.session.hook("context")` / `ctx.tool.hook(...)` callback behind an agent-scope check. Detection order: event `agent` ID → system-text sentinels → `session.get` parentID ground truth (cached). Fail-open, exactly like v1. `plugins/shared/system-block.ts` — shared `appendBlock` / `stripBlockByLine` / `escapeRegExp` for context-hook injectors operating on the v2 `SystemPart[]`. `plugins/shared/plugin-switch.ts` — shared project-level on/off state machine (`createPluginSwitch` factory + `normalizeSwitchState` helper): a plugin declares its field name, alias table, default state, and which canonical states count as "on"; the helper handles read-from-config / write-to-config / clear-to-default plumbing via `opencode-prime.ts`. Used by auto-advisor (`off`/`lite`/`full`), adr, env-guard, project-memory (`on`/`off`). Pure-function core (`normalizeSwitchState`) is exported for unit tests.

### Hook inventory

V2 plugin API: `{ id, setup }` typed as `Plugin.Plugin` (`import type { Plugin } from "@opencode/plugin"`) — do NOT call `Plugin.define(...)` or runtime-import `@opencode/plugin`: **the v2 server plugin loader cannot resolve ANY runtime bare package import from user plugin files** (verified on v2.0.15 — even a CJS-ready package with a complete target `node_modules` fails with `Die(ResolveMessage: Cannot find package '...')`; `import type` is erased at transpile and is safe; `Plugin.define` is an identity function, so the typed literal is exactly equivalent). Spawned worker processes (`md-to-pdf`/`mermaid-renderer` playwright templates) are exempt — they run as separate `node`/`bun` processes with normal resolution. Inside `setup(ctx)` registrations come from domain hooks (`ctx.session.hook(...)`, `ctx.tool.hook(...)`, `ctx.permission.hook(...)`, `ctx.shell.hook(...)`) and synchronous registry transforms (`ctx.tool.transform`, `ctx.command.transform`, `ctx.model.transform`, `ctx.agent.transform`, …). Runtime hooks run in registration order; a later transform wins over an earlier one. TUI plugins (`@opencode/plugin/tui`) use the same pattern with the TUI slot's type name: `Plugin.Definition` (`Plugin.Plugin` does not exist there, and vice versa — each slot exposes only its own interface).

**Plugin id convention**: every plugin id carries the `opencode-prime.` prefix (`opencode-prime.adr`, `opencode-prime.usage`, …) — plugin ids share one namespace with third-party npm plugins in the runtime registry, and upstream's own examples use vendor-prefixed dotted ids (`acme.*`). The prefix is identity only: `plugin-scope.json` gate names stay decoupled (caller-supplied literals via `scopedForAgent`/`scopedForCall`, e.g. `"adr-context-tool"`), and slash-command / slot names are separate namespaces that keep their own rules.

| Plugin | Hook | What it does |
|--------|------|-------------|
| `design-token-guard.ts` | `ctx.tool.hook("execute.before")` | Blocks writes with hardcoded colors/spacing/radius. Throws error. |
| `ai-slop-scanner.ts` | `ctx.event.subscribe` (`filesystem.changed`) | Scans frontend files for AI anti-patterns (gradient soup, div soup, …). Logs warnings. (v1's `file.edited` is replaced by `filesystem.changed`, `unlink` skipped.) |
| `auto-format.ts` | `ctx.event.subscribe` (`filesystem.changed`) | Auto-runs the project-selected dprint/Biome/Prettier/ESLint/Ruff/gofmt/rustfmt after file edit. dprint and Biome require their config and project-local binary; OCP never installs either globally. |
| `browser-screenshot.ts` | `ctx.tool.transform(editor.add)` | Registers `browser_screenshot` tool (Playwright headless) for `@vision` / `@frontend-dev`. |
| `lite-mode.ts` (+ `plugins/lite-mode/`) | `ctx.session.hook("context")` | Strips the `<!-- lite-mode -->` sentinel and every `Instructions from:` block (L0) from the `@lite` primary's system parts. |
| `project-profiler.ts` (+ `plugins/project-profiler/`) | `ctx.session.hook("context")` | Detects project nature (config-driven, zero CLI probing) and injects a compact profile + code-intelligence backend recommendation (Serena vs CodeGraph, GitNexus optional) into the system parts. **Cache key is the profile content SHA-256** (see ADR 0002), not the cwd — a profile change mid-session (tgrep watcher died, `opencode.jsonc` edited) refreshes the block; a stable profile leaves the prompt byte-identical. **Always injects** under opencode's verified Scenario-A runtime (system rebuilt per request — see ADR 0002): a "skip on same key" optimization would leave the LLM without the capabilities block after turn 1. The cache stores the rendered block per (cwd, key) so the render step (the only non-trivial per-turn work) is skipped on steady state. The defensive `stripBlockByLine` keeps behavior correct under a hypothetical Scenario-B runtime (prompt persists across turns). |
| `model-variants.ts` | `ctx.model.transform` + `ctx.agent.transform` + `ctx.event.subscribe` | Folds `{provider, model, variant=effort}` reasoning-effort refs onto proven sibling models and clears the variant (v2 errors on a variant the model no longer declares); shared vocabulary in `plugins/shared/model-variants.ts`. GAP: v1's `command.<name>.model` rewrite is dropped (v2 commands carry no model ref). |
| `tool-compress.ts` | `ctx.session.hook("context")` | Swaps heavy native tool schemas for compressed descriptions (scoped per agent via `event.agent`). |
| `rtk-write/` | `ctx.tool.hook("execute.before")` + `execute.after` | Vendored rtk integration: rewrites shell commands through the rtk compression proxy and annotates results. (The v1 root barrel `plugins/rtk-write.ts` no longer ships — the directory entry is discovered directly.) |
| `auto-advisor-mode.ts` (+ `plugins/auto-advisor/`) | 4 surfaces — see below | Advisor modes off/lite/full; protocol injection; full-mode auto-execute; red-team suppression. |
| `deepseek-anchor.ts` (+ `plugins/deepseek-anchor/`) | `ctx.command.transform` + `ctx.session.hook("context")` + `ctx.tool.hook("execute.before")` + `ctx.event.subscribe` | `/deepseek-anchor` command; anchor-based reasoning protocols with DeepSeek models; session-deleted cleanup via the event stream. |
| `adr.ts` (+ `plugins/adr/`) | `ctx.session.hook("context")` + `ctx.tool.hook("execute.before"/"execute.after")` + `ctx.tool.transform` + `ctx.command.transform` + `ctx.event.subscribe` | `/adr` command suite (guard switch `/adr guard`, alias `/adr-guard`); ADR iron-law protocol injection; hard-blocks `feat`/`refactor` commits without an ADR in the change set. Also registers the `adr_context` / `adr_compaction` tools and `/adr compaction` maintenance flow (bounded retrieval, reviewed consolidation, reversible archive): only the verified user channel can authorize writes (`adr-compaction.ts` / `adr-compaction-runtime.ts`, re-implemented on `tool.hook("execute.after")` + session synthetic events); storage, publication, archive moves and the finite read guard live in `adr-storage.ts` / `adr-publication.ts` / `adr-archive.ts` / `adr-read-guard.ts`. |
| `env-guard.ts` (+ `plugins/env-guard/`) | `ctx.tool.hook("execute.before")` | Secret-file gate: blocks reads/copies of secret-bearing `.env*` files. |
| `e2e-adopt.ts` (+ `plugins/e2e-adopt/`) | `ctx.command.transform` | `/e2e-adopt [dry\|status]` command — adopts the E2E red-line policy into PROJECT DOCS (`docs/e2e-redline.md` + marker-framed AGENTS.md section), baijiu-shop-style documentation governance; detection pre-fills, never applies silently, no runtime injection or gate (retired the e2e-guard plugin 2026-09-22). |
| `project-manager.ts` (+ `plugins/project-manager/`) | `ctx.session.hook("context")` + `ctx.tool.hook("execute.before")` + `ctx.command.transform` + `ctx.event.subscribe` (`session.created`) | `/project init\|index\|sync` commands; init runs the one-shot legacy migration (`.opencode/` OCP state → `.ocp/`, ADR 0004) then creates missing baseline files (`.ocp/ocp.json`, `docs/git-commits.md`, `AGENTS.md`, never overwrites); sync re-runs the migration on demand; file-as-switch commit discipline; one-time `/project init` suggestion (announce surface degraded to a log line — see OCP-V2-GAP in `project-manager-announce.ts`). |
| `project-memory.ts` (+ `plugins/project-memory/`) | `ctx.session.hook("context")` + `ctx.command.transform` + `ctx.tool.transform` | `/memory note [text]` (+ `--private`) writes dated bullets to `.ocp/memory/public.md` (committed, PR-reviewed) or `private.md` (gitignored, current-user-only); `memory_note` tool lets the agent call it when it discovers a reusable rule — **scope defaults differ on purpose** (ADR-2.0.2#01): the command defaults to `public`, the tool to `private` (the cheap-to-be-wrong side), and `/memory status` probes git twice — `git ls-files` for trackedness, then `git check-ignore` (4-state tracked/untracked/ignored/unknown, silent when undeterminable) so neither a root-ignore nor a never-staged file can silently un-share `public.md`; `/memory-summarize [focus]` skill (thin launcher in `commands/`, protocol in `skills/memory-summarize/`) reviews the session. Both files live inside the project at `.ocp/memory/` (same convention as `.ocp/handoffs/` etc.) — no user-home storage. Single marker `[PROJECT MEMORY]` with `=== Public ===` / `=== Private ===` sections; AGENTS.md authoritative on conflict; 16k-char cap per section → pointer. Tool is gated via `plugin-scope.json` (`project-memory-note-tool` key — utility sessions denied). |
| `sdd.ts` (+ `plugins/sdd/`) | `ctx.session.hook("prompt")` | Engine-only: `/sdd status\|handoff\|help` runtime actions (artifact discovery, handoff bundling). The SDD protocol itself lives at L2 (`skills/sdd-workflow/SKILL.md`); `/sdd` `/prd` `/plan` `/impl` are `commands/*.md` launchers. |
| `tgrep.ts` (+ `plugins/tgrep/`) | `ctx.tool.transform` | Registers the `tgrep_search` tool (`options.codemode:false` so the model sees it directly). GAP: v1's UI `title` field has no v2 `Tool.Result` equivalent — titles dropped, text preserved. |
| `context-watch.ts` (+ `plugins/context-watch/`) | `ctx.session.hook("context")` + `ctx.event.subscribe` | Context-window watch banner; session-deleted state cleanup. |
| `tui/profile-wizard/tui.ts` | TUI plugin | `/profile` dialog wizard: tier review, per-tier model override, live apply via server config API with file rewrite on request failure. |
| `tui/provider-wizard/tui.ts` | TUI plugin | `/provider` dialog wizard: baseURL/apiKey prompts, atomic write, model add/remove management; 🔌 Manage connections — union of the /connect credential store and config apiKeys (official built-ins and custom), one-click disconnect that keeps provider definitions and models. `/disconnect` (TUI-only keymap, official-/connect shape: one menu row, instant dialogs). |
| `tui/sidebar-status/tui.ts` | TUI plugin (slot) | TUI sidebar slot: plugin switches, MCP state, context watch, profile badge. |
| `tui/usage/tui.ts` | TUI plugin | `/usage` opens a dialog with auto-fitted width and a visible tab strip: **by session** (one row per session + total), **by agent**, **by model** — input (non-cached) / output / cached-in, cost, cache hit, share bars. `1/2/3` or `←→` (`[`/`[]`) switch tabs live via global keymap bindings; `Enter` closes. Dimensions switch in-dialog — typed `/usage all\|agent\|model` does NOT route (menu-Enter contract, no `slash.arguments`: decision record in `plugins/tui/_keymap-app.ts`). Pure view over server data — no local persistence. GAP: v2 folds steps into one assistant message per turn, so the "Steps" column counts assistant messages as the closest proxy. |
| `tui/project-wizard/tui.ts` | TUI plugin | `/project` dialog wizard: two-tier interactive wizard (scaffolding init, switch configuration, template sync, index catch-up) with re-entrant echo. New Node projects without an existing formatter may explicitly set up project-local dprint. Owns the `/project` TUI slash entry (menu Enter opens the wizard). The server `ctx.command.transform` twin in `project-manager.ts` serves BARE-Enter `/project <sub>` inside the TUI — keep it (its `init|index|sync` also back `/project` typed subcommands; headless `ocp project <sub>` parses independently in `install/src/index.ts`). |
| `md-to-pdf.ts` (+ `plugins/md-to-pdf/`) | `ctx.command.transform` + `ctx.tool.transform` | `/md-to-pdf` command & `md_to_pdf` tool: converts Markdown to styled A4 PDF via Pandoc + Playwright. Auto-steers natural language `@filepath 转PDF`. |
| `md-to-docx.ts` (+ `plugins/md-to-docx/`) | `ctx.command.transform` + `ctx.tool.transform` | `/md-to-docx` command & `md_to_docx` tool: converts Markdown to publication-quality styled Word (.docx) documents via Pandoc + Python typography engine. |

Workflow slash commands (`/dev-review`, `/goal`, `/handoff`, …) are native opencode command files in `commands/*.md` — thin launchers that instruct the agent to load the matching L2 skill (`skills/<name>/SKILL.md`) on demand. No runtime code, no system-prompt injection; the protocol body enters the conversation exactly once, only when the command is invoked. Runtime-logic plugins (guards, wizards, exporters) still register their commands programmatically via `ctx.command.transform(editor.add)`; every context-hook injector passes through the `agent-scope.ts` gate first (see shared plumbing), so injections never land in `@lite`, utility sessions, or subagent steps unless a per-plugin entry overrides the default (project-profiler does — its backend routing is explore's work discipline, not orchestration protocol).

### Auto-advisor internals

**Storage**: the `autoAdvisorMode` field in the project `.ocp/ocp.json` — no hidden state file, no env var. Resolution: project config → `off` (default); purely project-level, no global fallback. `/auto-advisor` always writes to the project-level config only (comments and other fields preserved).

**Four-surface enforcement** (`plugins/auto-advisor-mode.ts` + helpers in `plugins/auto-advisor/`) — v1's five hooks collapse to four in v2 (the `config` hook and plugin command merge into one `command.transform`):

1. `ctx.command.transform` (`editor.add`) — `/auto-advisor <mode>` upserts `autoAdvisorMode` in the project `.ocp/ocp.json`
2. `ctx.session.hook("context")` — injects the active-mode marker + embedded protocol into the system parts (`SystemPart[]`)
3. `ctx.tool.hook("execute.before")` — full-mode auto-answer enforcement (blocks the question tool when the advisor has auto-answered); off-mode relies on the system-prompt soft guard (no auto-dispatch, manual @advisor allowed)
4. `ctx.tool.hook("execute.after")` — parses confidence; full mode ≥ 8 gets the auto-execute directive (max 10/session, never on model fallback, never on red-team output)

### Red-team stance internals

An optional dispatch stance where `@advisor` argues AGAINST a proposal instead of balancing options — the design-phase gate, symmetric to `@code-review` as the implementation-phase gate. Same agent, same mode gating; only the stance changes.

- **Triggers**: explicit user request ("red team this" / "唱反调"), or orchestrator auto-trigger before irreversible design decisions (schema migration, public API contract, auth/permission redesign, destructive data operations). Never for routine single-domain tasks, bug fixes, or docs.
- **Output**: verdict `HOLDS` / `HOLDS WITH CAVEATS` / `FAILS` + severity-ranked attack list (weakness → what breaks → evidence) + steelmanned-defense rebuttal. No confidence score, by design.
- **On FAILS**: the orchestrator re-dispatches the design owner (`@architect`) with the attacks for rebuttal/revision, then presents attacks + rebuttal to the user. Optional tie-breaker: `@advisor` in neutral stance.
- **No blue team, on purpose**: the design owner defends their own proposal — a separate defender agent would produce hollow defense without design context. The system's real "blue team" is the implementation-phase gates: `@code-review`, `@security`, `@qa`, `/review-fix-loop`.

**Auto-execute isolation, enforced twice**:

- Prompt level: red-team output never carries a confidence score
- Code level: `isRedTeamOutput()` in `auto-advisor-runtime.ts` suppresses ALL directives in `auto-advisor-full-inject.ts` — adversarial verdicts can never trigger full-mode auto-execute, even if a stray score appears

### Compile & type-check

```bash
bun install
bunx tsc --noEmit    # type-check only — opencode compiles plugins at runtime
```

Opencode compiles plugins at runtime, but type errors indicate logic issues — run the check after any plugin change.

---

## Installer engine & OCP CLI

`install/` is a self-contained TypeScript engine (`install/src/`, run via Bun through `install/install.ps1` / `install/install.sh`). Modules:

- `index.ts` — CLI entry: action parsing (`install` / `update` / `status` / `register` / `unregister` / `wizard` / `dashboard` / `tui` / `serve` / `web` / `desktop`), and the launcher dispatch below;
- `installer.ts` — manifest-driven install/update/uninstall/status; carries the both-direction runtime/package compat gate (`requiredRuntimeMajor` / `checkRuntimeCompat`: OCP 2.x requires the opencode v2 runtime, v1↔v2 mixing is refused before any mutation; absent/unparseable versions fail open), and delegates the v2 terminal-client merge to `cli-merger.ts` (`mergeTuiConfig`: `cli.template.jsonc` → global `cli.json`, migrating a legacy v1 `tui.jsonc` plugin list on the first v2 run; plugin union is template-first with a `removed_plugins` retirement list (mirrors `removed_agents`) so deleted TUI plugins are stripped from the user's cli.json on upgrade; all other keys merge at leaf granularity — existing values win, missing template defaults are seeded);
- `manifest.ts` — `SHIPPED_DIRS` / `SHIPPED_FILES` → manifest generation;
- `wizard.ts` / `dashboard.ts` — interactive TUI setup wizard and single-screen control center (rows include `global_commands` and the three `openchamber_*` surface switches);
- `src/ui/` — standalone OpenTUI host for `ocp provider` / `ocp profile` / `dashboard` / project screens. `app.tsx` loads the SAME `plugins/tui/*-wizard.ts` modules through a `TuiPluginApi`-compatible adapter (`tui-host.ts` dialog stack); `opencode-theme.ts` + `builtin-themes.ts` adopt the user's opencode theme (`cli.json` `theme`, then opencode's theme-file hierarchy — built-in table < `~/.config/opencode/themes/` < `<cwd>/.opencode/themes/`, later shadows — never merges, plus hex/ANSI/refs/`{dark,light}`/`none` semantics) so the host looks like the opencode TUI — never hardcode wizard colors;
- `shim.ts` — global shims (`registerShim`) + PATH provisioning (`ensureBinDirOnPath`: Windows user-PATH registry via `[Environment]::SetEnvironmentVariable` — never `setx`; POSIX guarded profile block) wrapped by `runGlobalRegistration`;
- `launcher.ts` — runtime launchers behind `ocp tui` / `serve` / `web` / `desktop`, including the OpenChamber port-reclaim and auto-password logic;
- `openchamber.ts` — provision the `openchamber` CLI via the first detected package manager (pnpm > bun > yarn > npm) when missing (needs Node.js 22+), pinned to major 2 (`@openchamber/web@2`) like the opencode runtime; `openChamberWebMajorWarning()` warns (never blocks) when the installed CLI sits on another major.

`bin/opencode-prime` (bash) and `bin/opencode-prime.ps1` (PowerShell 7+) are standalone dispatchers that mirror the same subcommands without requiring Bun — installer subcommands exec `install.sh` / `install.ps1`, launcher subcommands (`tui`, `serve`, `web`, `desktop|ui`) are implemented natively per platform. `bin/ocp` / `bin/ocp.ps1` are thin forwarders. The full user-facing command list lives in the docs (`docs/maintenance/ocp-cli.md`).

Option switches in `install/options.jsonc` that gate engine behavior: `global_commands` (register shims + PATH during install, default `true`), `default_agent` (applied to `opencode.jsonc` when the name exists in the `agents` block), `tui_mode` (direct | herdr | luvus), `tools` (rtk, ripgrep, tgrep, and the three independent `openchamber_web` / `openchamber_desktop` / `openchamber_vscode` surfaces), `mcp` (per-server enable → `mcp.servers.<name>.disabled`), and `plugin` (npm plugin package membership).

---

## Testing

```powershell
# Structural checks only (no API calls)
pwsh -ExecutionPolicy Bypass -File tests/test-all.ps1 -StructuralOnly

# Structural + API prompt tests
pwsh -ExecutionPolicy Bypass -File tests/test-all.ps1

# Include behavioral prompt tests (API calls)
pwsh -ExecutionPolicy Bypass -File tests/test-all.ps1 -IncludePrompts

# Advisor-mode end-to-end (requires opencode CLI + LLM_ROUTER_* env vars)
pwsh -ExecutionPolicy Bypass -File tests/test-advisor-e2e.ps1

# Profile stress test (no API calls) — every profile applied to a fresh
# template copy; agent refs, root model, untouched tiers asserted
pwsh -ExecutionPolicy Bypass -File tests/test-profiles.ps1

# Unit tests (Bun) for individual plugins
bun tests/test-adr-guard-unit.ts
bun tests/test-env-guard-unit.ts
bun tests/test-e2e-adopt-unit.ts
bun tests/test-project-manager-unit.ts
bun tests/test-project-wizard-unit.ts
bun tests/test-project-dprint-unit.ts
bun tests/test-anchor-unit.ts
```

Pre-install gate (single-user repo — no CI by design): run `test-all.ps1 -StructuralOnly` (exit code 0) before `install/install.ps1`. Type-check the plugins once after toolchain setup: `bun install && bunx tsc --noEmit`. Runtime behavior (hooks, LLM compliance) still requires a real `opencode` environment — see the release workflow below.

API-test prerequisites:

```powershell
$env:LLM_ROUTER_BASE_URL = "https://router.example.com/v1"
$env:LLM_ROUTER_API_KEY  = "<your-api-key>"
```

### Test coverage

| Test | What it verifies |
|------|-----------------|
| Structural | File existence, frontmatter, protocol injection, content patterns, red-team guards |
| Decision strategy | Two-tier decision strategy, subagent no-ask rule, blocking markers |
| Advisor e2e | `/auto-advisor off/lite/full` state writes, invalid-arg no-op, off-mode soft guard (no auto-dispatch, manual @ allowed), cross-process persistence |
| Profiles | Every profile applies cleanly to a fresh template (agent refs, root model, untouched tiers) |
| Plugin units | adr guard commit gating, env-guard blocking matrix, e2e-adopt scaffold contract, project-manager gates, deepseek-anchor protocol |
| build.md / plan.md | Routing table, team table, workflow templates, identity, read-only rule |

---

## Design decisions

### Why not a single mega-prompt?
Token cost + context dilution. Specialist agents get only relevant domain knowledge, keeping context windows focused.

### Why shared instructions (`instructions` array)?
Output protocol, test scope, RFC keywords, and coding principles apply to ALL agents. Injecting via `instructions` ensures consistency without duplicating in each file.

### Why two primary orchestrators (build + plan) plus code?
- **build** = multi-domain orchestrator (full capability; default = dispatch specialists)
- **plan** = read-only analysis coordinator (review, audit, design)
- **code** = direct developer for single-domain tasks (no proactive delegation)
- Separation keeps analysis from mutating code; build's limiter is discipline, not missing tools.

### Why explore rides the flash tier?
Exploration is high-volume, low-complexity. Cheaper model + read-only + bounded steps = fast and cheap context gathering before dispatching specialists.

### Why no `designer` agent?
Design expertise (Design Tokens, AI Slop detection) is injected directly into `frontend-dev.md`. A separate designer agent would add routing overhead without sufficient benefit — frontend-dev already owns the UI domain.

### Why RFC 2119 for Hard rules but not competencies?
- Hard rules = constraints → LLM needs clear, unambiguous directives → RFC 2119 keywords maximize compliance.
- Competencies = knowledge → LLM needs semantic context for routing → prose is more effective than over-formalized bullets.

### Why `tiers.json` sidecar?
Upstream OpenCode (Console Go) rejects unknown schema fields in `opencode.jsonc`. The custom `tier` metadata therefore lives in a sidecar file consumed by the profile tooling instead of the root config.

---

## File inventory

```
instructions/
├── output-protocol.md        # Shared output format
├── test-scope.md             # Tiered test scope policy
├── rfc-keywords.md           # RFC 2119 keyword semantics
├── coding-principles.md      # Shared coding principles
└── edit-protocol.md          # Search-expression edit discipline (serena)

prompts/
├── build.md                  # Primary: full-capability orchestrator (default dispatch)
├── plan.md                   # Primary: read-only analysis coordinator
├── code.md                   # Primary: direct developer (default entry)
├── advisor.md                # Decision advisor + red-team stance
├── architect.md              # System design, ADR
├── code-review.md            # Deep/final diff/PR review
├── code-review-fast.md       # Routine P0/P1 diff triage
├── codegraph-scout.md         # Compact source-free graph evidence
├── gitnexus-scout.md          # Compact source-free process/cross-repo evidence
├── dba.md                    # Database, SQL, migrations
├── devops.md                 # Docker, K8s, CI/CD
├── explore.md                # Read-only explorer (efficient model)
├── frontend-dev.md           # Frontend + Design System + AI Slop
├── go-dev.md                 # Go/gRPC
├── java-dev.md               # Java/Spring Boot
├── node-dev.md               # Node.js/NestJS/Prisma
├── python-dev.md             # Python/FastAPI/Django
├── qa.md                     # Test strategy, coverage
├── researcher.md             # Tech research, comparison
├── rust-dev.md               # Rust/Axum/Tokio
├── security.md               # OWASP, vulnerability assessment
├── tech-writer.md            # Documentation
└── vision.md                 # Image/screenshot analysis

profiles/                     # Tier→model presets applied via /profile
providers/
├── antigravity-router.json   # Custom provider preset (seeded once, user-owned; importable via /provider → "Add preset")
├── claude-code-router.json   # Custom provider preset (seeded once, user-owned; importable via /provider → "Add preset")
├── codex-router.json         # Custom provider preset (seeded once, user-owned; importable via /provider → "Add preset")
├── llm-router.json           # Custom provider preset (seeded once, user-owned; importable via /provider → "Add preset")
├── omniroute.json            # Custom provider preset (OmniRoute gateway profile — ADR-0.38.0)
├── qoder-router.json         # Custom provider preset (seeded once, user-owned; importable via /provider → "Add preset")
└── qwen-router.json          # Custom provider preset (seeded once, user-owned; importable via /provider → "Add preset")

commands/                     # Native opencode slash-command launchers (thin: frontmatter + "load the skill")
├── dev.md · dev-plan.md · dev-quick.md · dev-flash.md · dev-review.md · dev-ultra.md · dev-deep.md   # Dev-flow launchers (agent: build)
├── git-merge.md                 # Git merge launcher — 2 strategies: merge/squash (agent-less; added in v0.23.0)
├── git-pick.md                  # Selective/all source-only cherry-pick with per-commit conflict resolution (agent-less; added in v0.27.0)
├── git-rebase.md                # Git rebase launcher — replay source commits onto target HEAD, linear (agent-less; added in v0.25.0)
├── git-pull.md                  # Safe upstream sync — ff-only first, diverged → guard + git-merge protocol; --rebase → git-rebase (agent-less; added in v0.24.0)
├── git-push.md                  # Safe push — ordinary push first; confirmed non-ff → guard + reconcile (merge/rebase) + retry; plain --force forbidden (agent-less; added in v0.27.0)
├── goal.md · handoff.md · grill-*.md · review-fix-loop.md · clean-dead-code.md
└── sdd.md · prd.md · plan.md · impl.md   # SDD launchers (agent: plan/code)

skills/                       # L2 workflow protocols — metadata resident, body loads on demand
├── dev/SKILL.md                     # /dev compositor — dev-quick/dev-plan/dev-review are preset routers over it
├── dev-prud/ · dev-ultra/ · dev-deep/
├── git-merge/SKILL.md          # /git-merge protocol — baseline-first conflict resolution, 2 strategies (merge/squash); Step 2 doctrine (incl. per-hunk confidence self-check + @advisor escalation) is shared with git-pick and git-rebase — see § Git workflow skill family (added in v0.23.0)
├── git-pick/SKILL.md           # /git-pick protocol — selected or all non-merge source-only commits, ordinary new commits, per-commit conflict resolution (added in v0.27.0)
├── git-rebase/SKILL.md         # /git-rebase protocol — replay source onto target HEAD, linear; self-contained conflict resolution (same Step 2 doctrine as git-merge in rebase terms — see § Git workflow skill family) (added in v0.25.0)
├── git-pull/SKILL.md           # /git-pull protocol — ff-first sync; diverged → guard backup + delegate to git-merge (--rebase → git-rebase) (added in v0.24.0)
├── git-push/SKILL.md           # /git-push protocol — ordinary push first; confirmed non-ff → guard + reconcile + retry; plain --force forbidden (added in v0.27.0)
├── goal/ · handoff/ · grill-me/ · grill-with-docs/ · improve-loop/
├── review-fix-loop/ · clean-dead-code/
├── adr-compaction/                   # /adr compaction protocol — analysis, batched drafting, native review Ask, archive/restore
├── adr-context/                      # Bounded retrieval protocol for adr_context (evidence-first, no gratuitous archive recursion)
└── sdd-workflow/             # Merged SDD protocol (/sdd /prd /plan /impl)

plugins/
├── shared/opencode-prime.ts      # Shared JSONC plumbing (project dir, field upsert)
├── shared/provider-creds.ts      # Credential single source of truth (auth store + config apiKeys; used by the wizard's disconnect flows)
├── auto-advisor-mode.ts           # Barrel: advisor mode guard (4 hook surfaces)
├── auto-advisor/                  # Mode config, runtime, protocol, per-hook helpers
├── adr.ts                         # Barrel: ADR workbench + iron-law guard
├── adr/                           # Engine, config, runtime, guard submodules, styles
│                                  #   + maintenance: compaction plans/apply, bounded
│                                  #     retrieval, journaled storage, view publication,
│                                  #     reversible archive moves, finite read guard
├── env-guard.ts                   # Barrel: secret-file gate
├── env-guard/                     # Config, runtime, tool guard
├── e2e-adopt.ts                   # Barrel: /e2e-adopt docs-governance scaffold
├── e2e-adopt/                     # Command, template, detect, apply
├── project-manager.ts             # Barrel: /project + commit discipline
├── project-manager/               # Command, scaffold, index, guards, templates/
├── project-memory.ts              # Barrel: /memory note|on|off|status + memory_note tool
├── project-memory/                # Config (switch + scoped lesson append), command, system-inject, tool
├── project-profiler.ts            # Barrel: project profile injection
├── context-watch.ts               # Barrel: context-window watch banner
├── context-watch/                 # Implementation
├── model-variants.ts              # Fold {provider,model,variant=effort} refs onto siblings; clears variant
├── tool-compress.ts               # Barrel: compress heavy native tool schemas (per-agent)
├── tgrep.ts (+ tgrep/)            # Barrel: registers tgrep_search (options.codemode:false)
├── deepseek-anchor.ts             # Barrel: /deepseek-anchor command
├── deepseek-anchor/               # Command, config, announce, index
├── sdd.ts                         # Barrel: SDD engine (/sdd runtime actions only)
├── sdd/                           # Engine + prompt hook (protocol lives at skills/sdd-workflow)
├── rtk-write/                     # Directory entry (no root barrel): vendored rtk command rewrite
├── lite-mode.ts                   # Hook: strip L0 from @lite system prompt
├── lite-mode/                     # Implementation
├── shared/plugin-scope.ts         # Scope policy (consumes plugin-scope.json)
├── shared/agent-scope.ts          # V2 gate: per-agent hook scoping (event.agent → system sentinel → parentID) over plugin-scope.ts
├── shared/notify.ts               # Announce surface bridge: v2 Context has no TUI domain → server-log line (OCP-V2-GAP)
├── shared/plugin-switch.ts        # Shared on/off state machine (auto-advisor, adr/env-guard, project-memory)
├── shared/system-block.ts         # Shared appendBlock / stripBlockByLine / escapeRegExp for context-hook injectors (SystemPart[])
├── design-token-guard.ts          # Hook: block hardcoded design values
├── ai-slop-scanner.ts             # Hook: scan for AI anti-patterns (filesystem.changed)
├── auto-format.ts                 # Hook: auto-run formatters (filesystem.changed)
├── browser-screenshot.ts          # Custom tool: Playwright screenshots
└── tui/                           # TUI plugins (registered in cli.template.jsonc:plugins → global cli.json)
    ├── provider-wizard.ts         # /provider dialog wizard + /disconnect (TUI keymap)
    ├── profile-wizard.ts          # /profile dialog wizard (core logic in shared/profile-core.ts)
    ├── project-wizard.ts          # /project dialog wizard
    ├── sidebar-status.ts          # TUI slot: plugin/MCP/profile status panel
    └── usage.ts                   # /usage token/cost view (assistant-message step proxy — OCP-V2-GAP)

tests/
├── test-all.ps1              # Main test runner (structural + prompt tests)
├── test-profiles.ps1         # Profile stress test
├── test-advisor-e2e.ps1      # Advisor-mode end-to-end (needs opencode CLI)
├── test-*-unit.ts            # Bun unit tests (adr, adr-compaction, env-guard, e2e-adopt,
│                             #   project-manager, anchor)
├── test-adr-compaction-*.ts  # Compaction services, 14-boundary crash matrix, native
│                             #   runtime/restart, release-package and installed-tree delivery
├── test-build/plan/subagent/ # Prompt dispatch tests
├── test-decisions.ps1        # Decision strategy checks
└── README.md                 # Test documentation
```

---

## Release workflow

1. Bump `version` in `install/version.json` (e.g. `2.1.0`) and sync `package.json` `version` + `install/README.md` title to match.
2. Regenerate the manifest: `bun run manifest:generate` — the manifest is **always overwritten**, so ensure `SHIPPED_DIRS` / `SHIPPED_FILES` in `install/src/manifest.ts` include every new file (see `AGENTS.md` §4). **Never hand-edit a generated manifest.** `pack.sh` / `pack.ps1` resolve the shipped-file inventory through `scripts/check-package-manifest.ts`, which refuses to build when the current-version manifest disagrees with what actually ships (a stale manifest silently omits files from the archive).
3. Run structural tests: `pwsh -ExecutionPolicy Bypass -File tests/test-all.ps1 -StructuralOnly`.
4. Type-check plugins: `bun install && bunx tsc --noEmit`.
5. Commit and push to the release line (`dev-v1`, `dev-v2.x`, …). Do **not** merge to `main` first — each line is its own release line; a `main` merge is optional snapshot only (see `AGENTS.md` §3).
6. Tag and push from that line: `git tag v2.1.0 && git push origin v2.1.0`.
7. The [Release workflow](.github/workflows/release.yml) builds `opencode-prime-<ver>.tar.gz` + `.zip` and creates a GitHub Release automatically — no manual artifact upload needed.

Runtime behavior (hooks, LLM compliance) cannot be fully covered by the structural suite — verify in a real **opencode v2** environment against the pre-release flow before tagging.
