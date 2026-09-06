/**
 * model-variants — local reasoning-effort helpers for custom providers.
 *
 * OpenCode already has first-class model `variants`: an agent `variant`
 * (low/medium/high/…) is used only when the selected model exposes a matching
 * `provider.<id>.models.<model>.variants.<variant>` entry.  Custom OpenAI-
 * compatible routers commonly expose effort as separate model IDs instead
 * (`gpt-x-low`, `gpt-x-high`) and omit the OpenCode variant map.  This module
 * derives the safe subset of that map from the provider's own model list.
 *
 * No external catalog is authoritative for a user's private router.  The only
 * source of truth is the configured/live model IDs under that provider.
 */

export const MODEL_VARIANT_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const

export type ModelVariantEffort = typeof MODEL_VARIANT_EFFORTS[number]

export interface VariantModelDef {
  id?: string
  reasoning?: boolean
  variants?: Record<string, { disabled?: boolean; [key: string]: unknown }>
  [key: string]: unknown
}

export interface VariantProviderDef {
  models?: Record<string, VariantModelDef>
  [key: string]: unknown
}

export interface VariantConfig {
  provider?: Record<string, VariantProviderDef>
  agent?: Record<string, { model?: string; variant?: string; [key: string]: unknown }>
  command?: Record<string, { model?: string; variant?: string; [key: string]: unknown }>
  [key: string]: unknown
}

const EFFORT_SET = new Set<string>(MODEL_VARIANT_EFFORTS)

export function splitModelRef(ref: string): { providerID: string; modelID: string } | undefined {
  const slash = ref.indexOf("/")
  if (slash <= 0 || slash === ref.length - 1) return undefined
  return { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) }
}

export function effortSuffix(modelID: string): ModelVariantEffort | undefined {
  const dash = modelID.lastIndexOf("-")
  if (dash <= 0 || dash === modelID.length - 1) return undefined
  const suffix = modelID.slice(dash + 1).toLowerCase()
  return EFFORT_SET.has(suffix) ? suffix as ModelVariantEffort : undefined
}

export function stripEffortSuffix(modelID: string): string | undefined {
  const suffix = effortSuffix(modelID)
  return suffix ? modelID.slice(0, -(suffix.length + 1)) : undefined
}

const modelReasoningKnown = (model: VariantModelDef | undefined): boolean => model?.reasoning === true

function candidateByApiID(models: Record<string, VariantModelDef>, base: VariantModelDef, effort: string): string | undefined {
  if (typeof base.id !== "string" || !base.id.trim()) return undefined
  const target = `${base.id}-${effort}`
  const hits = Object.entries(models).filter(([, model]) => model.id === target)
  return hits.length === 1 ? hits[0]![0] : undefined
}

/** Resolve `<provider>/<base>` to `<provider>/<base>-<variant>` when that sibling exists. */
export function resolveSuffixModelRef(config: VariantConfig, ref: string, variant: string | undefined): string {
  if (!variant || !EFFORT_SET.has(variant)) return ref
  const parsed = splitModelRef(ref)
  if (!parsed) return ref
  if (effortSuffix(parsed.modelID)) return ref

  const provider = config.provider?.[parsed.providerID]
  const models = provider?.models
  if (!models || typeof models !== "object") return ref

  const base = models[parsed.modelID]
  if (!base) return ref
  const candidateKey = models[`${parsed.modelID}-${variant}`]
    ? `${parsed.modelID}-${variant}`
    : candidateByApiID(models, base, variant)
  // A provider's concrete sibling model is authoritative for suffix-style
  // routers. If no sibling exists, preserve the base ref so OpenCode can use
  // its native parameter variant when one is declared.
  if (!candidateKey) return ref

  const candidate = models[candidateKey]
  // Avoid false positives like `qwen` -> `qwen-max` for size/model-family
  // suffixes unless at least one side explicitly says this is a reasoning model.
  if (!modelReasoningKnown(base) && !modelReasoningKnown(candidate)) return ref
  return `${parsed.providerID}/${candidateKey}`
}

/**
 * Mark effort-suffixed models as leaves: their ID already encodes the effort,
 * so OpenCode should not also apply an auto-generated `reasoningEffort` variant.
 */
export function disableLeafSuffixVariants(config: VariantConfig): number {
  let changed = 0
  for (const provider of Object.values(config.provider ?? {})) {
    const models = provider.models
    if (!models || typeof models !== "object") continue
    for (const [modelID, model] of Object.entries(models)) {
      if (!effortSuffix(modelID)) continue
      model.variants ??= {}
      for (const effort of MODEL_VARIANT_EFFORTS) {
        if (model.variants[effort] !== undefined) continue
        model.variants[effort] = { disabled: true }
        changed++
      }
    }
  }
  return changed
}

/** Mutate agent/command model refs to suffix IDs where the provider proves they exist. */
export function applySuffixModelRefs(config: VariantConfig): number {
  let changed = 0
  for (const agent of Object.values(config.agent ?? {})) {
    if (typeof agent.model !== "string") continue
    const next = resolveSuffixModelRef(config, agent.model, typeof agent.variant === "string" ? agent.variant : undefined)
    if (next === agent.model) continue
    agent.model = next
    changed++
  }
  for (const command of Object.values(config.command ?? {})) {
    if (typeof command.model !== "string") continue
    const next = resolveSuffixModelRef(config, command.model, typeof command.variant === "string" ? command.variant : undefined)
    if (next === command.model) continue
    command.model = next
    changed++
  }
  return changed
}

/** Full in-memory config pass used by the root plugin. */
export function applyModelVariantResolution(config: VariantConfig): number {
  return disableLeafSuffixVariants(config) + applySuffixModelRefs(config)
}
