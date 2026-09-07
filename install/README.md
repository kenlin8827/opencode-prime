# install (v0.31.0)

Self-installing OpenCode Prime (OCP) powered by a unified **TypeScript engine** and an **interactive TUI Setup Wizard**.

## ⚡ Remote One-Line Install

The repository root contains pipe-friendly remote installers (`install.sh` and `install.ps1`) that download the latest release and launch the in-repo installer automatically:

### macOS / Linux / WSL
```bash
curl -fsSL https://raw.githubusercontent.com/kenlin8827/opencode-prime/main/install.sh | bash
```

### Windows (PowerShell)
```powershell
irm https://raw.githubusercontent.com/kenlin8827/opencode-prime/main/install.ps1 | iex
```

> These remote scripts download the latest release archive, extract it to a temporary directory, and forward all arguments to the in-repo `install/install.sh` or `install/install.ps1` described below.

### Pin to a specific version

Omit the version flag to get the latest release, or pin explicitly:

```bash
# macOS / Linux / WSL — install v0.9.0
curl -fsSL https://raw.githubusercontent.com/kenlin8827/opencode-prime/main/install.sh | bash -s -- -v 0.9.0
```

```powershell
# Windows — install v0.9.0
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/kenlin8827/opencode-prime/main/install.ps1))) -Version "0.9.0"
```

---

## 🌟 Interactive TUI Wizard (Recommended)

Running the installer without arguments in an interactive terminal opens the **TUI Setup Wizard**:

```pwsh
# Windows (PowerShell)
pwsh install/install.ps1

# macOS / Linux / WSL (Bash)
./install/install.sh
```

The wizard guides you through:
- 🚀 **Quick Install / Update**: Instantly apply the repository configuration to `~/.config/opencode`.
- ⚙️ **Custom Component Setup**: Interactively choose your default agent (`code`, `build`, `plan`), toggle MCP servers (`serena`, `codegraph`, `dbhub`), and configure RTK.
- 🔍 **Check Status**: Inspect target vs repo versions.
- 🌐 **Register Global Commands**: Provision `ocp` & `opencode-prime` directly into PATH.
- 🧹 **Reset & Clear (Init)**: Full backup and clean start.
- ❌ **Safe Uninstall**: Precision manifest-driven cleanup.

---

## ⚡ Direct CLI / Non-Interactive Usage

All CLI flags remain fully compatible for CI and terminal power users:

### PowerShell (Windows)

```pwsh
# Quick install / re-apply:
pwsh install/install.ps1 install -Force -Yes

# Check installation status:
pwsh install/install.ps1 status

# Custom target directory:
pwsh install/install.ps1 install -Target C:\custom\path

# Backup + clear target directory:
pwsh install/install.ps1 init -Yes

# Precise uninstall:
pwsh install/install.ps1 uninstall -Yes
```

### Bash (macOS / Linux / WSL)

```bash
# Quick install / re-apply:
./install/install.sh install -f -y

# Check status:
./install/install.sh status

# Custom target directory:
./install/install.sh install -t /path/to/target

# Backup + clear target directory:
./install/install.sh init -y

# Precise uninstall:
./install/install.sh uninstall -y
```

## Global commands (`ocp` / `opencode-prime`)

After installing the files, register the repo to provision global command shortcuts
(`ocp`, `opencode-prime`) so you can run it from any directory.

PowerShell:

```pwsh
pwsh install/install.ps1 register              # shims to ~/.local/bin
pwsh install/install.ps1 register -BinDir C:\Tools\bin  # custom location
pwsh install/install.ps1 unregister            # remove shims
```

Bash:

```bash
./install/install.sh register
./install/install.sh register --bin-dir ~/bin
./install/install.sh unregister
```

`register` writes tiny trampolines that re-execute the in-repo dispatchers
(`bin/opencode-prime.ps1` on PowerShell, `bin/opencode-prime` on Bash), so
`git pull` updates the commands immediately. It will refuse to overwrite a file
it didn't create.

Add `~/.local/bin` to your user PATH, then run:

```pwsh
# PowerShell
[Environment]::SetEnvironmentVariable('Path', "$env:Path;$HOME\.local\bin", 'User')
# then in a fresh session:
ocp status
ocp install -Force
```

