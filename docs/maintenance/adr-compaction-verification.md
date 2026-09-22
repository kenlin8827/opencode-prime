# ADR compaction: verification and cost measurements

Token measurements: 2026-09-19; implementation verification extended 2026-09-20. Runtime: OpenCode **1.18.15**, Bun **1.4.2**, Linux. This records implementation evidence, not acceptance of the architectural proposal or a release announcement.

## Verification matrix

| Surface | Evidence |
| --- | --- |
| Existing ADR behavior | All 9 pre-existing ADR test scripts pass: 1,150 checks |
| New maintenance services | 21 test groups: default no-write analysis, CLI conflicts, bounded Unicode evidence, full read receipts, N-to-one/N-to-M, retained records, MADR/Nygard/OCP, OCP rejected-section preservation and mixed-container refusal, explicit iteration identities, custom/module roots, OCP state override, ownership, stale input/indexes, cycles/missing references, symlinks, journals/recovery, cost denial/expiry, Ask replay/cross-session checks, persisted/retry-safe batches, 100-record assembled submission and serialized lifecycle round-trip checks |
| Plugin scope | Existing scope suite: 26 checks pass; evidence and read policy share the `adr-context-tool` scope |
| Real native runtime | Local deterministic SSE model; actual plugin registration, skill discovery/loading, default command with zero model requests, cost Ask, complete evidence, named-batch submission, all 4 final Ask choices, strict ledger, CURRENT/index publication, archive and native `read` cancellation |
| Crash boundaries | 14 SIGKILL boundaries: durable approval; lifecycle start; ledger; successor; predecessor; lifecycle completion; CURRENT body; view completion; archive copy; archive source removal; archive completion; relocated CURRENT; relocated view completion; final plan completion. Every case replays without duplicate acceptance or lost sources. |
| Native restart/restore | Real OpenCode killed after the accepted successor write; fresh server rejects unrelated changes, resumes with original actor/ledger, then performs separately approved inverse archival. Manual recovery makes no model request. |
| Type checking | `bunx tsc --noEmit` passes |
| Bilingual documentation | `bun run docs:build` passes (font-resolution and large-chunk warnings remain). |
| Prompt budget | `bun scripts/measure-prompts.ts` passes |
| Aggregate PowerShell runner | Service and process-death suites registered; both native suites opt-in through `OCP_TEST_NATIVE_ADR=1`. The PowerShell wrapper was not run in this Linux environment: `pwsh` was absent and the attempted binary download failed. Its constituent ADR/scope scripts were run directly. |
| Packaging smoke test | Disposable checkout tree and validation-only version: generated manifest includes all new services/skills; `pack.sh` + `verify.sh` pass for ZIP and tar.gz, 297 manifest files; archives are listed file-by-file and must contain the required feature files with no unlisted payloads. A drifted release manifest is now refused instead of packing an incomplete archive. Actual version and historical manifests are hash-checked unchanged. This is not a release; production version/tag/manifest gates remain the maintainer’s release flow. |
| Release archives (real repository) | The in-progress `0.40.0` manifest was regenerated with `generateManifest` (297 shipped files; the only tracked file changed by that step; no historical manifest edited and no history compaction run). `bash scripts/pack.sh --out dist` + `bash scripts/verify.sh dist` pass: 392 packaged files per archive, file list OK, content integrity OK for all 297 manifest files, historical-manifest gate OK. |
| Installed-tree delivery | Production installer runs into a sandboxed `HOME` (canonical `~/.config/opencode` layout, isolated from the real user config); required plugin/skill/scope/config files are byte-identical to the repository, the installed copy performs read-only analysis on a real project without writes, and a real OpenCode server booted from that tree auto-discovers the ADR tools (`adr_context`, `adr_compaction`) and the `/adr-guard` command through native discovery only (no fixture plugin path). Opt-in: `OCP_TEST_INSTALL_ADR=1`. |

The native fixture creates temporary projects, uses random server authentication and ephemeral ports, submits actual Question reply API requests, then stops processes/removes fixtures. It does not call a paid provider. Approval receipts come from native server events rather than candidate data. Fixture-only filesystem interception kills a child process after real writes; no production fault hook is shipped. Stale locks are removed only after the recorded owner exits. These tests cover process death, not power loss/fsync durability or every filesystem failure.

The packaging guard is load-bearing rather than cosmetic: the committed `0.40.0` manifest still described the pre-restructure `plugins/adr-guard/…` layout, so `pack.sh` would previously have produced an archive missing 31 shipped files, including the whole compaction toolchain. `scripts/check-package-manifest.ts` now resolves the shipped-file inventory from the single `install/src/manifest.ts` implementation used by the installer, generates a missing manifest, and fails the build when an existing manifest disagrees.

An integration defect was found and fixed: sending a synthetic user-message receipt after Question approval could trigger an additional active model-loop turn even with `noReply`. Receipts now use the existing Question tool result plus a toast. The real test asserts that approval adds no unrequested model turn.

A second recovery defect was found at stage gaps: an approved plan could exist before its next journal was written. Pending recovery now includes `applying` plans as well as incomplete journals; bounded context, new plans and competing reviewed plans cannot bypass that interval. Recovery also refuses a cancellation that would discard the original authorization.

Serialized lifecycle changes are also reparsed with the style adapters before approval. Duplicate or noncanonical status fields can otherwise leave the actual Markdown proposed/accepted while the in-memory plan claims accepted/superseded. A mismatch in record/section status or reciprocal lineage becomes an execution blocker; it cannot retire sources or append an acceptance ledger entry.

