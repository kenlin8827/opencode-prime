---
style: madr
status: proposed
created: 2026-09-17
date: 2026-09-17
layer: system
---

# 0007. Multi-style ADL with a universal protocol layer

## Context and Problem Statement

The adr-guard plugin grew around a single MADR-shaped template with
per-directory numbering, path-based references, and hard-coded
feat/refactor gating. The plan at `docs/plan/adr-multistyle-adl-refactor.md`
audited that design against industry practice and the baijiu-shop
engineering discipline, and surfaced eight decision points that change how
this project (and its users) record architecture decisions:

1. Whether to keep a proprietary `ocp` record style alongside the industry
   templates.
2. Whether `style` frontmatter is mandatory for all new source documents.
3. Whether record IDs are globally unique across the whole ADL, including
   dotted iteration IDs.
4. How evolution metadata groups records (baseline/iteration vs.
   domain/refactor theme).
5. Whether a universal protocol layer (immutable accepted semantics,
   supersession, AI-drafts/human-decides, readability) applies to every
   style.
6. Whether the numbering policy (sequential default | iteration dotted IDs)
   is orthogonal to style.
7. Governance choices: (a) strict enforcement mode, and (b) the default
   governance for AI-assisted projects.
8. Whether `/adr init` exposes suites (`standard` / `evolution` / `custom`)
   instead of bare orthogonal options.

No earlier ADR (0001–0006) records ADR-tooling guidance that this decision
replaces, so nothing is superseded; this record is additive.

## Considered Options

- **Option A — keep the proprietary `ocp` template as a third style**: keeps
  the status quo; multiplies parsers and index shapes; drifts from the
  industry standard for no structural gain (the baijiu-shop skeleton maps
  one-to-one onto MADR's vocabulary).
  - *Amended 2026-09-18 (record still `proposed`, amended in place)*: the
    original audit conflated the **entry skeleton** with the **file shape**.
    The skeleton does map onto MADR; the file shape does not. baijiu-shop
    records one *iteration* (a batch of related decisions accepted
    together) per file, with per-decision sections as H3 payloads plus a
    cheatsheet/quick-view restatement layer. Reframed as **container =
    record, sections = structured payload**, Option A stops violating the
    record model: the graph keeps operating at one-record-per-file, and
    the previously fatal "multi-entry container" objection only applied
    to treating sections as records. See Decision Outcome amendment.
- **Option B — two canonical styles (`nygard`, `madr`) + universal protocol
  layer**: style adapters scaffold/validate only their own industry
  template; shared behavior (status lifecycle, immutable accepted semantics,
  supersession, AI-drafts/human-decides) lives in one protocol layer applied
  to every record; baijiu-shop discipline is opt-in via an `evolution`
  validation profile.
- **Option C — one style only (MADR), drop Nygard**: simplest parser surface,
  but locks out teams standardized on the original Nygard grammar.

Per decision point, the considered alternatives were: implicit/undeclared
style vs. mandatory `style` frontmatter; per-directory vs. globally unique
IDs; hand-maintained evolution quick-references vs. generated per-iteration
views over shared metadata; style-private vs. universal governance dialects;
numbering embedded in styles vs. an orthogonal numbering policy; mechanical
strict gating now vs. deferral until the normalized record model is stable;
and bare option exposure vs. opinionated init suites.

## Decision Outcome

Chosen option: **B — two canonical styles plus a universal protocol layer**,
adopting the plan's recommendations on all eight decision points:

1. The proprietary `ocp` record style is revived as the **OCP-native
   container style** (baijiu-shop grammar), alongside the two industry
   templates (this refactor's adapters are their own first customer).
   Concrete shape: one record per iteration file
   (`ADR-<baseline>.<iteration>`, stem `0.2.54-slug.md`); each section is an
   H3 block in short heading form (`### 01. <title>`; the canonical ID
   `ADR-0.2.54.01` derives from the container namespace and is never
   spelled out in the heading) carrying the five-part skeleton
   (background/decision/rationale/rejected/impact) and its own emoji status line;
   the container reserves the whole `<baseline>.<iteration>.*` sub-ID
   space at creation, so the dotted grammar stays collision-free with
   per-decision records. The graph (parent/supersession/INDEX/history/
   context) operates at CONTAINER granularity — sections are structured
   payload, never records; partial supersession of one section stays a
   status-line annotation plus prose cross-reference, exactly the
   baijiu-shop practice. Cheatsheet/quick-view are container body
   content (authored, governed by the prose-wins red line); cross-record
   views stay generated.
2. Every new source document declares `style` (`nygard` or `madr`);
   pre-refactor style-less documents remain readable as `legacy` and are
   converted only via explicit, confirmed migration (`/adr migrate --to`).
3. Record IDs are globally unique across the whole ADL; sequential
   (`ADR-0001`) and dotted (`ADR-0.2.54.01`) grammars are disjoint and can
   never collide. IDs are frozen forever — never reused or renumbered.
4. Evolution grouping is optional `baseline` / `iteration` metadata on any
   style, reconstructed by generated views (`INDEX.by-iteration.md`,
   `/adr context --iteration`) — never hand-maintained and never a
   multi-entry container file.
5. The universal protocol layer applies to every style; governance modes
   (`none` | `review` | `strict`) decide whether its principles are
   convention or enforcement, never a per-style dialect.
6. Numbering (`sequential` default | `iteration`) is orthogonal to style;
   iteration IDs are allocated only when creation passes
   `--baseline`/`--iteration` — no iteration value is ever invented.
7. Strict governance is deferred (build only on demand, on normalized
   records); `/adr init` defaults AI-assisted projects to `review` so
   "agents never self-accept" is a team rule, not just convention.
8. `/adr init` ships opinionated suites (`standard` / `evolution` /
   `custom`) that persist resolved `adr.*` values plus an informational
   `adr.suite` label.

### Consequences

- **Positive**: one adapter interface and one normalized record model keep
  indexes, trees, history, and integrity checks identical across styles;
  legacy documents keep working unchanged; style changes are explicit,
  dry-run first, and verified after write. The `ocp` container style adds
  a third adapter but reuses the same normalized model — section-level
  structure (five-part skeleton, rejected alternatives with reasons, impact by layer) becomes
  grammar-validated data instead of regex-mined prose.
- **Negative / Risks**: three parsers instead of one (mitigated by the
  shared normalized model and strict style isolation); mixed-style ADLs
  demand the `legacy` audit (`/adr check --report-style`) to keep
  documents honest; the `evolution` profile enforces baijiu-shop
  discipline only when opted in, so teams must choose it deliberately;
  the `ocp` container adds a second write shape (section append) and a
  namespace reservation rule that allocation must never bypass.
