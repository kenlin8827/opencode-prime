# Configuration & Profiles

Configure AI model providers, routing tiers, and one-shot presets inside OpenCode.

---

## Provider setup inside opencode (recommended)

For existing providers (such as official DeepSeek, Kimi, Qwen APIs, not self-hosted LLM routers), configure through OpenCode slash commands:

```
/connect <provider-name>    # connect to existing provider
/profile                    # open the profile picker dialog
```

**Configuration Flow:**

1. **Connect Provider** — Use `/connect` command to connect to an existing provider
2. **Select Profile** — Use `/profile` to open the picker dialog and select the corresponding configuration profile

**Example:**

```
> /connect deepseek
  → Connect to DeepSeek provider
> /profile
  → Dialog opens — pick the "deepseek" entry to apply the official API profile
```

**Important:** After configuration is complete, please exit the current opencode session and re-enter to ensure the new provider and profile configurations take full effect.

---

## Profiles

A profile is a named preset that maps all model tiers to a specific provider's models in one shot, rather than setting each tier individually.

### Available profiles overview
 
| Profile | Category | Description |
|---|---|---|
| `deepseek` | Official API Direct | Official DeepSeek API (V3.2 Reasoner, Chat, V4 Flash) |
| `anthropic` | Official API Direct | Official Anthropic API (Claude 3.5/3.7 Sonnet, Opus, Haiku) |
| `openai` | Official API Direct | Official OpenAI API (GPT-5, o3-mini, o4-preview) |
| `google` | Official API Direct | Official Google Gemini API (Gemini 2.5 Flash, 2.5 Pro) |
| `kimi-for-coding` | Official Coding Plan | Moonshot Kimi For Coding official coding plan (K1.5 / K2 series) |
| `alibaba/coding-plan` / `-cn` | Official Coding Plan | Alibaba Bailian Tongyi Qwen coding plan (Qwen3-Coder, Qwen3.7-Plus) |
| `alibaba/token-plan` / `-cn` | Official Coding Plan | Alibaba Bailian Token plan (DeepSeek V4 Flash / Qwen 3.8 Max) |
| `alibaba/token-plan-cn-deepseek` | Official Coding Plan | Alibaba Bailian Token plan, all-DeepSeek variant (V4 Flash / V4 Pro) |
| `minimax/coding-plan` / `minimax/cn-coding-plan` | Official Coding Plan | MiniMax official coding plan (M2.7, M3) |
| `zhipuai-coding-plan` | Official Coding Plan | Zhipu AI official coding plan (GLM-5.1, GLM-5.2, GLM-5v) |
| `zai-coding-plan` | Official Coding Plan | Z.AI official coding plan (GLM series) |
| `tencent/coding-plan` | Official Coding Plan | Tencent Hunyuan Coding Plan (Hunyuan Turbo, TC Code, MiniMax M2.5) |
| `tencent/token-plan` | Official Coding Plan | Tencent Hunyuan Token Plan (HY3) |
| `xiaomi/token-plan-cn` / `-ams` / `-sgp` | Official Coding Plan | Xiaomi LLM Token Plan (China / Europe / Singapore nodes, MiMo v2.5) |
| `opencode-go/ultimate` | OpenCode Go Gateway | Ultimate quality-first flagship ladder (Kimi K2.7-Code / Qwen 3.8 Max / Grok 4.6) |
| `opencode-go/performance` | OpenCode Go Gateway | Daily driver balance ladder |
| `opencode-go/economy` | OpenCode Go Gateway | Cost-effective balanced tier |
| `opencode-go/lite` | OpenCode Go Gateway | Minimum viable cost high-velocity tier |
| `opencode-go/deepseek` | OpenCode Go Gateway | All-DeepSeek family fallback |
| `opencode-go/kimi` | OpenCode Go Gateway | All-Kimi family fallback |
| `opencode-go/qwen` | OpenCode Go Gateway | All-Qwen family fallback |
| `opencode-go/glm` | OpenCode Go Gateway | All-GLM family fallback |
| `opencode-zen/ultimate` | OpenCode Zen Gateway | Strongest picks under the cost red line (DeepSeek V4 Flash / Gemini 3.8 Flash / GPT-5.6 Sol / Grok 4.6) |
| `opencode-zen/performance` | OpenCode Zen Gateway | Daily driver with review-capable `max` (DeepSeek V4 Flash / Kimi K2.7-Code / GPT-5.3 Codex / GPT-5.6 Terra) |
| `opencode-zen/economy` | OpenCode Zen Gateway | Cost-optimized for high-traffic coding (Gemini 3.5 Flash Lite / GPT-5.1 / GPT-5.1 Codex / DeepSeek V4 Pro) |
| `opencode-zen/lite` | OpenCode Zen Gateway | Cheapest usable ladder, DeepSeek V4 Pro still judges `max` (Ling 3.0 Flash Fin Free / Gemini 3.5 Flash Lite / MiniMax M2.7) |
| `opencode-zen/claude` | OpenCode Zen Gateway | All-Claude picks (Haiku 4.5 / Sonnet 5 / Sonnet 4.6) |
| `opencode-zen/gpt` | OpenCode Zen Gateway | All-GPT codex line (5.1 Codex Mini / 5.1 / 5.3 Codex / 5.6 Terra) |
| `opencode-zen/gemini` | OpenCode Zen Gateway | All-Gemini picks (3.5 Flash Lite / 3.6 Flash / 3.8 Flash / 3.1 Pro) |
| `opencode-zen/deepseek` | OpenCode Zen Gateway | All-DeepSeek family fallback (V4 Flash / V4 Pro / V4 Flash Vision EXP) |
| `opencode-zen/kimi` | OpenCode Zen Gateway | All-Kimi family fallback (K2.5 / K2.6 / K2.7-Code / K3) |
| `opencode-zen/qwen` | OpenCode Zen Gateway | All-Qwen family fallback (3.5 Plus / 3.6 Plus) |
| `opencode-zen/glm` | OpenCode Zen Gateway | All-GLM family fallback (5.3 Flash / 5.1 / 5.2 / 5.3) |
| `qoder/default` | Subscription & Gateway | Qoder subscription via opencode-qoder-bridge (needs `qoder login`) |
| `qoder/deepseek` / `qoder/qwen` | Subscription & Gateway | All-DeepSeek / All-Qwen on Qoder platform |
| `router/antigravity` | Custom Gateway | Self-hosted Antigravity gateway (Gemini Flash/Pro + Claude Sonnet/Opus Thinking) |
| `router/claude-code` | Custom Gateway | Self-hosted Claude Code gateway (Anthropic protocol) |
| `router/codex` | Custom Gateway | Self-hosted codex gateway (Sol/Luna series) |
| `router/qoder` | Custom Gateway | Self-hosted qoder gateway (Ultimate/Performance/Lite) |
| `router/llm` | Custom Gateway | Server-side routing baseline |

