# ADR Compaction and Controlled Retrieval — Implementation Plan

Status: approved implementation baseline; see [verification](../maintenance/adr-compaction-verification.md) for delivered coverage and limits. Revision: 3. Date: 2026-09-19.

## 1. Decisions and boundaries

Preserve the decision log while reducing the evidence entering model context. Separate five responsibilities:

| Capability | Responsibility |
| --- | --- |
| Context retrieval | Select bounded evidence for the current task |
| Summary | Maintain a derived view of current decision intent |
| Consolidation | Draft complete replacement ADRs for explicit human acceptance |
| Archival | Relocate wholly retired records without losing history |
| Read guard | Restrict supported unscoped reading paths, independently of compaction |

**Default compaction analyzes all unarchived canonical ADRs; it does not call a model, rewrite records, accept decisions, or move files.** An explicit mode starts drafting. Inspecting the whole collection does not mean rewriting every record. A source set of N records may yield M replacements, unchanged records, and unresolved items; do not force unrelated decisions into one large document.

Consolidation includes a reviewed CURRENT candidate and deterministic index refresh. Summary freshness is maintained across ALL decision changes, not just compaction. Archival is separately recoverable and never determines whether a decision is binding. Running compaction never changes the read-guard configuration.

Non-goals: deleting history; renumbering IDs; silently resolving conflicts or changing accepted substance in place; declaring actual code conformance from ADRs; permanent summary injection; a new model provider/vector database; age-based archival; or guaranteed isolation from arbitrary shell/MCP/Git access.

## 2. Existing implementation and integration risks

- `adr-views.ts` already bounds some related records/hops. Direct matches and the total response have no common hard output budget; rendered context mostly contains titles/status/path/relations rather than decision substance.
- Iteration context uses `adr-evolution.ts`; ID/domain context uses another route. Share the new evidence/budget service without losing iteration semantics.
- `adr-tool-guard.ts` enforces commit rules, not read access. Keep those gates intact and implement reading policy separately.
- `adr.ts` has hooks/commands but no ADR retrieval tool. Use the native plugin tool API, not an assumption that agents can invoke user slash commands.
- Flat/hierarchical discovery differs. Archived IDs and relations must remain discoverable in both modes; generated files and localized mirrors must stay excluded as canonical sources.
- OCP section references currently fall back to containers; section relations are annotation-grade, not an authoritative replacement graph. Precise excerpt lookup must not silently change this model.
- Verify actual tool argument shapes, before-hook cancellation, hook order, user-command and native-question response provenance, agent scope, and session/subagent behavior in P0. Do not claim authorization or guard coverage before that verification.

## 3. Storage, sources, and publication

```text
docs/adr/
  README.md
  INDEX.md                     # whole-log navigation, including archived history
  CURRENT.md                   # derived current-decision view
  CURRENT.sources.json         # provenance, coverage, freshness
  <original ADRs>.md
  archive/                     # optional; created only by confirmed archival
    INDEX.md
    <original ADRs>.md
  zh/                          # existing reader mirrors, not canonical records
```

Support custom and module ADR roots. The root links to module views rather than duplicating all module content; retrieval includes applicable system constraints. Start with one CURRENT pair per participating root, not a speculative domain-directory hierarchy. Refuse collisions with user-owned files.

CURRENT contains effective constraints, necessary rationale/risks, separate proposals/conflicts, coverage, source references, and a derived-view disclaimer. It neither creates decisions nor proves implementation conformance. A replacement ADR must independently support ordinary work; historical implementation detail and obsolete comparisons remain in linked originals instead of being copied wholesale.

The versioned JSON manifest records schema/generator contract version, selection rules, source IDs/paths/section locators/hashes, scope membership, per-unit coverage, and summary hash. Membership must detect newly added or deleted relevant records. Indexes are deterministic navigation; CURRENT prose is reviewed semantic content. Neither participates in ADR numbering or satisfies an original-ADR requirement merely by being generated.

Persist published ADRs, CURRENT, manifests, and indexes in version control. Candidates, plan fingerprints, bounded-read receipts, and recovery journals live under ignored `.ocp/`. Every replacement reserves a collision-checked identity in its plan; concurrent allocation invalidates that plan rather than silently renumbering reviewed references.

## 4. Source selection and lifecycle invariants

