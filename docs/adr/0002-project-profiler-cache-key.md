# 0002 — Project profiler cache: key on profile content hash, not cwd

## Status: accepted (revised 2026-09-11 — Tier 2 withdrawn)

The original draft of this ADR proposed two tiers: a Tier 1 fix for the
cwd-keyed cache bug (independently correct, accepted) and a Tier 2
"append-only delta" architecture (proposed, then withdrawn after
empirical runtime verification — see below). The shipped change is the
**Tier 1 fix only**. The Tier 2 architecture was implemented and then
stripped back because it was over-engineering under the actual
runtime behavior.

## ✅ RESOLVED (2026-09-11) — Opencode runtime is **Scenario A**

During the original review, a contradiction surfaced between two
plugins' runtime assumptions:

- `plugins/deepseek-anchor/index.ts:23-29` claimed opencode rebuilds
  `output.system` from scratch every chat request (Scenario A),
  documented a real production bug they encountered when relying on
  the alternative assumption.
- `plugins/auto-advisor/auto-advisor-system-inject.ts:6-11`,
  `plugins/project-manager/project-manager-system-inject.ts`,
  `plugins/adr-guard/adr-guard-system-inject.ts:6-11`, and
  `plugins/e2e-guard/e2e-guard-system-inject.ts:11-15` all implicitly
  relied on `output.system` being preserved across turns (Scenario B)
  for their prompt-cache-preservation fast paths.

Verified empirically with a probe plugin (since deleted). Method:
write a marker to `output.system` on first hook invocation, log
whether it survives to subsequent invocations. Result: marker **never
survives** between chat requests within the same session or across
sessions — `output.system` is rebuilt from scratch every chat request
on opencode 1.18.30. Probe captured 4 hook invocations across 2
sessions, all showing `markerSurvived: false`.

**`deepseek-anchor` was correct.** The prompt-cache-preservation
fast paths in the other four plugins are dead code under the actual
runtime. This is a **pre-existing bug** in those plugins (not
introduced by this ADR) and should be filed as a follow-up issue.

