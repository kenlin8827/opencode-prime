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
| `adr.ts` | `/adr` command suite — ADR workbench + per-project commit guard (`/adr guard`) |
| `env-guard.ts` | Per-project secret-file gate |
| `e2e-adopt.ts` | `/e2e-adopt` command — adopts the E2E red-line policy into project docs (`docs/e2e-redline.md` + AGENTS.md section); docs governance, no runtime gate |
| `project-manager.ts` | `/project` command + commit discipline |
| `project-memory.ts` | `/memory` command — project-level memory: note lessons to `.ocp/memory/public.md` (team) or `private.md` (gitignored), inject under `[PROJECT MEMORY]` on each chat request. `memory_note` tool for LLM-initiated capture; `/memory-summarize` skill for session summaries. |
| `queue-manager.ts` | `/queued` command — manage prompts queued while the session is busy |
| `profile-wizard.ts`, `provider-wizard.ts`, `project-wizard.ts` | `/profile`, `/provider`, and `/project` TUI dialog wizards; new Node projects without an existing formatter may explicitly set up project-local dprint |
| `md-to-pdf.ts` | `/md-to-pdf` command & `md_to_pdf` tool — export Markdown files as publication-quality A4 PDFs (via Pandoc + Playwright) |
| `md-to-docx.ts` | `/md-to-docx` command & `md_to_docx` tool — export Markdown files as publication-quality Word (.docx) documents (Chinese typography, auto TOC, styled tables & code blocks) |

> **Workflow commands are not plugins.** `/dev-quick`, `/dev-plan`, `/dev-review`, `/dev-ultra`, `/dev-prud`, `/review-fix-loop`, `/improve-loop`, `/grill-me`, `/grill-with-docs`, `/goal`, `/handoff` are native opencode command files (`commands/*.md`): thin launchers that load their protocol from an L2 skill (`skills/<name>/SKILL.md`) on demand — paid once per invocation, never resident. See [Workflow Slash Commands](commands.md) and [Five Dev Flows](dev-loops.md).

---

## ADR Iron Law & Living Architecture (`adr` & `/adr`)

Enterprise-grade Architecture Decision Record governance. Operates in two complementary modes:

1. **Commit Iron Law (`/adr guard`)** — Hard/soft guardrails preventing unrecorded architecture drift on `feat`/`refactor` commits.
2. **Hierarchical Living Architecture (`/adr`)** — Frictionless authoring, decision lifecycle management, multi-level hierarchy, and interactive DAG visualization.

### Switch & Configuration

The commit guard switch is **project-level** (stored in `.ocp/ocp.json`):

```text
/adr guard on       # enable commit gate for this project
/adr guard off      # disable commit gate
/adr guard          # status report (state + ADR dir)
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
| `/adr migrate --to nygard\|madr [--dry-run\|--confirm]` | Explicit style conversion: deterministic dry-run report (source/destination/ID mapping/link rewrites/drop warnings); **never writes without `--confirm`** | `/adr migrate --to nygard` |
| `/adr tree` / `/adr map` | Render full architecture decision tree & Mermaid DAG diagram | `/adr tree` |
| `/adr tree --by path\|layer\|domain\|iteration` | Deterministic logical views over normalized records (mixed-style safe) | `/adr tree --by domain` |
| `/adr history <ADR-ID>` | Traverse the supersession chain (predecessors + successors, cross-style safe) | `/adr history ADR-0.2.54.01` |
| `/adr context <ADR-ID>` / `--domain <slug>` / `--iteration <id>` | Bounded context bundle: target records + direct parents/supersession/same-iteration relations only, retrieval path disclosed — never the full corpus | `/adr context ADR-0003` |
| `/adr check` / `/adr lint` | Audit link integrity, parent references, and complexity advice | `/adr check` |
| `/adr check --report-style` | Style audit: every document's resolved style with a `legacy` flag (style-less files parse as MADR); report-only, never writes | `/adr check --report-style` |

#### Progressive Disclosure: Generated Indexes & Context Recovery

Every ADR directory automatically gets a generated `INDEX.md` that mirrors the directory tree: local indexes list only their own records plus child-scope summaries (with parent links), and the ADL root index puts global/system records first. Regeneration is deterministic (byte-stable) and generated files state they are not hand-edited. Use the index → narrow to relevant rows → deepen into selected bodies — `/adr context` runs the same algorithm programmatically and reports exactly which indexes and records it read.

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
* **Directory layout (dry-run preview)**: `/adr migrate h` (or `/adr migrate hierarchical`) outputs the planned file moves without modifying files.
* **Directory layout (execution)**: `/adr migrate h --confirm` atomically moves files, rewrites frontmatter and mutual references, and updates all directory indexes.
* **Style conversion**: `/adr migrate --to nygard|madr` reports per record — source path, destination path, frozen record-ID mapping, link rewrites, and unconvertible-content warnings (MADR-only sections such as Considered Options have no Nygard home and would be dropped; Nygard → MADR loses nothing). The default is a dry-run; **nothing is written without `--confirm`**, and the converted documents are verified to re-parse as the target style. IDs, `created`, `date`, status, and references are preserved verbatim.

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
/env-guard on       # enable for this project ("envGuard": "on" in <project>/.ocp/ocp.json)
/env-guard off      # disable
/env-guard          # status report
```

