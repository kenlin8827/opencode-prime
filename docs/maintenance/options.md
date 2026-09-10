# Installation & Options

Learn about installer commands, configuration options, token savings, and preserved fields.

---

## Commands

| Mode | PowerShell | Bash | What it does |
|---|---|---|---|
| Install (default) | `pwsh install/install.ps1` | `./install/install.sh` | Apply current manifest to target |
| Force reinstall | `pwsh install/install.ps1 install -Force` | `./install/install.sh install -f` | Re-apply same version |
| Status | `pwsh install/install.ps1 status` | `./install/install.sh status` | Show installed vs repo version |
| Init (fresh start) | `pwsh install/install.ps1 init` | `./install/install.sh init` | Backup + clear entire target directory |
| Register global cmd | `pwsh install/install.ps1 register` | `./install/install.sh register` | Install `opencode-prime` and `ocp` shims to `~/.local/bin` |
| Unregister global cmd | `pwsh install/install.ps1 unregister` | `./install/install.sh unregister` | Remove global shims |
| Launch TUI | `pwsh install/install.ps1 tui` | `./install/install.sh tui` | Launch the OpenCode terminal UI (`exec opencode`) |
| Launch desktop | `pwsh install/install.ps1 desktop` | `./install/install.sh desktop` | Launch the OpenChamber native desktop app (alias `ui`) |
| Launch web UI | `pwsh install/install.ps1 web` | `./install/install.sh web` | Launch the OpenChamber web UI (`openchamber --ui-password <generated>`) |

---

## Install Options (`options.jsonc`)

`install/options.jsonc` is the single source of truth for runtime options (MCP switches, external plugins, default agent, and the rtk compression proxy).

### Customizing Options Before Installing

1. **Enter the repository directory** (if cloned via Git or extracted from release archive):
   ```bash
   cd opencode-prime
   ```
2. **Edit `install/options.jsonc`** to set desired switches (`true` / `false`):
   ```jsonc
   // install/options.jsonc
   {
     // register global command shims (ocp / opencode-prime)
     // into ~/.local/bin and add that directory to the user PATH during install
     "global_commands": true,
     // Opt-in external binaries declared in install/tools.jsonc
     "tools": {
       // rtk output compression (60-90% token savings)
        "rtk": true,
        // Optional external full-text cache — OCP never downloads tgrep.
        // It is not MCP, LSP, or a code graph; .tgrep/ must stay uncommitted.
        "tgrep": false,
       // OpenChamber ships as three independent surfaces, one switch each:
        // Web UI CLI (@openchamber/web; powers `ocp web`, needs Node.js 22+)
        // Disabled by default: enabling it installs a global package.
        "openchamber_web": false,
       // Native desktop app for `ocp desktop` / `ocp ui` — always a separate
       // download (https://openchamber.dev/download); install only checks presence
       "openchamber_desktop": true,
       // VS Code extension for `ocp code` (auto-installs
        // fedaykindev.openchamber via the editor CLI when missing).
        // Disabled by default: enabling it modifies the editor.
        "openchamber_vscode": false,
        // Terminal workspace managers; the selected tui_mode is implied true.
        "herdr": false,
        "luvus": false
     },
     // Primary agent on start: lite (default, lean daily driver) / code (direct dev) / build (orchestrator) / plan (read-only)
     "default_agent": "lite",
     // MCP server switches (missing CLIs auto-provisioned on install)
     "mcp": {
       // Serena LSP semantic code retrieval & symbol analysis (needs uv / Python 3.13+;
       // default off — 23 tools ≈ 7.7k tok/step; enable when needed)
       "serena": false,
       // CodeGraph AST code knowledge graph (needs npm)
       "codegraph": true,
       // GitNexus code graph (PolyForm Noncommercial license; requires indexing)
       "gitnexus": false,
       // DBHub universal database gateway (PostgreSQL / MySQL / SQLite; needs npm)
       "dbhub": true,
       // Headroom context compression (Apache 2.0; heavy install — uv + Python 3.13,
       // first run downloads ONNX runtime + Kompress model; see core/mcp-servers)
       "headroom": false,
       // JetBrains IDE bridge (enable MCP Server in IDE: Settings → Tools → MCP Server)
       "idea": true
     },
     // External npm plugin switches (true: enabled; false: disabled)
     "plugin": {
       // Lazy coding protocol: build what was asked, name the lazier alternative
       "@dietrichgebert/ponytail": true,
       // Injects Qoder provider/models via official SDK (needs qoder login)
       "opencode-qoder-bridge": false,
       // Persistent project memory (vector store; extra LLM capture call per idle session)
       "opencode-mem@2.24.3": false
     }
   }
   ```
