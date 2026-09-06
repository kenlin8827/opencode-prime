/**
 * Profile Apply Variant Resolution — Unit Tests (no host dependency)
 *
 * Coverage:
 *   - suffix-style router: agent.variant resolves base ref to the concrete
 *     sibling model key (e.g. gpt-5.6-luna + high → gpt-5.6-luna-high)
 *   - missing suffix sibling falls back to the base model (no guessing)
 *   - base model with native variants keeps base ref (parameter-style router)
 *   - suffixed profile refs are not double-suffixed
 *   - agents without variant get the base ref unchanged
 *   - config.model (tier.standard) and small_model (tier.flash) are set
 *
 * Run: bun run tests/test-profile-apply-unit.ts
 */

// applyProfile is a pure function — no host or filesystem dependency.

const { applyProfile } = await import("../plugins/tui/profile-wizard")

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

type ApplyConfig = Parameters<typeof applyProfile>[0] & { agent: Record<string, { model?: string; variant?: string }> }

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

// ─── Tests ────────────────────────────────────────────────────────────

section("applyProfile resolves agent.variant against provider models")

{
  const config = makeConfig(CODEX_ROUTER_MODELS)
  const profile = { tiers: { flash: "codex-router/gpt-5.6-luna" } }
  const result = applyProfile(config, profile, TIER_MAP)

  // explore is tier.flash with no variant → base ref
  assert(config.agent.explore.model === "codex-router/gpt-5.6-luna", "agent without variant gets base ref")
  assert(result.patch.agent?.explore?.model === "codex-router/gpt-5.6-luna", "patch carries base ref")
}

{
  const config = makeConfig(CODEX_ROUTER_MODELS)
  config.agent.explore.variant = "low"
  config.agent.fast.variant = "high"
  const profile = {
    tiers: { flash: "codex-router/gpt-5.6-luna", standard: "codex-router/gpt-5.6-luna" },
  }
  const result = applyProfile(config, profile, TIER_MAP)

  assert(config.agent.explore.model === "codex-router/gpt-5.6-luna-low", "low variant resolves to sibling key")
  assert(config.agent.fast.model === "codex-router/gpt-5.6-luna-high", "high variant resolves to sibling key")
  assert(result.patch.agent?.fast?.model === "codex-router/gpt-5.6-luna-high", "patch carries resolved sibling key")
}

{
  const config = makeConfig(CODEX_ROUTER_MODELS)
  config.agent.explore.variant = "max"
  const profile = { tiers: { flash: "codex-router/gpt-5.6-luna" } }
  applyProfile(config, profile, TIER_MAP)

  assert(config.agent.explore.model === "codex-router/gpt-5.6-luna-max", "max variant resolves to sibling key")
}

{
  // Variant with no matching sibling: fall back to base, never guess.
  const config = makeConfig(CODEX_ROUTER_MODELS)
  config.agent.explore.variant = "ultra"
  const profile = { tiers: { flash: "codex-router/gpt-5.6-luna" } }
  applyProfile(config, profile, TIER_MAP)

  assert(config.agent.explore.model === "codex-router/gpt-5.6-luna", "unknown variant falls back to base ref")
}

{
  // Base model already carries a reasoning suffix: never double-suffix.
  const config = makeConfig(CODEX_ROUTER_MODELS)
  config.agent.explore.variant = "low"
  const profile = { tiers: { flash: "codex-router/gpt-5.6-luna-high" } }
  applyProfile(config, profile, TIER_MAP)

  assert(config.agent.explore.model === "codex-router/gpt-5.6-luna-high", "suffixed profile ref is kept as-is")
}

section("applyProfile keeps base ref for parameter-style routers")

{
  const config = makeConfig(PARAM_MODELS)
  config.agent.explore.variant = "high"
  const profile = { tiers: { flash: "codex-router/gpt-5.4" } }
  applyProfile(config, profile, TIER_MAP)

  assert(config.agent.explore.model === "codex-router/gpt-5.4", "native variant keeps base ref (parameter-style)")
}

section("applyProfile sets root model and small_model")

{
  const config = makeConfig(CODEX_ROUTER_MODELS)
  const profile = {
    tiers: { flash: "codex-router/gpt-5.6-luna", standard: "codex-router/gpt-5.6-terra" },
  }
  const result = applyProfile(config, profile, TIER_MAP)

  assert(config.model === "codex-router/gpt-5.6-terra", "root model tracks tier.standard")
  assert(config.small_model === "codex-router/gpt-5.6-luna", "small_model tracks tier.flash")
  assert(result.patch.model === "codex-router/gpt-5.6-terra", "patch carries root model")
}

export {}

console.log(`\nPassed: ${passed}, Failed: ${failed}`)
if (failed > 0) process.exit(1)
