---
name: adr-protocol
description: |
  ADR (Architecture Decision Record) protocol for the OCP adr-guard engine —
  iron law, governance modes, hierarchical model, slash commands, project-level
  overrides, natural-language triggers, commit checklist, per-style output
  protocol (madr / nygard / ocp), prose language rule, frontmatter semantics,
  guard-block handling. Load ONLY when the user signals an ADR intent: writing
  / superseding / checking decisions, asking about commit rules, governance,
  the iron law, or /adr config; or when an ADR-related file under docs/adr/
  is being scaffolded / drafted. NEVER force-load on ordinary chats — the
  protocol body is ~5 KB and stays out of the system prompt by design
  (Phase 7.8). The system hint always advertises `/adr config` and points
  at this skill, so the agent knows where to find the body.
---

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

The commit gate remains deliberately narrow: it mechanically enforces only
`feat` and `refactor`. Commit type is a signal for ADR review, never proof of
an iteration boundary or an excuse to omit an architectural decision.

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
- `/adr config [key] [value]` — Read or set a single project-level ADR config key (see §7). Keys: `style`, `numbering`, `layout`, `governance`, `filenamePattern`, `slugStyle`, `extraSections`, `indexColumns`. Use `/adr config reset <key>` to revert one key to its default.
- `/adr-guard on|off|status` — Toggles the hard commit guard.

## §7. Project-level overrides (Phase 7)

This project's `.ocp/ocp.json` may carry an `adr.*` block with eight
keys. The system prompt always carries the LIVE values as a small
table — **honor those values** when scaffolding, naming, and indexing.
Do not invent your own filename pattern or default style.

The keys fall into two groups that share the same storage and the
same `/adr config` command:

### §7.1 Suite fields (same block as `/adr init`)

| Key | Allowed | Default | Effect |
| :--- | :--- | :--- | :--- |
| `adr.style` | `nygard` \| `madr` \| `ocp` | `madr` | Default style for new records (file declares its own style; `--style` on `/adr new` overrides). |
| `adr.numbering` | `sequential` \| `iteration` | `sequential` | ID allocator. `iteration` requires `--baseline/--iteration` per `/adr new`. |
| `adr.layout` | `auto` \| `flat` \| `hierarchical` | (inherit from legacy `adrLayout`) | Directory layout mode. |
| `adr.governance` | `none` \| `review` \| `strict` | `none` | Lifecycle strictness. `strict` enables the proposed→accepted gate. |

### §7.2 Phase 7 overrides (file naming, slug, body, index)

| Key | Allowed | Default | Effect |
| :--- | :--- | :--- | :--- |
| `adr.filenamePattern` | string with `{id}` (required) and optional `{slug}` | `{id}-{slug}` | Filename template; `.md` appended automatically. `{id}` is the bare ID (`0001`, `0.2.54`) per style. `{slug}` is sanitized for `/\\:*?"<>\|`. |
| `adr.slugStyle` | `kebab` \| `snake` \| `lower` | `kebab` | Slug transform: `kebab` = `event-bus-streaming`; `snake` = `event_bus_streaming`; `lower` = `eventbusstreaming`. |
| `adr.extraSections` | array of `## <Heading>` strings | `[]` | Extra H2 sections appended to nygard/madr scaffolds after the style's last canonical section. **OCP containers deliberately opt out** — append sections via `/adr section`. |
| `adr.indexColumns` | subset of `id, title, style, layer, status, domain, iteration, created` | all 8 | Project the generated `INDEX.md` table to these columns; cells for dropped columns render empty. Order preserved. |

### §7.3 Quick examples

```text
# Project wants ADR-NNNN-slug.md with snake slug:
/adr config filenamePattern "ADR-{id}-{slug}"
/adr config slugStyle snake

# Project wants a Risks section on every MADR scaffold:
/adr config extraSections "## Risks"

# Project wants a narrow INDEX.md (no style column):
/adr config indexColumns id,title,status,created

# Revert a single key:
/adr config reset filenamePattern
```

Invalid values are silently rejected with a warning — the in-code
default stays in place. Re-running with the same value is a no-op
(byte-stable).

## §8. Natural-language triggers (no slash command needed)

When the user types a sentence instead of a slash command, infer the
intent and run the matching slash command. Common phrasings:

