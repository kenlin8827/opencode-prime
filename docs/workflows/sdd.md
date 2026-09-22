# Specification-Driven Development (SDD)

Specification-Driven Development (SDD) provides a structured, specification-first engineering workflow that connects requirements, architecture, execution planning, and code implementation.

---

## The SDD Lifecycle

```
[/prd: Requirements] ──▶ [/adr: Architecture] ──▶ [/plan: Task Breakdown] ──▶ [/impl: Code & Verify]
         │                       │                         │                           │
         └───────────────────────┴─────────────────────────┴───────────────────────────┘
                       (Can jump directly to any stage or finish)
```

1. **`/prd [topic]`**: Product Requirements Document
   - Defines problem statement, user personas, user stories (US-xx), functional requirements (FR-xx), non-functional requirements (NFRs), out-of-scope boundaries, and acceptance criteria.
   - Scaffolds and writes to `docs/prd/<topic>.md`.
2. **`/adr [title]`**: Architecture Decision Record
   - Records architecture design, tech stack choices, schema/API contracts, trade-offs, and decision outcomes.
   - Scaffolds and writes to `docs/adr/` (supports flat and hierarchical structures).
3. **`/plan [topic]`**: Implementation Plan & Task Breakdown
   - Decomposes specifications into atomic, test-driven phases and tasks.
   - Scaffolds and writes to `docs/plan/<topic>.md`.
4. **`/impl [task]`**: Code Implementation & Verification
   - Implements code following the Plan and ADR specifications with strict adherence to Karpathy coding tenets.
   - Executes automated unit tests, linters, and verification checks.

---

## 🏛️ ADR: Recording Architecturally Significant Decisions

Across the SDD lifecycle (`PRD` → `ADR` → `PLAN` → `IMPL`), **ADR (Architecture Decision Record) anchors the decisions that are expensive to get wrong** — it is an adaptive stage, not a mandatory gate for every change:

```
Architecture baseline / ADL
          ↕
PRD or requirement
          ↓
ADR record(s), only for architecturally significant decisions
          ↓
Plan / tasks → implementation → tests → release/observation
          ↓
New ADR, amendment, or supersession in the next evolution
```

**When to write an ADR** — trigger one for significant changes to:

- **Structure**: modules, layers, service boundaries, ownership
- **Quality attributes**: performance, scalability, reliability, observability
- **Dependencies**: frameworks, platforms, core third-party libraries
- **Interfaces**: APIs, protocols, event contracts, data schemas
- **Data**: storage engines, migration strategy, retention, consistency models
- **Security**: authentication, authorization, secrets handling
- **Financial/business rules**: pricing, commission, ledger invariants
- **Hard-to-reverse choices**: anything costly to undo after shipping

Trivial changes (copy edits, isolated bug fixes, local refactors with no architectural footprint) skip the ADR stage and flow directly from requirement to plan/implementation.

Why the stage matters when it applies:

1. **Defense for Irreversible Decisions**:
   - UI text or isolated logic can be changed cheaply, but **data schemas, communication protocols, dependency choices, and authentication mechanisms carry high rework costs**.
   - ADR forces upfront evaluation of trade-offs (Pros/Cons), alternatives, and blast radiuses before a single line of production code is written.
2. **Living Ledger of "Why" and Rejected Alternatives**:
   - Code shows *how* something is implemented; PRD shows *what* was desired.
   - **ADR documents *why* alternatives were rejected**, giving future maintainers and automated agents the exact context needed during refactoring or replacement (`/adr supersede`).
3. **Optional Hard Guardrails**:
   - Projects that opt in (`/adr guard on`) attach a Git commit gate so architecturally significant `feat:`/`refactor:` changes cannot land unrecorded. The gate is a per-project switch, not a built-in assumption of the SDD flow.

---

## Relationship with Standalone ADR Governance (`adr`)

