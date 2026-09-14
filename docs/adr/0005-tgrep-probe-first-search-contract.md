---
status: accepted
date: 2026-09-14
layer: component
deciders: ken
---

# 0005 — tgrep probe-first search contract

## Status: accepted

## Context and Problem Statement

`tgrep_search` previously returned a single, potentially broad match stream.
Managing that stream as paged cursor state would make the tool stateful and
would require snapshot retention, expiry, cleanup, and retry semantics.

v0.36.0 instead makes search a two-step, probe-first interaction. The default
request answers “where and how many?” before an agent requests individual
locations or matching text. The public result contract must stay complete,
stateless, and aligned with the upstream `tgrep` CLI.

The existing implementation proves the relevant upstream behavior:

- `-c --with-filename` produces the summary's `path:count` entries.
- `--with-filename --line-number` produces detail suitable for
  `path:line` or `path:line:text`.
- tgrep errors fall back to `rg`; the fallback preserves the requested search
  shape without passing tgrep-only corpus-policy flags.

The contract excludes pagination cursors, materialized snapshots, and an
OCP-owned disk cache for search results. It does not remove tgrep's upstream
index or the existing short-lived capability cache used to determine watcher
readiness; neither exposes paged result state to callers.

## Decision Drivers

- Broad searches should be compact by default.
- Every successful response should represent the complete requested result.
- The API should replay normal search parameters, not retain result state.
- OCP should use documented upstream CLI output rather than invent a parallel
  retrieval protocol.
- The design must retain a clear response-size boundary.

## Considered Options

1. **Cursor snapshots** — rejected. A cursor needs server-side or disk-backed
   result retention, expiry and invalidation rules, cleanup, and semantics for
   repository changes between pages. It also makes a tool result incomplete by
   default.
2. **Parameter replay** — rejected as the primary API. Replaying a query with
   caller-supplied offsets or limits remains stateless, but agents must reason
   about page boundaries and can miss or duplicate matches when files change.
   It also does not give a compact first answer for broad searches.
3. **Probe modes** — chosen. Omit `mode`, or use `summary`, for complete
   `path:count` output. Use `locations` for complete `path:line` output and
   `content` for complete `path:line:text` output. A later detail call replays
   the original search parameters and requests the chosen representation.

## Decision

`tgrep_search` uses probe modes as its stable public contract:

| Request | Output | Purpose |
| --- | --- | --- |
| omitted `mode` or `summary` | `path:count` | Complete per-file probe |
| `locations` | `path:line` | Complete navigation detail |
| `content` | `path:line:text` | Complete matching-text detail |

`files_with_matches` remains a compatibility alias for `summary`. It does not
restore a filename-only result or introduce another output shape.

Each response reports the backend and complete matched-file and matched-line
totals. `complete: true` means the process returned the requested representation
successfully. Detail modes impose no OCP-only character cap or pagination
truncation.

The process capture buffer is an explicit operational boundary:

```text
request → summary probe or detail search → process output ≤ 8 MiB → complete response
                                                │
                                                └─ exceeds/fails → rg fallback; error if it cannot return output
```

The 8 MiB `spawnSync` buffer prevents an unbounded child-process capture from
consuming the plugin host. It is not a partial-result protocol. A response that
cannot be captured completely must fail after fallback rather than claim
`complete: true` for truncated output. Callers narrow `path` or `glob` and
repeat the query when they hit this boundary.

Upstream alignment is intentional: summary uses `tgrep -c --with-filename`;
detail uses `tgrep --with-filename --line-number`; regex/literal, case, glob,
path, and `noIndex` arguments pass through as upstream search parameters.
`rg` remains the correctness fallback when the watcher is unavailable or tgrep
fails. OCP does not persist, snapshot, or page either backend's results.

## Consequences

### Positive

- Agents receive small, complete summaries before requesting verbose output.
- Calls are stateless and reproducible from their parameters.
- No cursor store, snapshot invalidation, retention policy, or disk cleanup is
  required.
- The API maps directly to upstream CLI representations and preserves the
  established `rg` fallback.
- `files_with_matches` callers keep receiving the summary representation.

### Negative

- Agents make a second call when a summary identifies files needing detail.
- Detail output can reach the 8 MiB process-capture boundary; callers must
  narrow the search instead of retrieving pages.
- Summary counts describe matching lines, not a separate filename-only mode.

### Neutral

- Existing tgrep indexing and readiness capability caching remain internal
  execution concerns, not result-pagination mechanisms.
- A replay can observe repository changes, because this contract intentionally
  does not freeze a snapshot between the probe and a detail request.

## Verification

- [Fact] Reviewed the staged v0.36.0 implementation in
  `plugins/tgrep.ts`, `plugins/tgrep/tgrep-search.ts`,
  `plugins/tgrep/tgrep-mode.ts`, and `plugins/tgrep/tgrep-output.ts`.
- [Fact] Reviewed the canonical public description in
  `plugins/tgrep/tgrep-tool-description.md` and pins in
  `tests/test-tgrep-search-unit.ts`.
- [Fact] `git diff --cached -- plugins/tgrep.ts plugins/tgrep/tgrep-search.ts plugins/tgrep/tgrep-mode.ts plugins/tgrep/tgrep-output.ts plugins/tgrep/tgrep-tool-description.md install/versions/0.36.0.notes.md` showed the mode, summary, fallback, and buffer implementation.
- [Fact] No implementation files were changed for this ADR.
- [Assumption] Runtime tests were not run during this documentation-only task.

## References

- `plugins/tgrep.ts`
- `plugins/tgrep/tgrep-search.ts`
- `plugins/tgrep/tgrep-mode.ts`
- `plugins/tgrep/tgrep-tool-description.md`
- `tests/test-tgrep-search-unit.ts`
- `install/versions/0.36.0.notes.md`