- Default scope: all unarchived canonical records across participating project roots; exclude mirrors, generated views, and temporary drafts. The preview discloses exact roots and counts.
- For explicit drafting modes, every selected source body is inspected in bounded batches. Track source-unit coverage; cross-batch review checks shared constraints and conflicts. Cached analysis may be reused only for unchanged evidence with adequate provenance.
- Classify each selected record as retain unchanged, summarize, consolidate, open/unresolved, or archival candidate. Preserve independently useful records. Ordinary task retrieval is selective, unlike an explicitly scoped maintenance job.
- Archive bodies are not implicitly included. Read them only to resolve a concrete dependency, rationale gap, or conflict; disclose that evidence in the plan. Referenced system constraints are evidence, not implicit replacement targets.
- Accepted records are candidate constraints. Proposals remain proposals; rejected/deprecated/superseded records are historical evidence. Unknown status, ambiguous IDs, cycles, broken references, or contradictions remain explicit issues.
- A proposed successor cannot retire an accepted predecessor. Whole-record retirement requires every source decision unit to be accounted for. A partly live OCP container remains live; annotation relations alone cannot authorize retirement.
- Map each consolidated unit to retained/new-location, deliberately changed/new-rationale, deliberately retired/reason, or unresolved. Citations alone do not prove semantic coverage. Unresolved units prevent whole-record retirement.
- Preserve old IDs, substance, ancestry, and reciprocal many-to-one replacement references. Prose/links may receive explicit mechanical relocation edits; never pretend a move preserves every byte if relative links change.

## 5. Approved command contract

### 5.1 Core interface

```text
/adr compaction
/adr compaction --dry-run
/adr compaction --mode summary [--domain <slug> | --sources <id1,id2,...>]
/adr compaction --mode consolidate [--domain <slug> | --sources <id1,id2,...>] [--archive]
/adr compaction --confirm <plan-id>
/adr compaction status [<plan-id>]
/adr compaction --help
```

| Flag | Meaning |
| --- | --- |
| `--mode summary\|consolidate` | Explicitly request AI drafting; no mode means read-only analysis |
| `--domain <slug>` | Select that domain; applicable global evidence remains discoverable |
| `--sources <ids>` | Select exact unarchived canonical records; ambiguous/missing/archived IDs are errors |
| `--dry-run` | Analyze the specified scope/mode without model calls or writes; also the default without a mode |
| `--archive` | Include a separate archive-on-accept plan, only with consolidation; never move immediately |
| `--style ocp\|madr\|nygard` | Replacement style; consolidation only; defaults to project configuration |
| `--baseline <version>` | Target numbering baseline, when required by the project |
| `--iteration <id>` | Target numbering iteration, NOT an input-record filter |
| `--confirm <plan-id>` | Fallback/recovery entry for the exact reviewed plan; default approval uses native Ask |
| `--help` | Show contract and examples |

`--domain` and `--sources` are mutually exclusive. Summary rejects archive/style/numbering flags. Confirm rejects all scope/mode/numbering/archive changes and dry-run; generate a new plan instead. An archive flag before P4 is delivered must error rather than be ignored. Reject unknown flags. Never invent a baseline/iteration; ask if no authoritative delivery plan/configuration supplies one. An iteration OCP container cannot silently share an already occupied namespace: preview the actual number of output records and resolve allocation before review.

Drafting modes show the scope, read volume, and available cost estimate before starting; obtain confirmation for the maintenance read/cost scope. Model work creates candidates only. Dry-run makes no semantic-quality promise: mechanical analysis cannot discover every duplicate or conflict.

Related interfaces:

```text
/adr context [<ADR-ID> | --domain <slug> | --iteration <id>] [--history]
/adr check --compaction
/adr config readGuard off|warn|guard
/adr compaction archive [--sources <ids>]                  # P4: standalone move preview
/adr compaction archive restore <completed-plan-id>       # P4: inverse-move preview
```

Use the same native Ask and application service for independently reviewed archive/restore plans, with `--confirm <plan-id>` as the fallback/recovery entry. No `--all` (already implicit), `--force`, `--delete-history`, `--include-archived`, or `--unlimited` in this release. These replace the earlier `prepare`/`apply` subcommand proposal; do not implement both interfaces.

### 5.2 Default approval: native Ask

