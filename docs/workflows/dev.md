# `/dev` Compositor

`/dev` is the single-pass pipeline compositor behind the [Five Dev Flows](dev-loops.md): assemble your own development pipeline from spec depth, plan review, code review, and QA flags. The preset commands (`/dev-quick`, `/dev-plan`, `/dev-review`) are fixed flag sets over this engine.

---

## Flag grammar

| Flag | Effect |
|---|---|
| `--plan` | Ephemeral in-session plan (clarify + plan + confirm gate) |
| `--sdd[="prd,adr,plan"]` | Documented SDD lifecycle front-end (implies `--plan`) |
| `--plan-review[=1\|2]` | Plan audit before confirm gate (implies `--plan`) |
| `--code-review[=1\|2]` | Post-implementation audit (bare value = 1) |
| `--qa` | `@qa` derives regression tests from acceptance criteria |
| `--fast` | Force `@fast-coder` regardless of other flags |
| `--max-rounds=N` | Review/fix round cap |
| `--auto-advisor[=full\|lite\|off]` | Task-scoped advisor mode override (bare = `full`); when present it governs Clarify auto-adopt + Confirm proxy-approve for this run only; absent → the ambient global mode applies |

Legacy alias: `--review` (still accepted on preset commands) → `--code-review=1`.

## Parsing & normalization rules

1. **Reviewer flags** (`--plan-review`, `--code-review`): bare = `1`; only `=1` / `=2` accepted. Any other value (including `dual`) → error `"valid values: 1|2"` and halt. Never guess.
2. **`--sdd` value is a set, not a sequence**: comma-separated, case-insensitive, whitespace-trimmed, duplicates silently deduped. Valid tokens: `prd`, `adr`, `plan`.
   - `impl` → error: "`impl` is not valid here — /dev already IS implementation". Any other token → error listing valid tokens.
   - Execution order is ALWAYS normalized to `prd → adr → plan`; input order is ignored.
   - Normalization never ADDS phases: `--sdd="plan,adr"` runs adr → plan, skipping prd. Bare `--sdd` = `"prd,adr,plan"`.
3. **`--max-rounds`**: per-preset default (table below); bare `/dev` default 5. Clamped to [1, 99]; non-numeric → preset default.
4. **Unknown flag** → one-line error listing valid flags; halt. No silent ignore.
5. **`--auto-advisor`**: bare = `full`; valid values `full|lite|off`; any other value → error listing valid values and halt. Effective ONLY when the ephemeral Clarify/Confirm stages run (`--plan` without `--sdd`) — a no-op on raw passthrough and under `--sdd` (artifact gates don't consult advisor mode). When effective it overrides the ambient global mode for this run only — any ambient auto-advisor injection is disregarded for these gates; absent → the global mode applies.

## Implications

| Flag present | Implies |
|---|---|
| `--plan-review` | `--plan` |
| `--sdd` | `--plan` (the documented lifecycle REPLACES the ephemeral Clarify+Plan stages; the last plan artifact is the confirmed plan) |
| `--code-review=2` | Dual review + `@advisor` arbitration on disagreement (Safety-First) |
| `--review` | `--code-review=1` |

## Coder routing

| Flags after normalization | Coder |
|---|---|
| Zero depth flags (none of `--plan/--plan-review/--sdd/--code-review/--qa`) | `@fast-coder` (Flash tier) |
| ANY depth flag | Domain-routed `@<lang>-dev` per `build.md` routing (`@node-dev`, `@python-dev`, `@frontend-dev`, `@dba`, …; multi-domain → sequential dispatches in dependency order) |
| `--fast` (overrides) | `@fast-coder` even with depth flags |

## Preset equivalence

| Preset | Equivalent `/dev` flags | Legacy translation | max-rounds default |
|---|---|---|---|
| `/dev-quick` (alias `/dev-flash`) | *(none)* | `--review` → `--code-review=1` | 3 |
| `/dev-plan` | `--plan` | `--review` → `--code-review=1` | 5 |
| `/dev-review` | `--code-review=2` | — | 10 |
| bare `/dev` | your flags | `--review` → `--code-review=1` | 5 |

Review stages use deterministic tiering: L0 skips review for docs/lockfiles/renames/version
bumps; L1/L2 dispatch `@code-review-fast` (pro/medium/15 steps). Before a qualifying L3
review, one ready graph backend may provide bounded evidence: CodeGraph for ordinary single-repo
impact, GitNexus for process/group/cross-repo questions. Otherwise L3 dispatches `@code-review`
(max/high/30 steps) directly.

## Usage

```bash
# Plan + dual code review + QA — a composition no preset covers
/dev Implement webhook retry with exponential backoff --plan --code-review=2 --qa

# Documented SDD front-end skipping the PRD (adr → plan), then implementation
/dev Add multi-tenant row-level security --sdd="adr,plan"

# Plan audit before coding: dual plan review + single code review
/dev Refactor the billing importer --plan --plan-review=2 --code-review=1

# QA alone — regression tests derived from the raw requirement
/dev Tighten the CSV parser edge cases --qa

# Force the fast coder even with depth flags
/dev Quick prototype of the settings drawer --plan --fast

# Explicit round cap
/dev Migrate config loader to ESM --code-review=1 --max-rounds=8
```

## When no preset matches

The five flows are decision defaults. When you need a combination they don't encode — a plan with dual review, QA without review, an SDD front-end that skips the PRD — invoke `/dev` directly with the flag set you want. The engine composes the same linear pipeline (SDD-Spec → Clarify → Plan → PlanReview → Confirm → Implement → CodeReview → QA → Deliver) from your flags: each stage runs or is skipped, never interleaved.

## Boundary

`/dev-prud` (FMEA risk register) and `/dev-ultra` (autonomous multi-phase) remain **standalone protocols** — different topologies (register-driven / multi-phase autonomous) that are not expressible as `/dev` flags.

See [Five Dev Flows](dev-loops.md) for the preset-first overview.
