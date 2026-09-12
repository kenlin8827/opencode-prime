---
status: accepted
date: 2026-09-12
layer: system
deciders: ken
---

# 0004 — OCP path contract: `.opencode/` → `.ocp/`, `ocp.jsonc` → `ocp.json`

## Status: accepted (v2 — no runtime fallback; one-shot migration at init)

## Context and Problem Statement

OCP-owned artifacts (plugin switches, memory, handoffs, logs, style
overrides) currently live inside `.opencode/` — a directory the OpenCode
platform also owns (config merging, `themes/`, `agent/`/`command/`/
`plugin/`/`skill/` discovery). Mixing OCP state into a platform namespace
means every OCP write potentially touches a file the platform reads, and
the platform's own evolution can collide with OCP conventions.

Confirmed user decisions (not re-litigated here):

1. Global OCP user config renames `~/.config/opencode/ocp.jsonc` →
   `~/.config/opencode/ocp.json` (location unchanged).
2. **No runtime compatibility.** Reads resolve from exactly one location
   (`.ocp/ocp.json`, global `ocp.json`). Legacy state is moved by a
   **one-shot migration executed at project initialization** (the
   project-init flow / TUI wizard) and, for the global file, by the
   installer.
3. Platform files stay untouched: `opencode.jsonc` (root, `.opencode/`,
   `~/.config/opencode/`) remains OpenCode's. Only OCP-plugin-read config moves.

Verified code facts this design builds on:

- Single choke point for project config IO: `plugins/shared/opencode-prime.ts`
  — `projectConfigFiles()`, `writableProjectConfigFile()`,
  `readProjectConfig()`, `setConfigField`/`clearConfigField`,
  `ensureOpencodeGitignore`, `getProjectLogDir`, `getProjectHandoffDir`.
  All five switch plugins (auto-advisor, adr-guard, env-guard, e2e-guard,
  project-memory) route through `plugins/shared/plugin-switch.ts`.
- `plugins/tui/sidebar-status.ts:181-200` duplicated the config reader
  privately — consolidated into the shared module.
- Global config: `plugins/shared/ocp-config.ts:30-34`
  (`~/.config/opencode/ocp.jsonc`, `OCP_CONFIG_PATH` override).
- Scaffold: `project-manager-config.ts:57` `CONFIG_REL =
  ".opencode/opencode.jsonc"`; template map `project-manager-scaffold.ts:70-74`.
- Installer already uses `.ocp` for global state: `install/src/installer.ts:102`
  (`OCP_STATE_DIR = '.ocp'`, `installed.manifest.txt`).
- `.opencode/themes/` is platform-read: `install/src/ui/opencode-theme.ts:136`
  mirrors opencode's hierarchy — themes **stay**.
- Handoffs are written by agents following skill text (`skills/handoff/`,
  `skills/sdd-workflow/`), not by plugin code.
- `scripts/serena-workspace-daemon.mjs` writes
  `<workspace>/.opencode/logs/serena.log` + bootstraps `.opencode/.gitignore`.
- `deepseek-anchor-config.ts:18-20` and `auto-advisor-runtime.ts:207-260`
  read **platform-owned** surfaces (global `opencode.jsonc` `deepSeekAnchor`
  key, project `agent`/`model` keys) — out of migration scope.

## Decision Drivers

- **Platform sovereignty** — `.ocp/` is 100% OCP; `.opencode/` is 100% platform.
- **Single source of truth at runtime** — no fallback chains, no merge
  precedence, no dual-era reads. One file, one path, per artifact.
- **Explicit, user-triggered migration** — the project-init wizard and the
  installer are the only places legacy paths are touched; a one-shot,
  idempotent move the user can see in the wizard output.
- **Token budget (AGENTS.md §2)** — shipped skill edits are line-for-line
  path substitutions, net-zero.

## Considered Options

1. **Runtime read-fallback chain (per-key merge)** — rejected by user
  decision: every read path would carry two-era logic forever; transitional
  split-brain; tests must pin precedence rules that no design doc can make
  obvious to users.
2. **Dual-write (mirror every write into legacy files)** — rejected: writes
   into platform files forever.
3. **One-shot migration at project init + hard cutover at runtime** — chosen.
   Cost: users who upgrade OCP but never re-run `/project init` (or the
   wizard) lose their project switches until they do. Accepted explicitly;
   release notes MUST surface it, and the wizard/init flow is the repo's
   existing entry point for project setup anyway.