After drafting, present the complete review artifacts plus a bounded approval card: plan ID/revision, source and replacement IDs/counts, coverage, deliberate constraint changes, unresolved blockers, CURRENT/index updates, and exact optional archive moves/link risks. Summaries on the card do not replace access to full candidate documents. Use OpenCode's verified native question mechanism, not a home-grown confirmation channel or a model assertion that the user agreed.

| Choice | Effect |
| --- | --- |
| Accept and execute | Explicitly accept the listed replacement decisions and authorize the displayed view/relationship/archive actions |
| Save drafts only | Materialize proposed replacements; do not supersede or archive originals, or publish a post-acceptance CURRENT |
| Request changes | Collect feedback, revise candidates, and present a new review/approval revision |
| Cancel | Do not apply the plan; disclose any retained local candidate files |

For summary-only mode offer Publish summary / Request changes / Cancel; it never implies accepting an ADR. Blockers disable the execution choice, not the user's ability to inspect or save drafts. Absence of a response, closing the question, or timeout never means approval.

Bind the trusted response to project/session, plan revision, candidate/source/membership hashes, listed decision changes, and exact permitted actions. Check again under the write lock. A changed plan requires a fresh Ask; duplicate replies cannot double-apply. Persist a minimal audit receipt and resumable progress, not a replayable unrestricted authorization token.

The normal path is one workflow: command -> draft/review -> Ask -> verified acceptance and automatic execution. There is no mandatory copy/paste of plan IDs, per-record `/adr decide`, or second application command. The pre-drafting maintenance scope/cost acknowledgment is distinct from accepting the resulting decisions. `--confirm <plan-id>` is for unavailable UI or recovery and uses the same reviewed scope and governance checks; it must disclose acceptance effects, not disguise them as merely saving a draft.

If P0 cannot establish trustworthy native-question/user-command provenance, pause acceptance and expose the supported existing human governance path. Do not substitute an agent-written `confirmed: true` or free-text assent interpreted solely by the model.

### 5.3 Native agent tool

Register `adr_context` and share a service with the user command. Inputs: overview/ID/domain/iteration selector, current/rationale/history intent, optional section locator, continuation cursor. Outputs: evidence, references, freshness, coverage/issues, omitted counts where computable, and continuation. Tool availability must match the scopes protected by the guard.

Initial tunable response ceilings: 8 decision units and 12,000 Unicode code points INCLUDING the envelope, references, warnings, and navigation. General relation traversal is at most 3 hops; archive-body expansion is at most 1 hop per request. Deterministic local successor resolution may locate a current replacement without loading ancestor bodies. Report ambiguity instead of guessing a successor.

Split long units into identified excerpts, never silent clipping. Budget every selector including broad iteration/domain results. Bind cursors to corpus fingerprints. Report bytes and tokenizer-specific estimates separately; characters are not universal tokens. Prioritize applicable system constraints and explicit dependencies before incidental same-iteration records. Incomplete essential coverage must be visible and requires continuation before claiming completeness.

## 6. Drafting, acceptance, and recovery

### 6.1 Shared plan and review

Create a deterministic plan containing selected source fingerprints, scope membership, candidate outputs, coverage, issues, expected lifecycle transitions, target identities, and optional archive moves. AI drafting itself is not deterministic. A dedicated L2 skill consumes evidence batches and prepares the candidate; no whole-log system-prompt injection or global read bypass.

Summary mode drafts only CURRENT and provenance. Consolidation drafts complete proposed replacement ADRs PLUS the resulting CURRENT candidate and index change preview. Review these together, retaining unaffected current constraints. A partial-domain operation cannot overwrite the rest of the root's view; unchanged validated portions can be reused. If retained portions are stale, regenerate their evidence with approval or leave the whole view explicitly stale rather than pretend completeness.

Consolidation defaults to preserving decision meaning: remove redundancy and reorganize without silently weakening constraints. Separate pure reorganization, unresolved ambiguity, and proposed substantive changes in the review report. A changed or retired constraint requires conspicuous, explicit acceptance; compression alone never authorizes it.

Validate IDs, references, hashes, coverage, namespace allocation, and output ownership mechanically. Human review is still required for meaning, sufficiency, deliberate changes, and retirements. New ADRs include necessary context, decisions, rationale, consequences, and rejected alternatives in their selected style; historical detail need not be copied.

### 6.2 Acceptance is not a shortcut

