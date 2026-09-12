# Project Memory — Phase 1 (capture + inject)

Status: implemented 2026-09-11. Design locked in the 2026-09-11 handoff
(`.opencode/handoffs/handoff-ocp-20260911-042842.md`); this doc records it.

## What

A lightweight, opt-in, project-level memory for "lessons learned" —
distinct from `AGENTS.md` (manually curated project facts, authoritative)
and from `opencode-mem` (auto-captured session history, heavier, different
grain). Complementary, not duplicative.

## Three stages, opt-in at every stage

1. **Capture** — `/memory capture "<lesson>"` appends one dated bullet to
   `<ocp memory root>/draft.md`. Explicit user trigger only; no auto-capture
   (auto-capture without curation = noise graveyard → LLM trust erosion).
2. **Review** — promotion from draft to `memory.md`. Phase 1:
   manual edit (move stable entries with their dates, delete stale ones).
   Phase 2 may tool this (`/memory review` dialog reusing `plugins/tui/`).
3. **Inject** — while `"projectMemory": "on"` in the project
   `opencode.jsonc`, `plugins/project-memory/` appends the full curated
   `memory.md` to the system prompt (marker `[PROJECT MEMORY]`, defensive
   strip, `plugin-scope.json` gating: lite/utility/subagent never see it).
   Default `off` — file absent or switch off = complete no-op.

## Rules

- **Authority**: memory is advisory; AGENTS.md wins on conflict. Stated
  inside the injected fragment so the model resolves it without a human.
- **Size ceiling**: over `INJECT_CHAR_CAP` (16 000 chars) the content is
  NOT injected — a pointer block tells the agent to read the file and asks
  the user to prune. `ponytail:` upgrade path is the phase-2 review tool
  keeping the file under the cap by curation.
- **Scope**: one memory per project (not per feature). Files live outside
  the checkout under the ocp user-level config root
  (`~/.config/opencode/memory/<projectKey>/` — path-hashed project key,
  move-safe), not in the gitignored `.opencode/` (see Decisions below).

## Layout

```
plugins/project-memory/
  project-memory-config.ts         — projectMemory switch + file paths + draft append
  project-memory-command.ts        — /memory capture|on|off|status
  project-memory-system-inject.ts  — system.transform: inject memory.md
plugins/project-memory.ts          — barrel (auto-discovery)
```

Switch integration: `PROJECT_SWITCH_{DEFAULTS,OPTIONS}` + `detectProjectSwitches`
+ `ProjectSwitches`/`applySwitchesToConfigContent` (project-manager), commented
line in `templates/opencode.jsonc`, one row in
`plugins/tui/wizard-schema/project-guards.json` (schema-driven wizard — no
wizard code change), en/zh i18n keys.

Tests: `tests/test-project-memory-unit.ts` (state, draft, fragment incl.
over-cap pointer, hook strip/re-inject byte-stability, command, switch upsert).

## Decisions & phase 2

- **Wizard grouping (2026-09-11, user call).** `adrGuard` moved from the ADR
  schema into the Project guards group (`project-guards.json` now: env, e2e,
  adr, memory); the remaining ADR group (dir + mode) is displayed as
  **“ADR Settings / ADR设置”**. Every guard field carries a `nameKey` so the
  group-menu row shows a localized display name (fallback: raw config key);
  `SchemaField` label keys are typed as `StringKey` (compile-time key check).

- **Location — moved OUTSIDE the project (2026-09-11, user call).** After a
  first cut stored memory under the project's `.opencode/`, the decision was
  reversed: project memory is heavy and must not live or die with a checkout.
  Files now sit under the ocp user-level config root:
  `~/.config/opencode/memory/<projectKey>/memory.md|draft.md` (honors
  `OCP_CONFIG_PATH`/`XDG_CONFIG_HOME`). `<projectKey>` = sanitized project-dir
  basename + sha256(abs-path)[0:8] — renamed/moved projects get a fresh key
  instead of silently adopting a stranger's memory. Unreleased at the time of
  the move, so no migration.
- **Phase 2**: review/promotion tool (draft → memory, reusing
  `plugins/tui/` wizard infra); lite-mode auto-*suggest* capture (manual
  only until real draft volume justifies it).
- **Guard chat-layer i18n — DONE (2026-09-11).** All user-visible
  command/announce text of adr-guard, e2e-guard, project-manager and
  project-memory renders in the user's language (`language` key of
  `~/.config/opencode/ocp.jsonc`, env detection fallback, live via
  `refreshLocale()` in `plugins/tui/i18n.ts`). Locale-invariant by design:
  `[plugin]` prefixes, `gate:`/`Status:` labels, ON/OFF, ACTIVE/INACTIVE,
  subcommand names, paths. LLM-facing fragments (system injections,
  protocol blocks, tool-guard block reasons, engine diagnostics) stay
  English — the model consumes them, not the user.
