# E2E Guard

A project-level switch guiding E2E testing best practices and quality red lines. E2E test suites are slow, resource-heavy, and prone to flakiness — running them silently or skipping them without assessment on critical tasks can cause severe reliability or productivity issues.

Instead of a rigid execution-blocking gate, **e2e-guard acts as a project-level switch** that injects a comprehensive **E2E Red-Line Protocol** into the LLM's system prompt when enabled (`on`), delegating the assessment and judgment to the LLM while keeping the final decision in the user's hands via interactive question tools (`ask`).

## How It Works

```
                     e2eGuard: "on" in .ocp/ocp.json
                                   │
                                   ▼
      experimental.chat.system.transform (system prompt injection)
                                   │
                                   ▼
                    LLM operates under E2E Protocol:
  ┌─────────────────────────────────────────────────────────────────┐
  │ 1. Triggers on `feat` and `fix` tasks, completion, or commit/push│
  │ 2. Assesses diff impact: full suite vs targeted/affected specs  │
  │ 3. Identifies test gaps (detects missing E2E test cases)        │
  │ 4. Interactively asks user before running or skipping tests     │
  └────────────────────────────────┬────────────────────────────────┘
                                   │
                     Interactive Question via `ask`
                     (a) Targeted E2E (affected specs)
                     (b) Full E2E suite
                     (c) Supplement missing E2E test case
                     (d) Skip E2E & proceed
                                   │
                                   ▼
             User decides → LLM executes chosen action
```

## Protocol Highlights

1. **Trigger Scope**:
   - Mandatory on **`feat` (new features)** and **`fix` (bug fixes)** tasks.
   - Triggered upon task completion (handoff) and before `git commit` / `git push`.
2. **Impact & Scope Assessment**:
   - **Targeted E2E**: Localized changes mapped to specific spec files (e.g. `playwright test tests/login.spec.ts`).
   - **Full E2E**: Architectural or cross-cutting changes affecting global user flows.
   - **Skip**: Pure cosmetic, docs, or non-functional modifications.
3. **Test Gap & Case Supplement Check**:
   - When a `feat` or `fix` lacks existing E2E spec coverage, the LLM actively flags the test gap and offers to author/supplement the missing E2E test case.
4. **User Alignment via `ask`**:
   - The LLM never runs E2E test suites silently or skips without confirmation; it presents the evaluation and choices using interactive tools.
5. **Primary Agent Scoping**:
   - Injected exclusively into primary delivery agents (`code`, `build`, `architect`, root sessions) that have interactive `ask` tool permissions and manage commit/handoff.
   - Subagents are automatically exempt to prevent context bloat and tool permission conflicts.

## User Commands

| Command | Description |
|---|---|
| `/e2e-guard on` | Enable the E2E guard (writes `"e2eGuard": "on"` to project `.ocp/ocp.json`) |
| `/e2e-guard off` | Disable the E2E guard (writes `"e2eGuard": "off"` to project `.ocp/ocp.json`) |
| `/e2e-guard status` | View the current guard status |

## File Layout

- `e2e-guard.ts` — Plugin entry point (registers system transform and command hooks).
- `e2e-guard-protocol.md` — The markdown specification of the E2E Red-Line Protocol.
- `e2e-guard-instructions.ts` — Injects the protocol markdown into prompt fragments with cache markers.
- `e2e-guard-system-inject.ts` — `experimental.chat.system.transform` hook for dynamic prompt injection / cleanup.
- `e2e-guard-config.ts` — Reads and updates the `e2eGuard` field in `.ocp/ocp.json`.
- `e2e-guard-command.ts` — Handles `/e2e-guard` subcommands.
