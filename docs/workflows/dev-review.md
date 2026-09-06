# Dual-Review Deep Consensus (`/dev-review`)

Review-dev enforces **dual independent review with arbitration** for mission-critical code. It is one of the [Five Dev Flows](dev-loops.md) — the deep consensus philosophy: an architect and a fast P0/P1 reviewer attack the diff through different lenses, then a max-tier final gate and advisor arbitration protect the Cleared decision under Safety-First principles.

> Implemented as the `--code-review=2` preset of the [`/dev`](dev.md) engine.

---

## Workflow

```
1. Code       @<lang>-dev (domain-routed) — reads raw requirements, implements
             across all touched layers; tests at test-scope.md tier
2. Review A   @architect — "Requirement Traceability & Contract Lens":
             spec coverage, architectural cohesion, contract integrity
3. Review B   @code-review-fast — "Defensive P0/P1 Lens":
             boundary conditions, concurrency safety, error recovery, strict typing
4. Arbitrate  @advisor — Safety-First principle resolves disagreements
5. Final gate  @code-review (max) — Cleared decision after process rounds
6. Consensus  both approve → final gate; disagreement → fix loop (max 10 rounds)
7. Deliver    verification report + dual-review sign-off
```

## Dual-review protocol

Both reviewers share the same evidence-driven baseline (Execute → Observe → Match) but operate through different lenses:

### Reviewer A — Architecture & Contract Lens (`@architect`)

- **Requirement Traceability** — every requirement in the user's raw prompt must map to exact code; unimplemented = finding
- **Anti-Slop & Contract Defense** — scope cuts, fake mocks, empty TODOs, happy-path-only logic; cross-module DTO and API contract fit
- **Verdict** — APPROVE only when every requirement is traceable AND no architectural defect found

### Reviewer B — Defensive Engineering & Resiliency Lens (`@code-review-fast`)

- **Defensive Code Audit** — null/undefined safety, error recovery, resource deallocation, strict typing (zero arbitrary `any`)
- **Extreme Stress & Concurrency** — race conditions, thread safety, boundary overflows, unhandled async rejections
- **Verdict** — APPROVE only when no concrete defect found

## Arbitration

When reviewers disagree (one approves, one rejects, or conflicting recommendations):

1. Dispatch conflicting points + raw requirements + both reports to `@advisor`
2. **Safety-First Principle** — when in doubt regarding security, correctness, or data integrity, always favor the stricter requirement
3. Advisor outputs final consolidated **Actionable Fix List**

## Selection guide

| Factor | Pick |
|---|---|
| Mission-critical: distributed TX, full-stack, security-sensitive | `/dev-review` |
| Plan approval desired, review optional | `/dev-plan` |
| Safety-critical, needs FMEA | `/dev-prud` |
| Large autonomous multi-phase objective | `/dev-ultra` |
| Throwaway script, no review needed | `/dev-quick` |

## Usage

```bash
# Mission-critical feature — dual review + arbitration
/dev-review Refactor settlement engine with distributed transaction compensation

# Full-stack feature with extended review loop
/dev-review Implement QR-code login: session table, polling API, dialog --max-rounds=10
```

Arguments: `--max-rounds=N` (max iteration rounds, default 10, range 1–99).
