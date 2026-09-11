# tgrep_search tool description (canonical)

> Loaded at runtime by `plugins/tgrep.ts` into the OpenCode `tgrep_search`
> tool's `description` field.
>
> Agent prompts (`prompts/lite.md`, `prompts/explore.md`, `prompts/code.md`)
> carry a compact summary of the same rules — **keep them in sync** with
> this file when the canonical text changes.

---

Built-in OpenCode tool for codebase-wide text/regex search — this is an LLM tool (invoke via model tool-calling), NOT a bash/CLI binary. The `freshness` argument is **required** (no silent default). Do NOT dispatch `@explore` (or any subagent) for plain text/regex matching — call `tgrep_search` directly.

The `[PROJECT CAPABILITIES]` block reports tgrep readiness as `tgrep=<state>`. Default for fresh queries:

  ready       — freshness=indexed   (fastest: watcher live, index current)
  no-watcher  — freshness=indexed   (OCP auto-starts the server on first call, ≤15s startup; subsequent calls hit the hot path)
  stale       — freshness=current   (index built under different policy; rebuild via /project index)
  building    — freshness=current   (rebuild in flight; result would be partial)
  no-index    — freshness=current   (CLI present, .tgrep/ missing; tool falls back to rg)
  no-cli      — tool NOT registered (tgrep binary not on PATH) — use native grep/glob
  unavailable — tool NOT registered (tools.tgrep = false)         — use native grep/glob

`freshness=indexed` is always safe (falls back to rg when the server isn't up), so default to it when in doubt. Pick `current` (= tgrep `--no-index`) for a guaranteed fresh view after a recent edit, or before reporting "no match" — per-query override, never session default. Do NOT pre-emptively reach for `current` when the sidebar shows READY.

OVERRIDE — verification only, per-query (not session default): after a recent edit, or before reporting "no match" / "doesn't exist", re-run THAT query with `freshness=current` to verify.
