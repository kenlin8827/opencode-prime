# Project Memory

Status: implemented 2026-09-11. Re-scoped 2026-09-12 to add the second
personal scope and the `memory_note` tool / `/memory-summarize` skill on top of
the original phase 1 capture + inject loop.

## What

A lightweight, project-level "lessons learned" store. Complementary to
`AGENTS.md` (manually curated project facts, authoritative) and to
`opencode-mem` (auto-captured session history, heavier, different grain).
This plugin handles short, durable lessons the team agrees on; AGENTS.md
stays the source of truth on conflict.

## Two scopes, one gate

Files live INSIDE the project at `<projectDir>/.opencode/memory/`, same
convention as `.opencode/handoffs/`, `.opencode/logs/`, `.opencode/recovery/`.
File names self-describe visibility (no ambiguity when scanning the dir):

| Scope | File | Visibility | Lifecycle |
|---|---|---|---|
| `public` | `public.md` | committed to git, follows the checkout | same as `AGENTS.md` — PR review is the gate |
| `private` | `private.md` | gitignored, only the current user sees it | rides along with the project; auto-gitignored on first capture via `.opencode/.gitignore` |

The `projectMemory` project-config switch (default on) controls injection
of both files together under a single `[PROJECT MEMORY]` marker, with
`=== Public ===` and `=== Private ===` sections. Either file being
non-empty triggers injection; both empty / switch off / file missing is a
complete no-op plus a defensive strip of any stale block.

`AGENTS.md` wins on conflict against both — stated inside each section so
the model resolves without a human in the loop.

## Why project-internal

Top-tier references (Cursor User Rules, Aider `~/.aider.conf.yml`, Copilot
VS Code settings) keep personal settings in the user home because those
plugins are NOT project-scoped — they naturally live in the IDE settings
or shell config. This plugin IS project-scoped (each project loads its
own plugin bundle); mixing in user-home storage breaks the plugin
boundary for the sake of a feature the team-vs-personal split already
covers. Both scopes ride along with the project — the team file stays
diff/PR-reviewable, the personal file stays scratchpad-ish.

## Entry points

User command (`/memory note`):

```text
/memory note "<lesson>"             # public, default
/memory note --private "<note>"     # private, gitignored
/memory on | off                    # toggle injection
/memory status                      # gate + public/private entry counts
```

LLM-initiated (`memory_note`):

The agent can call the `memory_note` tool itself when it discovers a
durable rule. Defaults to `public`; pass `scope: "private"` for
current-user-only notes. Confidence (`high` / `medium` / `low`) is
self-rated metadata only — the tool does not gate on it.

Session summary (`/memory-summarize`):

The `/memory-summarize` slash command loads a skill that scans the full session,
proposes durable lessons, and calls `memory_note` once per lesson. Use
it at session end instead of brainstorming lessons manually.

Direct file edit:

The files are plain markdown. Power users can edit `public.md` /
`private.md` directly — the gate injects whatever the files contain.

## Tool gate (plugin-scope)

Two gates, same policy engine (`plugins/shared/plugin-scope.ts`):

