# Review: project-memory v2 redesign (two-scope schema + memory_note tool)

- Baseline: uncommitted working tree (25 files) → committed as `46a2f9d` (chore release 0.34.0) + `7ae7633` (feat), pushed to `main`
- Tier: L2 → promoted L3; reviewers: code-review-fast (R1, R2), codegraph-scout (graph evidence), code-review max-tier (R3 final gate, R4 scoped re-verify), qa (regression pins)
- Verdict: Cleared

## Findings

- P1 — `plugins/project-memory/project-memory-command.ts:66` — quote-blind tokenizer consumed `--private` inside quoted lessons and collapsed inner whitespace; fixed via leading-flag regex peel + 8 regression tests (R1).
- P1 — `plugins/shared/opencode-prime.ts:359` + `plugins/project-memory/project-memory-config.ts:185` — `memory/private.md` gitignore guard existed only on the private-append path; shared `ensureOpencodeGitignore` recreation and manual-file paths could silently void the shipped "gitignored" contract; fixed by hoisting the guard into shared defaults + heal branch + synced duplicate; bypass classes closed (R3, R4), heal-path regression pins added (QA, mutation-verified).
- Dismissed (maintainer ruling) — legacy v0.33.0 `memory.md`/`draft.md` migration: this is version one; no backward compatibility wanted; all legacy-compat code deleted.
- P2 (backlog, not fixed) — root `.gitignore` shadowing `.opencode/` can silently un-commit `public.md` (no `git check-ignore` detection; document caveat or warn in `/memory status`); duplicated gitignore default string across two modules; `formatMtime`/`fileMtimeMs` duplication incl. `require("node:fs")` under a possible pure-ESM host; `slice(0,1000)` surrogate-pair split (`project-memory-config.ts:121`); substring `includes()` guard checks satisfiable by lookalike lines; wizard `project-memory.json:18` default "off" vs runtime "on" (pre-existing); stale team/personal vocabulary in `docs/workflows/plugins.md` examples; orphaned legacy comment in `plugins/project-manager/templates/opencode.jsonc:16`.

## Verification

- `bun run tests/test-project-memory-unit.ts` → pass (151/151 final; 145 mid-loop; QA mutation-verified both heal branches)
- `bun tests/test-sidebar-status-unit.ts` → pass (5/5)
- `bun tests/test-plugin-scope-unit.ts` → pass (26/26)
- `bun run --bun tsc --noEmit` → pass (exit 0)
- E2E suites → not run (no spec covers project-memory; logic is file/plugin-level, unit-pinned; maintainer-directed commit)
- `gh run list` (Deploy Docs, post-push) → pass (run 34680751721)

## Decision and residual risk

Cleared after 4 rounds: two P1s fixed at root cause, one finding dismissed by explicit maintainer decision (no version-one compatibility), L3 gate confirmed contract closure with graph evidence. Residual risk is concentrated in the adjudicated P2 backlog: the privacy contract now holds for repo-controlled paths, but an environment override (root `.gitignore` excluding `.opencode/`) can still silently prevent `public.md` sharing — detection (`git check-ignore`) was assessed P2 and deferred; the duplicated gitignore default string is the drift-watch item since the guard now lives in two synced copies.
