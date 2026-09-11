# Plugins & Project Guardrails

Plugins provide runtime enforcement and workflows that prompts alone cannot achieve. Everything below ships enabled — nothing to install.

---

## Plugins Overview

| Plugin | What it does for you |
|---|---|
| `project-profiler.ts` | Detects project languages & active MCP servers at session start; steers agents to LSP/graph queries before grep |
| `design-token-guard.ts` | Blocks writes with hardcoded colors/spacing/radius — keeps frontend code on design tokens |
| `ai-slop-scanner.ts` | Warns about AI anti-patterns in frontend files (gradient soup, div soup) |
| `usage.ts` | `/usage` TUI command opens a dialog with auto-fitted width and a visible tab strip: **by session** (one row per session + total), **by agent**, **by model** — non-cached input / output / cached-in tokens, cost, cache hit, share bars; `1/2/3` or `←→` switch tabs live, `Enter` closes; `↑/↓` scroll long tables (tab strip, warning, header, total and footers stay pinned); `/usage all\|agent\|model` opens a dimension directly; toast fallback when the dialog API is unavailable (TUI sessions only) |
| `auto-format.ts` | Auto-runs the project-selected dprint/Biome/Prettier/ESLint/Ruff/gofmt/rustfmt after file edits; dprint and Biome require their config and project-local binary |
| `auto-advisor-mode.ts` | `/auto-advisor` command, protocol injection, mode gating, red-team suppression |
| `deepseek-anchor.ts` | `/deepseek-anchor` command — anchor-based reasoning protocols with DeepSeek models |
| `adr-guard.ts` | `/adr-guard` command — per-project ADR enforcement |
| `env-guard.ts` | Per-project secret-file gate |
| `e2e-guard.ts` | `/e2e-guard` command — per-project gate: E2E runs need user confirmation |
| `project-manager.ts` | `/project` command + commit discipline |
| `project-memory.ts` | `/memory` command — opt-in project memory: capture lessons, inject curated memory (stored outside the project under the ocp memory root) |
| `queue-manager.ts` | `/queued` command — manage prompts queued while the session is busy |
| `profile-wizard.ts`, `provider-wizard.ts`, `project-wizard.ts` | `/profile`, `/provider`, and `/project-wizard` TUI dialog wizards; new Node projects without an existing formatter may explicitly set up project-local dprint |
| `md-to-pdf.ts` | `/md-to-pdf` command & `md_to_pdf` tool — export Markdown files as publication-quality A4 PDFs (via Pandoc + Playwright) |
| `md-to-docx.ts` | `/md-to-docx` command & `md_to_docx` tool — export Markdown files as publication-quality Word (.docx) documents (Chinese typography, auto TOC, styled tables & code blocks) |

> **Workflow commands are not plugins.** `/dev-quick`, `/dev-plan`, `/dev-review`, `/dev-ultra`, `/dev-prud`, `/review-fix-loop`, `/grill-improve-loop`, `/grill-me`, `/grill-with-docs`, `/goal`, `/handoff` are native opencode command files (`commands/*.md`): thin launchers that load their protocol from an L2 skill (`skills/<name>/SKILL.md`) on demand — paid once per invocation, never resident. See [Workflow Slash Commands](commands.md) and [Five Dev Flows](dev-loops.md).

---

## ADR Iron Law & Living Architecture (`adr-guard` & `/adr`)

Enterprise-grade Architecture Decision Record governance. Operates in two complementary modes:

1. **Commit Iron Law (`/adr-guard`)** — Hard/soft guardrails preventing unrecorded architecture drift on `feat`/`refactor` commits.
2. **Hierarchical Living Architecture (`/adr`)** — Frictionless authoring, decision lifecycle management, multi-level hierarchy, and interactive DAG visualization.

### Switch & Configuration

The commit guard switch is **project-level** (stored in `opencode.jsonc`):

```text
/adr-guard on       # enable commit gate for this project
/adr-guard off      # disable commit gate
/adr-guard          # status report (state + ADR dir)
```

The ADR hierarchy layout is configured via `/adr layout`:

```text
/adr layout                   # show current layout (auto | flat | hierarchical)
/adr layout flat              # pure flat single-directory layout (docs/adr/)
/adr layout hierarchical      # strict multi-tier hierarchy (L1/L2/L3)
/adr layout auto              # smart adaptive layout (default: flat by default, expands on multi-package)
```

### Slash Commands (`/adr`)

| Command | Description | Example |
|---|---|---|
| `/adr [new] [layer/scope] <title> [--empty]` | Scaffold a sequential MADR template & **auto-initiate AI drafting** (`new` keyword optional, pass `--empty` for template only) | `/adr "Use PostgreSQL as Primary DB"` or `/adr new "Use PostgreSQL as Primary DB"` |
| `/adr supersede <old-id> <new-title> [--empty]` | Atomically mark old ADR as superseded & **auto-initiate AI drafting** with evolution rationale | `/adr supersede 0001 "Migrate to NATS JetStream"` |
| `/adr migrate [h\|f\|a] [--confirm]` | Preview or execute bidirectional ADR directory restructuring | `/adr migrate h` |
| `/adr tree` / `/adr map` | Render full architecture decision tree & Mermaid DAG diagram | `/adr tree` |
| `/adr check` / `/adr lint` | Audit link integrity, parent references, and complexity advice | `/adr check` |

#### 1. Creating a Decision (`/adr` or `/adr new`)
* **Standard / Flat Monolith (AI-Assisted Drafting)**:
  ```text
  /adr "Use PostgreSQL as Primary Database"
  # or:
  /adr new "Use PostgreSQL as Primary Database"
  ```
  Generates `docs/adr/0003-use-postgresql-as-primary-database.md` with standard MADR template sections, updates `docs/adr/INDEX.md`, and **automatically prompts the AI Agent to investigate the codebase and write out the full MADR document**.
* **Template Only (No AI Drafting)**:
  ```text
  /adr "Use PostgreSQL as Primary Database" --empty
  ```
* **Hierarchical / Monorepo**:
  ```text
  /adr new system "Global Event Bus Standard"          # L1 System (in docs/adr/)
  /adr new domain/payment "Stripe Webhook Processing"  # L2 Domain (in packages/payment/docs/adr/)
  /adr new component/auth "JWT Refresh Rotation"       # L3 Component
  ```

#### 2. Superseding an Old Decision (`/adr supersede`)
Architecture decisions are immutable; evolving solutions should be recorded via `supersede`:
```text
/adr supersede 0001 "Migrate from RabbitMQ to NATS JetStream"
```
**Atomic System Actions**:
1. Marks `0001` frontmatter status as `status: superseded by 0004` with deprecation notes;
2. Scaffolds `0004` with `parent: docs/adr/0001-use-rabbitmq.md`;
3. Automatically synchronizes respective `INDEX.md` files;
4. Prompts AI Agent to review the previous decision and draft the new decision with full trade-off rationale (unless `--empty` is specified).

#### 3. Restructuring & Migration (`/adr migrate`)
* **Dry-Run Preview**: `/adr migrate h` (or `/adr migrate hierarchical`) outputs the planned file moves without modifying files.
* **Execution**: `/adr migrate h --confirm` atomically moves files, rewrites frontmatter and mutual references, and updates all directory indexes.

### Dual-Modal Interaction: Natural Language & Slash Commands

The ADR governance system supports **Slash Commands (deterministic numbering + automated AI drafting)** and **Natural Language** side-by-side:

| Scenario | Natural Language | Slash Commands (Deterministic Path & Indexing) |
| :--- | :--- | :--- |
| **New Decision** | "Help me draft an ADR on using Redis for distributed locking"<br>→ **AI researches requirements, compares alternatives, drafts MADR** | `/adr "Redis Distributed Lock Standard"`<br>→ **Instant index & file scaffolding, then AI automatically drafts body** |
| **Scaffold Only** | "Generate an empty ADR template, I will fill it myself" | `/adr "Redis Distributed Lock Standard" --empty` |
| **Supersede** | "Deprecate ADR 0001, we are switching from RabbitMQ to Kafka" | `/adr supersede 1 "Migrate to Kafka"` |
| **Integrity Audit** | "Audit all ADRs to verify if there are broken links or missing fields" | `/adr check` |
| **Architecture Migration** | "We restructured into a monorepo, migrate payment and auth ADRs to their sub-packages" | `/adr migrate h --confirm` |