### Using profiles

The `/profile` slash command opens a wizard with three entry points:

1. **Edit: Agent→Tier** — reassign which tier (flash/standard/pro/max/vision) an agent belongs to (writes `tiers.json`)
2. **Manage: Profile→Models** — edit a profile's tier→model mapping, or add/delete profile files
3. **Select: Profile** — pick a profile and apply immediately (writes `opencode.jsonc`)

No arguments — opens the native picker dialog:

```
/profile
  ┌─ Level 1: Main menu
  │
  ├─ "Edit: Agent→Tier"  ─────────────── see § Edit: Agent→Tier below
  ├─ "Manage: Profile→Models"  ────────── see § Manage: Profile→Models below
  ├─ "Select: Profile"  ────────────────── see § Select: Profile below
  └─ "🧹 Reset: Model refs"  ───────────── confirm dialog → clear all model refs
  │
  → Esc at the main menu closes the wizard
```

The `reset` subcommand removes every model ref the wizard wrote:

```
/profile reset
→ Confirm dialog listing all refs → removes root `model`, `small_model` and
  every `agent.*.model` from `opencode.jsonc` (keeps a `.bak` backup) and
  deactivates the profile. opencode falls back to its native model picker.
  Profile files and `tiers.json` are kept — reset clears the applied state,
  not the library. Restart to apply.
```

#### Edit: Agent→Tier

Reassign which tier an agent belongs to — without touching the tier→model side:

