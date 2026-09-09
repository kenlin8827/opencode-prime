# 0001 — OCP CLI migration + `ocp ui .` OpenChamber activation

## Context
The `plugins/ocp/` slash command family (`/ocp project init|index|sync`,
`/ocp ui`, `/ocp tui`, ...) duplicated surface that belongs on the
terminal, and slash commands cannot reach companion tools (OpenChamber
desktop) because they run inside the agent.

## Amendment (2026-09-10) — `.` is no longer an init alias

The original decision aliased a leading bare `.` to `--init`
(`ocp tui .` / `ocp ui .`). Shipped as designed, it surprised users:
`ocp tui .` looked like "open the TUI here" but ran project
initialization — and via the bin dispatcher's `project init` detour it
even surfaced the interactive project wizard. Revised semantics:

- **Only an explicit `--init`** triggers project init/registration
  (`ocp tui --init`, `ocp ui --init`, `ocp desktop --init`).
- A bare `.` is a **stripped no-op** everywhere (`ocp tui .` ≡
  `ocp tui`); no provider CLI accepts it as an argument.
- Init handling lives in ONE place — the TS engine (`normalizeTuiPassthrough`
  for tui, `launchDesktop` for desktop/ui). The bin dispatcher never invokes
  `project init` itself and performs no init-specific argument rewriting.

## Decision

1. **Drop `plugins/ocp/` entirely.** Every command moves to the global
   `ocp` shim:
   - `ocp project init|index|sync` (terminal mirror of `/project`)
   - `ocp tui --init` / `ocp tui .` (scaffold + exec `opencode`)
   - `ocp ui --init` / `ocp ui .` (scaffold + register cwd in
     OpenChamber + launch the desktop app)
   - plain `ocp desktop` / `ocp ui` (launch unchanged)
2. **Dispatcher** (`bin/opencode-prime` + `.ps1`) normalises a leading
   `.` to `--init` and delegates to `install.sh|ps1 desktop|tui`. Bare
   `ocp ui` stays a plain launch.
3. **`install/src/{index,launcher}.ts`** becomes the single source of
   truth: the `project` CLI namespace, the `desktop` action wired to
   the new `launchDesktop`, and the runtime helpers that integrate with
   OpenChamber.
4. **`ocp ui --init` / `ocp ui .`** registers the current directory as
   an OpenChamber project before launching the desktop app:
   - **Server not running** — seed
     `~/.config/openchamber/settings.json` (project entry with the
     same id format and field names OpenChamber uses) then launch.
     First render shows the project.
   - **Server running** — `POST /api/opencode/directory` (the same
     endpoint OpenChamber's own *Add project* dialog uses). On an
     interactive terminal, offer to restart OpenChamber so the window
     reopens with the project already loaded (the running UI keeps its
     projects list in memory, seeded from a localStorage snapshot, and
     can overwrite the whole list on the next sidebar edit). Decline
     or non-TTY falls back to a short verify-and-restore loop.
   - **Already registered** — just open the app, no prompts.
5. **`install/install.sh|ps1`** add `desktop` and `project` to the
   info-command list so the OpenCode auto-install prompt never fires
   when the user runs the project/launcher subcommands.

## Consequences
- CLI is the canonical surface; slash command redundancy is gone.
- `ocp ui .` gives a one-step *open this folder in OpenChamber*.
- The running-window race (stale OpenChamber UI overwriting the
  project list) is mitigated, not solved — a real fix needs upstream
  changes (selective PUT or a server push on `persistSettings`).
- Direct edits to `~/.config/openchamber/settings.json` by OCP trust
  the seed path is only taken when no server owns the file; the
  server's `persistSettings` is a disk read-modify-write so a seed
  survives concurrent saves.

## Verification
- `bash -n bin/opencode-prime`, `[scriptblock]::Create(...)` parse —
  both clean.
- Unit tests: `test-project-manager-unit.ts` 126 passed,
  `test-project-wizard-unit.ts` 48 passed.
- End-to-end against the live OpenChamber instance: `ocp project init`
  on empty + existing dirs, `ocp ui --init`, `ocp ui .`,
  already-registered fast path, restart prompt under TTY, verify-and-
  restore after wipe.

## Related files
- `install/src/launcher.ts` — runtime launchers, OpenChamber
  integration (settings read, fast path, POST helper, prompt + kill).
- `install/src/index.ts` — CLI engine, `project` namespace, `desktop`
  action wired to `launchDesktop`.
- `bin/opencode-prime` + `.ps1` — global shim dispatcher.
- `install/install.sh|ps1` — info-command list.
- `install/versions/0.9.2.manifest.txt` — `plugins/ocp/*` removed.