- `experimental.chat.system.transform` for the `[PROJECT MEMORY]` block — registered under `project-memory`. Lite allow, subagent deny (avoid narrow-context pollution), utility deny (title tasks don't need project lessons).
- `memory_note` tool — registered under `project-memory-note-tool`. Utility deny (title tasks can't discover reusable rules; a stray note pollutes the files), subagent allow (advisor subagent may legitimately learn a project quirk worth remembering).

Plugin IDs are intentionally distinct so the two gates stay independently
tunable in `plugin-scope.json`. Fail-open contract: broken policy
degrades to pre-gate behavior, never to lost functionality.

## Scope heuristic (in `memory_note` description)

The agent decides public vs private using one question: "Will another
developer at this same machine, on this project, tomorrow find this rule
useful?"

- YES → public (committed, team benefits)
- NO → private (your environment, your preferences, your hacks — only you see it)
- When in doubt → public (PR review routes misclassified entries back)

## Layout

```
plugins/project-memory/
  project-memory-config.ts         — switch + paths + lesson append (scoped)
  project-memory-command.ts        — /memory note|on|off|status
  project-memory-tool.ts           — memory_note tool (agent-driven, scoped)
  project-memory-system-inject.ts  — system.transform: inject both files
plugins/project-memory.ts           — barrel (auto-discovery)
```

Shared plumbing: `getProjectDir` / `setProjectDir` /
`writableProjectConfigFile` (from `plugins/shared/opencode-prime.ts`),
`createPluginSwitch` / `normalizeSwitchState` (from
`plugins/shared/plugin-switch.ts`), `scoped` / `scopedForTool` (from
`plugins/shared/plugin-scope.ts`).

Wizard grouping: `project-memory.json` (top-level inline control). New
entries only require a JSON row, no wizard code change.

Tests: `tests/test-project-memory-unit.ts` (state resolution, lesson
append incl. concurrency + gitignore, fragment builder incl. over-cap
pointer, system hook strip/re-inject byte-stability, command, tool, tool
gate). `tests/test-plugin-scope-unit.ts` covers the shared gate API.

## Decisions & changelog

- **Wizard grouping (2026-09-11, user call).** `adrGuard` moved from the ADR
  schema into the Project guards group; `project-memory` is a top-level
  inline control.

- **Two-scope split + file rename (2026-09-12, user call).** Originally
  shipped as one file (`memory.md`) with a draft→curated manual promotion
  flow. Re-scoped to `public.md` (committed) + `private.md` (gitignored)
  after the user asked "what about private and public" — file names
  self-describe visibility so scanning `.opencode/memory/` is unambiguous
  without reading docs. The draft/curated split was deleted in the same
  pass: every entry lands directly in the file the gate injects.

- **`memory_note` tool (2026-09-12).** Originally capture was user-only.
  Added the `memory_note` tool so the LLM can call it when it discovers a
  reusable rule during work. Description carries the scope heuristic and
  noise rules; tool gate (`project-memory-note-tool` plugin-scope key)
  denies utility sessions.

- **`/memory-summarize` skill (2026-09-12).** Originally considered a
  `/memory-summarize` skill; the user flagged the name as too long and
  shipped an interim `/remember` (8 chars), then `/reflect` (proposed
  for accuracy but rejected for industry-uncommon vocabulary). Final
  decision: keep the original `/memory-summarize` name — the user-facing
  mental model "summarize session → write to memory" is what they
  already use in Notion/Slack/Linear, so zero new vocabulary to learn.
  The skill walks the session, picks durable lessons, and calls
  `memory_note` once per lesson — never writes the file directly.

- **Naming `capture` → `note` (2026-09-12).** Originally the user
  command and tool both used "capture" — but capture implies automatic
  grab, while the behavior is user-typed note. Renamed
  `/memory capture` → `/memory note` and `memory_capture` tool →
  `memory_note` for semantic accuracy.

- **Project-internal (2026-09-12, user call).** Top-tier references
  keep personal settings in the user home because those plugins aren't
  project-scoped. This plugin IS project-scoped — both scopes live inside
  the project, the personal one gitignored. Mixing in user-home storage
  was reverted after the user pointed out "this plugin itself is
  project-scoped".

- **Tool gate vs system-inject gate (2026-09-12).** Two independent
  gates via two plugin-scope IDs (`project-memory` and
  `project-memory-note-tool`). The system-inject gate denies subagent
  sessions to keep narrow-context agents' prompts clean; the tool gate
  allows subagent calls so a subagent that genuinely learns a project
  quirk can still file it for the next primary session to see.

## Future

- Phase 2 review tool: a TUI dialog that lists the public/private files
  and lets users prune / rewrite. Lower priority now since there's no
  promotion step to automate.
- i18n: full `guard.memory.*` keys cover en + zh-CN.