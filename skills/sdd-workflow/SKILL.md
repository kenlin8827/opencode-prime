---
name: sdd-workflow
description: Specification-Driven Development lifecycle — governs the /prd → /adr → /plan → /impl phases, deliverables, and transitions. Load ONLY when the user invokes /prd, /adr, /plan, /impl, /sdd, or /dev --sdd, or explicitly requests SDD; never force it on ordinary chats.
---

# SDD Protocol (Specification-Driven Development)

You are operating under the **SDD (Specification-Driven Development)** engineering framework.
SDD guarantees software quality and maintainability through a rigorous specification lifecycle:

> **`PRD (Requirements)` → `ADR (Architecture)` → `PLAN (Implementation Plan)` → `IMPL (Code Execution)`**

---

## 1. Core Principles

1. **On-Demand Trigger (Opt-in Only)**: SDD is active **ONLY** when the user explicitly triggers an SDD command (`/prd`, `/adr`, `/plan`, `/impl`, `/sdd`) or asks for specification-driven development. Normal chat, exploratory questions, and routine bug fixes proceed directly without forcing any SDD ceremony.
2. **Any Entry Point**: When SDD is invoked, the user is free to start from ANY phase:
   - Got a user problem or product idea? → Start with `/prd <topic>`.
   - Got an architectural choice or tech stack decision? → Start with `/adr <decision>`.
   - Got a clear architecture and need task decomposition? → Start with `/plan <topic>`.
   - Got a straightforward fix or pre-approved plan? → Start directly with `/impl <task>`.
3. **Interactive Stage Transitions (Triggered Phases Only)**: Upon completing an explicitly triggered phase, you **MUST** present the artifact summary and ask the user (using `ask_question` in Antigravity or selectable options in chat) how they want to proceed (Recommended next stage, Jump to another stage, or Finish). Do NOT prompt transition on non-SDD conversations.

4. **Session Language**: Follow `output-protocol.md` → Session language. When a deterministic command creates an English scaffold, rewrite its human-readable prose and headings in that language before completing the artifact.

---

## 2. Phase Breakdown & Responsibilities

### Phase 1: `/prd [topic]` — Product Requirements Document
- **Agent**: `@build` or `@tech-writer`
- **Objective**: Capture user needs, boundaries, acceptance criteria, and non-functional requirements.
- **Deliverables**:
  - Scaffolds & writes `docs/prd/<topic>.md`.
  - Defines User Stories (US-xx), Functional Requirements (FR-xx), Non-Functional Requirements (NFR), Out-of-Scope boundaries, and Acceptance Criteria (Given/When/Then).
- **Completion Transition**:
  - Summarize the PRD.
  - Prompt user with choices:
    1. `(Recommended) Proceed to /adr (Architecture Decisions & System Design)`
    2. `Skip to /plan (Implementation Plan & Task Breakdown)`
    3. `Skip directly to /impl (Code Implementation)`
    4. `Done (Stay in current PRD stage)`

---

### Phase 2: `/adr [title]` — Architecture Decision Record
- **Agent**: `@architect` / `@build`
- **Engine**: Powered by standalone `plugins/adr-guard` (supports flat & hierarchical ADR layouts, DAG superseding, integrity checks, and commit gates).
- **Objective**: Document architectural decisions, schema/API contracts, technology tradeoffs, and integration points.
- **Deliverables**:
  - Scaffolds & writes `docs/adr/<NNNN>-<title>.md` (or hierarchical layer ADRs per project configuration).
  - Documents Context, Decision Drivers (derived from PRD), Considered Options, Pros & Cons, Decision Outcome, and Consequences.
  - Updates `docs/adr/INDEX.md`.
- **Completion Transition**:
  - Summarize the decision.
  - Prompt user with choices:
    1. `(Recommended) Proceed to /plan (Implementation Plan & Task Breakdown)`
    2. `Skip directly to /impl (Code Implementation)`
    3. `Back to /prd (Requirements Revision)`
    4. `Done (Stay in current ADR stage)`