Native Ask's Accept and execute choice is explicit human acceptance of the listed decisions, not merely approval to draft them. Refactor the existing user-driven `/adr decide` entry and the verified Ask executor to share one acceptance service. In strict mode that service must record every accepted replacement in the required decision ledger before retirement; native Ask is an additional audited entry, not a bypass. Materialize proposed replacements as needed, then apply the authorized transitions. The drafting agent never self-accepts; a trusted platform response, not a model-supplied boolean, drives the service.

The manual `--confirm` fallback uses the same explicit acceptance contract and checks. If user provenance, required approval, or governance prerequisites are unavailable, stop with an actionable awaiting-acceptance receipt rather than waive them. Source decisions remain binding while replacements are proposed. Save drafts only never grants later automatic acceptance. Once a valid Ask covers the full plan, do not require redundant per-record commands or another confirmation just to start the already authorized operations.

Acceptance and retirement are one logical lifecycle transition with a recovery journal, not a claim of one filesystem-atomic write. Each source may retire only after every replacement required to cover it is accepted. Extend/compose the current single-record handlers deliberately; do not assume they implement many-to-one acceptance. Gate inconsistent intermediate states and expose pending recovery to readers. Planned, authenticated governance state changes may advance a plan with receipts; unrelated body/membership changes invalidate it. This avoids falsely invalidating every plan merely because its expected acceptance occurred.

### 6.3 Independent outputs after the lifecycle transition

```text
Reviewed replacements accepted + supersession relationships applied
  |-- publish reviewed CURRENT + provenance; rebuild INDEX for actual state
  `-- execute separately preauthorized archive moves when still valid
