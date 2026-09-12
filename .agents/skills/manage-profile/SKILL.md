---
name: manage-profile
description: Create or update opencode provider profiles by fetching real model data from models.opencode.ai. Use when the user mentions a provider name (e.g. "anthropic", "google", "deepseek", "minimax", "alibaba") and wants to create, update, or fix a profile. Also use when the user says "profile", "provider profile", "add provider", or "fix profile".
---

# Manage Provider Profile

Create or update a provider profile in `profiles/` with **real model names** fetched from the opencode source of truth.

## Core principle

**NEVER guess model names.** Always run the helper script to fetch the live catalog from `models.opencode.ai/api.json` first, then pick models from the output.

## Blacklist

Providers in this list are **skipped** — no profile is created or updated. These are base
API providers without a subscription plan (coding plan / token plan), or non-plan variants
that don't qualify. Only providers that ARE a subscription plan (name contains `coding-plan`,
`token-plan`, or `for-coding`) are kept — plus `deepseek` as an explicit exception.

```python
BLACKLIST = [
    # Base providers (no subscription plan of their own)
    "alibaba", "alibaba-cn",
    "minimax", "minimax-cn",
    "moonshotai", "moonshotai-cn",
    "zhipuai", "zai",
    "stepfun", "stepfun-ai",
    "xiaomi",
    "tencent-tokenhub",
    # Step plans (not coding plan or token plan)
    "stepfun-step-plan", "stepfun-ai-step-plan",
    # Non-Chinese without subscription plan
    "mistral",
]

EXCEPTIONS = ["deepseek"]  # kept despite having no plan variant
```

If the user asks to add a blacklisted provider, **refuse and explain why** (no subscription
plan). Suggest the closest plan variant instead (e.g. for `alibaba` suggest `alibaba-token-plan-cn`).

## Workflow

### 1. Fetch provider data

Run the helper script with the provider ID:

```bash
python .agents/skills/manage-profile/scripts/fetch-provider.py <provider_id>
```

The script outputs JSON with:
- Provider name, env vars, API URL, doc URL
- All available models with capabilities (attachment, reasoning, tool_call, cost, modalities)
- Suggested tier assignments (based on keyword scoring)

If the provider ID is not found, the script suggests closest matches.

### 2. Review the suggestions

Check the `suggested_tiers` field. Adjust if needed:

| Tier | What to pick | Keywords that boost score |
|------|-------------|---------------------------|
| `flash` | **Cheapest, fastest** — rapid exploration, fast coder, lightweight search | flash, haiku, mini, lite, turbo, nano, small, highspeed |
| `standard` | **Second-highest / general workhorse** — high-traffic main orchestrator (build, plan, researcher, tech-writer) | pro, max, plus, chat, sonnet, flash |
| `pro` | **Strongest coding / engineering** — professional development (code, frontend, backend, devops, qa, dba) | codestral, coder, sonnet, pro, opus, max, large |
| `max` | **Absolute flagship / reasoning** — architecture design, security, red-team review, advisor | opus, max, large, ultra, pro, reasoner, r1, thinking |
| `vision` | Must have `attachment: true` + `image` in input modalities | (auto-selected by script) |

### Quality ladder

The tier-to-model assignment must follow a strict quality ladder:

```
flash  (fastest/cheapest)  <=  standard  (general workhorse)  <=  pro  (strongest coding)  <=  max  (flagship reasoning)
```

Rules:
- **`flash` = cheapest/fastest variant.** Use flash/turbo/highspeed/lite/mini variants.
- **`standard` = high-traffic workhorse.** The standard tier drives orchestrator & analysis agents (build, plan, researcher, tech-writer).
- **`pro` = strongest coding model.** Prefer codex/coder variants when available.
- **`max` = absolute flagship / reasoning.** Must be >= `pro` in quality. Used by advisor, architect, security, code-review.
- Skip `deprecated` status models.
- If no model has `attachment: true`, **omit** the `vision` tier entirely.
- Prefer the latest release date when scores tie.
- When the provider has a small catalog (<= 2 models), tiers can share the same model — but `max` should always get the strongest one available.

