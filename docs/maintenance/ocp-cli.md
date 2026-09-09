# OCP CLI Reference (`ocp` / `opencode-prime`)

After a one-time `register` (or a default install), the repo provisioned two global commands into `~/.local/bin`: `ocp` (3-letter quick form) and `opencode-prime` (full brand name). Both share the same dispatcher (`bin/opencode-prime` for bash, `bin/opencode-prime.ps1` for PowerShell 7+), so everything below works identically for each name.

> 💡 Since v0.8.0 the CLI doubles as a **runtime launcher**: running `ocp` with no arguments starts the OpenCode terminal UI instead of opening the installer dashboard. The dashboard is still one command away — `ocp dashboard`.

---

## Command List

| Command | Aliases | What it does |
| :--- | :--- | :--- |
| `ocp` *(no args)* | | Launch the **OpenCode terminal UI** (same as `ocp tui`) |
| `ocp tui` | | Launch the OpenCode terminal TUI (`exec opencode`); all extra args pass through to `opencode`. Add `--init` to create/activate the OCP project in the current directory before launching. |
| `ocp serve` | | Launch the headless OpenCode server (`opencode serve`); all extra args pass through (e.g. `ocp serve --port 4096`) |
| `ocp web` | | Launch the **OpenChamber web UI** (`openchamber serve`); auto-generates a `--ui-password`, auto-picks a free port starting at 3000 (see [port policy](#web-port-and-password-policy)) |
| `ocp code` | | Open the current project in **VS Code** (also probes `code-insiders` / `codium` / `cursor` / `windsurf`) with the OpenChamber editor extension guaranteed: `fedaykindev.openchamber` is auto-installed via the editor CLI when missing. Add `--init` to create/activate the OCP project before launching; a bare `.` passes through so VS Code opens the current folder |
| `ocp desktop` | `ocp ui` | Launch the **OpenChamber native desktop app** (a separate download from [openchamber.dev/download](https://openchamber.dev/download)). Add `--init` or pass `.` to create/activate the OCP project in the current directory, register it as an OpenChamber project, and then launch the desktop app. |
| `ocp project` | | Create or activate the OCP project in the current directory; opens the project wizard in an interactive terminal |
| `ocp project init` | | Create or activate the OCP project in the current directory: create baseline files when missing, sync + refresh indexes when already present |
| `ocp project index` | | Manually refresh existing code-intelligence indexes in the current project |
| `ocp project sync` | | Append newly added template switches to the existing project config (append-only, never overwrites) |
| `ocp usage [--all\|.\|sessionId]` | | Open the token and cost usage view for every project (default), the current directory, or one session |
| `ocp install` | | Apply the current version's manifest to the target (`~/.config/opencode` by default) |
| `ocp update` | | Check the suite (newest `install/version.json` on `main` vs what is installed in `~/.config/opencode`) **and** the companion tools (`opencode`, `openchamber`). Every available update is selected by default — on an interactive terminal press Enter to apply it or `n` to skip it. Add `-y` to apply ALL pending updates without prompting (safe for scripts/cron); add `--check-only` to probe versions and apply nothing (this is also the default when run non-interactively without `-y`) |
| `ocp upgrade` | | Pull the latest release and re-apply the installer: `git pull --ff-only` for git clones, otherwise download `opencode-prime-latest.{tar.gz,zip}` from GitHub Releases (same source as the one-liner quick install; set `OCP_RELEASE_MIRROR` to a ghproxy-style prefix as fallback). Add `--force` to re-apply even when already up to date |
| `ocp init` | | Backup + clear the entire target directory for a fresh start |
| `ocp uninstall` | | Remove the installed version's manifest files from the target |
| `ocp status` | | Show installed vs repo version |
| `ocp register` | | Install global shims (`opencode-prime`, `ocp`) into `~/.local/bin` **and** ensure that directory is on your `PATH` |
| `ocp unregister` | | Remove the global shims from `~/.local/bin` |
| `ocp wizard` | `ocp menu` | Interactive TUI setup wizard (first-run and reconfigure flows) |
| `ocp dashboard` | `ocp cc`, `ocp matrix` | Single-screen TUI control center — toggle MCP servers / plugins / RTK, cycle agent model tiers, then install |
| `ocp provider` | | Manage model providers — bare command runs the standalone `/provider` dialog wizard (add, import, edit, delete); `ocp provider list` prints configured providers without a TTY |
| `ocp profile` | | Manage model-tier profiles — bare command runs the standalone `/profile` dialog wizard; `ocp profile list`, `ocp profile apply <name>` and `ocp profile reset --yes` run without a TTY (bare `profile reset` asks for confirmation first) |
| `ocp session list` | | List sessions (passthrough to `opencode session list`) |
| `ocp session delete` | | Delete a session by ID (passthrough to `opencode session delete`) |
| `ocp session clean` | | Delete old sessions via `opencode session delete`. Usage: `ocp session clean --days 7 [--dry-run] [-y] [--project <id|name>] [--directory <path>]` |
| `ocp auth open` | | Open OpenCode's `auth.json` in the default editor; creates an empty file if it does not exist |
| `ocp version` | `ocp --version`, `ocp -v` | Print the repo's current version (`install/version.json`) |
| `ocp help` | `ocp -h`, `ocp --help` | Print the command help |
| *(anything else)* | | Falls through to `install.ps1` / `install.sh`, so unknown flags and future subcommands keep working after an upgrade |

---

## Launcher Subcommands in Detail

### `ocp provider` and `ocp profile`

With no subcommand, both commands run the same standalone dialog wizard used by `/provider` and `/profile`.
Model catalogs go through a shared OpenCode bridge: the built-in TUI uses OpenCode's SDK bridge; the standalone CLI uses the `opencode` CLI bridge (`models --verbose`); when the bridge is unavailable the wizards automatically fall back to `models.dev` and the local config file. Interaction and slash commands remain identical.
The interactive flow matches the slash-command experience, including nested menus, confirmations, and Esc back navigation.

Non-interactive commands are `ocp provider list`, `ocp profile list`, `ocp profile apply <name>`, and `ocp profile reset --yes`.
On a non-TTY, interactive mode exits with code 1 and prints the available alternatives; `profile reset` requires `--yes`.

### `ocp tui` — terminal UI

Requires `opencode` on PATH (the installer provisions it). Every argument after `tui` is passed to `opencode` verbatim:

```bash
ocp tui                     # plain terminal UI
ocp tui --version           # opencode's own --version
ocp tui --init              # init/activate current project, then open TUI
```

By default, `ocp tui` routes through a Herdr workspace (equivalent to `ocp herdr`). Set `"tui_mode": "direct"` in `install/options.jsonc` to launch `opencode` directly in the current shell instead. Herdr mode auto-enables `tools.herdr` if it is not already enabled.

CLI overrides (one-shot, take precedence over `tui_mode`):

```bash
ocp tui --direct            # force direct (opencode in current shell)
ocp tui --herdr             # force herdr workspace for this invocation
```

Bare `ocp` (no args) always opens `opencode` directly — it bypasses both `tui_mode` and the `--herdr`/`--direct` overrides.

### `ocp serve` — headless server

Pure passthrough to `opencode serve`. Handy for ACP/HTTP clients that talk to a running engine:

```bash
ocp serve                   # opencode picks a random port by default
ocp serve --port 4096       # pin the port
```

### `ocp web` — OpenChamber web UI

Requires the `openchamber` CLI (opt in to auto-provisioning with `"openchamber_web": true` in `install/options.jsonc`; needs Node.js 22+). Behavior:

- **Fresh session**: if an OpenChamber instance is already running, it is stopped first (a fresh `--ui-password` launch would otherwise die on the occupied port and leak a useless password);
- **Password**: a random UI password is generated and printed (`🔑 OpenChamber web UI password: ...`) unless you pass your own `--ui-password`;
- Extra args pass through to `openchamber serve`.

```bash
ocp web                     # auto free port (starting at 3000) + generated password
ocp web --port 3200         # pin the port (reclaimed from zombie daemons when possible)
ocp web --ui-password s3cret # bring your own password
```

#### Web port and password policy

| Situation | What `ocp web` does |
| :--- | :--- |
| No `--port` / `-p` / `--port=N` given | Picks the first **free** port in `3000–3199` and injects it |
| `--port 0` (random) requested | Resolved to the first free port in `3000–3199` too |
| Explicit port busy (zombie daemon holding it) | Runs `openchamber stop --port <n>`, waits up to 5s, then force-kills the listener **only if** its command line proves it is an OpenChamber process. If the port still cannot be reclaimed: the `ocp` / `opencode-prime` dispatcher exits with the blocking PID so you can `taskkill` / `kill` manually, while the TS-engine path (`install.ps1 web`) falls back to the next free port |
| OpenChamber already running | Stops the running instance and starts a fresh session with a new password |

### `ocp desktop` (alias `ocp ui`) — native desktop app

The Tauri-based desktop app is not usually on `PATH`, so the launcher probes the common install locations (Windows: `%LOCALAPPDATA%\Programs`, `%LOCALAPPDATA%`, `Program Files*`; Linux: `~/.Applications`, `/usr/local/bin`, `/opt`; macOS: `open -a OpenChamber` via LaunchServices). If it cannot be found, the error message points you to <https://openchamber.dev/download> — the installer never downloads the desktop app; it only provisions the `openchamber` **CLI** that powers `ocp web`.

```bash
ocp desktop                 # plain desktop app
ocp ui                      # same as above
ocp ui .                    # init/activate cwd, then open desktop app
ocp ui --init               # same as `ocp ui .`
```

When `.` or `--init` is used, the launcher:

1. Runs `ocp project init` in the current directory (creates baseline files if missing, syncs + refreshes indexes if present).
2. Registers the current directory as an OpenChamber project and makes it active:
   - **OpenChamber not running** — the project is written directly into `~/.config/openchamber/settings.json` (same schema and id format OpenChamber uses), then the desktop app launches with the project visible in the sidebar on first render.
   - **OpenChamber already running** — the project is registered via `POST /api/opencode/directory` and the app is opened/focused either way. On an interactive terminal, OCP then offers to **restart OpenChamber** so the app reopens with the project already in its list (the deterministic option — activation is on disk before the window loads). Decline (or non-TTY) and OCP instead verifies the registration for a few seconds and re-registers if the running window's stale in-memory project list overwrites it; press Ctrl+R in the window to load it now.

OpenChamber's own API never pushes project-list changes to a running UI, which is why the not-running path seeds the settings file before launch.

### `ocp code` — VS Code with the OpenChamber extension

Opens the current project in VS Code, making sure the OpenChamber editor extension (`fedaykindev.openchamber` on the VS Code Marketplace, also on OpenVSX) is installed first — it powers the same OpenChamber review UI inside the editor.

Editor CLI resolution: `code` → `code-insiders` → `codium` → `cursor` → `windsurf` — the first resolvable CLI wins. On Windows the resolver goes through `where.exe` and picks the `.cmd` shim, so a GUI `Code.exe` that happens to shadow the CLI on PATH cannot silently swallow the extension checks.

- `--init`: scaffold/activate the OCP project in the current directory before launching (same as `ocp ui --init`).
- A bare `.` is **not** swallowed: VS Code itself interprets it as "open the current folder", so `ocp code .` passes it through.
- Every other argument is forwarded verbatim (`ocp code -n` opens a new window, `ocp code <dir>` opens that folder).
- A failed extension install never blocks the launch — it is reported and the editor still opens.
- Auto-install is disabled by default. Enable it with `"openchamber_vscode": true` in `install/options.jsonc`; when disabled, `ocp code` just opens the editor.

```bash
ocp code                 # open VS Code, ensure the extension, open nothing in particular
ocp code .               # same, and open the current folder
ocp code --init          # scaffold/activate the OCP project first, then open VS Code
ocp code -n .            # open the current folder in a new window
```

---

## Project Subcommands

`ocp project` is a terminal mirror of the `/project` slash command family. It operates on the **current working directory** (not the install target). With no subcommand, it runs `project init`; in an interactive terminal this opens the project wizard. For scripts, use `ocp project init --headless` to skip prompts.

| Command | What it does |
| :--- | :--- |
| `ocp project init` | Create baseline files when missing, or sync + refresh indexes when already present. Never overwrites existing files. Also registers GitNexus git hooks (`post-commit`, `post-merge`, `post-checkout`) when gitnexus is enabled; removes them when it is not. |
| `ocp project index` | Refresh existing code-intelligence indexes (`codegraph sync`, `gitnexus analyze` when stale). |
| `ocp project sync` | Append newly added template switches to the existing project config (append-only, existing content untouched). |

```bash
ocp project init            # create/activate project in cwd
ocp project index           # refresh indexes for existing project
ocp project sync            # append missing template switches
```

---

## Usage

`ocp usage [--all|.|sessionId]` opens the token and cost usage view:

| Argument | Scope |
| :--- | :--- |
| *(none)* or `--all` | All projects (default) |
| `.` | The current working directory |
| `<sessionId>` | One specific session |

```bash
ocp usage                 # inspect usage across every project
ocp usage .               # inspect usage for the current directory
ocp usage <sessionId>     # inspect one session directly
```

---

## Installer Subcommands

`install` / `update` / `upgrade` / `init` / `uninstall` / `status` are thin wrappers over `install.ps1` / `install.sh` (the same TypeScript engine). Common flags that pass through:

| Flag | Aliases | Meaning |
| :--- | :--- | :--- |
| `-Target <dir>` | `--target`, `-t` | Override the install target directory (default `~/.config/opencode`) |
| `-Force` | `--force`, `-f` | Reapply every manifest file even if unchanged |
| `-BinDir <dir>` | | Custom directory for `register` / `unregister` shims (default `~/.local/bin`) |

```bash
ocp install                 # normal install / upgrade (credentials preserved)
ocp install -Force          # force reapply all files
ocp install -t ~/oc-test    # install into a scratch target
ocp register -BinDir ~/bin  # shims into a custom directory
```

### `register` and `unregister`

`register` now does two things: it writes the three shims into the bin directory, **and** makes sure that directory resolves in new terminals — by appending it to your user `PATH` (Windows registry, via `[Environment]::SetEnvironmentVariable` — never `setx`, so long PATH values are safe) or to your shell profile (`~/.zshrc`, `~/.bashrc` or `~/.profile`, guarded by a managed marker). `unregister` removes the shims; it does not touch your `PATH`.

### `ocp session` — session management

Unified session management surface. `list` and `delete` pass through to the `opencode` CLI verbatim; `clean` adds batch cleanup by date.

#### Passthrough commands

```bash
ocp session list                        # list recent sessions
ocp session list --format json -n 20    # JSON output, last 20
ocp session delete <sessionID>          # delete a specific session
```

#### `ocp session clean` — batch cleanup

Delete old sessions via the official `opencode session delete` CLI — no direct database access, all storage operations go through the engine. Requires `opencode` on PATH.

| Flag | Aliases | Meaning |
| :--- | :--- | :--- |
| `--days <n>` | `-d <n>` | Delete sessions older than *n* days (default: 7) |
| `--all` | | Delete every session in the current workspace, including subagents. Requires confirmation even with `-y`. |
| `--projects` | | With `--all`, delete sessions across every saved project. Cannot be combined with `--project`, `--directory`, or `--cwd`; always requires confirmation. |
| `--all-projects` | | Shorthand for `--all --projects`. |
| `--project <id\|name>` | | Delete sessions by `project_id` or project path/name. If the value is not a 40-char hex ID, it is resolved against `directory`. |
| `--project-name <name>` | | Alias for `--project` when passing a name/path instead of an ID |
| `--directory <path>` | `--dir <path>` | Delete sessions whose workspace path matches exactly. Use `--cwd` to match the current directory. |
| `--cwd` | | Match the current working directory (shorthand for `--directory <cwd>`) |
| `--dry-run` | | Preview what would be deleted without actually deleting |
| `--include-subagents` | | Also delete subagent (child) sessions (default: excluded) |
| `-y`, `--yes` | | Skip the confirmation prompt |

```bash
ocp session clean --dry-run             # preview — what would be deleted?
ocp session clean --days 3              # delete sessions older than 3 days
ocp session clean --days 30 -y          # delete sessions older than 30 days, no prompt
ocp session clean -d 7 --include-subagents  # include subagent sessions
ocp session clean --cwd --days 1        # clean sessions from the current workspace
ocp session clean --all --projects --dry-run  # preview deletion across every project
ocp session clean --all --projects      # delete every session across every project (requires confirmation)
ocp session clean --all-projects        # shorthand for --all --projects
ocp session clean --project <project_id> --days 7  # clean sessions for a specific project
ocp session clean --project opencode-prime --days 7  # clean by project path/name
```

The command prints a summary before deleting: session count, age breakdown, token totals, and up to 10 sample session titles. Deletion is performed via `opencode session delete` (the official CLI), so all storage operations go through the engine — no direct database access.

---

## Provider and profile commands

These commands share state and core logic with the TUI `/provider` and `/profile` commands.

```bash
ocp provider list             # list configured providers
ocp provider                  # add, import, edit, or delete providers
ocp profile list              # list installed profiles
ocp profile apply <name>     # apply a profile and write opencode.jsonc
ocp profile reset            # confirm and remove model references
ocp profile                  # select and apply a profile interactively
```

`provider` manages provider definitions and credentials. `profile` manages profile files, tier mappings, and model references. `list` and `profile apply <name>` work without a TTY; interactive actions and `profile reset` return a usage error when stdin or stdout is not a TTY.

## Related Pages

- [Installation & Options](/maintenance/options) — installer commands, `options.jsonc` switches (including `global_commands` and `openchamber`), and preserved fields
- [Quick Install & Dashboard](/getting-started/) — first install and the TUI control center
- [Clients & UI Options](/getting-started/clients) — TUI / Web / Desktop surfaces side by side