```bash
# bash/zsh
export PATH="$HOME/.local/bin:$PATH"
# then:
ocp status
ocp upgrade
```

Once registered, `ocp` doubles as a runtime launcher (running it with no
arguments launches the OpenCode terminal UI):

```pwsh
ocp tui          # launch the OpenCode terminal UI (exec opencode)
ocp desktop      # launch the OpenChamber native desktop app (alias: ocp ui)
ocp web          # launch the OpenChamber web UI (openchamber --ui-password <generated>)
ocp code         # open VS Code with the OpenChamber editor extension guaranteed
```

## Configuring credentials

The old `config.ps1` / `config.sh` helpers are retired. Credentials and
model picks are now configured inside opencode itself:

- `/connect <provider>` — authenticate an official provider
- `/profile <name>` — apply a bundled profile (per-tier model picks)
- `llm-router` credentials — set the `LLM_ROUTER_BASE_URL` /
  `LLM_ROUTER_API_KEY` environment variables, or edit the target
  `providers/llm-router.json` preset file directly

The replacement workflow is tracked by a follow-up ADR.

## Profiles

A profile is a named preset bundling per-tier model picks, applied in one
shot instead of editing each tier by hand. Profiles are applied from within
an opencode session via the `/profile` slash command (see
`plugins/profile-wizard.ts`, a TUI plugin registered in `tui.template.jsonc`):

```
/profile                  # dialog picker; first entry shows current mapping
```

Profiles live in `profiles/<name>.json`:

```json
{
  "description": "human-readable summary shown by `profile list`",
  "tiers": {
    "default": "opencode-go/kimi-k3",
    "code": "opencode-go/kimi-k2.7-code",
    "advisor": "opencode-go/gpt-5.6-luna"
  }
}
```

Semantics (as implemented by the `/profile` plugin):

- Tier values are full `<provider>/<model_id>` refs, applied verbatim.
- Mixed providers are allowed — a profile can route different tiers to
  different providers (refs missing `/` are rejected).
- Tiers not listed by a profile are left untouched; all bundled profiles
  cover all five tiers, `vision` included.
- Unknown tier names in a profile are rejected; every agent of a tier is
  rewritten in lockstep, and the root `model` tracks the `standard` tier.
- Apply validates everything up front per tier and backs up the target
  (`opencode.jsonc.bak`) before writing; restart opencode to take effect.

Bundled profiles.
Cost tiers mirror the IDE model-tier vocabulary (Auto / Ultimate / Performance / Economy / Lightweight).
Profile keys are `profiles/`-relative paths with `/` separators: the nested file
`profiles/opencode-zen/lite.json` is the profile `opencode-zen/lite`.
Gateway profiles fill all five tiers, mixing model families within the same
provider where that is the stronger or cheaper pick. Official-API profiles
borrow a vision-capable model across providers when their own family has none
(`deepseek` routes vision to MiniMax M3).
Every model ref below sits under the cost red line (input <= $3.00, output <= $15.00 per M tokens).

### Tier design principles

The tier-to-model assignment follows a strict quality ladder:

```
flash  (fastest/cheapest)  <=  standard  (general workhorse)  <=  pro  (strongest coding)  <=  max  (flagship reasoning)
```

- **`flash` = cheapest/fastest variant.** Use flash/turbo/highspeed/lite/mini.
- **`standard` = second-highest / general workhorse.** The standard tier drives high-traffic
  orchestrator & analysis agents (build, plan, researcher, tech-writer) and tracks root `model`.
- **`pro` = strongest coding model.** Prefer codex/coder variants when available.
- **`max` = absolute flagship / reasoning.** Must be >= `pro` in quality. Used by advisor, architect, security, code-review.
- **`vision` = any model with `attachment: true` + image input.**
- When a provider has <= 2 models, tiers can share — but `max` always gets the strongest.