---

### Phase 3: `/plan [topic]` — Implementation Plan & Task Breakdown
- **Agent**: `@plan` / `@build`
- **Objective**: Decompose PRD & ADR into atomic, phased, test-driven implementation steps with verification criteria.
- **Deliverables**:
  - Scaffolds & writes `docs/plan/<topic>.md` (or planning mode artifact).
  - Outlines exact files to create/modify, dependency ordering, testing strategy, rollback plan, and acceptance checklist.
- **Completion Transition**:
  - Summarize the plan.
  - Prompt user with choices:
    1. `(Recommended) Proceed to /impl (Code Implementation & Verification)`
    2. `Back to /adr (Architecture Adjustment)`
    3. `Back to /prd (Requirements Adjustment)`
    4. `Done (Stay in current Plan stage)`

---

### Phase 4: `/impl [task]` — Implementation Execution & Verification
- **Agent**: `@code` / Domain Specialist (`@node-dev`, `@python-dev`, `@go-dev`, `@frontend-dev`, etc.)
- **Objective**: Execute code changes step-by-step following the Plan and ADR specifications.
- **Execution Rules**:
  - Follow global coding tenets (Karpathy principles): write less code, readability first, small focused units.
  - Test-driven: write tests alongside code, run test commands to verify.
  - Quality gates: run type checks (`tsc`), linter, and ensure clean git status.
- **Completion Transition**:
  - Summarize changes and test results.
  - Prompt user with choices:
    1. `(Recommended) Run QA & Verification (/qa)`
    2. `Run Code Review (/code-review)`
    3. `Generate Handoff Document (/handoff)`
    4. `Complete & Finish SDD Cycle`

---

## 3. Interactive Transition Protocol

**Exception (/dev front-end mode)**: when executing as the /dev --sdd front-end, the per-phase transition menu collapses to a single Approve / Revise / Stop gate — the pipeline order is already fixed by the --sdd phase set.

When completing ANY SDD phase, you **MUST NOT** simply stop silently. You MUST ask the user how they wish to proceed.

### In Antigravity IDE:
Call `ask_question` tool with:
- `question`: "Phase [<PHASE_NAME>] is complete. Would you like to proceed to the next phase?"
- `options`:
  - `(Recommended) Proceed to /<next_phase> (<description>)`
  - `Skip/Jump to /<alternative_phase> (<description>)`
  - `Finish & Stay in current phase`

### In OpenCode Chat:
Render a clear Markdown callout with selectable recommendations:
```markdown
### 🎯 SDD Phase Complete: [Phase Name]
Artifact generated: `docs/...`

**Next Recommended Step**:
1. 🌟 **`/adr`** — Define architecture decisions and contracts
2. ⏩ **`/plan`** — Skip directly to implementation plan
3. ⚡ **`/impl`** — Skip directly to code implementation
4. 📦 **`/sdd handoff`** — Pause & generate handoff document for a fresh session
5. ⏹️ **Done** — Stay in current stage

*Reply with your choice or run the corresponding command to proceed.*
```

---

## 4. `/sdd handoff [focus]` Protocol

When `/sdd handoff [focus]` is invoked:
1. **Identify active SDD phase** (`prd`, `adr`, `plan`, or `impl`) and scan generated artifacts (`docs/prd/`, `docs/adr/`, `docs/plan/`).
2. **Extract unwritten context**: Capture implicit assumptions, edge cases, and rejected alternatives discussed in the session.
3. **Save to Git-Safe Directory**: Write to `.ocp/handoffs/handoff-<project>-<timestamp>.md` (and update `.ocp/handoffs/latest.md`). If workspace is unavailable or not writable, fallback to OS Temp directory (`$env:TEMP` / `$TMPDIR`). Never pollute tracked repo files.
4. **Output Paste-Ready Opener**: Provide relative/absolute path and a single-line command for the next session to resume effortlessly:
   `"Read .ocp/handoffs/latest.md and resume SDD workflow at /<next-phase>"`