3. **Run the installer**:
   ```bash
   # macOS / Linux / WSL
   ./install/install.sh

   # Windows (PowerShell)
   pwsh install/install.ps1
   ```

### Modifying Options After Installation

Every install re-evaluates `install/options.jsonc` in place and enforces your choices onto `~/.config/opencode/opencode.jsonc`. To toggle any feature later:
1. Update `install/options.jsonc` in your local repository clone.
2. Re-run install with force flag (`install -Force` on PowerShell or `-f` on Bash) when the version is unchanged:
   ```powershell
   pwsh install/install.ps1 install -Force
   ```
   ```bash
   ./install/install.sh install -f
   ```

---

## Optional tgrep full-text index

`tools.tgrep` is **enabled by default**. OCP never downloads the external
[`tgrep`](https://github.com/tgrep/tgrep) CLI or changes `PATH`: until you
install it yourself, the `tgrep_search` tool stays hidden and every search
uses the native grep/ripgrep path, so the default costs nothing. Once the CLI
is on PATH, `/project init` creates the first local `.tgrep/` index;
`/project index` rebuilds only an existing unhealthy index. A healthy
`tgrep serve .` watcher handles normal updates. Set `tools.tgrep` to `false`
to opt out entirely.

Use indexed search only for repeated broad text/regex queries. After saving,
while validating a change, or before asserting there are no matches, use a
current/full scan (`tgrep --no-index` or `rg`) because watcher updates are
asynchronous. Keep the default 64 MiB tgrep file-size policy and index/serve/
search parameters consistent. tgrep does not replace Serena symbol navigation
or CodeGraph/GitNexus relationship queries.

If the on-disk index was built under a different policy (`indexPath`,
`maxFileSize`, `exclude`, `noRequireGit`) or a different tgrep version, OCP
reports it as `stale`: indexed searches fall back to full scans until
`/project index` rebuilds it, so results never violate the configured policy.
The `tgrep_search` tool accepts gitignore-style `glob` filters in addition to
`-i`/`-F` flags.

### Verification and benchmark (opt-in)

OCP's normal test run never downloads a binary. After installing a fixed,
user-controlled tgrep version, run `OCP_TGREP_BIN=tgrep bun run
tests/test-tgrep-integration.ts` (PowerShell: `$env:OCP_TGREP_BIN = "tgrep"`)
to verify the actual CLI contract. Measure a repository locally with `bun run
scripts/benchmark-tgrep.ts <repo> <literal>`; retain the JSON output alongside
the tgrep version and repository revision before claiming a performance gain.

---

## Plugin Pre-warming Cache (Ensure-Plugins)

To avoid startup stalls during the first OpenCode launch caused by online package downloads, the installer auto-detects local package managers (`bun` > `npm` > `pnpm`) and pre-warms enabled external plugins into OpenCode's native cache directory (`~/.cache/opencode`).

- **Zero Config Directory Pollution**: Plugin caches reside strictly in OpenCode's data directory, keeping `~/.config/opencode` clean for manifest-based updates and uninstalls.
- **Graceful Fallback**: If no package manager is installed or the network is offline, the installer gracefully skips pre-warming without failing the installation. OpenCode will download them upon launch as usual.

---

## Token savings (rtk)

Install auto-provisions [rtk](https://github.com/rtk-ai/rtk) — a CLI proxy that compresses command output (git status, test runs, builds, ...) by 60-90% before it reaches the model.

If `rtk` is not on PATH, the installer downloads the pinned release into `~/.local/bin` (SHA256-verified, added to user PATH on Windows). The opencode hook ships in-tree as `plugins/rtk-write.ts`.

To opt out: set `"rtk": false` in `install/options.jsonc` and re-run install.

---

## Workspace-wrapped TUI (`ocp tui`)

The setup wizard lets you choose the workspace integration behind `ocp tui`: **Herdr** or **Luvus**. Bare `ocp` always launches OpenCode directly in the current shell.

| Mode | Integration | What OCP configures |
|---|---|---|
| `"herdr"` *(default)* | [Herdr](https://herdr.dev) | A workspace rooted at the current directory; OCP provisions Herdr, its OpenCode integration, and the bundled auto-start plugin. |
| `"luvus"` | [Luvus](https://luvus.dev) | A workspace rooted at the current directory; OCP runs Luvus's official installer, provisions its OpenCode session integration, and links the bundled auto-start module (every new tab/pane boots opencode), falling back to an explicit OpenCode agent start at launch. |
| `"direct"` | None | OpenCode runs in the current shell. |

Choose the default in the wizard or set it manually:

```jsonc
// install/options.jsonc
"tui_mode": "luvus"   // "direct" | "herdr" (default) | "luvus"
```

Selecting a workspace mode auto-enables its matching `tools` entry, even when it was explicitly `false`. For a one-off override, use `ocp tui --direct`, `ocp tui --herdr`, or `ocp tui --luvus`.

---

## OpenChamber (`ocp desktop` / `ocp web` / `ocp code`)

Install can provision [OpenChamber](https://openchamber.dev) — the GUI layer that runs on top of the local OpenCode engine (side-by-side diffs, multi-model comparison, session timeline). It ships as **three independent surfaces**, each behind its own `tools.openchamber_*` switch. Web and VS Code are opt-in by default:

| Switch | Surface | What install does |
|---|---|---|
| `tools.openchamber_web` | **Web** — `@openchamber/web` CLI powering `ocp web` | **Default: false.** When enabled, installs the package globally via the first package manager found (pnpm > bun > yarn > npm) when the `openchamber` binary is missing (needs Node.js 22+) |
| `tools.openchamber_desktop` | **Desktop** — native app powering `ocp desktop` / `ocp ui` | Checks presence only and prints the download link when missing — the installer **never** downloads the desktop app ([openchamber.dev/download](https://openchamber.dev/download)) |
| `tools.openchamber_vscode` | **VS Code** — editor extension powering `ocp code` | **Default: false.** When enabled, installs `fedaykindev.openchamber` via the first editor CLI found (`code`, `code-insiders`, `codium`, `cursor`, `windsurf`) when the extension is missing |

Launch afterwards with:

```bash
ocp desktop      # native desktop app (alias: ocp ui)
ocp web          # OpenChamber web UI (auto-generates a --ui-password)
ocp code         # VS Code with the OpenChamber extension guaranteed
ocp tui          # the OpenCode terminal UI
```

To enable Web or VS Code, set its switch to `true` in `install/options.jsonc` and re-run install. Set any surface to `false` to skip it (already-installed components stay put). An opted-out surface is also skipped by `ocp code`'s auto-install.

---

## Preserved fields across reinstalls

When `opencode.jsonc` is overwritten by a new template, these fields are snapshotted from your existing config and restored afterwards:

| Field | Why |
|---|---|
| `provider.<name>.options.baseURL` | Your API endpoint |
| `provider.<name>.options.apiKey` | Your API key |
| `provider.<name>.models` | Your model definitions (custom model ids, user-added models) |
| `model` (root) | Your standard-tier model pick |
| `agent.<name>.model` (per tier) | Your per-tier model assignments |

---

## Global commands (`ocp` / `opencode-prime`)

After initial install, register the repo to provision global command shortcuts (`ocp`, `opencode-prime`):

```powershell
pwsh install/install.ps1 register
```

```bash
./install/install.sh register
```

Once registered, `ocp` also acts as the runtime launcher: `ocp` (or `ocp tui`) starts the OpenCode terminal UI, `ocp desktop` (alias `ocp ui`) starts the OpenChamber desktop GUI, and `ocp web` serves the OpenChamber web UI on localhost with a generated `--ui-password`.

To opt out of automatic shim registration during install, set `"global_commands": false` in `install/options.jsonc` — the standalone `register` / `unregister` actions above remain available regardless.

👉 The complete command list and launcher semantics (port & password policy for `ocp web`) are documented in the dedicated [OCP CLI Reference](/maintenance/ocp-cli).
