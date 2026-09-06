/**
 * model-variants helpers — Unit Tests
 *
 * Run: bun tests/test-model-variants-unit.ts
 */

import {
  applyModelVariantResolution,
  disableLeafSuffixVariants,
  effortSuffix,
  resolveSuffixModelRef,
  splitModelRef,
  stripEffortSuffix,
  type VariantConfig,
} from "../plugins/shared/model-variants"

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✅ ${msg}`)
    passed++
  } else {
    console.error(`  ❌ ${msg}`)
    failed++
  }
}

function section(title: string): void {
  console.log(`\n${"═".repeat(60)}`)
  console.log(`  ${title}`)
  console.log(`${"═".repeat(60)}`)
}

section("model ref and effort suffix parsing")

assert(JSON.stringify(splitModelRef("codex-router/gpt-5.6-luna")) === JSON.stringify({ providerID: "codex-router", modelID: "gpt-5.6-luna" }), "provider/model ref splits at the first slash")
assert(splitModelRef("bad") === undefined && splitModelRef("/bad") === undefined && splitModelRef("bad/") === undefined, "invalid refs are rejected")
assert(effortSuffix("gpt-5.6-luna-high") === "high", "known suffix detected")
assert(effortSuffix("qwen-mini") === undefined, "size suffix is not treated as an effort")
assert(stripEffortSuffix("gpt-5.6-luna-xhigh") === "gpt-5.6-luna", "known suffix stripped")

section("suffix model ref resolution")

const config: VariantConfig = {
  provider: {
    "codex-router": {
      models: {
        "gpt-5.6-luna": { id: "cx/gpt-5.6-luna", reasoning: true },
        "gpt-5.6-luna-low": { id: "cx/gpt-5.6-luna-low", reasoning: true },
        "gpt-5.6-luna-medium": { id: "cx/gpt-5.6-luna-medium", reasoning: true },
        "gpt-5.6-luna-high": { id: "cx/gpt-5.6-luna-high", reasoning: true },
        "gpt-5.6-luna-max": { id: "cx/gpt-5.6-luna-max", reasoning: true },
        "odd-luna-xhigh": { id: "cx/gpt-5.6-luna-xhigh", reasoning: true },
      },
    },
  },
}

assert(resolveSuffixModelRef(config, "codex-router/gpt-5.6-luna", "low") === "codex-router/gpt-5.6-luna-low", "low variant resolves to sibling key")
assert(resolveSuffixModelRef(config, "codex-router/gpt-5.6-luna", "medium") === "codex-router/gpt-5.6-luna-medium", "medium variant resolves to sibling key")
assert(resolveSuffixModelRef(config, "codex-router/gpt-5.6-luna", "high") === "codex-router/gpt-5.6-luna-high", "high variant resolves to sibling key")
assert(resolveSuffixModelRef(config, "codex-router/gpt-5.6-luna", "xhigh") === "codex-router/odd-luna-xhigh", "fallback matches a unique sibling by provider-facing api id")
assert(resolveSuffixModelRef(config, "codex-router/gpt-5.6-luna-high", "low") === "codex-router/gpt-5.6-luna-high", "already-suffixed refs are not double-suffixed")
assert(resolveSuffixModelRef(config, "codex-router/gpt-5.6-luna", "turbo") === "codex-router/gpt-5.6-luna", "unknown variants are ignored")

section("conservative safety guards")

const noReasoning: VariantConfig = {
  provider: {
    p: { models: { qwen: { id: "qwen" }, "qwen-max": { id: "qwen-max" } } },
  },
}
assert(resolveSuffixModelRef(noReasoning, "p/qwen", "max") === "p/qwen", "unmarked qwen→qwen-max is not guessed")

const explicitVariant: VariantConfig = {
  provider: {
    p: {
      models: {
        gpt: { id: "gpt", reasoning: true, variants: { high: { reasoningEffort: "high" } } },
        "gpt-high": { id: "gpt-high", reasoning: true },
      },
    },
  },
}
assert(resolveSuffixModelRef(explicitVariant, "p/gpt", "high") === "p/gpt-high", "suffix model wins over native OpenCode variant")

section("config mutation")

const cfg: VariantConfig = {
  provider: {
    p: {
      models: {
        base: { id: "up/base", reasoning: true },
        "base-low": { id: "up/base-low", reasoning: true },
        "base-medium": { id: "up/base-medium", reasoning: true },
        "base-high": { id: "up/base-high", reasoning: true },
      },
    },
  },
  agent: {
    explore: { model: "p/base", variant: "low" },
    code: { model: "p/base", variant: "medium" },
    plain: { model: "p/base" },
  },
  command: {
    review: { model: "p/base", variant: "high" },
  },
}

const changed = applyModelVariantResolution(cfg)
assert(changed > 0, "config pass reports mutations")
assert(cfg.agent?.explore?.model === "p/base-low", "agent low model ref rewritten in memory")
assert(cfg.agent?.code?.model === "p/base-medium", "agent medium model ref rewritten in memory")
assert(cfg.agent?.plain?.model === "p/base", "agent without variant stays on base")
assert(cfg.command?.review?.model === "p/base-high", "command variant model ref rewritten in memory")
assert(cfg.provider?.p?.models?.["base-low"]?.variants?.low?.disabled === true, "suffix leaf variants are disabled to avoid double reasoningEffort")

const before = JSON.stringify(cfg)
disableLeafSuffixVariants(cfg)
assert(JSON.stringify(cfg) === before, "leaf disabling is idempotent")

console.log(`\nPassed: ${passed}, Failed: ${failed}`)
if (failed > 0) process.exit(1)
