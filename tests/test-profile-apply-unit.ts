/**
 * Profile Apply Variant Resolution — Unit Tests (no host dependency)
 *
 * Coverage:
 *   - suffix-style router: the agent's variant (v2 `#variant` ref, or a
 *     legacy `variant` field migrated on write) resolves the base ref to the
 *     concrete sibling model key (e.g. gpt-5.6-luna + high → gpt-5.6-luna-high)
 *   - missing suffix sibling falls back to the base model (no guessing)
 *   - base model with native variants keeps base ref + `#variant` suffix
 *     (parameter-style router)
 *   - suffixed profile refs are not double-suffixed
 *   - agents without variant get the base ref unchanged
 *   - config.model (tier.standard) and agents.title.model (tier.flash) are
 *     set — v1 fixtures migrate legacy `agent`/`small_model` to native keys
 *   - a v2-native fixture reads providers under the native `providers` key
 *
 * Run: bun run tests/test-profile-apply-unit.ts
 */

// applyProfile is a pure function — no host or filesystem dependency.

const { applyProfile } = await import("../plugins/tui/profile-wizard/tui")

let passed = 0
let failed = 0

function section(title: string): void {
  console.log(`\n${"═".repeat(60)}\n  ${title}\n${"═".repeat(60)}`)
}

function assert(cond: unknown, label: string): void {
  if (cond) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.log(`  ❌ ${label}`)
  }
}

// ─── Fixtures ─────────────────────────────────────────────────────────

const CODEX_ROUTER_MODELS: Record<string, Record<string, unknown>> = {
  "gpt-5.6-luna": { id: "cx/gpt-5.6-luna", reasoning: true },
  "gpt-5.6-luna-low": { id: "cx/gpt-5.6-luna-low", reasoning: true },
  "gpt-5.6-luna-medium": { id: "cx/gpt-5.6-luna-medium", reasoning: true },
  "gpt-5.6-luna-high": { id: "cx/gpt-5.6-luna-high", reasoning: true },
  "gpt-5.6-luna-xhigh": { id: "cx/gpt-5.6-luna-xhigh", reasoning: true },
  "gpt-5.6-luna-max": { id: "cx/gpt-5.6-luna-max", reasoning: true },
}

// Parameter-style provider: one base model exposing native variants, no
// sibling models. Mirrors a catalog-imported reasoning model.
const PARAM_MODELS: Record<string, Record<string, unknown>> = {
  "gpt-5.4": {
    id: "gpt-5.4",
    reasoning: true,
    variants: {
      low: { reasoningEffort: "low" },
      high: { reasoningEffort: "high" },
    },
  },
}

const TIER_MAP = { explore: "flash", fast: "standard", max: "max" }

type AgentEntry = { model?: string; variant?: string }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApplyConfig = Parameters<typeof applyProfile>[0] & Record<string, any>

// v1-shaped fixture — applyProfile migrates it to native keys on write.
function makeConfig(models: Record<string, Record<string, unknown>>): ApplyConfig {
  return {
    model: "old/base",
    agent: {
      explore: { model: "old/a" },
      fast: { model: "old/b" },
      max: { model: "old/c" },
    },
    provider: { "codex-router": { models } },
  }
}

// v2-native fixture — providers + agents with `#variant` refs.
function makeNativeConfig(models: Record<string, Record<string, unknown>>): ApplyConfig {
  return {
    model: "old/base",
    agents: {
      explore: { model: "old/a" },
      fast: { model: "old/b" },
      max: { model: "old/c" },
    },
    providers: { "codex-router": { models } },
  }
}

// ─── Tests ────────────────────────────────────────────────────────────

section("applyProfile resolves the agent variant against provider models (v1 fixture → native writes)")

{
  const config = makeConfig(CODEX_ROUTER_MODELS)
  const profile = { tiers: { flash: "codex-router/gpt-5.6-luna" } }
  const result = applyProfile(config, profile, TIER_MAP)

  // explore is tier.flash with no variant → base ref, written natively
  assert(config.agents.explore.model === "codex-router/gpt-5.6-luna", "agent without variant gets base ref")
  assert(result.patch.agents?.explore?.model === "codex-router/gpt-5.6-luna", "patch carries base ref")
  assert(!("agent" in config), "legacy agent map is migrated away")
}

