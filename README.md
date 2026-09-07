# OpenCode Prime (OCP)

> **The Flagship Production Engineering & Multi-Agent Suite for OpenCode**

A production-ready [OpenCode](https://opencode.ai) suite for real-world software engineering: layered MCP code intelligence and database gateway, hard engineering guardrails (ADR / secret-file / E2E / commit discipline), 21 specialist agents, and one-shot model tier governance — installed into `~/.config/opencode` with a single command.

> **English** | [中文](README.zh-CN.md) | 📖 **[Online Documentation](https://kenlin8827.github.io/opencode-prime/)**
>
> This README is the quick-start guide. For full documentation, see **[Online Docs](https://kenlin8827.github.io/opencode-prime/)**. To modify this repo itself, see **[DEVELOPING.md](DEVELOPING.md)**.

---

## ⚡ 10-Second Quick Install

Install directly to `~/.config/opencode` with a single command (no Git clone required):

### macOS / Linux / WSL
```bash
curl -fsSL https://raw.githubusercontent.com/kenlin8827/opencode-prime/main/install.sh | bash
```

### Windows (PowerShell)
```powershell
irm https://raw.githubusercontent.com/kenlin8827/opencode-prime/main/install.ps1 | iex
```

> 💡 **Zero-Risk Upgrades**: Re-running the command above smoothly upgrades to the latest release while **preserving** all your API keys, custom models, and tier assignments.

<details>
<summary><b>Install a specific version</b></summary>

```bash
# macOS / Linux / WSL
curl -fsSL https://raw.githubusercontent.com/kenlin8827/opencode-prime/main/install.sh | bash -s -- -v 0.9.0
```

```powershell
# Windows
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/kenlin8827/opencode-prime/main/install.ps1))) -Version "0.9.0"
```

</details>

<details>
<summary><b>Manual install & prerequisites</b></summary>

If you prefer to inspect the script before running, or your environment blocks remote scripts:

**macOS / Linux / WSL:**
```bash
curl -fsSL -o /tmp/ocp-install.sh https://raw.githubusercontent.com/kenlin8827/opencode-prime/main/install.sh
bash /tmp/ocp-install.sh
```

**Windows (PowerShell):**
```powershell
curl -fsSL -o "$env:TEMP\ocp-install.ps1" https://raw.githubusercontent.com/kenlin8827/opencode-prime/main/install.ps1
pwsh "$env:TEMP\ocp-install.ps1"
```

**Developer method (clone):**
```bash
git clone https://github.com/kenlin8827/opencode-prime.git
cd opencode-prime
./install/install.sh        # Windows: pwsh install/install.ps1
```

**Prerequisites:**

| Requirement | Why | Install |
|---|---|---|
| [opencode](https://opencode.ai) CLI | Runtime that reads the config and dispatches agents | `curl -fsSL https://opencode.ai/install \| bash` |
| PowerShell 7+ (Windows) | Install script | `winget install Microsoft.PowerShell` |
| Bash 4+ + `jq` (macOS / Linux / WSL) | Same script, bash side | `brew install jq` or `sudo apt install jq` |
| Git | Version control & manifest fallback | — |
| Node.js 22.5+ + npm (Optional) | Runtime for CodeGraph / GitNexus / DBHub MCPs | [nodejs.org](https://nodejs.org/) |
| uv / Python 3.13+ (Optional) | Runtime for Serena LSP MCP | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |

</details>

---

## 📋 OCP CLI Commands

After installation, the global command `ocp` (alias: `opencode-prime`) is available from **any terminal directory**:

| Command | Aliases | What it does |
| :--- | :--- | :--- |
| `ocp` *(no args)* | | Launch the **OpenCode terminal UI** (same as `ocp tui`) |
| `ocp tui` | | Launch the OpenCode terminal TUI (`exec opencode`); extra args pass through |
| `ocp serve` | | Launch the headless OpenCode server (`opencode serve`) |
| `ocp web` | | Launch the **OpenChamber web UI**; auto-generates a password |
| `ocp code` | | Open the current project in **VS Code**; auto-installs the OpenChamber editor extension when missing |
| `ocp desktop` | `ocp ui` | Launch the **OpenChamber native desktop app** |
| `ocp install` | | Apply the current version's manifest to `~/.config/opencode` |
| `ocp update` | | Check for suite + tool updates; interactively apply selected ones |
| `ocp upgrade` | | Pull the latest release and re-apply the installer (one-click upgrade) |
| `ocp init` | | Backup + clear the entire target directory for a fresh start |
| `ocp uninstall` | | Remove the installed version's manifest files from the target |
| `ocp status` | | Show installed vs repo version |
| `ocp register` | | Install global shims (`ocp`, `opencode-prime`) into `~/.local/bin` |
| `ocp unregister` | | Remove the global shims |
| `ocp wizard` | `ocp menu` | Interactive TUI setup wizard (first-run and reconfigure flows) |
| `ocp dashboard` | `ocp cc`, `ocp matrix` | Single-screen TUI control center — toggle MCP / plugins / tiers |
| `ocp version` | `ocp -v` | Print the repo's current version (`install/version.json`) |
| `ocp help` | `ocp -h` | Print the command help |

> 📖 **Full CLI reference**: [OCP CLI — Online Docs](https://kenlin8827.github.io/opencode-prime/maintenance/ocp-cli)

---

## 🖼️ Screenshots

### Single-Screen TUI Control Center

The `ocp dashboard` (or running the installer) opens a single-screen control center where you can press `Space` to toggle MCP servers, plugins, RTK optimizer, or cycle Agent-to-Tier model assignments (`flash` / `standard` / `pro` / `max` / `vision`):

<p align="center">
  <img src="./docs/public/images/tui-dashboard-en.webp" alt="OpenCode TUI Panoramic Dashboard" width="880"/>
</p>

> **Keyboard Shortcuts**: `↑/↓` Move cursor, `Space` Toggle/Cycle tier, `Enter` Execute action, `L` Instant language switch (EN/ZH), `Q` Exit.

---

### Interactive Project Wizard

Run `/project init` (or `ocp wizard`) inside any project to scaffold the code knowledge graph (CodeGraph + Serena LSP) and project guardrails (ADR + secret-file gates):

<p align="center">
  <img src="./docs/public/images/tui-project-wizard-en.webp" alt="Project Wizard Interactive Dialog" width="880"/>
</p>

The two-tier wizard lets you toggle quality guardrails (ADR / E2E / commit discipline / env-guard) with live `🟢 ON` / `🔴 OFF` / `⚪ default` badges, then `💾 Save & Apply Changes` — all changes stay in-memory until confirmed.

---

### OpenCode Terminal UI

Once configured, launch the OpenCode terminal UI with `ocp` (or `ocp tui`) and start working with your specialist agent team:

<p align="center">
  <img src="./docs/public/images/opencode-en.webp" alt="OpenCode Terminal UI" width="880"/>
</p>

The terminal UI provides a chat interface to 21 specialist agents (`@java-dev`, `@security`, `@dba`, `@frontend-dev`, `@fast-coder`, etc.), four working modes (`@lite` (default — ~2k tok/step) / `@code` / `@build` / `@plan`), workflow slash commands (`/dev` · `/dev-quick` · `/dev-plan` · `/dev-review` · `/review-fix-loop` · `/sdd` …), and the `/profile` picker for one-shot model tier mapping.

---

### OpenChamber Web UI

Run `ocp web` to launch the browser-based OpenChamber UI — a side-by-side diff and multi-model comparison surface that shares the same config as the terminal:

<p align="center">
  <img src="./docs/public/images/openchamber-web-en.png" alt="OpenChamber Web UI" width="880"/>
</p>

The web UI auto-generates a password-protected session, picks a free port starting at 3000, and reclaims zombie daemons — no manual setup needed.

---

### OpenChamber Desktop App

Run `ocp desktop` (alias `ocp ui`) to launch the native Tauri-based desktop application:

<p align="center">
  <img src="./docs/public/images/openchamber-desktop-en.png" alt="OpenChamber Desktop App" width="880"/>
</p>

The desktop app provides a native window with side-by-side diff views, multi-model comparison, and full keyboard navigation — one config shared across terminal, web, and desktop, zero re-setup.

---

> 📖 **For full documentation** — agents, profiles, MCP servers, workflows, guardrails, and installer options — visit the **[Online Docs](https://kenlin8827.github.io/opencode-prime/)**.

---

## License

Copyright (C) 2026 Ken Lin — licensed under the [GNU Affero General Public License v3.0 or later](./LICENSE). Third-party integrations keep their own licenses; per-component license notes live in `install/options.jsonc` and `opencode.template.jsonc`.
