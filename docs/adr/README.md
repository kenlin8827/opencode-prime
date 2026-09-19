# Architecture Decision Records (ADL)

This directory is the project's Architecture Decision Log: one Markdown file
per decision, plus generated `INDEX.md` views (never hand-edited — regenerate
with `/adr context` or any command that refreshes indexes).

## Canonical templates: Nygard, MADR, and the OCP container style

Two industry templates are canonical for interop, plus the OCP-native
container style. Every document declares its style in frontmatter
(`style: nygard`, `style: madr`, or `style: ocp`); adapters scaffold,
parse, validate, and format only their own template — no style carries
extra headings or private metadata in the body.

| Style | Canonical body | Best for |
| --- | --- | --- |
| `nygard` | `# N. Title` + `## Context` / `## Decision` / `## Consequences` (exactly these three sections) | Short, narrative records; teams wanting the original Michael Nygard grammar |
| `madr` | `# N. Title` + `## Context and Problem Statement` / `## Decision Outcome` (+ `### Consequences`); optional `## Decision Drivers`, `## Considered Options`, `### Confirmation`, `## More Information` | Option analysis; records that must show rejected alternatives and drivers |
| `ocp` | One record per **iteration file** (`ADR-<baseline>.<iteration>`, stem `0.2.54-slug.md`): cheatsheet + optional quick-view restatement layer, then H3 sections (`### 01. <title>`, canonical ID derived) each carrying the five-part skeleton (background/decision/rationale/rejected-with-reasons/impact bullets) and its own emoji status line | A batch of related decisions made and accepted together (baijiu-shop discipline); section-level rejected-alternatives structure becomes grammar-validated data |

A MADR document is never required to carry the optional sections; a Nygard
document is never required to carry MADR-only sections (strict style
isolation). Shared tooling consumes a normalized record model, so indexes,
trees, history, and integrity checks behave identically for both.

## Style selection

- `/adr init` persists the default style for new records (`adr.style`);
  the `standard` suite defaults to `madr`; `evolution` adds iteration
  numbering + review governance; `ocp` bundles the container style with
  iteration numbering + hierarchical layout + review governance
  (baijiu-shop discipline as a turnkey preset — every `/adr new` then
  requires `--baseline`/`--iteration`).
- `/adr new --style nygard|madr <title>` overrides per record; explicit flags
  always beat config. `--style ocp` routes to container creation and
  With `--baseline`/`--iteration` it is one iteration's record
  (`/adr new --style ocp --baseline 0.2 --iteration 54 <title>`); without
  them it is a SEQUENTIAL container (`ADR-NNNN`) — numbering is
  orthogonal to the container style (§6).
- Pick Nygard when the record is a short narrative; pick MADR when the
  decision needs visible option comparison; pick ocp when a whole
  iteration's related decisions are drafted and accepted as one batch.
  Do not mix templates inside one document — one file is always one
  record, and one ocp record is always one iteration.

## Mixed-style ADL behavior

- One file = one record = one globally unique ID (`ADR-0001`, the dotted
  per-decision `ADR-0.2.54.01`, or the container `ADR-0.2.54`). IDs are
  frozen forever: never reused, never renumbered, including across
  baselines and styles.
- **ocp containers**: the container reserves the WHOLE
  `<baseline>.<iteration>.*` sub-ID space at creation. Per-decision IDs
  are never minted under an occupied iteration (use
  `/adr section ADR-0.2.54 <title>` to append a section instead), and a
  container never claims an iteration that already holds per-decision
  records. The three grammars (sequential, dotted 4-segment, container
  3-segment) are disjoint by construction.
- The decision graph (parent/supersession/INDEX/history/context) operates
  at container granularity; sections are structured payload, not records.
  Partial supersession of a single section is a status-line annotation plus
  prose cross-reference — never a graph edge.