| User says | Route to |
| :--- | :--- |
| "写个 ADR / record a decision / document this choice" | `/adr new <title>` |
| "记录一下我们用 Postgres" / "note that we're switching to X" | `/adr new <title>` |
| "建一个决策记录" / "给这个方案建个 ADR" | `/adr new <title>` |
| "supersede ADR-0007 with the new approach" | `/adr supersede 0007 <new-title>` |
| "查看所有 ADR" / "show me the decision tree" | `/adr tree` |
| "ADR 校验 / validate ADRs / run integrity check" | `/adr check` |
| "ADR-0005 的历史 / supersession chain of ADR-0005" | `/adr history 0005` |
| "看一下跟 ADR-0007 相关的所有决策 / context bundle" | `/adr context 0007` |
| "把 ADR 目录打开严格治理 / turn on strict governance" | `/adr config governance strict` |
| "我们的 ADR 用什么格式" / "what's our ADR config" | `/adr config` |
| "开启 / 关闭 提交闸门 / enable / disable commit gate" | `/adr-guard on\|off` |
| "把 ADR 文件名加 ADR- 前缀" | `/adr config filenamePattern "ADR-{id}-{slug}"` |
| "再加一个 Risks section 到所有 MADR" | `/adr config extraSections "## Risks"` |

**Inference rules**:

1. The verb is the disambiguator. "记录 / record / document / 写" → `new`. "替换 / 取代 / supersede" → `supersede`. "看 / show / 查" → `tree|history|context`.
2. When in doubt between `new` and `supersede`, ask: "Does an existing ADR cover the same topic?" If yes (and the user names it), use `supersede`; otherwise `new`.
3. After scaffolding, the engine leaves a placeholder file. Draft the body per the style's output protocol (§3 below). Do NOT rewrite the scaffold as prose.
4. For `/adr config` style requests, prefer the single-key form `/adr config <key> <value>` over the bulk `/adr init` path — it's idempotent and reversible.

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

## ocp iteration boundary (style: ocp)

An OCP container represents one bounded delivery iteration: normally a release
version or a coherent feature/refactor batch. A commit is NOT an iteration:
one container may cover multiple commits, while a large feature may span
multiple containers.

- **Start a new iteration container** for a new release/version or an
  independently deliverable architectural batch.
- **Append a section to the current container** when the decision belongs to
  the same delivery scope and release boundary.
- `feat` and `refactor` are the default high-confidence signals that a new or
  changed ADR is needed. `perf` and security work are equally strong signals
  when they alter a long-lived architecture (for example caching, concurrency,
  data layout, authentication, authorization, audit, or isolation).
- Evaluate `fix`, `build`, and `ci` for ADR coverage when they alter a data,
  compatibility, reliability, release, deployment, or security boundary.
  Ordinary fixes, build repairs, and pipeline maintenance do not create an
  iteration merely because of their Conventional Commit type.
- `docs`, `test`, `chore`, `style`, and `revert` normally do not create an
  iteration. Treat them as exceptions only when the change itself establishes,
  revises, or rolls back a durable architectural contract.
- Never invent `baseline` or `iteration` values. Derive them from the project
  release/version plan or existing containers; if neither is authoritative,
  ask the user before creating the container.