ADR plays a dual role in the engineering configuration:
1. **Standalone Architecture Governance Tool (`adr`)**: Operates independently with `/adr new`, `/adr supersede`, `/adr tree/map`, `/adr check/lint`, flat/hierarchical directory modes, and the Git commit gate (`/adr guard on`).
2. **SDD Architectural Phase (`/adr`)**: Serves as the architecture design phase in the SDD lifecycle, automatically inheriting requirements from `/prd` and feeding decisions into `/plan`.

SDD acts as the **Lifecycle Orchestrator** while `adr` serves as the **Specialized Architecture Engine**. Developers can use `/adr` standalone without doing a full SDD cycle, or seamlessly flow through SDD where `/adr` provides architectural grounding.

---

## Key Features

### 1. Flexible Entry Point
Developers can initiate work at **ANY** stage based on task readiness:
- Starting a brand new feature from scratch → `/prd <feature>`
- Evaluating architectural alternatives → `/adr <decision>`
- Architecture is settled and you need task decomposition → `/plan <feature>`
- Direct bugfix or well-defined task → `/impl <task>`

### 2. Interactive Stage Transitions
At the completion of each phase, the system presents the produced artifact and interactively asks the developer how to proceed:
- **Recommended Next Stage**: e.g., `/prd` → `/adr`, `/adr` → `/plan`, `/plan` → `/impl`.
- **Skip/Jump to Any Stage**: e.g., jump directly from `/prd` to `/impl` when architecture and planning are trivial.
- **Backtrack**: e.g., return from `/plan` to `/adr` to adjust design decisions.
- **Finish**: Complete and remain in the current phase.

### 3. Hot Context & Cold Artifact Synergy
Continuing the SDD flow within the **same session** delivers maximum precision:
- **In-Session Hot Context**: Preserves domain nuances, edge-case discussions, and rejected alternatives. The subsequent `/plan` and `/impl` execute with razor-sharp alignment to your intent.
### 4. Cross-Session Handoff (`/sdd handoff`)
When you need to pause work, switch tasks, or combat context window token bloat, run `/sdd handoff`:
- **Locks Active Stage**: Records current completion state (e.g. PRD/ADR done, awaiting `/plan`) and artifact links.
- **Extracts Unwritten Context**: Captures subtle constraints and rejected alternatives into a git-safe handoff document (`.ocp/handoffs/`).
- **One-Click Fresh Resume**: Generates a paste-ready opener (`Read .ocp/handoffs/latest.md...`) to restart seamlessly in a fresh session with minimum token overhead.

---

## Command Reference

| Command | Purpose | Output Location |
|---|---|---|
| `/prd [topic]` | Create or update Product Requirements Document | `docs/prd/<topic>.md` |
| `/adr [title]` | Create or supersede Architecture Decision Record | `docs/adr/` |
| `/plan [topic]` | Create phased Implementation Plan | `docs/plan/<topic>.md` |
| `/impl [task]` | Execute code implementation & test verification | Source files & test suites |
| `/sdd status` | Inspect all SDD artifacts (PRDs, ADRs, Plans) in project | Main chat / TUI |
| `/sdd handoff [msg]` | Compact active SDD state for a fresh session takeover | `.ocp/handoffs/` |
| `/sdd help` | Display SDD lifecycle guide and command syntax | Main chat / TUI |

---

## Example Workflow

### Step 1: Draft PRD
```bash
/prd User Authentication
```
*Output: Scaffolds `docs/prd/user-authentication.md`, populates requirements, and prompts user:*
> **SDD Phase Complete: PRD**
> - (Recommended) Proceed to `/adr` (Architecture Decisions & System Design)
> - Skip to `/plan` (Implementation Plan & Task Breakdown)
> - Skip directly to `/impl` (Code Implementation)
> - Done (Stay in PRD)

### Step 2: Proceed to ADR
```bash
/adr JWT vs Session Auth
```
*Output: Records architecture decision, data schema, and security considerations.*

### Step 3: Create Implementation Plan
```bash
/plan User Authentication
```
*Output: Decomposes into models, auth middleware, token refresh service, and unit tests.*

### Step 4: Execute Implementation
```bash
/impl User Authentication
```
*Output: Implements code, executes `bun test`, verifies test coverage, and passes acceptance criteria.*