```
/profile → "Edit: Agent→Tier"
  ┌─ Level 2: Agent list
  │
  │  Lists all agents with their current tier and model:
  │    advisor    (max)   — model: anthropic/claude-opus
  │    code       (pro)   — model: anthropic/claude-sonnet
  │    explore    (flash) — model: anthropic/claude-haiku
  │    ...
  │
  │  Changed agents show the pending transition:
  │    dba        (pro → max)  ← pending
  │
  │  ├─ "( Apply changes )"  → write tiers.json + live-apply models
  │  ├─ Pick any agent  ────→ Level 3: tier picker
  │  └─ "( Back )"  ─────────→ return to main menu
  │
  └─ Level 3: Tier picker (per agent)
     │
     ├─ flash     "Fast / lightweight — exploration, high-throughput"
     ├─ standard  "General workhorse — orchestrator (root model)"
     ├─ pro        "Professional — strongest coding models"
     ├─ max        "Flagship reasoning — deep analysis, review, design"
     ├─ vision     "Multimodal — image/screenshot analysis"
     └─ "( Back )"  ──→ return to agent list (keep pending changes)
```

**What happens on Apply:**

1. `tiers.json` is rewritten atomically (backup `.bak` → write tmp → rename); the `$comment` field is preserved.
2. For each changed agent, its `model` in `opencode.jsonc` is updated to the new tier's current ref — sourced from the active profile's `tiers[newTier]`, or from the first agent already using that tier.
3. Live-apply is attempted first via the server's global config API (no restart). On older builds, falls back to direct `opencode.jsonc` write (backup `.bak`, restart needed).

**Example workflow:**

```
> /profile
  → pick "Edit: Agent→Tier"
  → pick "code" (currently pro)
  → pick "pro"
  → toast: "code: pro → pro (no change)"
  → pick "dba" (currently pro)
  → pick "max"
  → toast: "dba: pro → max (pending)"
  → "( Apply changes )"
  → toast: "1 tier change applied — dba → max (anthropic/claude-opus). Live, no restart needed."
```

#### Manage: Profile→Models

Edit a profile's tier→model mapping, or add/delete profiles:

```
/profile → "Manage: Profile→Models"
  ┌─ Level 2: Profile list
  │
  │  ├─ opencode-go-glm  ← active  — desc...
  │  ├─ opencode-go-kimi          — desc...
  │  ├─ ...
  │  ├─ "( Add profile )"  ────→ prompt for name, creates blank JSON
  │  ├─ "( Delete profile )"  ──→ pick a profile to remove (.bak kept)
  │  └─ "( Back )"  ─────────→ return to main menu
  │
  └─ Level 3: Tier review (per profile)
     │
     │  Lists the picked profile's tiers with their provider/model refs:
     │    flash     glm-4-flash
     │    standard  glm-4-plus
     │    pro       glm-4-plus
     │    max       glm-4-long
     │    vision    glm-4v
     │
     │  ├─ "( Apply changes )"  → write profile JSON + apply to opencode.jsonc
     │  ├─ Pick any tier  ─────→ Level 4: provider picker
     │  ├─ "( Back )"  ───────→ return to profile list (keep overrides)
     │  └─ "( Cancel )"  ─────→ discard overrides, return to profile list
     │
     └─ Level 4: Provider picker
        │
        ├─ anthropic  — 5 model(s) · built-in · connected
        ├─ openai     — 3 model(s) · built-in
        ├─ ...
        ├─ "( Type a custom ref )"  ──→ manual '<provider>/<model_id>' entry
        └─ "( Back )"  ───────────→ return to tier review
        │
        └─ Level 5: Model picker (per provider)
           │
           ├─ claude-sonnet  — Claude 3.7 Sonnet
           ├─ claude-opus    — Claude 3.7 Opus
           ├─ ...
           └─ "( Back )"  ──→ return to provider list
```

**What happens on Apply:**

1. The profile JSON file (`~/.config/opencode/profiles/<name>.json`) is rewritten atomically (backup `.bak` → write tmp → rename) with the overridden tier→model refs.
2. The updated profile is applied to `opencode.jsonc` — every agent's `model` is rewritten to match its tier's new ref.
3. `.active-profile` is updated. Live-apply is attempted first via the server's global config API (no restart).

#### Select: Profile

Pick a profile and apply it immediately — no intermediate review:

```
/profile → "Select: Profile"
  ┌─ Level 2: Profile list
  │
  │  ├─ opencode-go-glm  ← active  — desc...
  │  ├─ opencode-go-kimi          — desc...
  │  ├─ ...
  │  └─ "( Back )"  ─────────→ return to main menu
  │
  └─ Picking a profile → applies immediately (same as the old behavior)
```

> **Tip:** The three branches are complementary. Use **Edit: Agent→Tier** to decide *which tier* an agent belongs to (writes `tiers.json`), use **Manage: Profile→Models** to decide *which model* each tier uses within a specific profile (writes profile JSON + `opencode.jsonc`), and use **Select: Profile** for quick switching. The agent→tier mapping survives reinstalls (preserved in the `PreserveBag`).