## Slash Command & Natural Language Auto-Drafting Protocol
When `/adr`, `/adr new`, `/adr supersede`, or a natural language ADR request is received:
1. **Scaffold Discovery**: The local TypeScript engine has already created the new `docs/adr/NNNN-slug.md` file (and updated `INDEX.md`). Find the latest ADR file in `docs/adr/` (or target layer directory). The ocp scaffold (`plugins/adr-guard/styles/ocp.ts`) emits the structured placeholders — fill the structure, do not rewrite it as a prose essay.
2. **Context Research**: Use tools (`read_file`, `grep_search`, `find_by_name`) to research the workspace context, current technical architecture, dependencies, and requirements.
3. **Write the record** per the chosen style, **following the OCP output protocol** at `docs/adr/README.md` §OCP output protocol. The rules are the same for every style:
   - For `ocp`: numbered Cheatsheet (1–6, ≤ 60 chars each, ADR ref suffix) → mermaid `flowchart LR` + table Quick view (`≤ 2` figures) → sections with `**Background**` (≤ 3 sentences) → `**Decision**` as `| # | Point | Content |` table → `**Rationale**` ≥ 2 bullets, bold-keyword led → `**Rejected**` as `| Option | Reason rejected |` table → `**Impact**` layered bullets (Plugins / Runtime / Dispatcher / Installer / Tests / Docs) → optional `**Future extensions**`.
   - For `madr`: `## Context and Problem Statement` → `## Decision Drivers` (bullet list) → `## Considered Options` (each option carries `**Pros**` / `**Cons**` as a sub-list) → `## Decision Outcome` (lead-in `Chosen option: …, because …`) → `### Consequences` (`**Positive**` / `**Negative / Risks**`, bullets ≤ ~80 chars).
   - For `nygard`: `## Context` / `## Decision` / `## Consequences` — short narrative, paragraphs ≤ 4 lines, bullets ≤ ~80 chars.
   - Preserve valid YAML frontmatter (`style`, `status`, `created`, `date`,
     `baseline`, `iteration`, `domain`, `parent`, `supersedes`, `superseded_by`).
   - Language: draft ALL prose in the team's working language per the
     Prose language rule (ADR-0.40.0#02) — English only where grammar requires
     (canonical section headings, ocp field labels, status word, MADR `Chosen
     option …, because …` lead-in, frontmatter keys/enum, ID/numbering).
4. **Respond to User**: Provide a crisp walkthrough and summary of the decision record drafted, calling out which OCP output protocol rules the record conforms to (cheatsheet item count, table-based Decision/Rejected, mermaid figures ≤ 2, …).

## Prose language rule (every style) — ADR-0.40.0#02

Grammar labels and section headings are a single English authority across
all styles. EVERYTHING else is prose and MUST be drafted in the team's
working language. The working language is derived from the language
environment: a project-level declaration (pinned at init/config) wins;
otherwise the language of the conversation/request at drafting time
decides (a Chinese session drafts Chinese prose, an English session
drafts English prose):

- In the working language: H1 title, ocp section titles
  (`### 01. <title>`), all body prose (background / decision / rationale /
  rejected reasons / impact content), Cheatsheet conclusion lines, Mermaid
  node labels, and MADR Consequences bullet content.
- The ocp status word after the emoji is NOT prose: it is a fixed protocol
  token echoing the frontmatter enum — always `✅ accepted`, `🟡 proposed`,
  `🔄 superseded`, `⛔ deprecated`, never localized. The emoji carries the
  semantics; the word keeps one vocabulary per concept and stays greppable
  across every language tree.
- English grammar, never translated: canonical section headings
  (`## Context`, `## Decision Outcome`, `## Considered Options`, …), ocp
  field labels (`**Status**:`, `**Rejected**:`, …), MADR Consequences
  labels (`**Positive**` / `**Negative / Risks**`), the MADR lead-in
  `Chosen option: …, because …`, frontmatter keys AND enum values
  (`status: accepted`), ID/numbering formats (`0001.`, `### 01.`,
  `ADR-0.2.54#01`), the numeric filename prefix + ASCII slug, and the ocp
  container's fixed scaffold headings (`## Cheatsheet` / `## Quick view`).
- ocp `**Rejected**` bullets split option from reason on an ASCII colon
  (`- <option>: <reason>`); full-width colons do not split.
- ocp containers: the Cheatsheet is the reader's primary entry — pure
  conclusions in the team's working language.
- one-time glossary: optionally keep a single label mapping in the ADL
  root README so first-time readers decode the field labels once.
- per-label parentheticals are NOT recommended (repetition that drifts
  across files). Parsers tolerate and ignore them anyway — never let a
  parenthetical replace the English label.



## Before you commit — checklist

1. For feat/refactor the answer to "did this change make or alter a
   decision?" is treated as **YES by default**. Apply the same review to
   architectural `perf` and security work, and assess `fix`/`build`/`ci` when
   they change a durable boundary — architecture shape, tech choice,
   integration pattern, data or release behavior, deliberate deviation, or a
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

# NNNN. <short title of the decision — in the working language>

## Context and Problem Statement

<the situation, architectural context, and the decision to be made — in the working language>

## Decision Outcome

Chosen option: <the chosen option>, because <rationales and trade-offs>. (Prose — in the working language.)
```

## ocp container skeleton (style: ocp)

Frontmatter: `style/status/created/date` (+ `baseline/iteration` on the iteration form; optional
`domain`). Body: `# <iteration title>` → `## Cheatsheet` (≤ 6 numbered conclusions,
each ≤ 60 chars, ADR ref suffix, team language — the reader's primary entry)
→ `## Quick view` (diagrams/tables restate prose; mermaid `flowchart LR`
preferred; ≤ 2 figures; tables fill the rest) → `---` → sections. **The
scaffold from `plugins/adr-guard/styles/ocp.ts` emits the structured
placeholders below; fill them, do not rewrite them as a prose essay.**
Full rules: `docs/adr/README.md` §OCP output protocol.

```md
### 01. <section title — working language>
**Status**: 🟡 proposed
**Background**: <situation + pain, ≤ 3 sentences — working language>
**Decision**:
| # | Point | Content |
| --- | --- | --- |
| 1 | <point> | <what was decided — working language> |
| 2 | <point> | <what was decided — working language> |
**Rationale**:
- **<keyword>**: <single-line justification — working language>
- **<keyword>**: <single-line justification — working language>
**Rejected**:
| Option | Reason rejected |
| --- | --- |
| <option> | <why rejected — working language> |
| <option> | <why rejected — working language> |
**Impact**:
- **<Plugins / Runtime / Dispatcher / Installer / Tests / Docs>**: <what changes — working language>
- **<layer>**: <what changes — working language>
**Future extensions**: <optional — delete the line when none>
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