### Hierarchical Layers (Coarse to Fine)

- **L1: System & Macro (`layer: system`)** — Global `docs/adr/` (tech stack, core communication, global data architecture).
- **L2: Domain & Subsystem (`layer: domain`)** — `packages/<name>/docs/adr/` or `apps/<name>/docs/adr/` (service boundaries, state machines, domain storage).
- **L3: Component & Module (`layer: component`)** — Module `docs/adr/` (local algorithms, state management).

---

## Secret file guard (`env-guard`)

Optional per-project gate keeping secret-bearing env files out of the LLM context. The switch is **project-level** and defaults to off:

```text
# enable for this project (either one)
echo on > <project>/.opencode/.env-guard
# or add "envGuard": "on" to the project's opencode.jsonc
```

When on, agent access is blocked before execution for file tools targeting `.env`, `.env.local`, `.env.production`, etc., and shell commands reading `.env` into stdout.

---

## E2E gate (`e2e-guard`)

Optional per-project gate requiring explicit user confirmation before any E2E suite runs:

```text
/e2e-guard on       # enable for this project ("e2eGuard": "on" in project opencode.jsonc)
/e2e-guard off      # disable
/e2e-guard          # status report
```

Gating is graded by risk:
- **full**: Suite run with no explicit target (`npm run e2e`, bare `playwright test`) — every run needs a fresh one-shot `/e2e-guard allow` pass.
- **targeted**: Explicit spec/test-file argument (`playwright test tests/login.spec.ts`) — passes automatically once the session has confirmed approval.

---

## Project memory (`project-memory`)

Lightweight, opt-in project-level "lessons learned" memory — complementary
to `AGENTS.md` (manual facts, authoritative) and `opencode-mem` (automatic
session history). Stored OUTSIDE the project, under the ocp user-level
memory root (`~/.config/opencode/memory/<projectKey>/`, path-hashed key —
honors `OCP_CONFIG_PATH`/`XDG_CONFIG_HOME`). Three stages, opt-in at every
one; phase 1 = capture + inject:

```text
/memory capture "<lesson>"   # append a dated bullet to <memory root>/draft.md
/memory on | off             # toggle injection of <memory root>/memory.md
/memory status               # gate state + entry counts
```

Promotion draft → `memory.md` is a manual edit for now (keep the dated-bullet
form; delete stale entries). While `projectMemory` is on and the file is
non-empty, its content is appended to the system prompt under
`[PROJECT MEMORY]` — advisory: AGENTS.md wins on conflict. Over the
16 000-char cap the file is not injected (pointer block instead) — prune it.
Default off.
Design: `docs/plan/project-memory-phase1.md`.

---

## Commit discipline (`project-manager`)

Per-project commit-convention enforcement with a **file-as-switch**: no state file, no on/off command — the discipline is active exactly while `docs/git-commits.md` exists.

```text
/project init       # scaffold baseline files (.opencode/opencode.jsonc, docs/git-commits.md, AGENTS.md)
/project index      # manually refresh existing indexes (codegraph sync, gitnexus analyze)
/project sync       # config top-up only (append-only)
```

