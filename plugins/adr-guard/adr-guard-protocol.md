# ADR Iron Law & Living Architecture

This project records architecture decisions as ADRs. Each record declares
its style in frontmatter: `madr` (industry default), `nygard` (short
narrative), or `ocp` (OCP-native container — one record per iteration
file, sections as H3 sub-decisions). Architecture decisions are treated as
living, queryable artifacts rather than dead archives.

## The iron law

**Every `feat` or `refactor` commit MUST include at least one new or updated
ADR in the same commit.** Other commit types (fix, docs, chore, test, …) are
not gated, but a genuinely architectural fix **MAY** still deserve an ADR.

## Governance modes (`adr.governance`, §11)

Governance is a project-level policy, uniform across every record and style:

| Mode | Lifecycle | Agent self-accept | Audit ledger | Commit gate |
| --- | --- | --- | --- | --- |
| `none` (default) | convention | prohibited by protocol rule | none | off |
| `review` | PR review duty | protocol rule + review duty | none | off (protocol-only) |
| `strict` | mechanically gated | **mechanically blocked** | append-only `.ocp/adr-decisions.log` | on |

New records are always scaffolded `proposed` in EVERY mode — no code path
writes `accepted`. In `none` mode a human flips the status line by hand when
they decide; the flip IS the human act. In `strict` mode the ONLY
proposed → accepted path is the user-run `/adr decide <ADR-ID> [note]`: it
flips ONLY the status line (§9.5 byte-stability) and appends one ledger line
(timestamp, ADR ID, source path, note). The commit gate then blocks any
staged accept flip whose ID has no ledger entry, and requires every
feat/fix/refactor commit to ship a decided flip. `strict` subsumes the legacy
`adrGuard` presence gate — migrating to `strict` means turning `adrGuard`
off to avoid double-gating (the two stay independent, §6.4).

## Hierarchical Decision Model (Coarse to Fine)

In complex codebases, ADRs are structured into three distinct layers:

1. **L1: System & Macro Decisions (`layer: system`)**
   - *Location*: Global `docs/adr/`
   - *Scope*: System-wide tech stack, core communication paradigms, global security, data architecture.
2. **L2: Domain & Subsystem Decisions (`layer: domain`)**
   - *Location*: `packages/<name>/docs/adr/` or `apps/<name>/docs/adr/`
   - *Scope*: Service boundaries, database sharding, domain state machines, queue topology.
3. **L3: Component & Module Decisions (`layer: component`)**
   - *Location*: Subsystem or component `docs/adr/`
   - *Scope*: Internal state management, caching schemes, critical algorithm choices.

## Tooling & Slash Commands
- `/adr [new] [system|domain|component] <title> [--style nygard|madr] [--empty]` — Scaffolds the next record and dispatches to AI for drafting (pass `--empty` for scaffold only).
- `/adr new --style ocp [--baseline <b> --iteration <i>] <title> [--empty]` — Scaffolds an ocp CONTAINER: with baseline+iteration an ITERATION container (`ADR-<b>.<i>`, reserves the iteration namespace); without, a SEQUENTIAL container (`ADR-NNNN` — numbering is orthogonal to the container style).
- `/adr section <ADR-x.y.z> <title>` — Appends one section (`ADR-<x.y.z>.NN`, pending) to an existing ocp container; fill the five-part skeleton (background/decision/rationale/rejected/impact).
- `/adr supersede <old-id> <new-title> [--empty]` — Marks old ADR superseded, scaffolds new ADR with cross-references, and dispatches to AI.
- `/adr migrate [h|f|a] [--confirm]` — Restructures ADR directories between flat and hierarchical layouts.
- `/adr tree` — Visualizes the full hierarchical decision map and Mermaid DAG.
- `/adr check` — Validates links, frontmatter integrity, and index synchronization.
- `/adr-guard on|off|status` — Toggles the hard commit guard.

## ocp container red lines (style: ocp)
- Prose wins over diagrams: the cheatsheet/quick view restate
  the section prose and never add facts; on conflict the prose is
  authoritative.
- Presentation layer vs semantics: tabulation/bullets/sentence-splitting
  of an accepted section is allowed; wording, values, IDs, and scope
  never move one character. A semantic change is a NEW section or a NEW
  container ADR that supersedes.
- Section status (🟡/✅/🔄/⛔) is flipped by hand — flipping IS the human
  act; no code path writes ✅.
- The container's `date` is a status-change stamp: appending a section is
  NOT a status change and must not touch `date`.
- Section headings use the short form `### NN. <title>`; the canonical
  ID (`ADR-<container>#NN` — the `#` fragment form) derives from the container namespace
  and is never spelled out in the heading.

