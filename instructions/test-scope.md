# Test scope policy — single source of truth

> **Top principle**: minimize wasted time and resources, find the best balance point with quality. Test depth is matched to change size — full suite and E2E are exceptions, not the baseline.

Layer L1: attached to coding/review agent prompts via `{file:}` assembly (not injected globally).

## Tier table

| Change size | Default tests to run |
|---|---|
| Docs / config comments only (no code change) | none — no code run |
| ≤ 1 file (tweak / rename / comment) | `compile` + `lint`/`type-check` |
| 2–5 files in one module | unit tests for changed files + direct callers |
| > 5 files OR cross-module | + integration tests for touched modules |
| Schema / contract / shared infra / cross-service | + E2E on the boundary |
| User explicitly asks "run all tests" | full suite |

## Why this principle (the balance point)

- **Minimize wasted time/resources**: full suite on every change burns CI minutes and slows feedback. E2E is slow + flaky + expensive.
- **Maintain quality**: tier 1 (compile + lint) catches syntax/type errors. Tier 2 (unit tests) catches logic errors at 1-second feedback. Tier 3 (integration) catches module-contract errors. E2E catches user-journey errors.
- **The balance**: use the smallest tier that still gives real signal. Escalate only when justified.

## Escalation rules (when to promote to a higher tier)

Promote one tier when:

- Diff touches public API, schema, auth/payment, message contracts, or shared infra (auto-promote).
- Caller chain is unclear → run callers' unit tests.
- Flaky failure on lower tier → **investigate root cause** (mock time/random/network, find the order-dependence). Escalate tier only if the failure suggests cross-module interaction; never as a retry-in-disguise.

Never promote to E2E without one of:

- User said so.
- Diff crosses a service boundary / critical user journey.
- Lower tiers proved insufficient for this change.

## Bug-fix override

A bug fix with zero tests is not a real bug fix. Default to at least the 2–5-file tier (unit tests for changed file + direct callers), regardless of file count — the unit tier is the floor for bug fixes, not the 1-file tier.

## Skip rules (when NOT to run a higher tier)

- **E2E**: last resort — slow, flaky, expensive. Only when explicitly requested OR diff touches critical user journey / auth / payment / data-mutation. Confirm with user before executing.
  - **Project red-line doc** (`docs/e2e-redline.md`, adopted via `/e2e-adopt`): when present, it is the project's authoritative E2E policy — follow its tier table, confirmation loop, and coverage mandate; it wins over this generic policy on conflict.
- **Full suite**: only when requested, on release branches, or when the change is genuinely cross-cutting and module-scoped tests give no confidence.

## Transparency rule

`@qa` and `@code-review` reports MUST state which tier they ran and why. Silent "all green" without a tier label is a bug in the report.

Coverage tiering is defined in `prompts/qa.md` — the agent names the code class (Critical / Business / Other) in the report.

## What this policy is NOT

- **Not a replacement for CI.** CI still runs the full suite on PR/merge. This policy is for **local / per-change** execution.
- **Not a coverage waiver.** Coverage targets are **tiered**, not removed. Tiering is about *when* tests run, not *whether* they exist.
- **Not agent discretion on bug fixes.** Bug fixes have a floor (2–5-file tier). Discretion applies to other tiers.
