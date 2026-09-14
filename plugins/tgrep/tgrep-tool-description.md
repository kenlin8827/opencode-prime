# tgrep_search tool description (canonical)

> Loaded at runtime by `plugins/tgrep.ts` into the OpenCode `tgrep_search`
> tool's `description` field.
>
> Operational rules (when to verify, anti-patterns) live in
> `prompts/{lite,code,explore}.md` — keep this file parameter-focused,
> like an MCP tool spec.

---

Fast regex/literal search over the repo, ripgrep-compatible.

Args:

- `pattern` (string, required): regex, or literal with `-F`.
- `path` (string, default `.`): search root relative to the project directory (absolute paths also accepted).
- `glob` (string[]): gitignore-style filters, applied via `-g`.
- `ignoreCase` (boolean, optional): case-insensitive search.
- `literal` (boolean, optional): treat `pattern` as literal text instead of regex.
- `noIndex` (boolean, optional): when true, force `--no-index` (bypass the index, read from disk).
- `mode` (optional): `summary` (`path:count`), `locations` (`path:line`), or `content` (`path:line:text`). Omit for `summary`. `files_with_matches` remains a compatibility alias for `summary` only.

Exit codes: `0` match; `1` no match; `2` error.

The default probe returns complete per-file counts, capped at 2,000 files —
past the cap the first 2,000 plus an omission marker are returned with
`complete: false`. `locations` and `content` return complete detail output;
requests whose summary exceeds the 2,000-line budget are refused with
`complete: false` and the true totals — narrow `path`/`glob` or use `summary`
to pick files first. Materialized detail output is additionally bounded at
150,000 chars (long lines count too). Metadata reports the backend and
complete file/line totals.
