# Wizard Refactor — Phase 1 Schema Split (REVISED)

**Status**: revised 2026-09-11 — schema split **walked back**; Phase 1A no longer
includes schema split. The original schema-split design below is kept as a
design record for future reference but is NOT being implemented in this
iteration. Phase 1A now scopes to: helper extraction + project-wizard
group-based UI rewrite (config schema unchanged).

**Date**: 2026-09-11
**Scope**: project-level `.opencode/opencode.jsonc` only (unchanged)

## Why the schema split was walked back

The schema-split design below solves real problems (group-aligned files,
diff isolation, easier wizard groupings), but the user opted for a smaller
Phase 1A scope after seeing the plan: keep the schema unchanged and focus
the iteration on the wizard UI itself. The motivation for the split is
recorded here so future contributors can revisit when group-aware config
files become a real pain point (currently they are not — the project is
small enough that one `opencode.jsonc` is fine).

## Problem

`.opencode/opencode.jsonc` is a single file mixing all project-level configuration: advisor mode, ADR guard, env guard, e2e guard, ADR directory, ADR mode. This is awkward because:

1. **Wizards (project-wizard.ts, future provider-wizard / profile-wizard refactors) want to group settings conceptually** (Identity / Advisors / ADR / Other guards / Project tooling / Index). Flat file → group-based UI must reverse-map fields to groups at every wizard load.
2. **Adding a new project-level setting** (e.g., coding-profile for the future plugin) requires editing the same file. Splitting by group gives each new setting a natural home.
3. **Diff readability**: a commit that touches only ADR-related settings currently shows up as changes to the whole project config, polluting history.

## Target Layout (Phase 1)

Three new files alongside `.opencode/opencode.jsonc` (which becomes the index/manifest):

```
.opencode/
  ├── opencode.jsonc         # index/manifest — points to group files; no real config
  ├── advisors.jsonc         # autoAdvisorMode
  ├── adr.jsonc              # adrGuard, adrGuardDir, adrMode
  ├── guards.jsonc           # envGuard, e2eGuard
  ├── (future) identity.jsonc
  ├── (future) coding-profile.jsonc
  └── (future) tooling.jsonc
```

**Why this split?** Group boundaries align with how project-wizard already groups them visually (advisor section / guards section) and how the plugins are organized in `plugins/` (auto-advisor / adr-guard / env-guard / e2e-guard).

**Why three groups, not six?** Six groups for six fields is over-fragmentation. Two related guards (env + e2e) share the same on/off mental model; ADR has its own three settings because adrMode and adrGuardDir are non-trivial. Advisors is alone because the values are different (off/lite/full vs on/off).

**Why a manifest file?** It documents the split for humans and provides a single file tools can read to know "this project follows the new schema." It also lets us add a `_schemaVersion` field for future migrations.

## File Format

Each group file uses the **same JSONC convention** as `.opencode/opencode.jsonc` today: comments allowed, trailing comma allowed. The first comment in each file is a header:

```jsonc
// .opencode/advisors.jsonc — autoAdvisorMode (off | lite | full | default)
// See /project-wizard → Advisors

"autoAdvisorMode": "lite"
```

OR for `default`:
```jsonc
// .opencode/advisors.jsonc — autoAdvisorMode (off | lite | full | default)
// See /project-wizard → Advisors

// "autoAdvisorMode": "lite",  // off | lite | full — /auto-advisor <mode>
```

**Why commented default?** It mirrors the current scaffold template (`templates/opencode.jsonc`) where defaults are commented out. This means the existing `applySwitchesToConfigContent` "default = commented line" logic translates 1:1 to the new files.

## Manifest (`opencode.jsonc`)

```jsonc
// .opencode/opencode.jsonc — project-level config index (schema v2)
// Group files in this directory:
//   advisors.jsonc — autoAdvisorMode
//   adr.jsonc      — adrGuard, adrGuardDir, adrMode
//   guards.jsonc   — envGuard, e2eGuard
// Edit via /project-wizard.

{
  "_schemaVersion": 2
}
```

The `_schemaVersion` field is the only active config in the manifest. It tells consumers which schema the project is on:
- `1` = legacy single-file (the current state)
- `2` = split-by-group (this design)

## Migration Path