| Profile | Tier | flash / standard / pro / max / vision |
| --- | --- | --- |
| `router/llm` | Auto — server-side routing baseline | its five router slots |
| `router/codex` | codex gateway — Sol heavy / Luna cheap | gpt-5.6-luna / gpt-5.6-terra / gpt-5.6-terra / gpt-5.6-sol / gpt-5.6-luna |
| `router/qoder` | qoder gateway — Ultimate flags / Lite explores | lite / performance / ultimate / ultimate / auto |
| `router/claude-code` | Claude Code gateway — Fable codes / Sonnet default | claude-haiku-4-5 / claude-sonnet-5 / claude-fable-5 / claude-opus-5 / claude-sonnet-5 |
| `router/antigravity` | Antigravity gateway — Gemini Flash reasoning steps | gemini-3.7-flash-low / -medium / -high / -high / -high |
| `qoder/default` | Qoder subscription via opencode-qoder-bridge (official Qoder Agent SDK; needs `qoder login`) | lite / performance / ultimate / ultimate / auto |
| `qoder/deepseek` | All-DeepSeek family on Qoder (same bridge) | dfmodel / dfmodel / dmodel / dmodel / qmodel |
| `qoder/qwen` | All-Qwen family on Qoder (same bridge) | qmodel / qmodel_latest / qmodel_38max / qmodel_38max / qmodel |
| `opencode-go/ultimate` | Ultimate — quality first (needs `OPENCODE_API_KEY`) | deepseek-v4-flash / kimi-k2.7-code / qwen3.8-max / grok-4.6 / qwen3.8-flash |
| `opencode-go/performance` | Performance — daily driver | deepseek-v4-flash / kimi-k2.7-code / qwen3.8-max / qwen3.8-max / qwen3.8-flash |
| `opencode-go/economy` | Economy — cost-performance | qwen3.8-flash / qwen3.8-flash / kimi-k2.7-code / glm-5.3 / qwen3.8-flash |
| `opencode-go/lite` | Lightweight — cheapest usable, review-capable `max` | glm-5.3-flash / qwen3.8-flash / qwen3.7-plus / deepseek-v4-pro / qwen3.8-flash |
| `opencode-go/deepseek` | All-DeepSeek family fallback | deepseek-v4-flash / deepseek-v4-flash / deepseek-v4-pro / deepseek-v4-pro / deepseek-v4-flash-vision-exp |
| `opencode-go/kimi` | All-Kimi family fallback | kimi-k2.5 / kimi-k2.7-code / kimi-k2.7-code / kimi-k3 / kimi-k2.5 |
| `opencode-go/qwen` | All-Qwen family fallback | qwen3.6-plus / qwen3.6-plus / qwen3.8-max / qwen3.8-max / qwen3.8-flash |
| `opencode-go/glm` | All-GLM family fallback | glm-5.3-flash / glm-5.1 / glm-5.2 / glm-5.3 / glm-5.3-flash |
| `opencode-zen/ultimate` | Ultimate — strongest under the cost red line (needs `OPENCODE_API_KEY`) | deepseek-v4-flash / gemini-3.8-flash / gpt-5.6-sol / grok-4.6 / claude-sonnet-4-6 |
| `opencode-zen/performance` | Performance — daily driver, review-capable `max` | deepseek-v4-flash / kimi-k2.7-code / gpt-5.6-sol / gpt-5.6-sol / claude-sonnet-4-6 |
| `opencode-zen/economy` | Economy — high-traffic daily coding | gemini-3.5-flash-lite / gpt-5.1 / gpt-5.1-codex / deepseek-v4-pro / claude-sonnet-4-6 |
| `opencode-zen/lite` | Lightweight — cheapest usable, review-capable `max` | ling-3.0-flash-fin-free / gemini-3.5-flash-lite / minimax-m2.7 / deepseek-v4-pro / gemini-3.5-flash-lite |
| `opencode-zen/claude` | All-Claude family (Opus 5 excluded: over the cap) | claude-haiku-4-5 / claude-sonnet-5 / claude-sonnet-4-6 / claude-sonnet-4-6 / claude-sonnet-5 |
| `opencode-zen/gpt` | All-GPT family (5.6 line: luna/terra/sol) | gpt-5.6-luna / gpt-5.6-terra / gpt-5.6-sol / gpt-5.6-sol / gpt-5.6-luna |
| `opencode-zen/gemini` | All-Gemini family | gemini-3.5-flash-lite / gemini-3.6-flash / gemini-3.8-flash / gemini-3.1-pro / gemini-3.5-flash-lite |
| `opencode-zen/deepseek` | All-DeepSeek family fallback | deepseek-v4-flash / deepseek-v4-flash / deepseek-v4-pro / deepseek-v4-pro / deepseek-v4-flash-vision-exp |
| `opencode-zen/kimi` | All-Kimi family fallback | kimi-k2.5 / kimi-k2.6 / kimi-k2.7-code / kimi-k3 / kimi-k2.5 |
| `opencode-zen/qwen` | All-Qwen family fallback | qwen3.5-plus / qwen3.6-plus / qwen3.6-plus / qwen3.6-plus / qwen3.5-plus |
| `opencode-zen/glm` | All-GLM family fallback | glm-5.3-flash / glm-5.1 / glm-5.2 / glm-5.3 / glm-5.3-flash |
| `kimi-for-coding` | Kimi For Coding (official Kimi Code plan) | kimi-for-coding / kimi-for-coding / kimi-for-coding / k3-256k / kimi-for-coding |
| `zai-coding-plan` | Z.AI Coding Plan (official GLM subscription) | glm-5.3-flash / glm-5.1 / glm-5.2 / glm-5.3 / glm-5v-turbo |
| `zhipuai-coding-plan` | Zhipu AI Coding Plan (official GLM subscription) | glm-5.3-flash / glm-5.1 / glm-5.2 / glm-5.3 / glm-5v-turbo |
| `deepseek` | DeepSeek (official DeepSeek API) | deepseek-v4-flash / deepseek-v4-flash / deepseek-v4-pro / deepseek-v4-pro / MiniMax-M3 (minimax-cn) |
| `anthropic` | Anthropic (official Anthropic API) | claude-haiku-4-5 / claude-haiku-4-5 / claude-sonnet-5 / claude-opus-5 / claude-sonnet-5 |
| `google` | Google (official Vertex AI / Gemini API) | gemini-flash-lite-latest / gemini-2.5-flash / gemini-3-pro-preview / gemini-2.5-pro / gemini-2.5-flash |
| `openai` | OpenAI (official OpenAI API) | gpt-5.6-luna / gpt-5.6-terra / gpt-5.6-terra / gpt-5.6-terra / gpt-4o |
| `alibaba/coding-plan` | Alibaba Coding Plan (official) | qwen3.7-plus / qwen3.7-plus / qwen3-coder-next / MiniMax-M2.5 / qwen3.7-plus |
| `alibaba/coding-plan-cn` | Alibaba Coding Plan China (official) | qwen3.7-plus / qwen3.7-plus / qwen3-coder-next / MiniMax-M2.5 / qwen3.7-plus |
| `alibaba/token-plan` | Alibaba Token Plan (official) | deepseek-v4-flash-0731 / deepseek-v4-flash-0731 / qwen3.8-max / qwen3.8-max / qwen3.7-plus |
| `alibaba/token-plan-cn` | Alibaba Token Plan China (official) | deepseek-v4-flash-0731 / deepseek-v4-flash-0731 / qwen3.8-max / qwen3.8-max / qwen3.7-plus |
| `alibaba/token-plan-cn-deepseek` | Alibaba Token Plan China, all-DeepSeek | deepseek-v4-flash-0731 / deepseek-v4-flash-0731 / deepseek-v4-pro-0813 / deepseek-v4-pro-0813 / qwen3.7-plus |
| `minimax/coding-plan` | MiniMax Coding Plan minimax.io (official) | MiniMax-M2.7 / MiniMax-M2.7 / MiniMax-M3 / MiniMax-M3 / MiniMax-M3 |
| `minimax/cn-coding-plan` | MiniMax Coding Plan minimaxi.com (official) | MiniMax-M2.7 / MiniMax-M3 / MiniMax-M3 / MiniMax-M3 / MiniMax-M3 |
| `tencent/coding-plan` | Tencent Coding Plan (official) | hunyuan-turbos / hunyuan-turbos / tc-code-latest / minimax-m2.5 / kimi-k2.5 |
| `tencent/token-plan` | Tencent Token Plan (official) | hy3 / hy3 / hy3 / hy3 / hy3 |
| `xiaomi/token-plan-cn` | Xiaomi Token Plan China (official) | mimo-v2.5 / mimo-v2.5-pro / mimo-v2.5-pro / mimo-v2.5-pro / mimo-v2.5 |
| `xiaomi/token-plan-ams` | Xiaomi Token Plan Europe (official) | mimo-v2.5 / mimo-v2.5-pro / mimo-v2.5-pro / mimo-v2.5-pro / mimo-v2.5 |
| `xiaomi/token-plan-sgp` | Xiaomi Token Plan Singapore (official) | mimo-v2.5 / mimo-v2.5-pro / mimo-v2.5-pro / mimo-v2.5-pro / mimo-v2.5 |