> **Esc behavior:** At every dialog level, pressing Esc returns to the previous level (not closes the entire wizard). Only Esc at the main menu (Level 1) closes the wizard.

> **i18n:** All TUI wizard plugins (`/profile`, `/provider`, `/project`, `/queued`) support internationalization. The language is auto-detected from system locale/environment variables on first use, then stored in `api.kv`. Each wizard's main menu includes a `🌐 English → 中文` (or reverse) option to switch languages on the fly — the menu re-renders in the new language immediately. Translations are centralized in `plugins/i18n.ts`.

---

## Model Routing & Tier Architecture

The system uses 5 model tiers, each mapped to a set of agents:

| Tier | Purpose | Agents |
|---|---|---|
| `flash` | Fast, lightweight, exploration, high-throughput | explore, fast-coder |
| `standard` | General orchestrator, high-traffic workhorse (root model) | build, plan, researcher, tech-writer |
| `pro` | Professional engineering, code generation & debugging, routine review triage | code, code-review-fast, codegraph-scout, gitnexus-scout, java/python/go/rust/node-dev, frontend-dev, qa, dba, devops |
| `max` | Deep reasoning, system design, security, red-team review | advisor, architect, security, code-review |
| `vision` | Multimodal visual analysis, UI critique | vision |

Each tier resolves to the provider/model mapped by the active profile. **Variant** (low/medium/high) controls thinking/reasoning effort per agent; silently ignored if the backing model does not support variants.

---

## Custom providers (`/provider` wizard)

The `/provider` slash command (a TUI plugin registered via `tui.template.jsonc`) configures custom providers end to end through native dialogs — no arguments:

```
/provider
  → level 1 dialog: "➕ Add custom provider" (blank) and "📦 Add preset
    provider" (imports a providers/*.json definition into the config)
    pinned on top, then the providers stored in opencode.jsonc
  → level 2 (provider detail):
    ⚙ Basic settings — form (id on add / name / npm / baseURL / apiKey);
      fields mutate in memory, 💾 saves once via atomic opencode.jsonc
      write; empty apiKey keeps the stored key, secrets are never
      pre-filled; '{env:VAR}' tokens stay in options.apiKey, literal
      keys go to ~/.local/share/opencode/auth.json — the same store the
      official /connect command writes
    fetch — prompts a glob (default *) and imports matching models from
      the live {baseURL}/models (openai) or /v1/models (anthropic)
      endpoint; additive only — existing keys are skipped
    ── Models ── — mirrors the config node; click opens the model form
      (identity / capabilities / limits), 🗑 removes the entry
    ➕ Add model… — same model form for a new entry
    🗑 Delete provider… — confirm, then drop the whole config entry
  → Esc is the only way back at every level; changes need an opencode restart
```

---

## LLM Router credentials

For the `llm-router` custom provider, set `baseURL` / `apiKey` via the environment variables below (recommended), via the `/provider` wizard (interactive), or by editing `~/.config/opencode/providers/llm-router.json` directly (this is the preset definition file opencode loads — `opencode.jsonc` no longer carries an inline `llm-router` block).

> The `/provider` wizard stores literal API keys in `~/.local/share/opencode/auth.json` — the same store the official `/connect` command writes, so both stay in sync.

### Environment variables (recommended for API keys)

```powershell
# PowerShell ($PROFILE)
$env:LLM_ROUTER_BASE_URL = "https://router.example.com/v1"
$env:LLM_ROUTER_API_KEY  = "sk-xxxx"
```

```bash
# Bash (~/.bashrc or ~/.zshrc)
export LLM_ROUTER_BASE_URL="https://router.example.com/v1"
export LLM_ROUTER_API_KEY="sk-xxxx"
```

---

## Qoder provider (`opencode-qoder-bridge`)

The [opencode-qoder-bridge](https://github.com/naoufalelbani/opencode-qoder-bridge) plugin is included in the `plugin` array of the shipped config template (`opencode.template.jsonc`) and injects the `qoder` provider and its full model catalog at startup — no provider block or API keys needed. It communicates with Qoder through the official `@qoder-ai/qoder-agent-sdk` using your Qoder CLI credentials.

Prerequisites:
- Node.js `^22.18 || >=24.11`
- Qoder CLI installed and logged in: `qoder login` (credentials stored in `~/.qoder/.auth/user`)

Then restart opencode and apply the shipped `qoder` profile via `/profile`.