## Decision

### 1. Target layout

**Project scope** (`<project>/`):

| Current path | New path | Disposition |
|---|---|---|
| `.opencode/opencode.jsonc` / root `opencode.jsonc` — OCP switch keys (`autoAdvisorMode`, `adrGuard`, `adrLayout`, `adrDir`, `envGuard`, `e2eGuard`, `projectMemory`) | `.ocp/ocp.json` | **moves** at init migration (keys copied in, removed from legacy files) |
| `.opencode/memory/public.md`, `private.md` | `.ocp/memory/*` | **moved** at init migration (fs rename; merge-append if target exists) |
| `.opencode/handoffs/` | `.ocp/handoffs/` | **moved** at init migration (whole dir; skipped if target exists) |
| `.opencode/logs/`, `.opencode/dev-ultra-state.md` | `.ocp/logs/`, `.ocp/dev-ultra-state.md` | disposable — runtime uses new path only; dir move best-effort |
| `.opencode/md-to-pdf.css`, `md-to-docx.css`, `md-to-docx.docx` | `.ocp/*` | **moved** at init migration (per-file, skipped if target exists) |
| `.opencode/.gitignore` (OCP bootstrap) | `.ocp/.gitignore` | **moves** (legacy file frozen — never written again) |
| `.opencode/recovery/` (docs convention only) | `.ocp/recovery/` | docs text only |
| `.opencode/themes/` | — | **stays (platform)** — opencode reads it (`opencode-theme.ts:136`) |
| `.opencode/opencode.jsonc` / root `opencode.jsonc` as platform config (`$schema`, `agent`, `mcp`, …) | — | **stays (platform)** — OCP never writes it |
| `.opencode/{agent,command,plugin,skill}/` | — | **stays (platform discovery)** |

**Global scope** (`~/.config/opencode/`):

| Current | New | Disposition |
|---|---|---|
| `ocp.jsonc` | `ocp.json` | **renamed** by installer one-shot (rename if `ocp.json` absent; skip+warn if both) |
| `opencode.jsonc`, `project-hooks.jsonc`, `themes/` | — | **stay (platform / out of scope)** |
| `.deepseek-anchor-enabled`, `.active-profile` | — | **stay (out of scope)** — dotfiles, not `.opencode/` artifacts |
| `.ocp/installed.manifest.txt` | — | **already `.ocp`** (`installer.ts:102`) |

**Repo scope**: root `.gitignore` gains `.ocp/`.

### 2. Resolution algorithm

```
readProjectConfig():   parseJsonc(<p>/.ocp/ocp.json)      # the ONLY source; null if absent
writableProjectConfigFile() = <p>/.ocp/ocp.json           # unconditional
setConfigField(k, v):  mkdir .ocp/ + ensureOcpGitignore() on first create; pure-JSON upsert
clearConfigField(k):   remove key from .ocp/ocp.json only

ocpDir(root):          OCP_PROJECT_DIR env (user amendment): MUST be a project-
                       RELATIVE path → <root>/<env>; unset/empty/absolute →
                       <root>/.ocp (absolute values are ignored — the override
                       exists to dodge tool collisions inside the project, not
                       to relocate state out of it).
                       — THE single choke; every helper derives from it

ocpConfigPath():       OCP_CONFIG_PATH env → $XDG_CONFIG_HOME/opencode/ocp.json
                       → ~/.config/opencode/ocp.json      # the ONLY global source
```

Artifacts: `ocpArtifactPath(rel)` = `<root>/.ocp/<rel>` — one path, no
lookup chain. Reads that need "does the user have an override" stat exactly
this path.

### 3. One-shot migration (the only legacy-path code)

`migrateLegacyProjectArtifacts(root)` in `plugins/shared/opencode-prime.ts`,
invoked at the start of project init — `runInit`, `runInitWithSwitches`,
the TUI wizard's save path, and the wizard's OPEN (before switch detection,
so detection reads migrated truth; opening the wizard is itself the
user-triggered setup action, and the migration is idempotent + non-destructive)
— before scaffolding new files:

