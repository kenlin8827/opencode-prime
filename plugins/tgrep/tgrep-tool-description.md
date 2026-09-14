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
- `path` (string, default `.`): search root relative to the current working directory.
- `glob` (string[]): gitignore-style filters, applied via `-g`.
- `ignoreCase` (boolean, optional): case-insensitive search.
- `literal` (boolean, optional): treat `pattern` as literal text instead of regex.
- `noIndex` (boolean, optional): when true, force `--no-index` (bypass the index, read from disk).
- `mode` (optional): `summary` (`path:count`), `locations` (`path:line`), or `content` (`path:line:text`). Omit for `summary`. `files_with_matches` remains a compatibility alias for `summary` only.

Exit codes: `0` match; `1` no match; `2` error.

The default probe returns complete per-file counts. `locations` and `content`
return complete detail output. Metadata reports the backend and complete
file/line totals.
