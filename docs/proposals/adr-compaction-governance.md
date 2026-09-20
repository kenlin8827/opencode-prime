# Proposed decision: reviewed ADR maintenance and bounded evidence

Status: **Proposed — not accepted and not an authoritative ADR**.

Date: 2026-09-19. Identity: intentionally unallocated. The project uses OCP iteration namespaces; no next baseline/iteration has been approved for this change. This proposal must be assigned to an approved container/section through normal governance, not by guessing a release number. Implementation of the approved feature plan does not auto-accept this architectural proposal.

## Context

An append-only decision log preserves rationale but can impose repeated model/human reading costs. File movement, semantic consolidation, derived current views, decision acceptance and access policy have different authority and failure modes. Treating them as one file-rewrite operation risks silent constraint loss or accidental acceptance.

## Proposed decision

| Responsibility | Mechanism |
| --- | --- |
| Ordinary evidence | Native bounded `adr_context`; shared user-command service; source-bound pagination |
| Maintenance request | Read-only analysis by default; explicit drafting mode and native cost acknowledgment |
| Semantic publication | Complete candidates and unit coverage; reviewed CURRENT, provenance and index bytes |
| Authority | Native session/call/request-bound Question response; audited acceptance service; explicit manual recovery fallback |
| Lifecycle | Preserve source substance/IDs; accept successors before retiring fully covered predecessors; reciprocal N-to-M lineage |
| Derived state | Per-root views; whole-corpus membership/content fingerprints; no automatic model refresh |
| File movement | Separately journaled and explicitly authorized archive/restore; preserve decision status during inverse moves |
| Read policy | Independent off/warn/guard; finite supported adapters, never advertised as a sandbox |

Use the existing style adapters, project OCP path contract, plugin scope policy and acceptance/ledger helpers rather than create a competing governance system. Keep workflow instructions in L2 skills. Preserve normal `/adr decide`, commit checks and whole-log numbering.

## Rationale

- **Authority is explicit:** drafting permission, decision acceptance and file relocation are distinct.
- **History remains discoverable:** archival changes placement, not identity or binding status.
- **Failures are inspectable:** optimistic before/after journals avoid overwriting unrelated edits and expose partial progress.
- **Costs are measured:** bounded task context can be cheaper, while initial maintenance and transcript replay can be expensive.
- **Claims match runtime evidence:** native Ask and read cancellation are tested against real OpenCode, not inferred from unit mocks.

## Rejected alternatives

| Alternative | Reason |
| --- | --- |
| Replace the whole log with a summary | Loses original rationale, identity and auditability |
| Automatically supersede because a file is old or a summary exists | Confuses inference with accepted governance |
| Require individual manual acceptance commands for every replacement | Adds unnecessary friction when one native Ask can authorize an exact reviewed batch |
| Regex shell guard as a security boundary | Cannot cover arbitrary scripts, Git or MCP |
| Always inject CURRENT or the complete ADR corpus | Permanent repeated token cost and stale-authority risk |
| Regenerate semantic summaries on every edit | Unapproved model cost and unreviewed semantic changes |

## Consequences and review questions

The implementation maintains local state and recoverable journals; operators must inspect stale locks and editor conflicts. Human review remains necessary for semantic faithfulness. Large maintenance jobs still require provider context/output planning; per-response bounds are not total-cost bounds. Native approval is tied to the runtime's trusted Question event channel, not cryptographic isolation from arbitrary local process access.

Before acceptance, review the [approved plan](../plans/adr-compaction.md), [user workflow](../workflows/adr-compaction.md) and [verification/limitations](../maintenance/adr-compaction-verification.md). No existing repository ADR has been accepted, superseded, moved or renumbered by this implementation exercise.
