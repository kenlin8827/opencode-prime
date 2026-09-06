# Plan-First Development (`/dev-plan`)

Plan-dev front-loads **requirement clarification and implementation planning before any code is written**. It is one of the [Five Dev Flows](dev-loops.md) — the plan-first philosophy: see and approve the plan before a single line of code exists, then execute with optional review.

> Implemented as the `--plan` preset of the [`/dev`](dev.md) engine.

---

## Workflow

```
1. Clarify   @advisor Socratic loop — batch questions (FACTUAL/PREFERENCE tagged),
            contradiction check, max 3 rounds; leftovers become explicit assumptions
2. Plan      @architect — structured implementation plan with step-by-step breakdown,
            agent assignments, risk notes
3. Confirm   user gate — or auto-advisor full proxy-approve (FACTUAL, ≥ 8)
4. Implement @<lang>-dev (domain-routed) — per the confirmed plan;
            tests at the test-scope.md tier before done
5. Review    (optional, --review flag) tiered evidence-driven audit;
            fix loop max 5 rounds
6. Deliver   verification report + plan-executed summary
```

## The plan artifact

The plan is the contract between requirement and implementation. It contains:

- **Step-by-step breakdown** — ordered, each step: what, which files, dependencies
- **Agent assignments** — domain-routed (`@node-dev`, `@python-dev`, `@dba`, etc.)
- **Risk notes** — any step that could fail or needs special attention
- **Assumptions** — explicit list of unresolved items from clarification

## Clarification phase

The Socratic clarification uses `@advisor` to surface ambiguities, edge cases, and implicit constraints:

1. **Batch questions** — all questions presented at once via the `question` tool, tagged FACTUAL (verifiable) or PREFERENCE (user choice) with confidence scores
2. **Contradiction detection** — after user answers, advisor checks for contradictions; if found, re-ask only the contradiction points (max 3 rounds)
3. **Auto-advisor compatibility** — full mode auto-adopts FACTUAL questions with confidence ≥ 8; lite/off mode presents all to user
4. **Fallback** — after 3 rounds with unresolved ambiguity, proceed with explicit assumptions recorded in the plan header

## Optional review

By default, dev-plan skips review entirely for maximum speed. With `--review`:

- `@code-review-fast` by default; `@code-review` for sensitive/L3/final gates
- Max 5 fix rounds (configurable via `--max-rounds=N`)
- Same audit protocol as other flows: requirement traceability, defensive code audit, anti-slop check

## Selection guide

| Factor | Pick |
|---|---|
| Want to approve plan before coding | `/dev-plan` |
| Throwaway script, no plan needed | `/dev-quick` |
| Mission-critical, needs dual review | `/dev-review` |
| Safety-critical, needs FMEA | `/dev-prud` |
| Large autonomous multi-phase objective | `/dev-ultra` |

## Usage

```bash
# Standard plan-first development
/dev-plan Implement user avatar upload and crop component

# With optional single-review audit
/dev-plan Add payment webhook handler --review

# With extended review loop
/dev-plan Refactor order service --review --max-rounds=8
```

Arguments: `--review` (enable single-review audit, default off), `--max-rounds=N` (review-fix rounds when `--review` is set, default 5, range 1–99).