{
  const config = makeConfig(CODEX_ROUTER_MODELS)
  config.agent.explore.variant = "low"
  config.agent.fast.variant = "high"
  const profile = {
    tiers: { flash: "codex-router/gpt-5.6-luna", standard: "codex-router/gpt-5.6-luna" },
  }
  const result = applyProfile(config, profile, TIER_MAP)

  // legacy `variant` folds into the ref on migration, then resolves siblings
  assert(config.agents.explore.model === "codex-router/gpt-5.6-luna-low", "low variant resolves to sibling key")
  assert(config.agents.fast.model === "codex-router/gpt-5.6-luna-high", "high variant resolves to sibling key")
  assert(result.patch.agents?.fast?.model === "codex-router/gpt-5.6-luna-high", "patch carries resolved sibling key")
}

{
  const config = makeConfig(CODEX_ROUTER_MODELS)
  config.agent.explore.variant = "max"
  const profile = { tiers: { flash: "codex-router/gpt-5.6-luna" } }
  applyProfile(config, profile, TIER_MAP)

  assert(config.agents.explore.model === "codex-router/gpt-5.6-luna-max", "max variant resolves to sibling key")
}

{
  // Variant with no matching sibling: fall back to base, never guess.
  const config = makeConfig(CODEX_ROUTER_MODELS)
  config.agent.explore.variant = "ultra"
  const profile = { tiers: { flash: "codex-router/gpt-5.6-luna" } }
  applyProfile(config, profile, TIER_MAP)

  assert(config.agents.explore.model === "codex-router/gpt-5.6-luna", "unknown variant falls back to base ref")
}

{
  // Base model already carries a reasoning suffix: never double-suffix.
  const config = makeConfig(CODEX_ROUTER_MODELS)
  config.agent.explore.variant = "low"
  const profile = { tiers: { flash: "codex-router/gpt-5.6-luna-high" } }
  applyProfile(config, profile, TIER_MAP)

  assert(config.agents.explore.model === "codex-router/gpt-5.6-luna-high", "suffixed profile ref is kept as-is")
}

section("applyProfile keeps base ref + #variant for parameter-style routers")

{
  const param = makeConfig(PARAM_MODELS)
  param.agent.explore.variant = "high"
  applyProfile(param, { tiers: { flash: "codex-router/gpt-5.4" } }, TIER_MAP)
  // v2 encodes the parameter variant in the ref itself — v1 kept a separate
  // `variant` field; after migration the effort rides as `#high`.
  assert(param.agents.explore.model === "codex-router/gpt-5.4#high", "native variant keeps base ref with #variant (parameter-style)")
}

section("applyProfile sets root model and agents.title.model")

{
  const config = makeConfig(CODEX_ROUTER_MODELS)
  const profile = {
    tiers: { flash: "codex-router/gpt-5.6-luna", standard: "codex-router/gpt-5.6-terra" },
  }
  const result = applyProfile(config, profile, TIER_MAP)

  assert(config.model === "codex-router/gpt-5.6-terra", "root model tracks tier.standard")
  assert(config.agents.title.model === "codex-router/gpt-5.6-luna", "tier.flash lands in agents.title.model")
  assert(!("small_model" in config), "no legacy small_model is written")
  assert(result.patch.model === "codex-router/gpt-5.6-terra", "patch carries root model")
  assert(result.patch.agents?.title?.model === "codex-router/gpt-5.6-luna", "patch carries title slot")
}

section("applyProfile on a v2-native config (agents record + providers key)")

{
  const config = makeNativeConfig(CODEX_ROUTER_MODELS)
  config.agents.explore.model = "codex-router/gpt-5.6-luna#low"
  const profile = { tiers: { flash: "codex-router/gpt-5.6-luna", standard: "codex-router/gpt-5.6-terra" } }
  applyProfile(config, profile, TIER_MAP)

  assert(config.agents.explore.model === "codex-router/gpt-5.6-luna-low", "#variant ref resolves to the sibling under native providers key")
  assert(config.model === "codex-router/gpt-5.6-terra", "root model tracks tier.standard")
  assert(config.agents.title.model === "codex-router/gpt-5.6-luna", "flash tier materializes agents.title")
  assert(!("agent" in config) && !("provider" in config), "native config is not polluted with legacy keys")
}

{
  // #variant survives a model swap on a parameter-style native router.
  const config = makeNativeConfig(PARAM_MODELS)
  config.agents.explore.model = "codex-router/gpt-5.4#high"
  applyProfile(config, { tiers: { flash: "codex-router/gpt-5.4" } }, TIER_MAP)
  assert(config.agents.explore.model === "codex-router/gpt-5.4#high", "existing #variant is re-applied to the new ref")
}

export {}

console.log(`\nPassed: ${passed}, Failed: ${failed}`)
if (failed > 0) process.exit(1)