When on, agent access is blocked before execution for file tools targeting `.env`, `.env.local`, `.env.production`, etc., and shell commands reading `.env` into stdout.

---

## E2E red-line adoption (`e2e-adopt`)

Scaffolds the project's E2E red-line policy into its **own documentation** —
baijiu-shop-style docs governance, no runtime switch or gate (the retired
`e2e-guard` plugin's successor):

```text
/e2e-adopt        # detect E2E setup → write docs/e2e-redline.md + AGENTS.md red-line section
/e2e-adopt dry    # preview detection + unfilled placeholders, write nothing
/e2e-adopt status # report whether the policy is adopted
```

Detection pre-fills the template (package manager, e2e script, spec dir,
runner config); undetected values stay as <code v-pre>{{...}}</code> placeholders for manual
fill-in. The adopted policy carries the four core elements: risk-graded
tiers (lightweight / targeted / full), a confirmation loop (ask before ANY
E2E run; explicit request this turn counts as confirmed; refusal pauses the
commit), trigger discipline (E2E only at commit/push time), and a coverage
mandate (feat/API changes carry proportionate E2E coverage, same-batch
commit). Uninstall = delete `docs/e2e-redline.md` + the
`<!-- e2e-redline -->` section in AGENTS.md.

---

## Project memory (`project-memory`)

Lightweight project-level "lessons learned" memory — complementary to
`AGENTS.md` (manual facts, authoritative) and `opencode-mem` (automatic
session history, heavier, different grain). Lives INSIDE the project at
`<projectDir>/.ocp/memory/`, same convention as `.ocp/handoffs/`,
`.ocp/logs/`, `.ocp/recovery/`. Two scopes, one gate:

```text
/memory note "<lesson>"              # append a dated bullet to public.md (default, committed)
/memory note --private "<note>"      # append to private.md (gitignored, only you see it)
/memory on | off                     # toggle injection of both into the system prompt
/memory status                       # gate state + public/private entry counts
/memory show                         # preview what's currently injected (entries + last-edited + stale flag)

/memory-summarize                     # LLM reviews the session and captures durable lessons
```

File names self-describe visibility:
- `public.md` — committed to git, reviewed by your team through the normal PR flow (same authority tier as AGENTS.md).
- `private.md` — gitignored, only the current user sees it. Auto-gitignored on first capture via `.ocp/.gitignore`.

No draft/curated split — every entry lands directly in the file that the gate injects. The agent also has a `memory_note` tool it can call proactively when it discovers a reusable rule; a session-level `/memory-summarize` skill summarizes durable lessons for users who'd rather have the model pick. While `projectMemory` is on and either file is non-empty, content is appended to the system prompt under `[PROJECT MEMORY]` (with `=== Public ===` and `=== Private ===` sections) — advisory: AGENTS.md wins on conflict. Over the 16 000-char cap per section, that section falls back to a pointer block instead of injecting the content. Default on (an empty file is a no-op; the sidebar shows `ON · empty` to nudge a first capture).
Design: `docs/plan/project-memory.md`.

### Usage examples

User command (`/memory note`):

```text
# 1. Team-visible rule — discover it, file it
$ /memory note "this repo uses pnpm not npm — package.json has pnpm-lock.yaml"
[project-memory] Noted to /…/.ocp/memory/public.md — entry is live in memory (team scope).

# 2. Personal note — only you need it
$ /memory note --private "VPN slow, set API timeout to 60s for API calls"
[project-memory] Noted to /…/.ocp/memory/private.md — entry is live in memory (personal scope).

# 3. Toggle injection off when debugging other prompts
$ /memory off
$ /memory on

# 4. Status — gate + both scope counts
$ /memory status
[project-memory] gate: on — team: 3 entries, personal: 1 entries. Injection ACTIVE.
```

LLM-initiated (`memory_note` tool) — called by the agent when it spots a reusable rule:

```text
# In the middle of a code session, the LLM calls:
memory_note({ lesson: "use bun not node", scope: "public", confidence: "high" })
→ {
    title: "Memory noted (public, high)",
    path: "<projectDir>/.ocp/memory/public.md",
    metadata: { path, scope: "public", confidence: "high", confidenceRank: 3, lesson }
  }
```

Session summary (`/memory-summarize` skill) — at session end, optionally with a focus:

```text
# Whole-session summary (both scopes, all topics)
$ /memory-summarize
## Memory summary
**Captured 3 lesson(s)**.
- public (2): this repo's CI needs --no-sandbox on Windows;
                OpenCode plugin API requires client at registration time
- private (1): user prefers dark-mode editor
**Skipped** (counts only — no list):
- session-specific: 4
- already in AGENTS.md: 1
- speculative: 1

# Focused extraction — only API-related lessons, team memory only
$ /memory-summarize "API quirks" --public
## Memory summary
**Captured 2 lesson(s) [filter: public] [focus: "API quirks"]**.
- public (2): OpenCode plugin API requires client at registration time;
                scopedForTool needs both sessionID and agent for subagent detection
**Skipped**:
- session-specific: 4
- off-topic for "API quirks": 3
- already in public.md: 1

# Focus matches nothing — explicitly reports no match (does NOT broaden)
$ /memory-summarize "error handling patterns"
## Memory summary
**No lessons matched focus "error handling patterns". Drop the focus to capture the full session.**
```

Combine with the scope filter — focus and `--public`/`--private` are orthogonal:
```text
$ /memory-summarize "workflow lessons" --private    # workflow lessons, personal notes only
$ /memory-summarize "gotchas we hit"                # all topics matching the focus, both scopes
```

Tool gate behavior:

```text
# Title-generator utility session trying to note:
memory_note({ lesson: "x" }, ctx: { agent: "title-generator" })
→ {
    title: "Memory note denied",
    output: "memory_note is not available in this agent context (title-generator). …",
    metadata: { denied: true, agent: "title-generator", … }
  }
# (Tool gate is gated; system-inject also denies it. Title tasks can't
#  discover reusable rules — denying prevents noise.)

# Subagent (advisor) noting a real project quirk:
memory_note({ lesson: "auth middleware swallows JWT errors" }, ctx: { agent: "advisor", sessionID: "sub-1" })
→ succeeds (subagent genuinely learned something worth remembering)
```

Over-cap behavior (16 000-char per section):

```text
# public.md crosses the cap → that section falls back to a pointer block:
# [PROJECT MEMORY]
# === Public ===
# /…/public.md is 18500 chars — over the 16000-char injection cap, so it is NOT in
# your context. Read /…/public.md when making decisions it could affect, and ask
# the user to prune/summarize stale entries.
# === Private ===
# (normal injection — private.md is small)
# Per-section: a bloated private.md does NOT silence public, and vice versa.
```

---

## Commit discipline (`project-manager`)

Per-project commit-convention enforcement with a **file-as-switch**: no state file, no on/off command — the discipline is active exactly while `docs/git-commits.md` exists.

```text
/project init       # migrate legacy state, then scaffold baseline files (.ocp/ocp.json, docs/git-commits.md, AGENTS.md)
/project index      # manually refresh existing indexes (codegraph sync, gitnexus analyze)
/project sync       # re-run the one-shot legacy migration on demand (idempotent)
```

While `docs/git-commits.md` exists:
- First line of commit message must match `type(scope): summary` (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`, `build`, `style`, `revert`) and stay ≤ 72 characters.

---

## Managing queued prompts (`/queued`)

OpenCode persists prompts submitted while busy as durable inbox items. The bundled `queue-manager.ts` TUI plugin provides an interactive UI:

- `/queued` opens a picker dialog listing all queued messages.
- Selected actions: **Toggle delivery** (steer ↔ queue — steering promotes the item ahead of queued work at the next safe boundary), **Cancel Prompt**, **View Full Text**, or **Cancel ALL**.
- v1's "Edit text" is gone: the v2 inbox API can cancel, re-admit, and change delivery, but cannot rewrite a pending item's payload.

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
  - Project-level exclusive styling via `.ocp/md-to-docx.css` and template via `.ocp/md-to-docx.docx`.
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

In addition to bundled TypeScript plugins, this distribution integrates validated external NPM plugins. These plugins are managed declaratively in `install/options.jsonc` (the `plugin` block controls membership in `opencode.jsonc`'s `plugins` array); the v2 runtime loads cached package plugins at server startup and installs missing ones in the background.

| Plugin | Default Status | Description & Prerequisites |
|---|---|---|
| `opencode-qoder-bridge` | Optional (`false`) | **Official Qoder Bridge**: Auto-injects `qoder` provider and all models via `@qoder-ai/qoder-agent-sdk` (requires `qoder login`). |
| `opencode-mem@2.24.3` | Optional (`false`) | **Persistent Vector Memory**: Preserves project knowledge in a local vector store (issues extra lightweight LLM capture calls during idle periods). |

To enable any optional plugin, simply set its switch to `true` in `install/options.jsonc` and re-run the installer.
