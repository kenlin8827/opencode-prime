# ADR compaction and controlled retrieval

ADR compaction reduces repeated reading without deleting decision history. It is separate from the existing commit guard. **An accepted ADR remains authoritative until an explicitly accepted successor replaces it.** CURRENT is a reviewed, derived view—not a new decision or proof that the code conforms.

## Everyday workflow

```text
/adr compaction
/adr compaction --mode summary
/adr compaction --mode consolidate --sources ADR-0001,ADR-0002
/adr compaction --mode consolidate --domain runtime --archive
```

The first command is local, read-only analysis: no model calls, files, or decisions are created. `--dry-run` has the same property even with a mode. Analysis is structural; it cannot establish semantic equivalence.

An explicit drafting mode proceeds through:

1. **Scope/cost Ask.** Displays source count, characters and a rough characters/4 token estimate. Authorizes evidence ingestion and drafting only. The small dialog itself uses model turns; subsequent evidence, output, tool definitions, transcript replay and review cost extra. No provider price or spending ceiling is inferred.
2. **Bounded evidence and candidates.** The agent retrieves full evidence in pages, reserves IDs, preserves independent records, and builds a per-decision coverage matrix. Selecting sources limits replacement targets; a complete CURRENT still requires evidence for unaffected current records.
3. **Review.** Inspect complete proposed ADRs, preserved/changed constraints, reciprocal lineage, CURRENT, provenance, deterministic indexes and any moves/link repairs. A local review artifact and paginated review tool expose the full changes.
4. **Native Ask.** Choose accept and execute, save proposed drafts only, request changes, or cancel. Summary mode instead offers publish summary / request changes / cancel. One acceptance applies the exact reviewed plan; no per-record `/adr decide` or second confirmation is required.

Publication/move blockers remove the execution choice while preserving inspection and proposed-draft saving. Draft-only does not publish indexes or CURRENT.

A rejected/closed/expired question is not approval. A changed source, membership, configuration, output path or plan requires renewed review. Questions are bound to session, native call/request, revision and hashes; a model-supplied approval flag is not accepted. The approval window is 30 minutes.

Consolidation supports N-to-M successors, not only N-to-one. Useful records can remain unchanged. Each source unit must be covered; a partially replaced OCP container remains live. Proposed sections cannot be implicitly accepted by retiring their container. Structural coverage is necessary, but **humans still judge semantic preservation and deliberate changes**.

## Large drafts: incremental candidate batches

Agents can use `adr_compaction` action `stage` with a stable `batch` key and a
`candidate` subset containing `summary`, `replacements`, and `coverage` arrays
(empty arrays allowed). Each parsed payload is at most 12,000 Unicode codepoints.
Retrying a key replaces its entire batch; it does not append duplicates. Source
coverage rows and replacement IDs must be unique across batches. Action `batches`
retrieves saved drafts in bounded pages, including continuation for split entries.

After reading all required evidence and saving all batches, `submit` **without a
candidate** assembles them and runs the same full validation as direct submission.
Only then can review and native Ask authorize execution. Changed batches invalidate
the previous seal/Ask; identical retries do not. A full explicit `submit` replaces
saved batches. Staging writes local draft state only, not ADRs, CURRENT, or indexes.

This avoids requiring a whole large plan in one final model output. It does **not**
remove evidence/context replay costs, guarantee semantic synthesis, or chunk an
individual replacement body: one replacement must fit one batch, or be sent in a
full submission. For a body beyond the provider's output limit, reduce the scope
without losing constraints; do not silently truncate it.

## Numbering and configuration

Replacements use the chosen/project style (`ocp`, `madr`, `nygard`) and project-wide identities, including archived IDs. Use `--style` only with consolidation. Sequential IDs are allocated without reuse. Iteration numbering requires **explicit approved** `--baseline` and `--iteration`; the tool does not invent the next release namespace. An OCP iteration container occupies its namespace and cannot silently collide with another container or per-decision records.

`--domain` and `--sources` are mutually exclusive. Summary rejects archive/style/numbering options. Unknown or conflicting flags fail. A custom filename pattern must remain discoverable by the existing numeric-prefix ADR grammar; otherwise compaction refuses the candidate rather than losing it from discovery.

## Task retrieval

```text
/adr context
/adr context ADR-0002
/adr context ADR-0.40.0#01 --history
/adr context --domain runtime
/adr context --iteration 0.40.0
/adr check --compaction
```

Agents use native `adr_context` with `id`, `domain`, or `iteration`, optional `intent: current|rationale|history`, and a continuation `cursor`. Do not ask an agent to simulate user slash-command approval.