Operational steps, install/rollback guidance and the remaining platform limits are collected in [ADR compaction: delivery status](./adr-compaction-delivery.md).

## Reproduce

```bash
bun tests/test-adr-compaction-unit.ts
bun tests/test-adr-compaction-faults.ts
bun tests/test-adr-compaction-runtime.ts  # OpenCode on PATH; runs all four choices
bun tests/test-adr-compaction-recovery-runtime.ts
bun tests/test-adr-compaction-package.ts  # Bun + bash, zip/unzip/tar/hash utilities
bun tests/test-plugin-scope-unit.ts
bunx tsc --noEmit
bun scripts/measure-prompts.ts

python3 -m venv .venv
.venv/bin/pip install tiktoken==0.12.0
.venv/bin/python scripts/benchmark-adr-compaction.py
```

The tokenizer's first run downloads its official vocabulary. In the measurement environment that Azure endpoint was inaccessible; the identical vocabulary was reconstructed from the npm `tiktoken` encoder distribution and checked against the official SHA-256 `223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7` before using the ordinary tokenizer cache. No vocabulary or large fixtures are committed.

## Synthetic benchmark

Tokenizer: **tiktoken 0.12.0, cl100k_base**. No paid calls. Temporary 10/100/1,000-record Nygard corpora contain a shared system constraint, service domains, explicit normative requirements, rationale/rejected alternatives and a longer record every 20 records. The identical task retrieves one service domain plus shared system constraints and follows every required page.

The realistic baseline is the **existing context navigation plus targeted original bodies**, including the same system constraints—not just an intentionally wasteful read-all comparison. The warm path uses deterministic oracle summaries. These measurements test retrieval cost and fixture coverage, **not the quality of an LLM-generated summary**.

| Records | Read all tokens (reference only) | Existing targeted baseline | Warm evidence, all pages | Warm pages | Reduction vs targeted | Fixture constraint recall |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 5,580 | 1,265 | 300 | 1 | 76.3% | 2/2 |
| 100 | 62,430 | 13,565 | 1,569 | 2 | 88.4% | 11/11 |
| 1,000 | 624,336 | 129,971 | 14,697 | 13 | 88.7% | 101/101 |

Maximum warm response sizes were 991 / 3,713 / 3,732 Unicode codepoints, each below the 12,000-codepoint limit. Total task evidence may legitimately exceed one response. Requirements were matched exactly against known fixture text; this is not a general semantic recall guarantee.

### Initial cost is separate

| Records | Draft evidence tokens, read once with envelopes | Oracle summary output tokens | Illustrative initial cost floor | Optimistic amortization tasks |
| ---: | ---: | ---: | ---: | ---: |
| 10 | 9,037 | 492 | $0.0115 | 11.9 |
| 100 | 101,185 | 4,902 | $0.1257 | 10.5 |
| 1,000 | 1,012,062 | 49,003 | $1.2571 | 10.9 |

Illustrative rates are **$1/M input and $5/M output**, not a provider quote. The floor excludes prompts, tool definitions, replacements, review, retries, caching and transcript replay. It is not an end-to-end invoice or a spending cap. Amortization assumes identical repeated tasks and no subsequent source changes, so actual break-even can be much later.

With naive full-prefix replay and no cache/session compaction, the evidence-input model totals **22,674 / 2,332,393 / 228,292,388 tokens**. This warning matters: bounded responses do not make a large maintenance session cheap. The 1,000-record oracle summary is also larger than many providers' single-response output limit. This benchmark does **not** establish that one paid model session can faithfully draft a 1,000-record plan. No fixed savings percentage is promised.

Named candidate batches now avoid a single enormous final tool call. A structural fixture assembles a 100-record summary from 20 persisted batches; native tests stage decisions and coverage separately. Each batch is bounded to 12,000 Unicode codepoints and full validation still occurs at submit. This does not reduce accumulated input replay, prove large-session synthesis quality, or split an individual long replacement. The token table is unchanged: it measures oracle summaries and does not include the new batching tool overhead.

## Enforcement and remaining limits

- Real cancellation was verified for native `read`; generic reader/search adapters and finite shell recognition also have service tests. Arbitrary Shell scripts, Git, MCP, custom transports and a cumulative native-read cap are not covered by a universal barrier.
- Basic unrelated-source and filename-discovery cases are allowed; this is not a statistically measured false-positive rate across every shell/tool dialect.
- Structure, source hashes, per-unit mappings and native consent cannot prove semantic faithfulness. Human review is mandatory, especially for deliberate constraint changes or unresolved conflicts.
- Cross-batch synthesis quality, actual paid-provider token usage and model context/output limits remain deployment-specific. The benchmark is deliberately zero-cost and does not substitute for those evaluations.
- Native event verification is tied to the runtime's trusted Question channel. It is not isolation from an arbitrary local process able to control the same server or edit project state.
- Generated CURRENT is checked on read, not permanently injected; manual edits and ordinary ADR mutations can make it stale. Large manifests are local provenance, not automatic model context.
- Existing layout migration explicitly refuses archived records rather than risking incompatible movement. Do not assume every old migration path supports archive trees.
- The [architectural proposal](../proposals/adr-compaction-governance.md) remains proposed and unnumbered pending an approved OCP namespace. Repository ADR history was not modified to manufacture approval.
