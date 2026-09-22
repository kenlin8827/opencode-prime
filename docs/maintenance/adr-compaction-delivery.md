# ADR compaction: delivery status, install and release steps

Implementation status: **complete and verified on the working branch**, not yet released. `install/version.json` says `0.40.0`, which is the release in progress (the newest published tag is `v0.39.1`); this work created no tag, release, or version bump. Functional review, crash recovery, packaging and real-server delivery evidence live in [ADR compaction: verification and cost measurements](./adr-compaction-verification.md); the architecture proposal in [`docs/proposals/adr-compaction-governance.md`](../proposals/adr-compaction-governance.md) is still unaccepted.

## What ships

| Surface | Shipped path | Purpose |
| --- | --- | --- |
| Command | `/adr compaction` (alias `/adr-guard compaction`) | Read-only analysis, drafting, review, apply, archive, restore |
| Tools | `adr_context`, `adr_compaction` | Bounded retrieval and plan staging available to agents |
| Skills | `skills/adr-compaction/`, `skills/adr-context/` | On-demand workflow and retrieval guidance |
| Services | `plugins/adr/adr-compaction.ts`, `adr-compaction-runtime.ts`, `adr-context.ts`, `adr-publication.ts`, `adr-archive.ts`, `adr-storage.ts`, `adr-read-guard.ts` | Planning/apply, native cost + final Ask, bounded retrieval, CURRENT/provenance/index publication, reversible archive moves, atomic storage/journals, supported-path read guard |
| Policy | `plugin-scope.json` → `adr-context-tool` | Independent off/warn/guard read policy for the retrieval scope |

Every file above is in the released manifest; see `install/versions/0.40.0.manifest.txt`.

## Install and first use

1. Install or upgrade OCP (`ocp install` / `ocp upgrade`). The plugin tree, skills and scope policy land in the OpenCode config dir; no extra npm dependency is required beyond OpenCode's own `@opencode-ai/plugin`. The delivery test below proves this by running the production installer and then booting a real server from the installed tree.
2. In a project that already has ADRs, run `/adr compaction`. This default path is read-only: it lists the records that would be consolidated, their coverage and the current view freshness, and it makes no model call and no write.
3. When you are ready, ask for a semantic summary or a consolidation draft. A separate cost Ask authorizes the model spend; drafting then stages named batches (`stage`), which are persisted and retry-safe.
4. Finish with `submit` and answer the native review Ask: **accept**, **save drafts only**, **request changes**, or **cancel**. A single explicit accept both records the decision and applies the listed plan through the audited path — no per-record commands.
5. Retirement is separate from acceptance: superseded sources are archived only through an explicitly authorized archive plan, and `restore` reverses an archive move without reversing the decision.

Interrupted work is never silently discarded: pending plans (including partially applied ones) are reported on the next `/adr compaction` call, and `--confirm <plan-id>` is the explicit recovery path for a plan whose Ask answer was lost. Recovery preserves the original actor and ledger entry.

## Verification map

| Claim | Evidence | Command |
| --- | --- | --- |
| Service behavior, batching, lifecycle round-trip | 21 groups | `bun tests/test-adr-compaction-unit.ts` |
| Interrupted-write recovery at every boundary | 14 SIGKILL boundaries | `bun tests/test-adr-compaction-faults.ts` |
| Native cost gate, skill loading, all four review outcomes | Real OpenCode server, deterministic local model, no paid calls | `OCP_TEST_NATIVE_ADR=1 bun tests/test-adr-compaction-runtime.ts` |
| Real process death + restart + inverse archival | Real server killed after an accepted write | `OCP_TEST_NATIVE_ADR=1 bun tests/test-adr-compaction-recovery-runtime.ts` |
| Release archives carry the feature | Disposable version, file-by-file ZIP/tar check, stale-manifest refusal | `bun tests/test-adr-compaction-package.ts` |
| Production installer + installed tree really work | Installer into a sandboxed HOME, installed-copy analysis, real server auto-discovery of tools and command | `OCP_TEST_INSTALL_ADR=1 bun tests/test-adr-compaction-install.ts` |
| No regression in existing ADR behavior | All pre-existing ADR scripts and the scope suite | `for f in tests/test-adr-*.ts tests/test-plugin-scope-unit.ts; do bun "$f"; done` |

Repository-level gates: `bunx tsc --noEmit`, `bun scripts/measure-prompts.ts`, `bun run docs:build`, `git diff --check`.

## Release steps

```bash
# 1. Bump the in-progress version (version.json + release notes)
# 2. Regenerate the current-version manifest (never hand-edited)
bun run manifest:generate
# 3. Build and verify the archives
bash scripts/pack.sh --out dist
bash scripts/verify.sh dist
# 4. Tag; the release workflow performs the same build + verify steps
git tag vX.Y.Z && git push origin vX.Y.Z
```

`pack.sh`/`pack.ps1` now resolve the shipped-file inventory through `scripts/check-package-manifest.ts`, which fails the build when the current manifest does not match what actually ships. This is a real guard, not a formality: before it existed, `pack.sh` would happily build an archive from a stale manifest and silently omit files — exactly what would have happened here, because the committed `0.40.0` manifest still listed the pre-restructure `plugins/adr-guard/…` layout and omitted 31 shipped files, including the whole compaction toolchain. The in-progress `0.40.0` manifest was therefore regenerated (297 files, the only tracked file changed by that step); no historical manifest was edited, no history compaction was run, and `bash scripts/pack.sh --out dist && bash scripts/verify.sh dist` now passes with content hashes matching the working tree.

## Known limitations

- The PowerShell aggregate runner (`tests/test-all.ps1`) was **not executed** in this Linux verification environment (`pwsh` unavailable); every constituent script was run directly. The Windows-only `pack.ps1` path was kept in parity with `pack.sh` but was not executed.
- No paid-provider evaluation: semantic summary quality, real token billing and 1,000-record single-session feasibility are **not** established. The benchmark uses `tiktoken` and deterministic oracle summaries, and prices are illustrative.
- The read guard enforces the finite, supported retrieval paths; it is not a Shell/Git/MCP sandbox and does not impose a cumulative native-read cap.
- Structural checks, source hashes and native consent cannot prove semantic faithfulness; human review remains mandatory, especially for deliberate constraint changes.
- Crash coverage is process death (`SIGKILL`, run interruption), not power-loss/fsync durability or arbitrary storage failures.
- Generated CURRENT/provenance views are validated on read; ordinary ADR edits can make them stale, and manual edits are detected rather than auto-repaired.
- `OCP_TEST_INSTALL_ADR=1` needs registry access for OpenCode's own dependency install and is therefore opt-in.

## Rollback

Answering **cancel**, or leaving an interrupted plan unrecovered, changes nothing on disk. Once a plan was applied, rollback is explicit and audited: run the inverse archive plan (`/adr compaction archive restore`) to move records back, and record a new decision if the retirement itself must be reversed. ADR bodies and IDs are never rewritten or reused, and the ledger keeps the original acceptance entry.