- A fresh CURRENT serves concise decision intent; stale/missing/invalid views fall back to bounded source evidence or navigation. Source membership and content hashes are checked at read time, including ordinary/manual additions, deletion, status/section edits, migration and relocation. No automatic paid refresh occurs.
- System constraints are included. A current query for a superseded ID prefers an unambiguous accepted successor. Historical links are lookup opportunities, not recursive-reading instructions.
- Responses contain at most **8 entries / 12,000 Unicode codepoints**, including JSON metadata. Excerpts are at most 1,600 codepoints; general relation expansion is at most 3 hops and archive-body expansion at most 1 archive hop per request.
- `coverage: incomplete` and `next` must not be ignored when required constraints remain missing. Cursors are query/source-bound and invalidate after changes. Repeated evidence generates a warning, not a universal session-wide token ceiling.
- Working subagents and Lite can retrieve evidence. Maintenance drafting retains the main ADR plugin scope; utility contexts are excluded.

## Reading policy

```text
/adr config readGuard off
/adr config readGuard warn
/adr config readGuard guard
```

Default is **off**, independent of governance and `/adr guard`. `warn` gives deduplicated guidance. `guard` rejects supported direct archive reads, stale CURRENT reads, oversized ADR reads, root-wide ADR body searches and recognized bulk/archive shell commands before content output. Targeted live reads and filename discovery remain available. Existing-file symlinks are resolved for matching; maintenance writes refuse symlink paths and root escape.

This is a context-efficiency aid, **not a security sandbox**. The verified native cancellation path is `read` (verified on OpenCode 1.18.15; the v2 2.0.x line exposes the same tool name, runtime re-verification against v2 is pending in the integration-test phase). Adapters also recognize `read_file`, `grep`, and a finite set of obvious `bash`/`shell` shapes. Arbitrary scripts, shell obfuscation, Git history, MCP, unintegrated tools and cumulative native-reader budgets are **not universally enforced**. Do not route around a block; use targeted `adr_context` history retrieval.

Invalid policy configuration warns and retains the last known mode in the running guard. A fresh process without a valid policy starts off and reports degradation. This does not create a deny-all policy. Compaction never enables the guard silently.

## Files, archive and recovery

```text
<adr-root>/CURRENT.md
<adr-root>/CURRENT.sources.json
<adr-root>/INDEX.md
<adr-root>/archive/<original-filename>.md
<ocp-state>/adr-compaction/<plan-id>.review.md
```

Canonical sources, CURRENT pairs and indexes belong in version control. Plans, receipts, locks and journals are local ignored state. `<ocp-state>` is `.ocp` by default and honors the project-relative `OCP_PROJECT_DIR` contract. Custom/module ADR roots get CURRENT pairs and cross-root navigation. Global retrieval retains project-wide coverage.

```text
/adr compaction archive --sources ADR-0001
/adr compaction archive restore cp-0123456789abcdef
/adr compaction status
/adr compaction status cp-0123456789abcdef
/adr compaction --confirm cp-0123456789abcdef
```

Archive/restore first prepare a reviewed native Ask. Only wholly retired records with valid applicable lineage are eligible. IDs and decision substance are preserved; relative links and translation pointers can receive visible mechanical repairs. External links cannot be guaranteed repaired. Restore reverses location/link changes, **not decision acceptance**. Fresh existing summaries can be mechanically republished after reviewed relocation; stale ones are not silently blessed.

Acceptance/audit, views/indexes, archive and post-move views use separate journals. Accepted successors are written before predecessor retirement. An interrupted step resumes only from original or planned bytes; unrelated edits, new ADRs and configuration changes stop recovery. `status` exposes state, journal completion and receipt. Pending transactions, including approved-plan gaps before/between journals, prevent context from pretending publication is complete and block new plan creation/execution.

`--confirm` is an explicit **user** fallback/recovery action for an already reviewed plan. It can accept the listed decisions, not merely save files. Recovery preserves the original actor/choice. It cannot change mode, sources or archive scope. A restart does not restore an in-memory Ask; request a fresh Ask or use this explicit fallback.

Never automatically delete a lock: inspect its PID/owner and remove it only after confirming the writer stopped. Resolve editor conflicts without resetting the worktree. Do not delete accepted successors to “roll back” a failed file move; use ordinary successor governance for decision reversal.

## Verification and cost evidence

See [verification and benchmark results](../maintenance/adr-compaction-verification.md) and, for install/release steps and remaining platform limits, [delivery status](../maintenance/adr-compaction-delivery.md). The reproducible native suite uses a deterministic local model, no paid provider calls, and verifies batched drafting, all four approval outcomes, supported read cancellation, actual process-death recovery, and separately approved archive restoration. A 14-boundary process-death matrix and isolated package/hash checks complement it. Synthetic token measurements distinguish initial drafting from warm retrieval and compare against the existing context-plus-targeted-source baseline. They are not semantic-quality scores or promised savings.