While `docs/git-commits.md` exists:
- First line of commit message must match `type(scope): summary` (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`, `build`, `style`, `revert`) and stay ≤ 72 characters.

---

## Managing queued prompts (`/queued`)

OpenCode persists prompts submitted while busy as user messages. The bundled `queue-manager.ts` TUI plugin provides an interactive UI:

- `/queued` opens a picker dialog listing all queued messages.
- Selected actions: **Edit Prompt**, **Cancel Prompt**, **View Full Text**, or **Cancel ALL**.

---

## Document Export & Typography (`md-to-pdf` & `/md-to-pdf`)

Export project Markdown documents (API specs, ADR proposals, research briefs) into publication-ready, styled A4 PDFs.

### Capabilities

- **Natural Language Steered**: Type `@doc/api-v1.md to PDF` or `Export @README.md as PDF`, and agents automatically call `md_to_pdf` to render and attach the result.
- **Deterministic Slash Commands**:
  ```text
  /md-to-pdf README.md                         # Render to README.pdf
  /md-to-pdf doc/api-v1.md dist/api-v1.pdf     # Custom output path
  /md-to-pdf --doctor                          # Check Pandoc and Playwright health
  /md-to-pdf --install-deps                    # Auto-install missing dependencies
  ```
- **Modern Typography & Printing**:
  - **Pandoc Parser**: Standalone HTML5 with syntax highlighting and asset embedding.
  - **Refined A4 Styles**: GitHub-flavored typography, code blocks, borders, and margins.
  - **Playwright Headless Print**: Isolated Node runner printing high-fidelity vector PDFs in milliseconds.

---

## Word Document Export & Typography (`md-to-docx` & `/md-to-docx`)

Export project Markdown documents (technical designs, requirements, ADRs, meeting summaries) into publication-ready, styled Executive Word (`.docx`) files.

### Capabilities

- **Natural Language Steered**: Mention `@docs/design.md convert to word` or `Export @README.md to docx`, and agents automatically invoke the `md_to_docx` tool.
- **Deterministic Slash Commands**:
  ```text
  /md-to-docx README.md                                    # Render to README.docx
  /md-to-docx docs/design.md dist/design.docx              # Custom output path
  /md-to-docx doc/whitepaper.md --style=custom-theme.css   # Custom CSS stylesheet
  /md-to-docx --doctor                                     # Check Pandoc and Playwright status
  /md-to-docx --install-deps                               # Auto-provision missing packages
  ```
- **Pure TypeScript Architecture**: 100% pure TS/Node.js implementation with zero Python dependencies, utilizing OpenXML manipulation via `@xmldom/xmldom` & `adm-zip`.
- **100% Parameterized CSS Styling**:
  - Full control over page geometry, typography, palette, table zebra striping, and code cards via CSS variables and selector rules.
  - Project-level exclusive styling via `.opencode/md-to-docx.css` and template via `.opencode/md-to-docx.docx`.
- **Mermaid Publication Diagram System**:
  - **Zero-latency Offline Rendering**: Built-in bundled offline Mermaid engine, eliminating network delays and CDN outages.
  - **Retina 300+ DPI & 100% Width Expansion**: Generates crystal-clear high-res PNGs scaled proportionally to fill full content width.
  - **Harmonious Modern Light Blue Theme**: Eliminates black boxes/artifacts across all diagram types (Flowcharts, State Machines, Sequence Diagrams, ER Diagrams, Class Diagrams).
  - **100% Dynamic CSS Driven**: All diagram colors, typography, and borders dynamically derived from `--mermaid-*` CSS variables.
- **Executive Publication Typography**:
  - **Biphasic Typography**: Standard dual-font system for Western (Times New Roman / Segoe UI) and East Asian (SimSun / SimHei / Microsoft YaHei) with standard 10.5pt (No. 5) body sizing.
  - **Executive Palette**: Royal Deep Navy headers (#1E3A8A), Charcoal slate body text (#1E293B), subtle ice tint zebra stripes (#F8FAFC).
  - **Adaptive Tables**: Full-width layout, content-based column width calculation, compact header row height (0.74cm), and cleared paragraph margins.
  - **Code Blocks**: Card styling with Cascadia Code (9.5pt), light gray background (#F8FAFC), and subtle borders.

---

## External NPM Plugins & Bridges

In addition to bundled TypeScript plugins, this distribution integrates validated external NPM plugins. These plugins are managed declaratively in `install/options.jsonc` and automatically pre-warmed into `~/.cache/opencode` by `Ensure-Plugins` upon install.

| Plugin | Default Status | Description & Prerequisites |
|---|---|---|
| `opencode-qoder-bridge` | Optional (`false`) | **Official Qoder Bridge**: Auto-injects `qoder` provider and all models via `@qoder-ai/qoder-agent-sdk` (requires `qoder login`). |
| `opencode-mem@2.24.3` | Optional (`false`) | **Persistent Vector Memory**: Preserves project knowledge in a local vector store (issues extra lightweight LLM capture calls during idle periods). |

To enable any optional plugin, simply set its switch to `true` in `install/options.jsonc` and re-run the installer.
