---
name: adr-compaction
description: |
  Draft or review a user-started ADR compaction plan, consolidate multiple
  decisions, publish CURRENT, or archive/restore retired records. Use only
  for /adr compaction intent; ordinary architectural tasks use adr_context.
---

# ADR compaction

The command supplies a plan ID. Do not create plans or accept decisions by
editing files or calling shell/API workarounds. All maintenance goes through
`adr_compaction`; user approval is a native `question` reply verified by the plugin.

## Draft

1. First call action `ask` and present the native scope/cost question. Only its
   trusted reply authorizes source ingestion; it does not accept decisions.
   Then call `adr_compaction` action `evidence` with the plan ID. Follow every `next`
   cursor until coverage is complete. This explicit maintenance task may inspect
   all its evidence, but never recursively read the archive. Referenced system
   constraints are evidence, not permission to replace records outside the scope.
2. For consolidation, get reserved ID/scaffold pages with action `slots`.
   Retain independent, clear records. Group related decisions; do not force all
   inputs into one file. Never invent a baseline, iteration, or new ID.
3. Preserve current meaning. Distinguish pure reorganization, ambiguity, and
   deliberate changes/retirements. Keep necessary rationale, risks, and rejected
   alternatives; historical implementation details may remain in linked sources.
4. Build `candidate` data (one direct `submit` for small plans):
   - `summary`: `{text, sources: [canonical ID or section ID]}` items covering
     every live decision unit, including unaffected records. Separate proposals
     from accepted constraints; show conflicts, never resolve them by recency.
   - `replacements`: `{id, title, content}` using reserved IDs, selected style,
     explicit proposed frontmatter, and proposed OCP sections. Do not populate
     supersedes/superseded_by: the engine derives them from reviewed coverage.
   - `coverage`: one `{source, disposition, targets, note}` per source decision
     unit. Disposition is retain, replace, historical, or unresolved. Only replace
     may name target replacement IDs. Notes explain scope/meaning changes.
   A partly covered source remains live; retain it rather than retire it partially.
   For large plans, `stage` named `batch` subsets (each parsed candidate at most
   12,000 Unicode codepoints). Include all three arrays; empty arrays are allowed.
   A stable key replaces that whole batch on retry, never appends. Do not repeat
   coverage sources/replacement IDs in other batches. `batches` pages saved data;
   follow `next` and reassemble split entries before editing. Finish with `submit`
   **without candidate** to assemble every batch and run full coverage validation.
   Changing a batch invalidates the old review/Ask; explicit full `submit` replaces
   all saved batches. One replacement must fit one batch, or use full submission.
   Batching avoids one enormous final call, not total context/replay costs.
5. Summarize the proposed changes for the user. Full artifacts are in the returned
   review path and action `review` pages. Do not claim structural validation proves
   semantic faithfulness. Inform the user of external-link risks when moving files.

## Ask and execution

`submit` or `ask` returns exact arguments for the native `question` tool. Present
those questions unchanged after review. Choices: accept and execute, drafts only,
request changes, cancel (summary uses publish/modify/cancel). The plugin, not the
model, applies the matching user reply. Never synthesize a confirmed flag or
invoke the manual confirmation command on the user's behalf.

Changes require resubmission and a fresh Ask. Timeout/rejection is not consent.
A reply may fail freshness checks: report the actual receipt, never claim success
from the user's choice alone. Use `status` after interrupted execution. Manual
`/adr compaction --confirm <plan-id>` is a user fallback/recovery entry only.

Do not automatically rerun consolidation after ordinary ADR edits. CURRENT can
be stale; bounded source retrieval remains valid while explicit refresh is pending.