## Files

| Path                                  | Role                                |
| ------------------------------------- | ----------------------------------- |
| `install/version.json`                | Authoritative version info: `version` (current) + `minVersion` (supported floor) |
| `install/versions/<ver>.manifest.txt` | One repo-relative path per line (loose for versions ≥ `minVersion`) |
| `install/versions/history.manifest.txt` | Deduplicated union of every manifest below `minVersion` (rebuilt by `bun run manifest:generate`) |
| `<target>/.CONFIG_VERSION`            | Records the active version          |

### Iron rule: never modify historical manifests

**NEVER edit `install/versions/<ver>.manifest.txt` for any version other than
the current one** (the `version` field in `install/version.json`), and never
edit `history.manifest.txt` by hand. Historical manifests — loose or compacted
— are immutable records of what prior versions shipped; the upgrade path
uses them to clean up old files. Tampering with them breaks upgrade
correctness for users on those older versions.

When a file is removed or renamed:
1. Edit **only** the current version's manifest (or run `bun run manifest:generate`).
2. Bump `version` in `install/version.json`.
3. Leave all prior manifests untouched.

### Manifest compaction (supported floor)

`bun run manifest:generate` merges every loose manifest strictly below `minVersion` into a
single deduplicated `install/versions/history.manifest.txt` and deletes the
loose copies. Install-time stale-file cleanup unions loose manifests and the
history file. Per-version attribution below the floor is intentionally
dropped; uninstalling a below-floor install therefore cleans against the
history union (a superset of every shipped set — entries absent on disk are
skipped), falling back to a live repo scan only when `install/versions/` is
missing entirely. Upgrading from below `minVersion` still works but runs with
a best-effort warning. Raising `minVersion` only takes effect on the next
`generate`.

