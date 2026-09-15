# /build-product — Invoke @ultra in product-shaped mode

`/build-product` is the slash-command entry that invokes **`@ultra`** (the universal full-domain commander) in its **product-shaped mode**. One-line requirement → full pipeline.

For **non-product tasks** (SQL optimization, bug fix, refactor, scripts, library work, infra setup, code review), invoke `@ultra` directly — it runs a lightweight **Triage → Contract → Dispatch → Verify → Deliver** loop.

---

## At a glance

| | |
|---|---|
| **Command** | `/build-product <one-line requirement> [flags]` |
| **Agent** | `@ultra` (primary, universal commander) |
| **Category** | Dev Flow |
| **Output** | Working product at project root + `docs/build-product/<slug>/` artifacts |
| **Default round cap** | 3 QC iterations |

---

## Stages (full pipeline mode)

```
P1  Grill        @advisor + requirements constitution  → SPEC.md (MACHINE block)
P1.5 Preflight   @ultra probes stack toolchain          → env report
P2   Confirm     user gate (silence → all defaults advance)
P3   Design      @designer + universal design-guide     → DESIGN.md
P4   Architecture @architect                            → ARCHITECTURE.md
P5   Scaffold    capability-routed implementer           → foundation
P6   Backend+DB  @dba then @<lang>-dev from contract    → endpoints + schema + seeds
P7   Implement   serial default; --parallel adds forbidden-modify lists
P8   Security    @security → SEC_VERDICT (FAIL → one backend fix round)
P9   QC loop     @qa + quality constitution             → VERDICT (FAIL → P7 ×N)
P10  Gate        @code-review-fast + @ultra's own gates → APPROVE / REQUEST_CHANGES
P11  Deliver     @tech-writer README sweep + report    → delivery summary
```

Two back-edges only: P8 → P6 (once), P9 → P7 (bounded). `@ultra` drives every transition.

## Tech-stack agnostic

`@ultra` has **no built-in tech-stack bias**. Stack knowledge lives in `references/constitution/language_stacks.yaml` — an **open registry** of stack cards (web: typescript_web / vue_web / svelte_web / static_web; mobile: flutter / react_native / swift_kotlin_native; mini-programs: taro / uniapp; backends: node_ts / go / rust / java / python; focused SQL; library_sdk). Uncovered stacks grow live via the `extension_rule`. No card is more default than another.

## Output artifacts

```
docs/build-product/<slug>/
├── SPEC.md             # P1 — scope verdict + capabilities (Given/When/Then) + decision trees
├── DESIGN.md           # P3 — tokens, pages/screens + per-section animation, asset manifest
├── ARCHITECTURE.md     # P4 — layering, pinned versions, field-level API contract, budgets
└── qc/
    ├── security.md     # P8 — SEC_VERDICT block
    └── acceptance-round-N.md
```

## Flags

| Flag | Default | Effect |
|---|---|---|
| `--max-rounds=N` | `3` | QC ↔ fix loop cap. Clamp [1, 99]. |
| `--parallel` | off (serial) | P7 parallel page agents — each carries a forbidden-modify list. |
| `--no-security` | off | Skip P8 (backend shapes). Risky. |
| `--no-qc` | off | Skip P9. Final gate still runs. Risky. |
| `--no-gate` | off | Skip P10. Risky; refused when combined with `--no-qc`. |
| `--auto-advisor[=full\|lite\|off]` | ambient global | P1/P2 advisor behavior. Bare = full. |

## When to use

Use `/build-product` when: a single sentence expresses a full product (app, service, site, tool, mobile app, mini-program, library). For everything else, invoke `@ultra` directly — it triages into the focused loop.

## Examples

### Product-shaped (one-liner → product)
```
> /build-product build me a Trello-style kanban board
  → P1 SPEC (fullstack) → P2 confirm → P3 DESIGN → P4 ARCHITECTURE → P5 scaffold → P7 implement → P9 QC → P10 gate → P11 deliver
```

### Focused (any non-product task via @ultra directly)
```
@ultra optimize this query: <paste query>
  → Triage: focused work, SQL optimization
  → Contract: EXPLAIN before/after + p95/p99 timing; done when X% faster on workload Y
  → Dispatch: @dba (closest specialist) with perf_engineer soul contract
  → Verify: rerun EXPLAIN + measure; report numbers
```

```
@ultra fix the bug in this file
  → Triage → Contract (repro + fix) → Dispatch @code or domain implementer → Verify (rerun failing test) → Deliver
```

## Token economy note

`/build-product` runs the full pipeline by default. For tasks where the SPEC is obvious, prefer `@ultra` directly with a focused loop — lighter ceremony, same evidence bar.

## Full protocol

The single source of truth is `@ultra`'s prompt (`prompts/ultra.md`). It carries the full pipeline mode (per-stage playbooks with soul contract blocks, machine-block formats, flag parsing) and the focused-task mode (Triage → Contract → Dispatch → Verify → Deliver).
