---
name: review-report
description: Review Report - create a compact, durable review record after a qualifying review. Load ONLY for L2/L3, P0/P1 findings, a terminal review-fix-loop, or an explicit request to retain a report.
---

# Review Report

Write durable review decisions without preserving source, diffs, tool output, or agent transcripts.

## Trigger

Create a report only for L2/L3, P0/P1 findings, a review-fix-loop terminal state, a release/final gate, or an explicit user request. Do not write a clean L0/L1 review by default.

## Location and lifecycle

- Write `docs/reviews/YYYY-MM-DD-<scope>.md`; use `-2`, `-3`, and so on if occupied. Never overwrite.
- English only. It is a project record and may be committed with the reviewed change.
- `.omo/` remains local agent evidence, not a durable report.
- Subsequent agents receive only the verdict, unresolved-risk sentence, and report path.

## Required record

```md
# Review: <scope>

- Baseline: <commit, branch, PR, or uncommitted range>
- Tier: L<n>; reviewers: <agents>
- Verdict: Cleared | Changes requested | Inconclusive

## Findings

- P<n> — <file:line> — <one-line cause and required action>

## Verification

- `<command>` → pass | fail | not run (<reason>)

## Decision and residual risk

<one compact paragraph>
```

Omit an empty Findings section only for `Cleared`. Record only verified findings; link to
source locations rather than reproducing source. If the result is `Inconclusive`, say what
blocks a verdict and who must decide.