```

Archival is not a prerequisite for publishing current decision intent. An accepted-but-unmoved old record remains superseded at its existing path. If movement later changes source paths/links, mechanically refresh provenance/navigation after verified relocation; if semantic content changed, invalidate the view and require review. Do not silently invoke a model for path-only changes.

Stage writes under a project lock, validate preconditions immediately before writes, and journal recoverable steps. Refuse mismatched CURRENT/manifest pairs. On failure report lifecycle, view-publication, index, and archive states separately; never claim overall success while a component is pending. Deterministic indexes must describe actual locations, not planned ones.

Reapplying completed steps is idempotent. A validated pending step can resume; it cannot silently accept changed inputs. Preserve unrelated worktree changes. Once accepted, reversing a decision requires normal decision governance, not deleting the new ADR during file-operation rollback.

## 7. Global freshness, not compaction-only freshness

Invalidate dependent views after ANY relevant source change: new ADR, accept/reject/deprecate, supersede, section append/status/body edit, migration, archive/restore, manual edit, addition/deletion/rename, changed domain/scope, or changed relevant module/global dependency. Changes to open proposals can also invalidate a view that displays proposals. Hooks provide immediate feedback; read-time membership/hash validation catches out-of-band changes. Publishing correctness cannot rely only on mtimes.

Rebuild deterministic INDEX views when appropriate; do not automatically pay for or publish new semantic CURRENT prose. Consolidation publishes its already reviewed candidate. Other changes report stale and offer explicit summary refresh. A stale/missing/corrupt/unsupported manifest falls back to bounded original evidence for the requested scope, never silent old authority or a corpus dump.

A failed archive move need not invalidate a view already validated against the unchanged actual paths. A successful move requires source/reference updates before the view is fresh again. Compaction need not run a second model-backed summary command to complete normal publication.

## 8. Read guard and archive traversal

Modes: `off` preserves legacy access; `warn` emits deduplicated guidance; `guard` blocks supported archive-body direct reads and recognized unscoped ADR content reads/searches. Existing projects default to off. Modes are independent of commit governance and compaction; no automatic activation.

Allow filename discovery/navigation and targeted live-source access. Root-wide content search including protected bodies must narrow scope or use the evidence tool; source-code searches excluding protected roots remain possible. Normalize project roots, separators, relative paths, symlinks, and scope. Never block unrelated directories just because they are named archive.

Use explicit adapters for verified tool shapes. Finite shell recognition may block obvious reads/searches/loops; arbitrary scripts, Git history, MCP, and unintegrated output channels remain documented gaps. Do not market regex-based shell detection as isolation. Block errors occur before supported content output, contain actionable tool arguments, and must not be swallowed by logging/safe-hook failures. If configuration/tool scope fails, report the exact degraded state rather than invent a deny-all policy or claim protection.

Historical links are lookup opportunities, not recursive-read instructions. Current queries for old IDs prefer unambiguous accepted successors. A rationale/history request names a concrete target and evidence gap; deeper archive reads require explicit bounded continuation. Stop when evidence suffices. Missing/stale evidence and conflicts permit targeted investigation. Full audits are explicitly scoped, paged maintenance workflows.

A model-written reason cannot prove necessity or authorize an audit. Scoped maintenance receipts must expire with the task/session and never grant unrestricted reads. If trusted user authorization is unavailable, omit an automatic bypass. Track cumulative evidence and deduplicate/warn on repeated tool reads, but do not promise a hard session-wide cap across arbitrary tools.

## 9. Optional archival and restore

Preview all source/destination paths, inbound/outbound relative links, translation pointers, index changes, collisions, external-link risks, and inverse actions. Eligibility requires whole-record retirement, consistent sections, valid applicable replacement evidence, and no unresolved issue affecting the move. Age alone is irrelevant.

Only execute the exact approved move plan after required acceptance and fresh path/content checks. Refuse changed inputs, collisions, unrepairable required links, or unacknowledged external-link risk. External references cannot be guaranteed repaired. Journal moves and verify normalized identity, decision substance, status, and references; recovery does not reset the entire worktree.

Archives remain in whole-ADL ID allocation, integrity, graphs, history, references, and supported migrations in BOTH layouts. Incompatible migrations must fail explicitly until updated. New records target the live roots. Ship tested inverse restore planning/application with archival. Restoring location does not restore a superseded decision's authority.

## 10. Module responsibilities

| Module | Change |
| --- | --- |
| `adr-engine.ts`, types/adapters | Source classification, archive-aware identity, precise evidence units; preserve style grammars |
| New `adr-context.ts` | Shared selection, budgets, cursors, freshness, evidence |
| `adr-views.ts`, `adr-evolution.ts` | Preserve view semantics while sharing bounded output |
| New `adr-compaction.ts` | Analysis, drafting contracts, reviewed publication, consolidation lifecycle/recovery |
| New `adr-read-guard.ts` | Reading policy separate from commit gates |
| Later `adr-archive.ts` | Move/restore plans and recovery |
| `adr.ts`, commands/config/UI schemas | Native tool registration, hook composition, validated flags/settings/help |
| L2 context/compaction skills | On-demand workflows; minimal permanent hint only |
| i18n, bilingual docs, tests | Public behavior and real plugin registration coverage |

Honor plugin scope/export contracts and existing project configuration. Do not introduce a generic workflow framework solely for this feature.

## 11. Delivery phases

| Phase | Deliverable | Exit gate |
| --- | --- | --- |
| P0 | Runtime capability matrix, lifecycle/storage contracts, proposed meta-ADR | Real tool cancellation, user/Ask response provenance, scope, style round-trip and numbering verified |
| P1 | Shared bounded retrieval tool/commands | Every selector bounded; applicable system evidence and stale/missing views handled |
| P2 | Summary plans, reviewed publishing, global invalidation | All source mutation paths covered; interruption/concurrency recovery passes |
| P2b | Formal consolidation + CURRENT/index updates | N-to-M coverage and audited Ask acceptance verified; archive absent/failed does not block correct current state |
| P3 | Independent off/warn/guard modes | Supported reads block before output; alternative lookup reachable; commit gates unchanged |
| P4 | Optional preauthorized archive and inverse restore | IDs/links/migrations survive both layouts; move recovery tested |
| P5 | Bilingual documentation, benchmarks, release gates | Automated and real-session tests pass; limits/costs published |

P1/P2/P2b/P3 form the initial functional scope. P4 is separately releasable and not required for token savings. Record architectural choices in a proposed ADR before coding; choose baseline/iteration from an approved delivery plan, never auto-accept it. Until P0 proves the runtime contract, guard/authorization details are implementation risks, not completed guarantees.

## 12. Tests, measurements, and acceptance

- Semantics: three styles, mixed OCP statuses, proposals, unknown/contradictory states, cycles/broken references, ambiguous duplicates, accepted vs proposed successors, whole vs partial replacement.
- Scope: all unarchived roots, exact/domain filters, references not promoted to targets, translation/generated exclusion, unknown domains, unchanged records retained, N-to-M grouping and cross-batch constraint review.
- CLI: no-argument/dry-run has zero model calls/writes; explicit modes draft only; flag conflicts/unknowns; numbering collisions; confirmation cannot expand scope; unavailable features error.
- Ask: all four consolidation choices; summary-only wording; full artifacts accessible; blockers disable apply; cancellation/timeout; spoofed model confirmation; changed/replayed/cross-session responses; strict ledger parity with `/adr decide`; no mandatory second approval; partial-failure resumption stays within authorized actions.
- Retrieval: large matches, long bodies/titles, CJK, full-envelope budgets, archive 1-hop vs general 3-hop rules, stale cursor, precise sections, current-successor preference, visible incomplete coverage.
- Freshness: every ordinary mutation plus manual edits, additions/deletions/migrations; partial scope preserves unaffected valid constraints; no unapproved paid refresh; corrupt/mismatched manifests fall back safely.
- Consolidation: draft/rejected replacements leave predecessors binding; human review for changed/retired constraints; expected governance transitions versus unplanned edits; partial multi-replacement acceptance; interrupted lifecycle update; reserved ID collision.
- Publication: CURRENT reviewed with replacements; deterministic INDEX mirrors actual state; source hashes/pair ownership verified; archive failure does not stop independent view publication; successful path-only relocation repairs provenance without model regeneration; pending steps resume idempotently.
- Guard: verified read/search shapes, filename vs body search, known shell cases and bypasses, logging failures, agent scope/subagents, mode changes, unrelated files unaffected, tool-unavailable degradation and repeat-read warnings.
- Archive: custom/module roots, flat/hierarchical, translation/inbound/outbound links, collisions, symlinks/root escape, external-link warning, move/restore interruption, migration compatibility, archived IDs never reused.

Run all `tests/test-adr-*.ts` with Bun, new context/compaction/read-guard/archive suites through the existing runner, type checks, and structural checks. Real OpenCode sessions must verify tool registration, hook cancellation, command/question-response provenance, all Ask choices, skill loading, no corpus injection, acceptance, and recovery; unit tests alone cannot prove these behaviors.

Generate temporary 10/100/1,000-record corpora including long records; do not commit large fixtures. Measure initial drafting cost, warm task evidence bytes/characters, tokenizer-specific estimates where available, relevant-constraint recall, unsupported reads, and guard false positives. Compare identical tasks against existing context-plus-targeted-source retrieval, not only a deliberately wasteful read-all baseline. Report initial compaction cost separately and do not promise a fixed saving percentage.

Release requires preserved IDs/history, no silent omitted constraints, bounded responses, detectable stale views, supported guard enforcement with available lookup, deterministic index correctness, reviewed semantic output, recoverable publication/archival, and unchanged legacy defaults/commit governance.

## 13. Operational rollback and approval

Disable reading policy independently. Disable only owned derived artifacts and continue bounded original-source retrieval. Restore archive locations before removing archive-aware discovery. Never delete historical decisions to roll back tooling. Once a replacement is accepted, semantic rollback is a new governed decision, not a storage rollback.

Approval checkpoints: revised plan; P0 runtime findings and proposed architectural ADR; representative summary/consolidation quality; verified guard coverage; separately approved physical moves. This document changes no runtime behavior by itself.

## 14. Design review score

Self-assessment of revision 3, not implementation validation or an independent audit:

| Dimension | Maximum | Score | Remaining uncertainty |
| --- | --- | --- | --- |
| Correctness and traceability | 30 | 27 | Semantic fidelity and multi-record recovery still need runtime/fixture proof |
| Context efficiency | 20 | 17 | Cold drafting cost, repeated reads, and batch quality need measurement |
| Maintainability and scope | 20 | 17 | Recovery and multi-style consolidation add unavoidable complexity |
| Verifiability | 20 | 18 | Concrete acceptance cases exist; actual runtime coverage remains untested |
| Usability | 10 | 8 | Numbering, governance waits, and partial failures need a validated UX |
| **Total** | **100** | **87** | **Ready for P0, not a claim of release readiness** |

Revision 3 also makes native Ask the default review/acceptance interface, keeps manual confirmation for fallback/recovery, and requires semantic-preservation review. The score is unchanged without runtime evidence. The consolidated plan removes conflicting command variants, makes no-argument execution read-only, integrates CURRENT/index publication into consolidation, extends freshness beyond compaction, and decouples archival and read policy. Raise the score only with measured evidence: real hooks/acceptance, crash recovery, source-coverage quality, false positives, and end-to-end token cost.