## What gets shipped

The manifest whitelists exactly the paths opencode reads at runtime:

| Path                     | Why                                           |
| ------------------------ | --------------------------------------------- |
| `prompts/`               | Agent prompt fragments (21 files; pure bodies, loaded via `{file:}` — never shipped as `agents/`, which opencode auto-discovers as agent definitions) |
| `commands/`              | Slash commands (4 files)                      |
| `plugins/`               | TypeScript plugins (12 files)                 |
| `instructions/`          | Shared protocols injected into all agents     |
| `opencode.template.jsonc` | Main config template (merged into `opencode.jsonc`, never copied verbatim) |

Everything else stays in the repo and never reaches the target:

| Path            | Reason                                    |
| --------------- | ----------------------------------------- |
| `.git/`         | VCS metadata — not part of the config     |
| `node_modules/` | Dependency cache — not part of the config |
| `.metrics/`     | Runtime metrics — not part of the config  |
| `install/`      | This installer and its manifests (*)          |
| `tests/`        | Test scripts — not part of the config     |
| `package.json`, `bun.lock`, `package-lock.json` | npm metadata — not needed by opencode |
| `tsconfig.json` | TS build config — not needed at runtime   |
| `tui.template.jsonc` | TUI tweak kept locally only               |
| `.gitignore`, `README.md` | Repo metadata — not config          |

In particular, **`.git/` is never copied to the target** — the target should
be a clean config directory, not a working copy.

(*) `install/options.jsonc` never ships to the target: the installer reads
it in place and applies its switches to `opencode.jsonc` — see Options below.

## How cleanup works

`.CONFIG_VERSION` holds the active version string (single line, no newline).
On the next install, the script reads it, looks up
`install/versions/<that>.manifest.txt`, deletes each entry from the target,
then copies the current manifest and rewrites `.CONFIG_VERSION`.

`.CONFIG_VERSION` itself is never deleted during install (even if an old
manifest listed it) — it is always rewritten at the end of each install.