## Slash Command & Natural Language Auto-Drafting Protocol
When `/adr`, `/adr new`, `/adr supersede`, or a natural language ADR request is received:
1. **Scaffold Discovery**: The local TypeScript engine has already created the new `docs/adr/NNNN-slug.md` file (and updated `INDEX.md`). Find the latest ADR file in `docs/adr/` (or target layer directory).
2. **Context Research**: Use tools (`read_file`, `grep_search`, `find_by_name`) to research the workspace context, current technical architecture, dependencies, and requirements.
3. **Write Complete MADR**: Use `replace_file_content` or `write_to_file` to flesh out the document with:
   - Real **Context and Problem Statement**
   - Concrete **Decision Drivers**
   - Viable **Considered Options** with **Pros and Cons**
   - Defensible **Decision Outcome** and **Consequences** (Positive, Negative/Risks & Mitigations)
   - Preserve valid YAML frontmatter (`status`, `date`, `layer`, `scope`, `parent`, `superseded_by`).
4. **Respond to User**: Provide a crisp walkthrough and summary of the decision record drafted.

## Reading aids vs grammar (every style)
Grammar labels and section headings are a single English authority across
all styles. Multilingual reading is a CONTENT concern, never grammar:
- ocp containers: the Cheatsheet is the reader's primary entry — draft
  it in the team's working language (pure conclusions).
- one-time glossary: optionally keep a single label mapping in the ADL
  root README so first-time readers decode the field labels once.
- per-label parentheticals are NOT recommended (repetition that drifts
  across files). Parsers tolerate and ignore them anyway — never let a
  parenthetical replace the English label.


## Before you commit — checklist

1. For feat/refactor the answer to "did this change make or alter a
   decision?" is treated as **YES by default** — architecture shape,
   boundaries, tech choice, integration pattern, deliberate deviation,
   constraint not visible in code.
2. **New decision** → run `/adr new [layer] <title>` or create the next ADR file
   (sequential number `NNNN-slug.md`).
3. **Changed decision** → run `/adr supersede <old-id> <new-title>` (accepted
   ADRs are immutable except their status).
4. Stage the ADR file(s) together with the code change, then commit.
5. Keep `INDEX.md` updated in the corresponding directory.

## ADR template (MADR)

```md
---
status: Accepted     # Proposed | Rejected | Accepted | Deprecated | Superseded by NNNN
date: 2026-08-25     # ISO date of the decision / latest status change
layer: system        # system | domain | component
scope: global        # optional scope or package name
parent: docs/adr/0001-slug.md  # optional parent ADR
---

# NNNN. <short title of the decision>

## Context and Problem Statement

<the situation, architectural context, and the decision to be made>

## Decision Outcome

Chosen option: <what we decided>, because <why>.
```

## ocp container skeleton (style: ocp)

Frontmatter: `style/status/created/date` (+ `baseline/iteration` on the iteration form; optional
`domain`). Body: `# <iteration title>` → `## Cheatsheet` (≤6 conclusions,
team language — the reader's primary entry) → optional `## Quick view`
(diagrams/tables restate prose) → `---` → sections:

```md
### 01. <title>
**Status**: 🟡 proposed
**Background**: <situation + pain>
**Decision**: <what was decided>
**Rationale**: <bulleted, bold-keyword led>
**Rejected**:
- <option>: <why rejected>
**Impact**:
- <layer or area>: <what changes>
```

Canonical section IDs derive from the container namespace
(`ADR-<container>#NN`, e.g. `ADR-0.2.54#01` or `ADR-0042#01`) and are never spelled out in headings.

## Frontmatter semantics:
- `Proposed` — under discussion, not yet binding.
- `Accepted` — the current binding decision.
- `Rejected` — decided against; keep it as a negative record so the idea is not raised again unknowingly.
- `Deprecated` — no longer applies but not replaced by another ADR.
- `Superseded by NNNN` — fully replaced; the successor ADR **MUST** cross-reference back.
- An Accepted ADR is immutable: only its frontmatter `status` may change. Any change to the decision itself **MUST** be a new superseding ADR.

## If the guard blocks your commit

The block message names the missing ADR requirement. Fix it properly: create
the ADR (or the superseding pair), stage it, re-run the commit. You **MUST NOT**
bypass the guard by relabeling the commit type (e.g. calling a feat a chore)
— that corrupts the changelog.

Known ceiling (strict gate): `git commit -F msg.txt` carries no inline `-m`
message, so the positive feat/fix/refactor decision check cannot see its type
and the commit passes that check — the undecided-flip audit still holds on
every commit regardless of message form.

