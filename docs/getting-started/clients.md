# Clients & UI Options

OpenCode features an open, modular frontend ecosystem. Whether you prefer a lightweight terminal environment or a graphical dual-column diff review experience, you can seamlessly switch based on your workflow.

---

## Supported Interfaces

| Interface | Best for | Key Advantages | How to Launch |
|---|---|---|---|
| **Terminal TUI — Direct** | Command-line power users, SSH remote development | Ultra-lightweight, sub-millisecond response, native keyboard flow | Run `ocp` (or `ocp tui --direct`) |
| **Terminal TUI — Workspace wrapper** | Terminal users who want a managed workspace | Together with Direct, the terminal TUI currently supports three selectable modes: Direct, Herdr, and Luvus | Run `ocp tui` for the selected Herdr or Luvus wrapper |
| **OpenChamber Desktop** | Visual review, side-by-side comparison | **Visual Side-by-Side Diff**, multi-model parallel Fusion & comparison, session timeline | Download the [OpenChamber](https://openchamber.dev/download) desktop app, then run `ocp desktop` |
| **OpenChamber VS Code Extension** | Reviewing without leaving the editor | The same OpenChamber review UI inside VS Code (also VSCodium / Cursor / Windsurf) | Run `ocp code` — auto-installs the extension when missing |
| **OpenChamber Web UI** | LAN access, lightweight browser experience | Password-protected browser access, visual side-by-side review | Run `ocp web` |

---

## Interface Preview

### Terminal TUI — Direct

Run `ocp` (or `ocp tui --direct`) in any project directory to launch OpenCode directly in the current shell — the default daily-driver interface with 21 specialist agents, four working modes, and workflow slash commands:
![OpenCode Terminal UI](/images/opencode-en.webp)

---

### Terminal TUI — Workspace Wrapper

The terminal TUI currently supports three selectable modes: **Direct**, **Herdr**, and **Luvus**. Run `ocp tui` to launch through the workspace wrapper selected during setup (Herdr or Luvus); use `ocp tui --herdr` or `ocp tui --luvus` to override the selection for one launch.

---

### OpenChamber Desktop

Run `ocp desktop` (alias `ocp ui`) to launch the native Tauri-based desktop app with side-by-side diff views and multi-model comparison:

![OpenChamber Desktop App](/images/openchamber-desktop-en.png)

---

### OpenChamber Web UI

Run `ocp web` to launch the browser-based UI — auto-generates a password-protected session, picks a free port, no desktop install needed:

![OpenChamber Web UI](/images/openchamber-web-en.png)

---

### OpenChamber VS Code Extension

Run `ocp code` to open the current project in VS Code with the OpenChamber extension guaranteed — OCP auto-installs `fedaykindev.openchamber` through the editor CLI when it is missing. `--init` scaffolds/activates the OCP project first; a bare `.` opens the current folder:

```bash
ocp code          # open VS Code with the extension ensured
ocp code .        # open the current folder
ocp code --init   # scaffold/activate the OCP project first
```

---

## Seamless Configuration Sharing

No matter which client interface you choose, all engineering capabilities installed in `~/.config/opencode` are automatically active and 100% shared:

- **21 Specialist Agents**: `@java-dev`, `@security`, `@dba`, etc. are available across all clients;
- **MCP Code Intelligence**: Serena LSP, CodeGraph knowledge graph, and DBHub database gateway work out-of-the-box;
- **Model Profiles**: Tier assignments configured via `/profile` apply uniformly;
- **Project Guardrails**: ADR enforcement, secret guarding, and commit discipline apply consistently.

You can switch between Terminal, Desktop GUI, and Web UI at any time with zero re-configuration!

---

## Next Steps

- Return to the Quick Start guide: **[Quick Install & Dashboard](/getting-started/)**
- Check project initialization: **[Project Initialization & Guardrails](/getting-started/project-init)**
- Check system prerequisites: **[Prerequisites & Source Install](/getting-started/prerequisites)**
