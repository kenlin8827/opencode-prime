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
- `path` (string, default `.`): repo-relative search root.
- `glob` (string[]): gitignore-style filters, applied via `-g`.
- `flags` (string[]): `-i`, `--ignore-case`, `-F`, `--fixed-strings`.
- `noIndex` (boolean, optional): when true, force `--no-index` (bypass the index, read from disk).

Exit codes: `0` match; `1` no match; `2` error.