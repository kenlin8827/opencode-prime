# Workflow Slash Commands

OpenCode Multi-Agent ships with a suite of high-leverage workflow slash commands.

---

## Command Overview

| Command | Category | What it does |
|---|---|---|
| **`/prd <topic>`** | SDD Lifecycle | Scaffold & draft Product Requirements Document in `docs/prd/` |
| **`/adr [new\|supersede\|tree\|check\|migrate\|mode]`** | Architecture | Architecture Decision Record management: automated drafting, supersede lifecycle, DAG graph, link audits, bidirectional migrations & hierarchy mode switches |
| **`/plan <topic>`** | SDD Lifecycle | Scaffold & draft phased Implementation Plan in `docs/plan/` with automatic PRD & ADR linking |
| **`/impl [task]`** | SDD Lifecycle | Execute test-driven code implementation & verification adhering to specifications |
| **`/sdd [status\|handoff\|help]`** | SDD Lifecycle | Specification-Driven Development lifecycle navigator & session handoff (`/sdd handoff`) |
| **`/grill-me <topic>`** | Brainstorming | Socratic interview that rigorously pressure-tests a plan or design |
| **`/dev <requirement> [--plan] [--sdd[="prd,adr,plan"]] [--plan-review[=1\|2]] [--code-review[=1\|2]] [--qa] [--fast] [--max-rounds=N] [--auto-advisor[=full\|lite\|off]]`** | Dev Flow | **Dev Compositor**: single-pass pipeline engine — spec depth (`--plan` / `--sdd`), plan review, code review (1\|2), and QA flags compose your pipeline; `--auto-advisor` overrides the advisor mode for this run only (bare = full); presets dev-quick/dev-plan/dev-review are fixed flag sets over this engine (see [/dev Compositor](dev.md)) |
| **`/dev-quick <task> [--review] [--max-rounds=N]`** | Dev Flow | **Quick-Dev Zero-Review Fast Track**: Lowest-cost Flash-tier coding + dynamic domain persona injection (instant delivery; optional `--review` triggers single audit, alias `/dev-flash`; no-depth-flag preset of `/dev` — see [Five Dev Flows](dev-loops.md)) |
| **`/dev-plan <requirement> [--review] [--max-rounds=N]`** | Dev Flow | **Plan-Dev Plan-First Development**: Socratic clarification + architect plan + domain-routed implementation, with optional single review on demand (`--plan` preset of `/dev`, see [Five Dev Flows](dev-loops.md)) |
| **`/dev-review <task> [--max-rounds=N]`** | Dev Flow | **Review-Dev Mission-Critical Dual-Review Loop**: Domain-routed coding + dual flagship review + Advisor consensus arbitration with full-stack multi-stage staging (`--code-review=2` preset of `/dev`, see [Five Dev Flows](dev-loops.md)) |
| **`/dev-ultra <objective> [--max-rounds=N] [--max-phases=N]`** | Dev Flow | **Ultra-Dev Autonomous Multi-Phase Track**: End-to-end autonomous execution — decomposes large objectives into phases, each with tiered review, context compaction, git-commit isolation, one max final gate, and `--resume` support (see [Five Dev Flows](dev-loops.md)) |
| **`/dev-prud <requirement> [--top=N] [--max-rounds=N]`** | Dev Flow | **FMEA-front-loaded development**: Socratic clarification + pre-implementation risk register (SEV×PROB ranked, top-N) that drives planning, implementation, and register-audited verification (see [Prudent Development](dev-prud.md)) |
| **`/review-fix-loop [scope] [--max-rounds=N]`** | Quality Loop | Automated review-verify-fix-re-review loop until zero P0/P1 issues. Scope: `last commit`, `HEAD~N`, `branch`, `PR`, or uncommitted changes |
| **`/git-merge <source> <target> [--dry-run] [--no-verify] [--squash] [--no-ff] [--continue] [--abort]`** | Git Workflow | **Stock `git merge`, agent as the resolver**: syncs target to origin (`--ff-only`; divergence halts), guard-backs up, then merges — git auto-merges everything it can, and only conflicted files get hands-on semantic resolution with **target HEAD as the authoritative baseline**. One clean commit → `--squash`; otherwise no flag (merge commit keeps both sides' topology) |
| **`/git-pick <source> <target> <commit>... [--all] [--dry-run] [--no-verify] [--continue] [--skip] [--abort]`** | Git Workflow | **Stock `git cherry-pick`, agent as the resolver**: copies selected commits — or with `--all` every non-merge commit unique to source — in reverse topological order, resolving per commit against target as the baseline. Each result is a new ordinary commit (never a merge commit); source history is unchanged |
| **`/git-rebase <source> <target> [--dry-run] [--no-verify] [--continue] [--skip] [--abort]`** | Git Workflow | **Stock `git rebase`, agent as the resolver**: replays all of source's unique commits onto target's HEAD for a linear history — syncs target, guard-backs up **both** tips, resolves each stopped commit semantically, then fast-forwards target. Rewrites source: updating an already-pushed source needs `git push --force-with-lease`, your call |
| **`/git-pull [--rebase] [--dry-run] [--no-verify] [--abort]`** | Git Workflow | **Safe upstream sync for the current branch**: `git pull --ff-only` first, rewriting nothing; diverged → guard backup, then delegate to the git-merge protocol with the fetched upstream as source. `--rebase` replays local commits onto the remote tip instead. No `--squash` — squashing published branch history is never legitimate |
| **`/git-push [--rebase\|--merge] [--dry-run] [--no-verify] [--force-with-lease] [--abort]`** | Git Workflow | **Safe push for the current branch**: fetches the configured upstream and tries ordinary `git push`; a confirmed non-fast-forward rejection → guard backup, reconcile through merge or rebase, verify, and retry. Auth, policy, hook, network, and semantic conflicts halt; plain `--force` is forbidden |
| **`/grill-improve-loop [subject] [--max-rounds=N] [--target=N]`** | Score Loop | Score-driven improvement loop: score → analyze → fix/refactor → verify → re-score until structural ceiling, stall, or max rounds. Triggers verification-honesty scoring (Rules 5–7) every round |
| **`/goal [text]`** | Goal Execution | Structured goal execution protocol with audit-friendly checklists and mechanically checkable stop conditions |
| **`/handoff [focus]`** | Session State | Compacts current session state into a git-safe handoff bundle (`.opencode/handoffs/`) and outputs a paste-ready opener for a fresh session |
| **`/adr-guard [on\|off\|status]`** | Quality Gate | Project-level ADR commit gate: enforces architecture decision records on `feat:` and `refactor:` commits |
| **`/e2e-guard [on\|off\|status]`** | Quality Gate | Project-level E2E testing gate: requires end-to-end coverage verification on features and bug fixes |
| **`/env-guard [on\|off\|status]`** | Security Gate | Project-level secret leak prevention: blocks reading or leaking `.env` files to external tools |
| **`/deepseek-anchor [on\|off\|status]`** | Model Engine | DeepSeek V4/Pro reasoning depth anchor: prevents reasoning degradation and gates tools during deliberation |
| **`/auto-advisor [off\|lite\|full]`** | Intelligence | Toggle auto-advisor mode (`off`, `lite` recommendations, `full` factual auto-answers) |
| **`/md-to-pdf <file.md> [output.pdf]`** | Publishing | Export Markdown to high-res A4 PDFs with 300 DPI Mermaid diagrams, CSS themes & `--doctor` diagnostics |
| **`/md-to-docx <file.md> [output.docx]`** | Publishing | Export Markdown to publication-grade Word (.docx) with pure TS engine, dual fonts & Mermaid rendering |
| **`/project` (or `init`/`index`/`sync` subcommand)** | Project Setup | `init\|index\|sync` subcommands scaffold project baseline files (`.opencode/opencode.jsonc` etc.) and trigger CodeGraph / GitNexus indexing. Bare `/project` opens the interactive wizard menu (toggles MCP services & plugins via visual terminal UI) |
| **`/memory [capture\|on\|off\|status]`** | Project Memory | Opt-in project memory: capture lessons, view or toggle the gate, check injection status (memory stored outside the project under the ocp memory root) |
| **`/profile`** | TUI Wizard | Open model profile picker: easily switch or customize Auto / Ultimate / Performance / Economy / Lightweight tiers |
| **`/provider`** | TUI Wizard | Open provider wizard: configure credentials (`baseURL` / `apiKey`) and manage model catalogs |
| **`/disconnect [id\|--all]`** | TUI Wizard | Disconnect a provider credential — bare opens the connections wizard; `<id>` jumps straight to confirm; `--all` asks once for every connection |
| **`/queued`** | TUI Wizard | Interactive TUI dialog to inspect, edit, or cancel queued messages submitted while the agent was busy |
| **`/usage [session\|agent\|model\|all]`** | Observability | Token/cost usage with tabbed dimensions (session / agent / model) — 1/2/3 or ←→ to switch, ↑/↓ to scroll |

> The five `/git-*` commands share one doctrine: preflight halts instead of cleaning up after you, `--ff-only` target sync where applicable, `guard/` backups, baseline-first conflict resolution, a per-hunk confidence self-check that escalates to `@advisor` and hands uncertain hunks to you rather than guessing, verify-once honesty, and a redacted hash-chained audit trail in `.git/ocp-*-reports/` on **every** invocation. Full doctrine, flag matrix and failure catalog: **[Git Workflows](git.md)**.



---

## Example: review-fix-loop

```
> /review-fix-loop last commit
  → @code-review-fast finds P0/P1 issues; qualifying L3 routes add one compact capability-selected graph evidence pass before @code-review
  → Verifies each finding (reads code, traces data flow, checks upstream guards)
  → If false positive → skipped only after @advisor confirms
  → If confirmed BUG → @<domain-dev> fixes each verified issue
  → @code-review-fast re-reviews; the final Cleared gate uses max @code-review
  → Repeats until clean or max rounds reached (default: 5)
  → Summary output: verdict + stats

> /review-fix-loop HEAD~3 --max-rounds=8
  → Same flow, up to 8 rounds (good for larger diffs)
```
