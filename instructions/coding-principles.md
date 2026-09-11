# Coding principles — global baseline

> Layer L1: attached to coding/review agent prompts via `{file:}` assembly (not injected globally). Universal code-quality baselines inspired by [Andrej Karpathy's coding tenets](https://karpathy.bearblog.dev/code-and-tenacity/). Language-specific agents add their own hard rules on top; when a per-agent rule conflicts, the more specific rule wins.

## Core tenets

| # | Principle | Rule | Why |
|---|---|---|---|
| 1 | Write less code | **MUST** minimize new code for any task. Reuse before creating. | Every line is a liability — maintenance, bugs, attack surface. |
| 2 | Delete > write | **SHOULD** remove dead code, unreachable branches, unused params when encountered. | Code rots. Dead code invites confusion and future bugs. |
| 3 | Readability first | **MUST** optimize for the reader, not the writer. If a reader needs >30 seconds to understand a function, it's too complex. | Code is read 10× more than written. Clever code that needs 5 minutes to parse is worse than plain code that takes 30 seconds. |
| 4 | Small, focused units | **SHOULD** keep functions short, one responsibility. Extract when a function does two distinct things. | Small functions are testable, reusable, comprehensible. |
| 5 | Comments explain why | **SHOULD** comment intent and decisions. **MUST NOT** restate code in prose. **SHOULD** prefer single-line comments (`//`, `#`) over block comments (`/* */`) for inline logic — block comments invite padding (see `comment-strategy.md`). | Code already says *what*. Comments add *why*: rationale, trade-offs, constraints. |
| 6 | No premature optimization | **MUST NOT** optimize without a measured problem. Correct first, fast later — only with evidence (benchmark, profiling output, slow-query log, or p99 latency data). "Feels slow" is not evidence. | Premature optimization trades maintainability for unmeasured gains. |
| 7 | No premature abstraction | **SHOULD NOT** abstract until ≥3 concrete use cases exist. Duplicate first, abstract when the pattern is proven. | Wrong abstractions are costlier to fix than duplication. |
| 8 | Understand before solving | **MUST** understand the problem and existing code before writing new code. Read the surrounding context. | Solutions without understanding produce bugs and rework. |
| 9 | Adaptive shell execution | **MUST** adapt shell commands to the active host OS/shell. Prefer cross-platform binaries (`git`, `npm`, `node`). On native Windows PowerShell/CMD, **MUST NOT** use Bash-only builtins (`export`, `cat`, `rm -rf`, `ls -la`). | Shell errors break workflows; commands must match the host environment. |
| 10 | Top-tier floor + YAGNI discipline | **MUST NOT** ship code failing top-tier **quality** (correctness, security, testability, type safety, error/edge-case handling) or **philosophy** (maintainability, defensibility, platform-native design, simplicity) without triage: refactor inline / file-as-issue / explicit-out-of-scope, by impact on the current task. "Do less / lazy / pragmatic / good-enough" rationales are evaluated as **YAGNI** — welcome when the dropped work was genuinely unneeded for the stated goal, rejected when they bypass the floor. `cp#7` (≥3 use cases) and `cp#8` (understand first) still bind. | Rationalization is not engineering; lowering the bar to dodge refactor cost shifts the cost to every future reader. |

## Shell & OS command self-adaptation

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

## Application by agent role

- **Code-writing agents** (`go-dev`, `python-dev`, `node-dev`, `rust-dev`, `java-dev`, `frontend-dev`, `dba`, `devops`, `qa`): These are your baseline. Your language-specific hard rules refine and extend them.
- **Code-evaluating agents** (`code-review`, `advisor`, `architect`, `security`): Use these as review criteria. Flag violations with the specific principle name.

## What this is NOT

- **Not a style guide.** Formatting, naming, idioms → per-agent rules.
- **Not a testing policy.** → `instructions/test-scope.md`.
- **Not an output protocol.** → `instructions/output-protocol.md`.

## Cross-reference legend

> Other prompt files reference this table as `cp#N` (= row N). When you see `cp#N` in another file, look up row N in this table for the full rule.

