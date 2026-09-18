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
| `ocp` | One record per **iteration file** (`ADR-<baseline>.<iteration>`, stem `0.2.54-slug.md`): cheatsheet + optional quick-view restatement layer, then H3 sections (`### 01. <title>`, canonical ID derived) each carrying the five-part skeleton (background/decision/rationale/rejected-with-reasons/impact bullets) and its own emoji status line | A batch of related decisions made and accepted together (OCP discipline); section-level rejected-alternatives structure becomes grammar-validated data |

A MADR document is never required to carry the optional sections; a Nygard
document is never required to carry MADR-only sections (strict style
isolation). Shared tooling consumes a normalized record model, so indexes,
trees, history, and integrity checks behave identically for both.

## Style selection

- `/adr init` persists the default style for new records (`adr.style`);
  the `standard` suite defaults to `madr`; `evolution` adds iteration
  numbering + review governance; `ocp` bundles the container style with
  iteration numbering + hierarchical layout + review governance
  (OCP discipline as a turnkey preset — every `/adr new` then
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

### OCP iteration boundaries

An OCP iteration is a bounded delivery batch, usually a release version or a
coherent feature/refactor batch — not an individual commit. Start a new
container for a new version or independently deliverable architectural batch;
append a section when the decision belongs to the current delivery scope.

- `feat` and `refactor` are the default ADR-review signals. `perf` and security
  work are also strong signals when they change long-lived architecture.
- Assess `fix`, `build`, and `ci` when they change data, compatibility,
  reliability, release, deployment, or security boundaries; routine work does
  not create an iteration merely because of its commit type.
- `docs`, `test`, `chore`, `style`, and `revert` are exceptions only when they
  establish, revise, or roll back a durable architectural contract.
- Do not invent a baseline or iteration number. Use the release/version plan
  or an existing container; ask the user when neither is authoritative.

The hard `adr-guard` commit gate remains narrower: when enabled it enforces
ADR coverage for `feat` and `refactor` commits. That gate is not the iteration
classifier and does not replace architectural judgment.

## Chinese reader mirror

`zh/` contains Chinese reader mirrors of the canonical ADR containers. It is
not a second ADL: files there retain their source IDs for navigation but are
excluded from discovery, allocation, integrity checks, generated indexes,
graphs, and commit gates. The root records remain the authoritative source;
each mirror declares `translation_of` and `language: zh-CN` in frontmatter.
See [`zh/README.md`](./zh/README.md).

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
- **Prose language**: grammar is a single English authority (canonical
  headings, field labels, frontmatter keys/enum values, the MADR
  `Chosen option …, because …` lead-in); all prose — titles, bodies,
  cheatsheet, emoji status decoration words — is drafted in the team's
  working language (`ADR-0.40.0#02`).

Governance (how strongly these are enforced) is a project-level policy
independent of style; see `/adr init` suites.

## OCP output protocol (every style, every iteration)

Every record — regardless of style — follows the same rendering rules. The
goal is **scannable on the first read**: an old reader skims the Cheatsheet
and lands where they need; a new reader walks the H3 sections and
follows the decision chain. The rules apply to both root and zh-mirror
trees; the rules do not depend on prose language (ADR-0.40.0#02) — field
labels stay English, prose follows the working language.

### Container layout (style: ocp)

```
# Iteration X.Y · <topic — in the working language>

> Index: [`README.md`](./README.md). Supersedes / amends: <prior IDs or "—">.
>
> Cheatsheet & quick view are restatement layers: diagrams/tables restate the
> section prose and never add facts — on conflict the prose wins.
> Amend/supersede relations are declared in each section's status line;
> accepted semantics never move one character.

## Cheatsheet                                              ← reader's primary entry
1. <conclusion 1 — ≤60 chars> (ADR-X.Y#NN)
2. <conclusion 2 — ≤60 chars> (ADR-X.Y#NN)
3. <conclusion 3 — ≤60 chars> (ADR-X.Y#NN)
4. <conclusion 4 — ≤60 chars> (ADR-X.Y#NN)
5. <conclusion 5 — ≤60 chars> (ADR-X.Y#NN)
6. <conclusion 6 — ≤60 chars> (ADR-X.Y#NN)                 ← hard cap 6, priority: implementation pitfalls > semantic boundaries > structural conclusions > historical pointers

---

## Quick view                                               ← restate layer (graphs + tables)
[mermaid `flowchart LR` when there is structure; tables for ≥2×≥3, old→new, enum semantics, decision lists, rejected lists]
≤2 figures per iteration; restate layer fills the rest by table.

---

### 01. <section title — in the working language>           ← five-part skeleton
**Status**: 🟡 proposed (or ✅ accepted / 🔄 superseded / ⛔ deprecated)
**Background**: <situation + pain, ≤3 sentences — no solution detail>
**Decision**:
| # | Point | Content |
| 1 | <point> | <what was decided> |
| 2 | <point> | <what was decided> |
**Rationale**:
- **<keyword>**: <single-line justification>
- **<keyword>**: <single-line justification>
**Rejected**:
| Option | Reason rejected |
| <option> | <why rejected> |
| <option> | <why rejected> |
**Impact**:
- **Plugins**: <changes>
- **Runtime**: <changes>
- **Tests**: <changes>
- **Docs**: <changes>
**Future extensions**: <optional — delete the line when none>
```

### Hard rules (every record)

1. **Cheatsheet ≤ 6 items, each ≤ 60 chars** (ADR refs and code symbols
   don't count). One conclusion per item, plain text, ADR ref as a `(ADR-X.Y#NN)`
   suffix. Items cover, in priority order: **implementation pitfalls >
   semantic boundaries > structural conclusions > historical pointers**.
   Hard cap 8; never cut an implementation pitfall to fit.
2. **Background ≤ 3 sentences** — situation + pain only, no solution detail.
3. **Decision is a table, not prose** — `| # | Point | Content |`. No
   "we decided to…" essay. Each row = one decision point, ≤ ~80 chars in the
   Content column. If a decision can't be a row, it isn't a decision — fold it
   into Rationale or Impact.
4. **Rationale ≥ 2 bullets, bold-keyword led** — every bullet starts with
   `**Keyword**:`. Keyword = the load-bearing concept (`Parser stability`,
   `Defendability gate`, `Single source at runtime`, …). No "and" / "or" /
   "however" prose connectives that bypass the keyword.
5. **Rejected is a table, not prose** — `| Option | Reason rejected |`.
   Every rejected option carries its reason. No bullet form; no inline list
   separated by `/`. If the rejected list exceeds 4 rows, the chosen
   decision is overcomplicated — re-scope.
6. **Impact is layered bullets** — group by layer:
   **Plugins / Runtime / Dispatcher / Installer / Tests / Docs / Skills /
   Data / Frontend** (whatever applies, omit what doesn't). Each bullet
   starts with the bold layer name; the bullet itself ≤ ~60 chars. No
   comma-chained "and" lists.
7. **Paragraphs ≤ 4 lines**. One sentence = one idea. No nested em-dashes
   (`——`) — at most one per clause; deeper nesting breaks readability, split
   the sentence.
8. **Cheatsheet & Quick view are restate layers** — they NEVER add facts
   beyond what the section prose establishes. On conflict the prose wins
   (OCP container red line, §prose-wins). Cheatsheet is the reader's primary
   entry, so it must be readable as pure conclusions.
9. **mermaid `flowchart LR` preferred** for flow control. `flowchart TD` only
   when LR would be unreadable. ≤ 2 figures per section / iteration in
   the restate layer; tables fill the rest. Per `classDef` / `linkStyle`
   highlighting is allowed **only inside the erratum section**; the body
   figure stays plain.
10. **erratum rule** — when the restate layer (figure / table) is later
    proven wrong, do NOT edit the original. Append an **erratum** section
    below the sections with the corrected figure / table. `classDef` /
    `linkStyle` highlighting is permitted in the correction only, with an
    explicit legend.

### Soft rules (style preference, not enforced)

- Bold-keyword rationale bullets where possible — keyword = the load-bearing
  concept, not the first noun.
- Decision tables: short rows (≤ ~80 chars in Content), concrete noun
  phrases; no run-on sentences in a single cell.
- Rejected tables: option name = what was actually considered, not a
  paraphrase; reason = the disqualifying property.
- Impact bullets: start with the layer name in bold; if a single change
  touches ≥ 3 layers, it is over-scoped — split the ADR.
- mermaid node labels: ≤ 6 words; long phrases become tables, not nodes.

### Style isolation reminder

The output protocol applies to **every style**, not just `ocp`:

| Style | Cheatsheet | Quick view | Section body |
| --- | --- | --- | --- |
| `nygard` | n/a (short record) | n/a | Context / Decision / Consequences — same length rules |
| `madr` | n/a (long record) | optional Quick-view per ADR | tabular Decision Drivers / Considered Options / Consequences follow the same table rules |
| `ocp` | **mandatory**, numbered 1–6 with refs | **mandatory**, mermaid LR + table | five-part skeleton, table-based Decision / Rejected, layered Impact |

`madr` Considered Options: each option carries `**Pros**` / **Cons** as a
sub-list, not a paragraph. Consequences split `**Positive**` /
`**Negative / Risks**` — both kept to ≤ ~80 chars per bullet.

`nygard` Consequences: prose form allowed (the style's grammar) but
follows the bullet / length rules; a 200-line Context block violates the
"Background ≤ 3 sentences" intent — split.

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

## Provenance: OCP principles

The discipline of grouping decisions per iteration, freezing accepted
semantics, and pairing AI drafts with human acceptance originates in the
**OCP** engineering practice. It ships here as a **universal protocol
layer applied to every style** — not as a third template: the OCP
entry skeleton mapped one-to-one onto MADR's vocabulary, so keeping a
duplicate template would only multiply parsers and drift from the industry
standard. Teams wanting that discipline enforced on MADR records opt in via
`/adr check --profile evolution` (non-empty Considered Options with per-option
cons, good/bad Consequences split, Confirmation required for `risk: high`
records). See `ADR-0.40.0#01` for the architectural decision record.

**Amendment (2026-09-18, ADR-0.40.0#01 in place)**: the audit had conflated the
entry skeleton with the file shape. Reframed as **container = record, sections =
structured payload**, the OCP file shape no longer violates the
record model, so the `ocp` container style ships as the OCP-native third
style — one record per iteration file, graph at container granularity,
namespace reservation keeping the ID grammars collision-free. The industry
templates remain the interop default; `ocp` is for teams whose natural
decision batch is the iteration.