### Auto-migration on first read

When `project-manager` reads a project's config:

1. If `.opencode/opencode.jsonc` exists AND `_schemaVersion: 2` → read split files, ignore manifest body.
2. If `.opencode/opencode.jsonc` exists AND no `_schemaVersion` (or schemaVersion !== 2) → **auto-migrate**: read all fields, write to split files, replace `opencode.jsonc` with the manifest.
3. If `.opencode/opencode.jsonc` does not exist → init scaffold writes the new layout directly (manifest + split files + comments).

Auto-migration is **one-shot** — once migrated, the project stays on v2. No re-migration triggers.

### What gets preserved during migration

- Field values: read from the old `opencode.jsonc` exactly as they were
- Comments on the old file (other than the field we're extracting): the migration utility keeps them in the manifest as a header block
- File ordering: not preserved (new files are written in deterministic order: advisors, adr, guards)

### Failure mode

If migration encounters a malformed old file (no closing brace, trailing content, parse error), the migration utility:
1. Does NOT write any new files
2. Leaves the old file untouched
3. Returns an error
4. The wizard reports: "Config is malformed; please fix it manually, then run /project-wizard sync."

This matches the existing behavior of `runSync()` for malformed files.

## Project-Manager Changes

### Read path (`detectProjectSwitches`)

```typescript
// New pseudocode
export function detectProjectSwitches(rootDir: string): DetectedProjectState {
  const manifestPath = join(rootDir, ".opencode", "opencode.jsonc")
  const legacyPath = join(rootDir, ".opencode", "opencode.jsonc")

  if (!existsSync(manifestPath)) return { exists: false, switches: defaultProjectSwitches() }

  const schemaVersion = readSchemaVersion(manifestPath)
  if (schemaVersion === 2) {
    // Read split files
    return readSplitSchema(rootDir)
  } else {
    // Auto-migrate legacy → v2
    const legacy = readLegacySchema(manifestPath)
    writeSplitSchema(rootDir, legacy.switches)
    writeManifest(rootDir)
    return { exists: true, ... }
  }
}
```

### Write path (`runInitWithSwitches`)

When writing switches, route each field to its group file:
- `autoAdvisorMode` → `advisors.jsonc`
- `adrGuard`, `adrGuardDir`, `adrMode` → `adr.jsonc`
- `envGuard`, `e2eGuard` → `guards.jsonc`

The `applySwitchesToConfigContent` function becomes `applySwitchesToGroupFiles(rootDir, switches)`.

### Sync path (`runSync`)

For a v2 project, sync adds any new template group files (and any new fields inside existing group files). The iron rule "never overwrite, append-only" applies per file.

For a v1 project, sync migrates to v2 first, then continues normally.

## Test Coverage (Phase 1)

- `tests/test-project-manager-schema-unit.ts` (new) — covers:
  - Read legacy → auto-migrate → read v2 → same result
  - Write to v2 → re-read → same result
  - Migration on malformed file → error, no writes
  - Sync adds new template fields without overwriting existing values
  - Manifest has correct `_schemaVersion: 2`

## Risks

1. **Race condition during migration**: if two processes read the legacy file simultaneously, both might try to migrate. Mitigation: atomic write via temp-file + rename; the migration is idempotent (re-running on already-migrated files is a no-op).
2. **Comments lost on migration**: non-field comments in the legacy file are moved to the manifest header, but their position/format may differ. Mitigation: the legacy file's content (minus the extracted fields) becomes a header comment block in the manifest, preserving user-written text.
3. **Existing test fixtures**: `tests/test-project-manager-*` files reference the old schema. They need updates to use the new layout (or include a fixture generator that creates both layouts).

## Phase 2 Forward Compatibility

The schema design supports future groups:
- `identity.jsonc` — `defaultAgent`, future user-level overrides
- `coding-profile.jsonc` — methodology choices (future coding-profile plugin)
- `tooling.jsonc` — dprint, formatters
- `runtime-tools.jsonc` — rtk, ripgrep, tgrep (currently in `install/options.jsonc`; Phase 2 may move some)

Adding a new group is purely additive: write a new `<group>.jsonc`, update the manifest header comment, add a template file under `plugins/project-manager/templates/groups/`. No breaking change to existing projects.