**v0.17.0 migration note.** Agent prompt fragments moved from `agents/` to
`prompts/` (the old path is auto-discovered by opencode as agent definitions
that silently override the jsonc `agent` block). On upgrade, the stale-file
cleanup removes the legacy `agents/*.md` automatically (they are listed in
historical manifests). If you had modified those files, your copies are safe
in the timestamped `.bak` full backup the installer takes before every apply.

## Uninstall mode

`uninstall` is the precise reverse of `install`: it reads the target's
`.CONFIG_VERSION`, deletes exactly the files listed by that version's
manifest (files you added yourself survive), then removes the
installer-owned extras (`.CONFIG_VERSION`, any stale `.CONFIG_VERSION.bak`,
and a legacy `options.jsonc` copy left behind by older installers).

The merged `opencode.jsonc` is not a manifest entry — the repo ships
`opencode.template.jsonc` (never copied verbatim), so the rendered config
survives uninstall. It carries your credentials and model picks; delete it
manually, or use `init` (backup + clear) for a total wipe.

```pwsh
pwsh install/install.ps1 uninstall        # confirmation prompt
pwsh install/install.ps1 uninstall -Yes   # skip confirmation
```

```bash
./install/install.sh uninstall          # confirmation prompt
./install/install.sh uninstall -y       # skip confirmation
```

Behaviour notes:

- No marker → nothing to do. A missing manifest for the installed version
  aborts with an error — use `init` (backup + clear) instead.
- External tools are untouched: the rtk binary and provisioned MCP CLIs
  stay installed; remove them manually if wanted.
- The global shim stays too — run `unregister` to remove it.
- Use `init` instead when you want a total wipe (it backs up first).

## Init mode (fresh start)

`init` (PowerShell and Bash) backs up the entire target directory
to a timestamped sibling (`~/.config/opencode.backup.YYYYMMDD-HHMMSS`), then
clears everything inside it — a clean slate for a fresh install.

```pwsh
pwsh install/install.ps1 init             # backup + clear
pwsh install/install.ps1 init -NoBackup   # clear without backup
pwsh install/install.ps1 init -Yes         # skip confirmation
```

```bash
./install/install.sh init               # backup + clear
./install/install.sh init --no-backup    # clear without backup
./install/install.sh init -y            # skip confirmation
```

After `init`, run `install` to reinstall config files, then configure
credentials and model picks inside opencode (`/connect` + `/profile`).

## Preserved fields

When the manifest contains `opencode.template.jsonc`, both scripts snapshot the user's
state from the target file **before** rewriting it with the merged config,
then write it back afterwards:

| Field                      | Why preserved                         |
| -------------------------- | ------------------------------------- |
| `provider.<name>.options.baseURL` | User's API endpoint          |
| `provider.<name>.options.apiKey`  | User's API key (secret)      |
| `model` (root)             | User's model pick for `tier.standard` |
| `agent.<name>.model`       | User's per-tier model picks           |

Model picks are preserved **per tier** (the same semantics the `/profile`
plugin uses — every agent of a tier shares one `provider/model_id` ref):
a reinstall rewrites all agents of a tier to the user's ref, including agents
that the newer template added. Tiers with no prior pick keep the template
default. To discard the preserved picks, remove the target `opencode.jsonc`
before reinstalling.

Everything else in `opencode.jsonc` is overwritten from the repo. To add more
preserved credential fields, extend `$preserveJsonKeys` (PowerShell) or
`PRESERVE_KEYS` (Bash).

## Options (default agent + MCP + external plugin + rtk switches)

`install/options.jsonc` is the single switch panel AND the single source of
truth for the default agent, every MCP server, external (npm) plugin, and
the rtk proxy — it replaces the old `-EnableMcp` / `--enable-mcp`
command-line flags. It lives
in install/ (NOT in the version manifest) and never ships to the target —
every install reads it in place and forces the target state onto it,
unconditionally on every install. Nothing in the target directory looks like
an editable options file (a copy left behind by older installers is deleted
on install).

```jsonc
{
  "rtk": true,
  "openchamber": true,
  "default_agent": "lite",
  "mcp":    { "serena": false, "codegraph": true, "gitnexus": false, "dbhub": true },
  "plugin": {
    "@dietrichgebert/ponytail": true,
    "opencode-qoder-bridge": false,
    "opencode-mem@2.24.3": false
  }
}
```

