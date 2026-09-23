# Prerequisites & Source Installation

This page details the foundational system dependencies for running OpenCode Prime, as well as instructions for developers looking to modify or contribute to this repository.

---

## Base Prerequisites

| Requirement | Purpose | How to Install |
|---|---|---|
| [opencode](https://opencode.ai) CLI (major **v1 only** — v2 is refused) | Core runtime that reads configurations and schedules agents | `curl -fsSL https://opencode.ai/install \| bash -s -- --version <latest-1.x>` (take the newest v1 from [releases](https://github.com/anomalyco/opencode/releases); normally installed automatically, pinned to v1) |
| PowerShell 7+ (Windows) | Windows installer and maintenance scripts | `winget install Microsoft.PowerShell` |
| Bash 4+ + `jq` (macOS / Linux / WSL) | Unix installer and manifest parser | `brew install jq` or `sudo apt install jq` |
| Git | Version control & manifest rollbacks | System package manager |

---

## Optional MCP Runtimes (On-Demand Provisioning)

This configuration integrates layered MCP code intelligence and database gateway servers. The installer supports **automated on-demand provisioning**: when an MCP server is enabled in `install/options.jsonc` and its CLI is missing, the installer will automatically call `npm` / `uv` to install it:

| Runtime | Target MCP Server | Notes |
|---|---|---|
| **Node.js 22.5+ + npm** | CodeGraph / GitNexus / DBHub | Install via [nodejs.org](https://nodejs.org/) or manage via `fnm` / `nvm` |
| **uv / Python 3.13+** | Serena LSP (Multi-language symbol analysis) | Install via `curl -LsSf https://astral.sh/uv/install.sh \| sh` |

> 💡 **Note**: If your current workflow does not require specific MCP servers, you can disable them in the TUI Panoramic Dashboard without installing their runtimes.

---

## Developer Method: Clone and Contribute

If you plan to develop or customize this repository directly (e.g. adding new specialists, developing plugins, or updating scripts):

```bash
# 1. Clone the repository
git clone https://github.com/kenlin8827/opencode-prime.git
cd opencode-prime

# 2. Run the installer (Windows: pwsh install/install.ps1)
./install/install.sh
```

- **Bun Runtime**: Recommended for development and running test suites (`powershell -c "irm bun.sh/install.ps1 | iex"` or `curl -fsSL https://bun.sh/install | bash`).
- For complete developer guidelines and architecture standards, see **[DEVELOPING.md](https://github.com/kenlin8827/opencode-prime/blob/main/DEVELOPING.md)**.

---

## Next Steps

- Return to the Quick Start guide: **[Quick Install & Dashboard](/getting-started/)**
- Explore full install options: **[Installation & Options](/maintenance/options)**
