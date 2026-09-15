---
name: improve-loop
description: Improve-loop - score-driven improvement loop (score, analyze, fix, verify, re-score) until the structural ceiling or max rounds. Load ONLY when the user invokes /improve-loop.
---

# Improve-Loop Protocol — score-driven improvement loop

You are now running the **improve-loop** — a score-driven iterative improvement cycle. The loop drives review → fix/refactor → re-score until the score cannot be raised further or max rounds are reached.

## Core principle

> **Improve, don't console.** Every round must either produce concrete improvements with evidence, or stop with a structural reason. "Can't improve" without a structural reason is a consolation conclusion — see `instructions/verification-honesty.md` Rule 3.

## Arguments

- Positional arg: the subject to improve (a file, a directory, a feature, a rule system, or empty for the current diff).
- `--max-rounds=N` (optional): maximum iterations. Default: 10, range 1–999.
- `--target=N` (optional): stop when the score reaches N/10. Default: unset (runs until structural ceiling).

## Graph

```
[*] → Scope: Determine improvement subject
  → ROUND 1
    1. Score: Agent self-assesses with verification-honesty scoring table (R5–R7)
    2. Analyze: Identify concrete improvement paths (or structural ceiling)
       — If structural ceiling reached → ✅ Done → Post-loop
       — If improvement possible → Step 3
    3. Fix/Refactor: Dispatch to matching agent for targeted improvements
    4. Verify: Build/test/lint per test-scope.md — show real commands
    5. Re-score: Re-assess with the same scoring table
       — Score improved → ROUND N+1
       — Score unchanged → ⚠️ Stall → Post-loop
       — Score dropped → 🔴 Regression → revert fix, Post-loop
  → if round = max → ⚠️ Max rounds → Post-loop
Post-loop: Final score table + improvement log
```