- `default_agent` drives `opencode.jsonc`'s root `default_agent` — which
  primary agent opencode enters first (`build` orchestrator, `code` direct
  developer, `plan` read-only coordinator). The pick is validated against the
  shipped `agent` block: unknown names are rejected with a warning and the
  template value is kept. Omit the field to keep the shipped default.
- `rtk` drives rtk provisioning: `true` downloads the binary when missing
   and keeps the vendored `plugins/rtk-write*`; `false` skips the download AND
   removes `plugins/rtk-write.ts` + `plugins/rtk-write/` from the target (an
  already-installed `rtk` binary on PATH stays put).
- OpenChamber ships as three independent surfaces, one `tools.openchamber_*`
  switch each:
  - `openchamber_web` — `true` (default) installs the `@openchamber/web` CLI
    globally via the first detected package manager (pnpm > bun > yarn > npm)
    when the `openchamber` binary is missing — it powers `ocp web` and needs
    Node.js 22+.
  - `openchamber_desktop` — the native desktop app behind `ocp desktop` /
    `ocp ui` is always a separate download from https://openchamber.dev/download;
    the installer never downloads it — this switch only gates a presence
    check (the download link is printed when missing).
  - `openchamber_vscode` — `true` (default) installs the OpenChamber editor
    extension (`fedaykindev.openchamber`) via the first editor CLI found
    (`code`, `code-insiders`, `codium`, `cursor`, `windsurf`) when missing —
    it powers `ocp code`.
  - `false` on any switch skips that surface (already-installed components
    stay put).
- `mcp.<name>` drives `opencode.jsonc`'s `mcp.<name>.enabled`; enabling an
  entry that declares an `install` field also provisions its CLI on the
  next install (disabled entries are never provisioned). Entries the options
  file doesn't list keep the shipped `opencode.template.jsonc` value.
- `plugin.<name>` drives membership in `opencode.jsonc`'s `plugin` array;
  plugins the target carries but the options file doesn't list survive as-is.
- Edit this file and re-run `install` (`-Force`/`-f` when the version is
  unchanged). Your choices persist in this file (git); no installed copy
  exists.
- Bundled `plugins/*.ts` files are not toggled here — they ship wholesale and
   are always active. The one exception is the vendored rtk-write plugin, which
  follows the `rtk` switch.

**Note on the shipped template.** The repo's `opencode.template.jsonc` ships with
`{env:LLM_ROUTER_BASE_URL}` / `{env:LLM_ROUTER_API_KEY}` as
[opencode-style env-var substitution tokens](https://opencode.ai/docs/providers#environment-variables).
This is the **recommended** setup: keep the token in the config, set the
real values in your shell environment, and never commit a real key. The
preservation logic simply round-trips the token through every reinstall.

If you prefer hardcoded values over env vars, edit the target
`opencode.jsonc` directly to replace the token with a literal.
The installer will preserve that literal across future reinstalls, so a
literal key is never silently overwritten.

## Scripts

| Script             | Language   | Purpose                                      |
| ------------------ | ---------- | -------------------------------------------- |
| `install.ps1`      | PowerShell | Install / status / init / uninstall / register |
| `install.sh`       | Bash 4+    | Same, with `jq` for JSON                     |

The two implementations share the same contract — same manifest format, same
preserved fields, same default target — but are tested independently. If you
find a behavioural drift, file it. The retired `config.ps1` / `config.sh`
helpers are replaced by in-OpenCode Configuration (`/connect` + `/profile`).

## Model name verification principle

**DO NOT GUESS provider model names** based on internal knowledge or naming
patterns. Every `provider/model_id` in a profile **must reference a real,
current model on the provider's official API**. If you cannot verify the
model_id via the provider's official documentation, do not invent it.

If you add a new provider profile (e.g. `anthropic.json`), always:

1. Visit the provider's official API docs (e.g. [Anthropic API models doc](https://docs.anthropic.com/en/docs/about-models)).
2. Copy the exact model_id from the official list.
3. If the provider only supports one model family (e.g. `claude-3-haiku`),
   reference those in your comment and omit speculative versions.
4. Record your research in a TODO and update README or TODO as needed, with links and model names.
