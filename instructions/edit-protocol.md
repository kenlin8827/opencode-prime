# Edit-tool discipline — search-expression replacements

> Layer L1: attached to coding-agent prompts via `{file:}` assembly (not injected globally). Governs content-editing tools that take a search expression (serena `replace_content` / `replace_in_files`; same discipline for any find/replace-style tool). A failed match wastes the entire needle plus every retry — these rules make edits land first-try. If the tools referenced below are not in this session's toolset, ignore the selection table and apply Hard Rules 1–4 and 6.

## Tool & mode selection

| Situation | Use | Why |
|---|---|---|
| Replace exact text you can quote | `replace_content`, mode `literal` — paste the text verbatim as read; no escaping | Literal mode auto-escapes: zero escaping mistakes |
| Replace a long span | `replace_content`, mode `regex` — `anchor-start[\s\S]*?anchor-end` with 1–2 short anchors | ~10 escaping decisions instead of ~200 |
| Replace or insert a whole function / class / method | `replace_symbol_body` / `insert_before_symbol` / `insert_after_symbol` | Name-path addressing; no needle at all |
| Same small edit across many files | `replace_in_files` (`dry_run` first when unsure) | One call replaces many needle-crafting attempts |

## Hard rules

| # | Rule |
|---|---|
| 1 | **MUST NOT** hand-escape a long verbatim block into a regex needle. Full escaping is all-or-nothing: one wrong escape (e.g. `[]` written as `\(\)\]`) yields zero matches, and the error does not show where the needle diverged. |
| 2 | **MUST** build every needle from content actually read in this session (`read_file`, symbol overview), never from remembered code — `cp-understand`. |
| 3 | On `No matches of search expression`: **MUST NOT** retry the same needle or a trivial variant; **MUST** read the target region first, then rebuild the needle from what the read returned. |
| 4 | On multiple-match or ambiguity errors: **MUST** tighten the anchors with unique context; never loosen them. |
| 5 | **MUST NOT** put `\r` in needles or blame CRLF when using serena's tools — they normalize line endings (CRLF→LF) before matching. |
| 6 | Circuit-breaker: if the informed retry still fails, **MUST** stop crafting regex needles and switch strategy — symbol-level tools, or split the replacement into small `literal` chunks. |
