---
name: memory-summarize
description: Memory-summarize - review the current session and capture durable lessons as project memory. Load ONLY when the user invokes /memory-summarize [focus] [--public|--private] or asks "what should we remember from this session".
---
# Memory Summarize Protocol

`/memory-summarize [focus] [--public|--private]` — review the current session and capture durable lessons as project memory.

## Your only job

Walk the session, identify durable lessons, and capture them via the `memory_note` tool. No coding, no dispatching, no new investigation. Read what happened, write what matters, report.

## Arguments

- (none) — both scopes eligible; pick scope per lesson using the SCOPE HEURISTIC.
- `<focus>` (positional, optional) — narrow extraction to a topic. Same shape as `/handoff [focus]`: a free-form phrase the user wants you to focus on. When provided, only capture lessons that CLEARLY match the focus; tighten the noise floor (no near-misses). Trim unrelated topics even if reusable.
- `--public` — only public-scope candidates (team memory).
- `--private` — only private-scope candidates (personal notes).

Combinations: `<focus>` and `--public`/`--private` can be used together — e.g. `/memory-summarize "API quirks" --public` means "API-related lessons, team memory only".

## Steps

1. **Read the conversation in full.** For each user/assistant exchange, ask:
   - Without focus: "Is there a clear, reusable rule another developer at this machine, on this project, tomorrow would benefit from?"
   - With focus: "Does this CLEARLY match `<focus>`, AND is it a reusable rule another developer would benefit from?"
   If yes → candidate. If no → skip. Focus mode is **stricter**: ambiguous or near-miss topics are dropped, not captured.

2. **Read existing memory before proposing** — run `read` (or your file-reading tool) on `.opencode/memory/public.md` and `.opencode/memory/private.md` to avoid duplicates. If a candidate lesson already exists, skip silently or refresh its wording only if genuinely improved.

3. **For each lesson you propose, pick scope** using the same SCOPE HEURISTIC documented in the `memory_note` tool description:
   - **public** — team-visible: project conventions, cross-developer rules, shared gotchas. Goes to `.opencode/memory/public.md` (committed, PR review).
   - **private** — current-user-only: personal preferences, environment quirks, local hacks. Goes to `.opencode/memory/private.md` (gitignored).

4. **Call `memory_note` tool once per lesson.** NEVER write the file directly, NEVER batch multiple lessons into one call. The tool handles:
   - Dated-bullet prefix + scope-specific header
   - Atomic concurrent-write protection (wx/EEXIST)
   - Auto-gitignore for private.md on first capture
   - `confidence` metadata (default "medium"; pass "high" only for rules you'd act on next session)
   The tool's gate denies utility sessions; if you're somehow running in one, abort and tell the user.

5. **Skip noise.** Explicitly do NOT capture:
   - Session-specific facts ("user asked me to fix bug X")
   - Current task state ("WIP: implementing Y")
   - Anything already in AGENTS.md (the authoritative file wins)
   - One-off bug fixes with no generalizable pattern
   - Speculative ideas not validated against the codebase
   - Tool output verbatim (the model paraphrases; raw output is noise)
   - **Focus mode only**: anything that doesn't CLEARLY match the focus, even if reusable in general

## Output

Per `output-protocol.md` (conclusion first, labels, counterargument):

```markdown
## Memory summary

**Captured N lesson(s) [filter: public|private|none]** [focus: "<focus>" | (no focus)].

- public (X): <one-line each>
- private (Y): <one-line each>

**Skipped** (counts only — no list):
- session-specific: X
- already in AGENTS.md: Y
- already in public.md/private.md: Z
- speculative: W
- (focus mode) off-topic for "<focus>": V

> Counter: I missed capturing ... if you want it filed, run `/memory note "..."` directly.
```

If `--public` or `--private` excluded lessons you identified, surface them in a "Held back (filtered)" line so the user knows what they passed on.
If focus mode dropped obvious reusable lessons outside the focus, surface them in a "Held back (off-focus)" line.

## Edge cases

- **Empty session / nothing durable**: report "No durable lessons found — session was task-specific." Do not invent lessons.
- **Focus matches nothing**: report "No lessons matched focus `<focus>`. Drop the focus to capture the full session." Do not silently broaden the scope.
- **`projectMemory` switch is off**: capture still writes the file (the gate is on injection, not capture). Mention this only if the user asked to verify what's injected.
- **File write fails** (read-only fs, gitignore error): the tool returns it; surface verbatim in your report.

## Constraints

- Do NOT modify the lesson files directly — never use `write` or `edit` on `public.md` / `private.md`. Always go through `memory_note` so headers, gitignore, and concurrency stay correct.
- Do NOT recurse into subagents or read other files for context — your only inputs are the current conversation + the two existing memory files. Lesson extraction is a read-then-write, not a research task.
- Do NOT propose lessons that require interpretation of code or architecture beyond what the conversation already exposed.
- Do NOT broaden the focus when nothing matches — report "no matches" instead.

Invoke via `/memory-summarize` or Tab.