```
1. switches: for each OCP switch key found in <root>/.opencode/opencode.jsonc,
   .opencode/opencode.json, opencode.jsonc, opencode.json (legacy→new order,
   newest wins per key): copy into .ocp/ocp.json, then removeConfigField()
   from the legacy file (re-comment via existing text surgery; platform keys
   and comments preserved).
2. memory: fs-rename .opencode/memory/{public,private}.md → .ocp/memory/
   (if target exists: append, then delete source).
3. style overrides: rename md-to-pdf.css / md-to-docx.css / md-to-docx.docx
   (skip if target exists).
4. handoffs/: rename whole dir if .ocp/handoffs absent.
5. result: return a migration report { switchedKeys, movedFiles, skipped }
   surfaced in wizard/init output so the move is visible, not silent.
Idempotent: second run finds nothing (legacy files have no OCP keys after
step 1; moved files no longer exist). Never throws; read-only fs degrades
to a warning line like setConfigField.
```

Installer (`install/src/installer.ts`, step 5.5 after config merge): the
destination is always the runtime-resolved dir
(`$XDG_CONFIG_HOME||~/.config/opencode`, mirroring `ocpConfigPath()` —
keep-in-sync cross-ref comment): in-place rename when only the legacy file
exists there; wrong-base rescue (move `targetDir/ocp.jsonc` →
runtime `ocp.json`) when the legacy sits under `OPENCODE_CONFIG_DIR` only;
collision (both files) → warn, keep both; never delete, never throw.

### 4. Central API — `plugins/shared/opencode-prime.ts` (extended)

The path contract lives in exactly one module; consumers import, never
hardcode. (The serena daemon is the documented plain-js mirror — standalone
`.mjs`, shipped without the plugin tree.)

```ts
export const OCP_DIR = ".ocp"
export const OCP_CONFIG_REL = ".ocp/ocp.json"

export function ocpDir(root = getProjectDir()): string
export function ocpConfigFile(root = getProjectDir()): string
export function readProjectConfig(): Record<string, unknown> | null   // .ocp/ocp.json only
export function writableProjectConfigFile(): string
export function ensureOcpGitignore(root = getProjectDir()): void      // §5 bootstrap + heal
export function getProjectLogDir(root?): string                       // .ocp/logs (+ensure)
export function getProjectHandoffDir(root?): string                   // .ocp/handoffs (+ensure)
export function ocpArtifactPath(rel: string, root?): string           // <root>/.ocp/<rel>
export function migrateLegacyProjectArtifacts(root?): MigrationReport // §3 one-shot
```

Removed (`cp-delete`): `ensureOpencodeGitignore`, `projectConfigFiles`
(single-path read replaces the list), `readProjectTemplate` + the
`templates/opencode.jsonc` bootstrap dependency (pure-JSON config bootstraps
from `{}`).

`OCP_SWITCH_KEYS` (the §3.1 key set) is exported from this module — the
migration and `project-manager-options.detectProjectSwitches` share it.

Consumer wiring:

- `shared/ocp-config.ts` — `ocp.json` only (installer performs the rename).
- `project-memory-config.ts` — `memoryBaseDir()` → `ocpArtifactPath("memory")`;
  single-path reads; `ensurePrivateIgnored` duplication deleted →
  `ensureOcpGitignore` (closes the standing P2 drift-watch item).
- `md-to-pdf/engine.ts`, `md-to-docx/engine.ts` — stat `ocpArtifactPath(...)`.
- `tui/sidebar-status.ts` — private reader deleted → shared import; scaffold
  row counts `.ocp/ocp.json` + `docs/git-commits.md` + `AGENTS.md`.
- `project-manager-config.ts` — `CONFIG_REL = OCP_CONFIG_REL`;
  `SCAFFOLD_TARGETS = [".ocp/ocp.json", "docs/git-commits.md", "AGENTS.md"]`;
  `.opencode/opencode.jsonc` no longer scaffolded (platform file; its only
  scaffold purpose was carrying OCP switches).
- `project-manager-scaffold.ts` — `TEMPLATE_FILES` maps `.ocp/ocp.json` →
  new `templates/ocp.json` (minimal pure JSON; absent keys = defaults).
  Init paths call `migrateLegacyProjectArtifacts()` first. The
  commented-line top-up machinery (`extractSwitchLines`,
  `mergeSwitchLines`) retires — a pure-JSON config needs no template
  top-up; `/project sync` repurposes to "run the §3 migration on demand"
  (explicit re-invocation for users who skipped the wizard).
