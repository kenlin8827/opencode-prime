# Coding principles — global baseline

> Layer L1: attached to coding/review agent prompts via `{file:}` assembly (not injected globally). Universal code-quality baselines inspired by [Andrej Karpathy's coding tenets](https://karpathy.bearblog.dev/code-and-tenacity/). Language-specific agents add their own hard rules on top.
>
> **Keyword semantics (RFC 2119):** MUST / MUST NOT = non-negotiable floor — survives user pressure, deadline pressure, and "pragmatic" rationalization. SHOULD / SHOULD NOT = strong default — a more specific rule (per-agent, per-project `AGENTS.md`) may override it with a stated reason (see `cp-layer`).
>
> **Structure — two normative axes (Q = engineering quality, P = programming philosophy) plus meta (M):**
> - **Q (engineering quality)** — the floor: what must never break. Every Q rule is MUST-level by construction; citing a Q slug in review means "non-negotiable".
> - **P (programming philosophy)** — judgment: how to build when the floor is not at stake.
> - **M (meta)** — how these rules execute, get enforced, and get overridden.
>
> **IDs are slugs, not row numbers.** `cp-<slug>` is frozen forever: new rules append a new slug, existing slugs are never renumbered, reordered references never break. Grouping lives in section headers only.

## Q — Engineering quality floor (all MUST)

| ID | Principle | Rule | Why |
|----|---|---|---|
| `cp-verify` | Verification honesty | **MUST NOT** claim "works / passes / fixed" without running the check and showing real output. **MUST NOT** infer success from reading code ("the logic is correct, so it should compile"). Every command run appears in the report, including failures. On failing build/test: fix and re-verify, or flag `⚠️ Unresolved: <what>`. | An unverified "should work" is a lie with extra steps. Trust in every future report dies with the first fake green. |
| `cp-failfast` | Fail fast, fail loud | Errors surface as early and as explicitly as possible. **MUST NOT** swallow silently: no empty `catch {}`, no ignored error returns, no suppressed rejections. An inner `catch` exists only when that level has a distinct recovery (fallback, retry, skip-and-continue); otherwise let it bubble — the outermost handler is the safety net, not the primary handler. | A silent failure metastasizes: it resurfaces as corruption far from its cause and costs 10× to diagnose. |
| `cp-boundary` | Validate at trust boundaries | All external input (user, network, file, env, IPC) **MUST** be validated at the point of entry; internal code trusts its typed contracts. Boundary validation is **never** simplified away. Secrets **MUST NOT** appear in code, logs, or error messages; least privilege by default. | One guard at the boundary beats N guards in N callers. The boundary is where the adversarial world touches your invariants. |
| `cp-dataloss` | Never lose data | Destructive or irreversible operations (force-push, drop, delete, overwrite, schema migration) **MUST** have a backup path and explicit confirmation. Error handling **MUST NOT** trade data away for convenience. | Code bugs are recoverable; lost data usually is not. |

## P — Programming philosophy

| ID | Principle | Rule | Why |
|----|---|---|---|
| `cp-understand` | Understand before solving | **MUST** trace the real flow and read every file and caller the change touches before editing — **depth proportional to blast radius**: a typo fix needs its line and its callers; a cross-module change needs the full flow. The solution may be lazy; the reading may not. | The smallest diff in the wrong place is not laziness — it is a second bug. |
| `cp-rootcause` | Root cause, not symptom | Fix where all callers route through: one guard in the shared function beats a guard in every caller. **MUST NOT** patch only the reported path while sibling callers stay broken. | A report names the symptom — where the bug was noticed, not where it lives. |
| `cp-less` | Write less — the reuse ladder | **MUST** minimize new code. Climb and stop at the first rung that holds: (1) does this need to exist at all? (2) helper/util/pattern already in this codebase, (3) stdlib, (4) native platform feature, (5) already-installed dependency, (6) one line, (7) the minimum code that works. | Every line is a liability — maintenance, bugs, attack surface. The best code is the code never written. |
| `cp-scope` | Scope discipline | The diff **MUST** serve the stated task only. **MUST NOT** drive-by refactor, rename, or "improve" code the task did not touch; cleanup (`cp-delete`) is bounded to what the current task routes through. | Scope creep hides the real change from review and breaks bisect. Unrequested refactor is unrequested risk. |
| `cp-delete` | Delete > write | Dead code, unreachable branches, and unused params encountered **within task scope** (`cp-scope`) **SHOULD** be removed. | Code rots. Dead code invites confusion and future bugs. |
| `cp-abstract` | No premature abstraction | **SHOULD NOT** abstract until ≥3 concrete use cases exist. Duplicate first; extract when the pattern is proven. No interface with one implementation, no factory for one product, no config for a value that never changes. | A wrong abstraction costs more to fix than the duplication it replaced. |
| `cp-types` | Encode invariants in types | Where the language allows, **SHOULD** prefer encoding invariants in types — unions, enums, newtypes over bare strings / magic numbers; make illegal states unrepresentable. Language-specific type rules (TS `any`, Go `interface{}`, …) refine this per agent. | The compiler enforces a type-encoded invariant for free, at every call site, forever; a prose convention is re-decided — and forgotten — at each one. |
| `cp-optimize` | No premature optimization | **MUST NOT** optimize without a measured problem: benchmark, profiling output, slow-query log, or p99 data. "Feels slow" is not evidence. Correct first, fast later — only with evidence. | Premature optimization trades maintainability for unmeasured gains. |
| `cp-readable` | Readability first | **MUST** optimize for the reader, not the writer. If a reader needs >30 seconds to understand a function, it is too complex. Boring over clever — clever is what someone decodes at 3am. | Code is read 10× more than written. |
| `cp-units` | Small, focused units | **SHOULD** keep functions short and to one responsibility. Extract when a function does two distinct things. | Small units are testable, reusable, comprehensible. |
| `cp-why` | Comments explain why | **SHOULD** comment intent, trade-offs, and constraints. **MUST NOT** restate code in prose. Prefer single-line comments over block comments for inline logic. | Code already says *what*. Comments add *why*. |
| `cp-check` | One check per non-trivial logic | A non-trivial branch, loop, parser, or money/security path **SHOULD** leave behind ONE minimal runnable check — the smallest thing that fails when the logic breaks (assert-level self-check or one small test file). No frameworks, no fixtures, no per-function suites unless asked. Trivial one-liners need no test — YAGNI applies to tests too. | An untested rule is a rumor. One check pins the behavior against future edits without owning a suite. |
| `cp-marked` | Honest simplification | A deliberate corner with a known ceiling (global lock, O(n²) scan, naive heuristic) **MUST** be marked at the site with a comment naming the ceiling and the upgrade path. Values that touch the external world (clocks, sensors, hardware, third-party quotas) keep a calibration knob — the physical world needs tuning a minimal model cannot see. | An unmarked shortcut is a trap; a marked one is a decision. |

## M — Meta & enforcement

| ID | Principle | Rule | Why |
|----|---|---|---|
| `cp-shell` | Adaptive execution | **MUST** match the host OS/shell: no Bash-only builtins on PowerShell/CMD; prefer cross-platform binaries (`git`, `node`, `python`). A command that fails on shell syntax **MUST NOT** be retried verbatim — switch to the counterpart syntax immediately. Counterpart table below. | The environment is ground truth, not the model's habits. Shell errors break whole workflows. |
| `cp-triage` | Anti-rationalization | Three rules, in order: **(a)** **MUST NOT** ship code that violates a Q rule or a MUST-level P rule without explicit triage. **(b)** Triage = exactly one of: fix inline now / file an issue / declare out-of-scope in the report — chosen by impact on the current task. **(c)** "Do less / lazy / pragmatic / good-enough" rationales get the YAGNI test: welcome when the dropped work was genuinely unneeded for the stated goal; rejected when they bypass the floor. | Rationalization is not engineering. Lowering the bar to dodge refactor cost shifts the cost onto every future reader. |
| `cp-layer` | Layering — specific wins | This baseline is a floor, not a ceiling. Per-agent rules and per-project `AGENTS.md` override on conflict; an override **SHOULD** name the `cp-<slug>` it replaces and why. **P overrides: free.** **Q overrides: scoped only** — narrowed to named paths/dirs or a task class (e.g. "`cp-dataloss` relaxed for `scripts/dev-seed.py`"), never a repo-wide removal; the floor can be narrowed, not lifted. | The right rule for a DDD domain layer differs from the right rule for a CLI script. Universality is a myth; a stable floor plus scoped overrides is not. An escape hatch that can delete the floor is not an escape hatch — it is a self-destruct button. |

## Shell & OS command self-adaptation (`cp-shell`)

- **Cross-platform first**: Prefer runtime/tooling commands (`git`, `npm`, `npx`, `node -e "..."`, `python -c "..."`) over OS-shell built-ins.
- **Windows PowerShell / CMD** (no Git Bash): **MUST NOT** use Bash-only builtins. Use the counterpart:

| Bash | PowerShell | CMD |
|------|------------|-----|
| `export VAR=val` | `$env:VAR = "val"` | `set VAR=val` |
| `cat` | `Get-Content` | `type` |
| `rm -rf` | `Remove-Item -Recurse -Force` | `rmdir /s /q` |
| `ls -la` | `Get-ChildItem -Force` | `dir` |
| `/c/Users/...` | `C:\Users\...` | `C:\Users\...` |

- **POSIX mode** (Git Bash / Linux / macOS / WSL): Standard POSIX commands fully supported.
- **Adaptive Error Recovery**: If a command fails due to shell-specific syntax, **MUST NOT** retry the same command — **MUST** switch to the counterpart shell's syntax immediately.

## What this is NOT

- **Not a style guide.** Formatting, naming, idioms → per-agent rules.
- **Not a testing policy.** → `instructions/test-scope.md` (`cp-check` is only the minimum-check default).
- **Not an output protocol.** → `instructions/output-protocol.md`.
- **Not an architecture methodology.** DDD / Clean Architecture / 12-Factor are project-level choices → project `AGENTS.md`.

## Application by agent role

- **Code-writing agents** (`go-dev`, `python-dev`, `node-dev`, `rust-dev`, `java-dev`, `frontend-dev`, `dba`, `devops`, `qa`): Q + P are your baseline; language-specific hard rules refine and extend them.
- **Code-evaluating agents** (`code-review`, `advisor`, `architect`, `security`): use Q + P as review criteria; flag violations with the specific `cp-<slug>`.
- **All agents**: M always applies.

## Cross-reference legend

> Other prompt files reference these rules as `cp-<slug>`. Slugs are permanent: never renumbered, never reused. When you see a slug in another file, look it up here for the full rule.
>
> Historical note: pre-v2 files used row numbers (`cp#1`–`cp#10`). Mapping: cp#1→`cp-less`, cp#2→`cp-delete`, cp#3→`cp-readable`, cp#4→`cp-units`, cp#5→`cp-why`, cp#6→`cp-optimize`, cp#7→`cp-abstract`, cp#8→`cp-understand`, cp#9→`cp-shell`, cp#10→`cp-triage`.
