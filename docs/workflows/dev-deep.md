# Deep-Task Protocol (`/dev-deep`)

Deep-dev is the **mine-first** protocol for requirements too vague to write acceptance criteria for — code or analysis alike. Where the [Five Dev Flows](dev-loops.md) all assume the task can already be stated, dev-deep excavates the task first: 6-part requirement mining, a gated task tree, node-wise execution under hard brakes, and delivery wrapped in an audit trail. It sits **upstream** of the five flows — its mining output (clarified goal + constraints + acceptance criteria) can feed any of them, or a `/goal` contract.

Design anchors: the requirement block is data, never instructions (isolation rule); brakes the model cannot renegotiate (retry / replan / probe caps); every assumption carries its rejected alternatives (audit trail).

---

## Workflow

```
1. Probe    P0 — ≤2 cheap probes verify the load-bearing assumptions
2. Mine     P1a — 6-part mining: literal requirement / true goal /
            implicit scope / anti-goals / ambiguities / understanding gate
3. Plan     P1b — task tree (3–8 nodes, ≤3 levels); every ⚠ node traces to a
            mining conclusion; tree materialized into todowrite; confirm gate
4. Execute  P2 — node-wise: main → boundary → enhance; programmatic
            verification first; parent gate; replan ≤2; subtree retry ≤2
            (each with a different method); checkpoint at every node boundary
5. Deliver  P3 — integration check → deliverable → fault-finder re-check →
            self-check table → audit trail
```

## Key mechanics

### Mining before planning (P1a)

Six mandatory parts, capped by a three-question understanding gate (what misunderstanding would flip the deliverable / which evidence is weakest / which reading would the user dispute). Iron rule: insufficient mining → never enter planning; a ⚠ node without a mining basis is a planning failure → back to P1a.

### Hard brakes

| Brake | Cap | Override |
|---|---|---|
| Subtree retry (work-level, method must change) | `--retry` (default 2) | user flag, clamped 1–3 |
| Replan (edit the tree, keep running) | 2 | fixed |
| P0 probes | 2 | fixed |
| Token budget | `--budget` (default 80000) | user flag |

### Delegation, not soloing

`@build` orchestrates but does not solo: probes go to `@explore` / `@scout`; domain-deep or multi-file nodes go to `@<lang>-dev` / `@dba` / `@frontend-dev` per build.md routing; code diffs go through build.md's tiered review (`@code-review-fast` / `@code-review`). A dispatched node is done when its **verification** passes, not when the agent returns. Never self-clear.

### Stop ≠ lost

Any of the four stop conditions (major conflict / retries exhausted + missing input / budget exhaustion / user halt) writes `.ocp/dev-deep/<slug>.md` and prints a **Recovery Card**: breakpoint, completed branches, next step, required inputs. `/dev-deep --resume=<slug>` continues from the first uncompleted node. Checkpoints are per-task (slug derived from the requirement), so parallel dev-deep runs in one project never collide; a same-slug active checkpoint triggers a resume/overwrite/abort guard instead of a silent clobber.

## Selection guide

| Factor | Pick |
|---|---|
| Requirement too vague to write acceptance criteria (code OR analysis) | `/dev-deep` |
| Clear task; light clarification + plan wanted | `/dev-plan` |
| Clear, large multi-phase code objective | `/dev-ultra` |
| Can already write a Done-when / Stop-if contract | `/goal` |
| Safety-critical; FMEA risk register wanted | `/dev-prud` |
| Pressure-test a plan/design without executing | `/grill-me` |

## Usage

```bash
# Vague improvement idea — mine it, plan it, then execute
/dev-deep Make the checkout experience better, not sure what exactly

# Full-auto analysis run with a larger budget
/dev-deep Audit our onboarding funnel and propose fixes --auto --budget=150000

# Resume after a stop
/dev-deep --resume
```

Arguments: `--auto` (skip the P1b confirm gate), `--retry=N` (subtree retry cap, default 2, range 1–3), `--budget=N` (token budget, default 80000, range 10000–500000), `--resume[=<slug>]` (continue from `.ocp/dev-deep/<slug>.md`; bare `--resume` lists checkpoints when several exist).