- `adr-guard/adr-engine.ts` — `IGNORED_DIRS` gains `".ocp"`.
- `scripts/serena-workspace-daemon.mjs` — `.ocp/logs/serena.log` +
  `.ocp/.gitignore` bootstrap (plain-js mirror).

### 5. Edge cases

- **`.ocp/.gitignore` bootstrap** (single source `ensureOcpGitignore`; heal
  branch appends missing lines):

  ```
  .gitignore
  logs/
  *.log
  handoffs/
  memory/private.md
  dev-ultra-state.md
  ```

  Deltas vs the `.opencode/` bootstrap: drops `node_modules`/lockfiles
  (plugin-dependency install only ever happens in `.opencode/`); **adds
  `dev-ultra-state.md`** (the shipped skill already claims it is
  git-ignored — pre-existing inconsistency, fixed here). `ocp.json` and
  `memory/public.md` are deliberately NOT ignored — committed, team-shared.
- **themes/** — stays `.opencode/themes/` (platform-read). No `.ocp/themes/`.
- **Migration on a project with `.ocp/` already populated** — §3 per-item
  "skip if target exists" makes re-runs safe; switch-key copy prefers the
  new value (copy only keys absent from `.ocp/ocp.json`? No — legacy→new
  newest-wins per key during copy, matching the order the old chain
  produced).
- **Hand-edited comments in `.ocp/ocp.json`** — reads tolerate JSONC
  (`stripJsonc`); upsert/remove preserve comments via the existing text
  surgery.
- **Read-only project dir** — never-throw `SetConfigResult` degradation is
  kept; migration emits warnings instead.
- **Users who never re-init** — switches read defaults until the wizard
  runs once. This is the accepted cost of decision 2; release notes state
  it, `/project sync` offers the on-demand escape hatch.
- **Downgrade** — older OCP versions do not read `.ocp/`. Accepted lossy by
  design.

### 6. Impact checklist (phases 2–5)

**Phase 2 — plugins/ (+ shipped runtime script)**

- `plugins/shared/opencode-prime.ts` — single-path reads/writes,
  `ensureOcpGitignore`, artifact helpers, `OCP_SWITCH_KEYS`,
  `migrateLegacyProjectArtifacts`; removals per §4.
- `plugins/shared/ocp-config.ts` — `ocp.json` only; pure-JSON writes; header
  comment update.
- `plugins/shared/plugin-switch.ts` — contract unchanged; source
  diagnostics reduced to `config | default`.
- `plugins/project-memory/` — single-path config; status/help text sweeps
  (no legacy-hint lines — fallback is gone).
- `plugins/project-manager/` — `CONFIG_REL`, `SCAFFOLD_TARGETS`,
  `templates/opencode.jsonc` → `templates/ocp.json`, init paths call the
  migration, `runSync` = on-demand migration, top-up machinery retired,
  `configExists`/`detectProjectSwitches` single-path.
- `plugins/md-to-pdf/engine.ts`, `plugins/md-to-docx/engine.ts` — single-path stat.
- `plugins/adr-guard/adr-engine.ts` — `IGNORED_DIRS += ".ocp"`.
- `plugins/tui/` — `sidebar-status.ts` (reader dedupe, scaffold row),
  `project-wizard.ts` (migration call on save, `CONFIG_REL` import),
  `i18n.ts` (path strings, migration report lines; drop legacy-hint keys).
- `plugins/sdd/sdd-command.ts` — `.ocp/handoffs/` text.
- Doc-comment sweeps: `auto-advisor/*-config.ts`, `env-guard/*-config.ts`,
  `e2e-guard/*-config.ts`.
- `scripts/serena-workspace-daemon.mjs` — `.ocp/logs` + gitignore mirror.

**Phase 3 — installer / repo root**

- `install/src/installer.ts` — global `ocp.jsonc → ocp.json` one-shot rename
  (skip+warn on collision); confirm `.ocp` state dir untouched.
- `install/src/ui/app.tsx` comment sweep; `bin/` verified clean.
- Repo `.gitignore` — add `.ocp/`.
- `scripts/capture-wizard-screenshot.ts` fixture text.

**Phase 4 — tests (bun)**

- Path/expectation updates: `test-project-memory-unit.ts`,
  `test-project-manager-unit.ts` (scaffold target `.ocp/ocp.json`; the old
  "no second config spawned" pin **inverts** — write-new is the policy),
  `test-env-guard-unit.ts`, `test-e2e-guard-unit.ts`,
  `test-sidebar-status-unit.ts`, `test-sidebar-tgrep-badge.ts`,
  `test-wizard-helpers-unit.ts`, `test-md-to-pdf-unit.ts`,
  `test-md-to-docx-unit.ts`, `test-ocp-config-unit.ts`,
  `test-ocp-ui-render.tsx`, `test-ocp-busy-alert-render.tsx`,
  `test-usage-unit.ts`, `installer.test.ts` (global rename step),
  `tests/test-all.ps1` path sweep.
- New pins (one minimal check each): migration moves switches + removes
  them from legacy files (platform keys/comments preserved); migration
  idempotent (second run = no-op report); memory file rename;
  `ensureOcpGitignore` content (incl. `dev-ultra-state.md`);
  `setConfigField` creates `.ocp/ocp.json` pure JSON; installer rename
  skip-on-collision.

**Phase 5 — shipped skills + docs (line-for-line path substitution)**

- `skills/handoff/SKILL.md`, `skills/sdd-workflow/SKILL.md`,
  `skills/memory-summarize/SKILL.md`, `skills/dev-ultra/SKILL.md`,
  `skills/md-to-pdf/SKILL.md`, `skills/md-to-docx/SKILL.md`.
- `docs/workflows/*` (plugins, commands, sdd, auto-advisor, dev-loops) +
  `docs/zh/workflows/*` mirrors; `docs/getting-started/project-init.md` + zh.
- `DEVELOPING.md` (`ocp.jsonc`, memory paths, architecture map).
- Next release: `install/versions/<v>.notes.md` — user-facing migration note
  (run `/project init` or `/project sync` once after upgrading; global file
  auto-renamed by installer; downgrade is lossy).
- `README.md` / `README.zh-CN.md` sweep if any `.opencode/` artifact mention
  is found.

## Consequences

- **+** Runtime is dead simple: one path per artifact, zero precedence
  logic, zero dual-era reads.
- **+** Migration is explicit, user-triggered, visible in wizard output —
  and re-runnable via `/project sync`.
- **+** Dedupe: sidebar's private config reader and project-memory's
  duplicated gitignore bootstrap fold into the shared module (closes a
  standing P2 drift-watch item).
- **−** Upgrade without re-init = switches at defaults until the wizard or
  `/project sync` runs once. Accepted by user decision; documented in
  release notes.
- **−** `.json` extension forbids commented-switch documentation;
  discoverability shifts to wizard/`/project setup`/docs.
- **−** Downgrade is lossy by design.

## Open questions

1. Fold `.deepseek-anchor-enabled` / `.active-profile` global dotfiles into
   `ocp.json` keys? Recommend deferral.
2. Deprecation horizon for the migration code itself (legacy paths in
   `migrateLegacyProjectArtifacts` only): remove after 2 minor versions.

## Verification (design stage)

- Read-only design phase; no commands run. Claims verified by reading:
  `plugins/shared/{opencode-prime,ocp-config,plugin-switch}.ts`,
  `plugins/project-memory/project-memory-config.ts`,
  `plugins/project-manager/*`, `plugins/{auto-advisor,adr-guard,env-guard,e2e-guard,deepseek-anchor}/*`,
  `plugins/md-to-{pdf,docx}/engine.ts`, `plugins/tui/*`,
  `plugins/sdd/sdd-command.ts`, `install/src/{installer,merger}.ts`,
  `install/src/ui/opencode-theme.ts`, `scripts/serena-workspace-daemon.mjs`,
  `skills/**`, `docs/**`, `tests/**` (line refs cited inline).
- Implementation gate per phase: `bunx tsc --noEmit` + `bun test` green;
  before release: `pwsh scripts/pack.ps1 && pwsh scripts/verify.ps1`.

## References

- AGENTS.md §0 (architectural legitimacy), §2 (token budget), §3 (manifest flow)
- `instructions/coding-principles.md` — `cp-dataloss`, `cp-delete`, `cp-check`
- ADR 0002 (shared-helper consolidation precedent)
- `docs/reviews/2026-09-12-project-memory-v2.md` (gitignore-duplication P2)