**Loop invariant (carried forward every iteration):**
- Prior improvements applied (so re-scoring doesn't re-report them)
- Score history (round → score, so progress is trackable)
- Structural ceiling analysis from each round (so the same ceiling isn't re-claimed)
- Round counter (1–max, default 10, cap 999)

**Exit conditions (exactly one fires per loop):**

| Exit | Condition | Next action |
|------|-----------|------------|
| ✅ Ceiling | No improvement path found — structural reason stated | Post-loop → final score + summary |
| ⚠️ Max rounds | Max rounds exhausted, score still improvable | Post-loop → final score + remaining paths |
| ⚠️ Stall | Score unchanged after a fix attempt | Post-loop → analyze why fix didn't move score |
| 🔴 Regression | Score dropped after a fix | Revert fix, post-loop → diagnose what broke |
| 🎯 Target reached | Score ≥ --target value | Post-loop → done |

## Determining the subject to improve

Parse the arguments:

1. **If a file/directory path** → improve that specific target.
2. **If "current diff" or empty** → run `git diff` to discover uncommitted changes.
3. **If a feature/concept name** → identify the relevant files (use code-intelligence backend if available, else grep/glob).
4. **If unclear** → ask one focused question to clarify.

## The loop

### Maximum iterations: 10 rounds (default, configurable via `--max-rounds=N`, range 1–999)

**Parsing `--max-rounds`:** parse as integer; non-numeric, empty, or missing → default 10. Clamp to [1, 999].

**When to increase:** complex multi-file systems, architectural overhauls → `--max-rounds=50` or `100`.
**When to decrease:** single-file quick polish → `--max-rounds=3`.

### Round structure

Each round has 5 steps. Every step's output must follow `instructions/verification-honesty.md` — evidence-anchored, no consolation.

#### Step 1 — Score

Apply the scoring format from `instructions/verification-honesty.md` (Rules 5–7 triggered by this loop's nature). Output the full scoring table with:

- Dimensions, weights, pass/fail criteria, scores, and evidence — all in one table.
- Aggregate with weighted calculation.
- **Language adaptation**: output in the same language as the user's message.

**Phase marker** at the start of every reply (for compaction recovery):

```
[improve-loop] Round: 1 | Score: 7.2/10 | Improvement: pending
```

#### Step 2 — Analyze improvement paths

Based on the scoring table, identify **concrete** improvement paths — each with:
- Which dimension can be improved.
- What specific change would improve it.
- Expected score delta (e.g., "+0.5").

**Structural ceiling rule**: if a dimension's score is capped by a physical boundary (e.g., Enforceability requires semantic judgment that no rule text can make mechanical), state the structural reason explicitly. Do NOT claim "can't improve" without a structural reason — that's consolation (Rule 3).

**If no improvement paths found** → exit with ✅ Ceiling. Log the structural reasons.

#### Step 3 — Fix/Refactor

Dispatch to the matching agent for each improvement path. Classification follows the same domain routing as `build.md` trigger words:

| Fix type | Agent |
|----------|-------|
| Code correctness/quality fix | `@code` |
| Architecture refactor | `@architect` → `@<domain-dev>` |
| Test coverage improvement | `@qa` |
| Documentation improvement | `@tech-writer` |
| Rule/prompt system improvement | `@code` (direct edit) |
| Security hardening | `@security` → `@<domain-dev>` |

**Dispatch means tool call** — invoke the subagent tool, don't print text.

**Fix constraint**: one improvement per dispatch. No drive-by refactoring. The fix must be minimal and targeted to the specific dimension being improved.

#### Step 4 — Verify

After fixes are applied, run verification per `instructions/verification-honesty.md`:

```
### Verification
- `<command>` → <✅/❌/⚠️> <result>
```

Legend: ✅ executed+passed · ❌ executed+failed (address per R3) · ⚠️ not run (state reason).

**If verification fails** → the fix didn't work. Score must NOT improve. Consider this a Stall or Regression exit.

#### Step 5 — Re-score

Re-assess using the same scoring table. Compare with the prior round's score:

| Outcome | Condition | Action |
|---------|-----------|--------|
| Improved | Score increased ≥ 0.1 | Log improvement, proceed to next round |
| Stall | Score unchanged (±0.0) | Exit ⚠️ Stall — analyze why fix didn't move the needle |
| Regression | Score dropped ≥ 0.1 | Revert fix, exit 🔴 Regression — diagnose what broke |
| Ceiling | No new improvement paths | Exit ✅ Ceiling |

**Score honesty**: the re-score MUST reflect verification results. If verification failed (Step 4), the score MUST NOT increase — that's Rule 5 (score reflects evidence, not optimism).

## Agent failure handling

1. **Retry once** with same dispatch + failure note. No more than one retry.
2. **If retry fails** → escalate to user with failure reason + current score + pending improvements.
3. **If scoring agent fails** → the round cannot proceed. Escalate with partial results.

## Stop conditions

- **Stop immediately** when no improvement paths found (structural ceiling reached).
- **Stop** after max rounds, even if score is still improvable — report remaining paths.
- **Stop** if a fix causes regression (score drops) — revert and report.
- **Stop** if `--target` score is reached.
- **Stop** when user says "stop" / "enough" / "done".

## Post-loop

Once the loop exits:

1. Output the **final score table** (same format as Step 1).
2. Output the **improvement log** (round-by-round score history).
3. List any **remaining improvement paths** that weren't pursued (hit max rounds).
4. List any **structural ceilings** that cap the score permanently.

## Output format

**Per-round output** (concise):

```
### Improve Round N
- Score: <N>/10 (was <prev>, delta <±N>)
- Improvement target: <dimension> — <what to fix>
- Fix dispatched: <agent> — <what changed>
- Verification: `<command>` → <✅/❌/⚠️> <result>
- New score: <N>/10
```

**Final summary:**

```markdown
## Improve-Loop Summary

**Final score: <N>/10** (started at <initial>, improved by <delta>)

### Score history
| Round | Score | Delta | Improvement |
|-------|-------|-------|-------------|
| 1 | 7.2 | — | Initial assessment |
| 2 | 7.8 | +0.6 | Fixed test coverage |
| ... | ... | ... | ... |

### Structural ceilings (permanent caps)
- <dimension>: <reason> — capped at <score>

### Remaining paths (not pursued)
- <dimension>: <what could still be improved>

### Files modified
- `path/to/file` — <what changed>
```