### 3. Write the profile file

Write to `profiles/<provider_id>.json`:

```json
{
  "description": "<Provider Name> (official API) — <model-id> carries the high-traffic standard tier (<why>), <model-id> codes on pro, <model-id> judges on max, <model-id> explores on flash<vision sentence>.",
  "tiers": {
    "flash": "<provider>/<model_id>",
    "standard": "<provider>/<model_id>",
    "pro": "<provider>/<model_id>",
    "max": "<provider>/<model_id>",
    "vision": "<provider>/<model_id>"
  }
}
```

If the file already exists, **update** it (overwrite all tiers and description). If not, **create** it.

### 4. Update README profile table

In `install/README.md`, find the profile table (the `| Profile | Tier | ...` markdown table). Add or update the row for this provider:

```
| `<provider_id>` | <Provider Name> (official API) | <flash> / <standard> / <pro> / <max> / <vision or —> |
```

If the provider has no vision tier, write `—` in the vision column.

### 5. Verify

Run the profile test to confirm the profile matches what opencode CLI reports:

```bash
pwsh tests/test-profiles.ps1
```

This checks that all `provider/model_id` refs in profiles exist in `opencode models` output.

## Common provider IDs

### Non-Chinese (official, kept)

| Provider ID | Name |
|-------------|------|
| `anthropic` | Anthropic (Claude) |
| `google` | Google (Gemini) |
| `openai` | OpenAI (GPT) |

### Chinese — kept (subscription plans + deepseek exception)

| Provider ID | Name | Type |
|-------------|------|------|
| `deepseek` | DeepSeek | Exception (no plan, but kept) |
| `kimi-for-coding` | Kimi For Coding | Coding plan |
| `zhipuai-coding-plan` | Zhipu AI Coding Plan | Coding plan |
| `zai-coding-plan` | Z.AI Coding Plan | Coding plan |
| `alibaba-token-plan` | Alibaba Token Plan | Token plan |
| `alibaba-token-plan-cn` | Alibaba Token Plan (China) | Token plan |
| `alibaba-token-plan-cn-deepseek` | Alibaba Token Plan (China), all-DeepSeek variant | Token plan |
| `alibaba-token-plan-cn-qwen` | Alibaba Token Plan (China), all-Qwen variant | Token plan |
| `minimax-coding-plan` | MiniMax Token Plan (minimax.io) | Coding plan |
| `minimax-cn-coding-plan` | MiniMax Token Plan (minimaxi.com) | Coding plan |
| `tencent-coding-plan` | Tencent Coding Plan | Coding plan |
| `tencent-token-plan` | Tencent Token Plan | Token plan |
| `xiaomi-token-plan-cn` | Xiaomi Token Plan (China) | Token plan |
| `xiaomi-token-plan-ams` | Xiaomi Token Plan (Europe) | Token plan |
| `xiaomi-token-plan-sgp` | Xiaomi Token Plan (Singapore) | Token plan |

### Chinese — blacklisted (base providers, step plans, non-plans)

`alibaba`, `alibaba-cn`, `minimax`, `minimax-cn`, `moonshotai`, `moonshotai-cn`,
`zhipuai`, `zai`, `stepfun`, `stepfun-ai`, `stepfun-step-plan`, `stepfun-ai-step-plan`,
`xiaomi`, `tencent-tokenhub`

## Example

User: "Add an anthropic profile"

1. Run: `python .agents/skills/manage-profile/scripts/fetch-provider.py anthropic`
2. Script returns models: claude-haiku-4-5, claude-sonnet-5, claude-opus-5, etc.
3. Suggested tiers: flash=claude-haiku-4-5, standard=claude-haiku-4-5, pro=claude-sonnet-5, max=claude-opus-5, vision=claude-sonnet-5
4. Write `profiles/anthropic.json` with real model IDs
5. Update README table
6. Run `pwsh tests/test-profiles.ps1` to verify
