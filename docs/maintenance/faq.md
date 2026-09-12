# Troubleshooting & FAQ

Frequently asked questions, upgrading guidelines, and troubleshooting tips.

---

## Upgrading

```powershell
# Windows
git pull origin main
pwsh install/install.ps1
```

```bash
# macOS / Linux / WSL
git pull origin main
./install/install.sh
```

The installer reads `.CONFIG_VERSION` from the target directory, looks up that version's manifest, deletes its files, then copies the current manifest. Your credentials and model picks are preserved.

---

## Uninstalling & Fresh Start

### Full uninstall

```bash
rm -rf ~/.config/opencode
```

```powershell
Remove-Item -Recurse -Force "$HOME/.config/opencode"
```

### Init mode (backup + clear)

```powershell
pwsh install/install.ps1 init
```

```bash
./install/install.sh init
```

---

## Troubleshooting FAQ

### "provider.llm-router not configured"

Set credentials via environment variables `LLM_ROUTER_BASE_URL` / `LLM_ROUTER_API_KEY` (see [Configuration & Profiles](/core/profiles)), or edit `~/.config/opencode/providers/llm-router.json` directly, then restart opencode.

### Auto-advisor mode does not switch

Check the `autoAdvisorMode` field in your project `opencode.jsonc`:

```powershell
Select-String -Path "opencode.jsonc" -Pattern "autoAdvisorMode"
```

If the field does not exist, mode is `off` (default). Run `/auto-advisor lite` to write the field to project config and enable advisor consultations.

### `/profile` does not preserve JSONC comments

The `/profile` plugin strips comments when rewriting `opencode.jsonc`. If comments are important to you, maintain them in your repository template (`opencode.template.jsonc`) — each reinstall copies the original (comments restored), but the next `/profile` mutation will strip them again.

### Bash command execution on Windows (Adaptive Support)

OpenCode's built-in tool is natively named `bash`, so LLMs frequently output POSIX/Unix shell commands. This configuration features a **dual-layer self-adaptive mechanism**:

1. **Installer auto-detection & shell adaptation**:
   When running `pwsh install/install.ps1`, the installer automatically probes for Git Bash and configures the User `SHELL` environment variable. To set it manually:
   ```powershell
   [System.Environment]::SetEnvironmentVariable('SHELL', 'C:\Program Files\Git\bin\bash.exe', [System.EnvironmentVariableTarget]::User)
   ```
2. **Global Agent Instruction Adaptation**:
   In `instructions/coding-principles.md`, `cp-shell` mandates adaptive command execution. Even in pure PowerShell/CMD environments without Git Bash, agents adapt to native PowerShell syntax (e.g. `$env:VAR = "val"`, `Get-ChildItem`, `Remove-Item`) or cross-platform commands (`git`, `npm`, `node`), and auto-recover if a syntax mismatch occurs.

### Serena `replace_content` fails with "No matches of search expression"

A needle-quality error, not a Serena or Windows bug. Two frequent causes:

1. **Hand-escaped regex needles** — the agent escaped a long verbatim code block into regex and one escape is wrong (e.g. `[]` written as `\(\)\]`). Regex needles should use short anchors + a `[\s\S]*?` wildcard, never full escaping.
2. **Needle drifted from the file** — the needle was written from memory instead of a fresh read of the target region.

`instructions/edit-protocol.md` is attached to every coding agent's prompt (L1 disclosure layer) and injects the editing discipline: `literal` mode for exact text (auto-escaped, zero escaping surface), short-anchor regex for spans, symbol tools for whole functions, and a mandatory read-before-retry loop on match failures. Line endings are normalized (CRLF→LF) before matching, so Windows line endings are never the cause.

### How do I use this configuration with the OpenChamber desktop app?

As long as you have completed the installation using this repository's install script, no extra setup is required:
1. Download and install the [OpenChamber](https://openchamber.dev) desktop app (or VS Code extension).
2. Open your project directory in OpenChamber.
3. OpenChamber automatically connects to the local OpenCode daemon and loads all configurations under `~/.config/opencode`. All 21 specialist agents, MCP servers, and workflow commands will be immediately available through the GUI, along with visual side-by-side diffs and multi-model fusion features.