- Nygard, MADR, and ocp documents coexist under one ADL root (flat or
  hierarchical). Generated indexes render each record's style; `/adr
  history` and `/adr context` traverse relationships across styles.
- **Legacy documents** (no `style` frontmatter, written before the multi-style
  refactor) parse through the MADR adapter and keep working unchanged.
  They are reported — never silently rewritten:
  - `/adr check --report-style` lists every document's resolved style with a
    `legacy` flag (report-only).
  - `/adr migrate --to nygard|madr` converts styles **explicitly**: the
    default is a deterministic dry-run report (source path, destination path,
    frozen record-ID mapping, link rewrites, and unconvertible-content
    warnings — MADR-only sections such as Considered Options have no Nygard
    home and would be dropped). Nothing is written without `--confirm`; a
    conversion preserves `created`, `date`, status, and all references
    verbatim, and the result is verified to re-parse as the target style.
  - `ocp` is deliberately NOT a `--to` target: the container grammar
    (baseline/iteration namespace + section payload) is not reachable by
    per-file conversion. Adopt it by creating a container
    (`/adr new --style ocp --baseline <b> --iteration <i> <title>`).

## Universal protocol layer

Independent of template, every record follows the same protocol:

- **Status lifecycle**: `proposed → accepted / rejected / deprecated /
  superseded`. Agents draft and interrogate; humans decide and own. No code
  path writes `accepted` — acceptance is a human act.
- **Immutable accepted semantics**: an accepted record's body never changes
  semantically; any semantic change is a NEW record that amends or supersedes
  the old ID (`/adr supersede` flips only the old status line).
- **Supersession mechanics**: `/adr supersede <ADR-ID> <new title>` creates
  the successor with `supersedes: <old-ID>` and flips only the old file's
  status — cross-style supersession works because references are IDs, not
  paths.
- **Readability**: records state context, decision, and consequences in
  prose; task progress and checklists belong in plans and issues, not ADRs.

Governance (how strongly these are enforced) is a project-level policy
independent of style; see `/adr init` suites.

## Evolution metadata conventions

- `created` — immutable creation date, written once. Indexes sort by
  `created` (falling back to path), never by `date`.
- `date` — last **status-change** stamp. A style conversion or reformat is
  not a status change and must not touch `date`.
- `baseline` / `iteration` / `domain` — optional frontmatter grouping any
  style. Iterations are reconstructed from shared metadata via generated
  views (`INDEX.by-iteration.md`) and `/adr context --iteration <id>` —
  cross-record quick references are never hand-maintained. An ocp
  container additionally carries its OWN cheatsheet/quick view as authored body
  content (they restate the section prose, never add facts); that is record
  content, not a cross-record view, and the prose-wins red line governs it.
- IDs come in four disjoint grammars that cannot collide: sequential
  (`ADR-0001`), per-decision dotted (`ADR-<baseline>.<iter>.<seq>`),
  container (`ADR-0001` or `ADR-<baseline>.<iter>`, ocp style), and
  container section (`ADR-<container>#NN` — the `#` fragment form).
  Iteration containers reserve the whole `<baseline>.<iteration>.*`
  namespace; sequential containers share the sequential allocator.

## Provenance: baijiu-shop principles

The discipline of grouping decisions per iteration, freezing accepted
semantics, and pairing AI drafts with human acceptance originates in the
**baijiu-shop** engineering practice. It ships here as a **universal protocol
layer applied to every style** — not as a third template: the baijiu-shop
entry skeleton mapped one-to-one onto MADR's vocabulary, so keeping a
duplicate template would only multiply parsers and drift from the industry
standard. Teams wanting that discipline enforced on MADR records opt in via
`/adr check --profile evolution` (non-empty Considered Options with per-option
cons, good/bad Consequences split, Confirmation required for `risk: high`
records). See `ADR-0007` for the architectural decision record.

**Amendment (2026-09-18, ADR-0007 in place)**: the audit had conflated the
entry skeleton with the file shape. Reframed as **container = record, sections =
structured payload**, the baijiu-shop file shape no longer violates the
record model, so the `ocp` container style ships as the OCP-native third
style — one record per iteration file, graph at container granularity,
namespace reservation keeping the ID grammars collision-free. The industry
templates remain the interop default; `ocp` is for teams whose natural
decision batch is the iteration.