The Tier 2 architecture (decision function with three branches: skip /
append-full / append-delta) was implemented and verified to be
**technically correct under both scenarios** — it would have
degraded gracefully to `append-full` under Scenario A. But under
Scenario A the delta / audit-trail / cache-preservation rationale
**does not apply** — Tier 2 was **defensive design handling a case
that does not occur in production**. AGENTS.md §0 ("Defendability
gate": "refactoring cost never justifies shipping a design the
maintainers themselves cannot defend in public") rules out shipping
defensive-only code with documentation acknowledging it's dead. Tier
2 was stripped back to Tier 1 in the same PR. The prompt contract
changes ("read the LATEST `[PROJECT CAPABILITIES]` block; ignore
earlier blocks") were also reverted for the same reason — under
Scenario A there are no earlier blocks to read.

## Context

`plugins/project-profiler/project-profiler.ts` advertises the runtime
backend capabilities (CodeGraph / GitNexus / Serena / tgrep) to the
LLM by appending a `[PROJECT CAPABILITIES]` block to the system prompt
on every chat request. The block is rendered from a `ProjectProfile`
produced by `buildProfile(root)`, which reads `opencode.jsonc` and
inspections `.codegraph/` / `.gitnexus/` directories on disk.

The previous cache was:

```ts
const cachedBlocks = new Map<string, string>()   // key = cwd only
function profileBlock(root: string): string {
  const existing = cachedBlocks.get(root)
  if (existing) return existing                   // ← unconditional hit
  const block = renderProfileBlock(buildProfile(root))
  cachedBlocks.set(root, block)
  return block
}
```

The defect: the cache key is **only the cwd**, not the profile contents.
Within one process, if the user edits `~/.config/opencode/opencode.jsonc`
mid-session (e.g. enables the `codegraph` MCP) or adds a `.codegraph/`
directory, `buildProfile()` would now return a different profile —
but `cachedBlocks.get(root)` returns the **stale** block that was
rendered before the change. The model continues to see
`CodeGraph=unavailable` until the process restarts or the cwd changes.

This is a correctness bug, not a performance one. AGENTS.md §0
("architectural legitimacy outranks implementation convenience")
requires a fix that satisfies the contract — "what the model sees is
what the runtimes advertise".

## Decision

Replace the cwd-keyed cache with a **content-keyed** cache, keep the
strip-then-append injection strategy (no append-only delta layer —
that was Tier 2, withdrawn). Implementation:

```ts
const injectedCwds = new Map<string, string>()  // cwd → last profile key

// Hook:
const cwd = process.cwd()
const profile = buildProfile(cwd)
const key = profileKey(profile)
if (injectedCwds.get(cwd) === key) return  // unchanged → skip
injectedCwds.set(cwd, key)
stripBlockByLine(output.system, MARKER)
appendBlock(output.system, renderProfileBlock(profile))
```

Properties:

1. **Cache invalidation rides on content, not location.** The hit
   condition is `injectedCwds.get(cwd) === profileKey(profile)`. Same
   cwd + same profile → skip. Same cwd + different profile → re-emit.
   Different cwd → independent slot, no cross-contamination. The
   cwd is still in the picture because the cache value is
   content-derived (per the bug fix).
2. **`JSON.stringify` is safe.** `ProjectProfile` is a fixed-shape
   record of string literals of a closed union (`Capability`), so the
   serialization is deterministic across JS engines. SHA-256 over the
   JSON bytes keeps the cache key bounded and the comparison O(length).
3. **Strip-then-append stays.** A profile change strips the stale
   block and re-emits the fresh one. Under Scenario A the runtime
   rebuilds `output.system` per request, so the strip is a defensive
   no-op against within-request hook chaining (rare but possible).
   Under a future Scenario B the strip is the correct behavior. The
   strip pattern is line-start and derived from `MARKER` via
   `escapeRegExp` — single source of truth in
   `plugins/shared/system-block.ts`.
4. **No prompt contract change.** The model is told to read
   `[PROJECT CAPABILITIES]` (not "the LATEST one" or "ignore earlier
   blocks"). Under Scenario A there is only ever one block per
   prompt, so any "LATEST" framing would be misleading.
5. **No exports for tests' sake.** The exports on the plugin module
   are exactly what the runtime surface needs (`ProjectProfilerPlugin`
   in `plugins/project-profiler.ts`) plus the pure functions a future
   refactor might legitimately reuse (`MARKER`, `mcpEnabledFrom`,
   `ProjectProfile`, `buildProfile`, `renderProfileBlock`,
   `profileKey`). Each export has a documented rationale; no
   re-exports exist solely to preserve test import paths
   (AGENTS.md §100: "Do not add or restore production exports solely
   to make unit tests import private helpers").
6. **Shared helpers in `plugins/shared/system-block.ts`.** The
   `appendBlock`, `stripBlockByLine`, and `escapeRegExp` helpers are
   extracted from project-profiler into a shared module so
   `auto-advisor`, `project-manager`, `adr-guard`, and `e2e-guard`
   can use them too. (The pre-existing migration in those plugins
   is tracked separately; see Related files.)

## Consequences

- **+ Correctness.** Mid-session MCP / `.codegraph` / `.gitnexus`
  changes propagate to the model on the next chat request, no restart
  required. The cache now models "what the profile looks like right
  now" instead of "what it looked like the first time we looked".
- **+ **Defendable in public.** "Why does the cache key include a
  SHA-256 of the profile?" has a one-paragraph answer that survives
  review. "Why isn't this Tier 2 append-only delta?" has an answer
  too: verified Scenario A, so the delta path is dead code.
- **+ Smallest possible diff.** Removes a real bug, does not
  introduce a speculative one. Reviewable in minutes.
- **− One extra `JSON.stringify` + SHA-256 per chat request.** Both
  are microsecond-scale on the profile size (4 short strings). The
  savings from skipping `buildProfile()` when the cache hits dwarf
  this cost by orders of magnitude — `buildProfile()` reads and
  parses `opencode.jsonc` and `stat`s two directories.

## Verification

- `tests/test-project-profiler-unit.ts` (rewritten):
  - `profileKey` returns equal keys for structurally equal profiles
    (idempotency invariant)
  - `profileKey` returns distinct keys for any single-field change
    (invalidation invariant)
  - `profileKey` returns 64 hex chars (SHA-256, not truncated)
  - `renderProfileBlock` is byte-identical for equal profiles
    (cache-stable)
  - `renderProfileBlock` is distinct for distinct profiles
    (cache-invalidation visible)
  - `escapeRegExp` correctly escapes `[]`, `()`, `.`, `*`, `?` and
    passes plain text through (locks the `stripBlockByLine` regex
    derivation)
  - `appendBlock` happy path + empty-array fallback + mixed-array
    fallback (defensive coverage for the hook helper)
  - Round-trip `stripBlockByLine` + `appendBlock`: stale block gone,
    fresh block present, exactly one marker (no stacking), prefix
    preserved — this is the bug-fix invariant
- `tests/test-system-block-unit.ts` (new, parallel work): covers
  the shared helpers in isolation.
- `tsc --noEmit` clean.

## Related files

- `plugins/project-profiler/project-profiler.ts` — `MARKER`,
  `ProjectProfile`, `mcpEnabledFrom`, `buildProfile`,
  `renderProfileBlock`, `profileKey`. Hook uses
  `stripBlockByLine(output.system, MARKER)` + `appendBlock(...)`
  from the shared module. Cache is `Map<cwd, profileKey>` keyed on
  cwd + content hash.
- `plugins/shared/system-block.ts` — `appendBlock`,
  `stripBlockByLine`, `escapeRegExp` shared by every system-
  transform injector (project-profiler, project-manager,
  auto-advisor, adr-guard, e2e-guard).
- `tests/test-project-profiler-unit.ts` — rewritten for the
  minimal Tier 1 fix.
- `tests/test-system-block-unit.ts` — covers the shared helpers.
- `prompts/lite.md`, `prompts/explore.md`, `prompts/code.md` —
  unchanged (the original "read `[PROJECT CAPABILITIES]`" wording
  stays — no "LATEST block" / "ignore earlier blocks" framing).
- `plugins/tui/sidebar-status.ts` and
  `plugins/tgrep/tgrep-service.ts` — untouched; the
  `resolveTgrepCapability` shared resolver contract is preserved.

## Future directions (separate issues, not this ADR)

The empirical verification surfaced follow-up fixes that are **out of
scope** for this ADR (each is a pre-existing bug, not introduced by
this change):

1. **`auto-advisor` / `adr-guard` / `e2e-guard` / `project-manager`**
   ✅ **Fixed 2026-09-11** — these plugins previously used the
   dead-code "skip on same state" pattern (introduced as a CPU
   optimization for the prompt-cache-preservation fast path that
   never fired under Scenario A). The fix replaces each plugin's
   `lastInjectedMode` / `lastGuardState` / `lastShouldInject` /
   `lastFilePresent` style tracker with a **fragment cache**: cache
   the rendered prompt string per (state, key), always inject when
   state says inject, and keep the defensive strip path for
   Scenario B correctness. Each plugin is now correct under
   Scenario A AND Scenario B; the fragment cache just saves the
   per-turn string concat (~µs per chat, ~10⁻⁴ % of the cost of
   re-sending the system prompt). The shared pattern is documented
   in DEVELOPING.md and locked by `tests/test-system-inject-fragment-cache-unit.ts`.
2. **`project-profiler`** ✅ **Fixed 2026-09-11** — same root
   cause: `injectedCwds.get(cwd) === key → return` was the same
   "skip on same key" pattern that would have left the LLM
   without `[PROJECT CAPABILITIES]` after turn 1. The cache now
   stores `{ key, text }` per cwd and the hook always injects.
   Defensive `stripBlockByLine` keeps the round-trip correct under
   a hypothetical Scenario B.
3. **`md-to-docx`** pushes its block via `output.system.push(...)`
   with no marker check — under Scenario A this is correct (no
   duplicate), but under a future Scenario B it would stack.
   Adding a marker check via `ANY_CAPABILITY_MARKER_RE` (or
   equivalent) would future-proof it. (Out of scope for the
   2026-09-11 round; the plugin still works correctly today under
   Scenario A.)
4. **`deepseek-anchor`** appends to **every** string entry in
   `output.system`; `appendBlock` (only-last) is the converged
   pattern across the other plugins. Migrating to `appendBlock`
   would align semantics. (Out of scope; deepseek-anchor's
   per-session tracking is the correct pattern for its
   first-turn-only injection contract.)
5. **If opencode ever switches to Scenario B** (output.system
   preserved across turns), the fragment-cache + always-inject +
   defensive-strip pattern still works: under B the strip removes
   the previous turn's injection, then re-injection produces a
   byte-identical final prompt → provider cache hit. No rework
   needed for any of the five plugins covered by items 1–2.