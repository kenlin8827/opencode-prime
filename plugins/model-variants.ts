import type { Plugin } from "@opencode/plugin"
import { MODEL_VARIANT_EFFORTS, effortSuffix } from "./shared/model-variants"

/**
 * Model Variants Plugin — resolves suffix-style reasoning models at runtime.
 *
 * Private OpenAI-compatible routers commonly expose reasoning effort as
 * sibling model IDs (`model-low`, `model-high`) instead of the native v2
 * `variants` map. Profiles stay readable as tier → base model + variant;
 * this plugin rewrites the runtime agent model ref to the concrete sibling.
 *
 * v1 ran one mutable `config` pass over the loaded config object. v2 has no
 * global config hook, so this is decomposed per domain (the documented
 * migration for `config`):
 *
 *   ctx.model.transform   — effort-suffixed models are leaves: drop native
 *                           effort variants so the resolver never layers a
 *                           `reasoningEffort` overlay on a model whose ID
 *                           already encodes the effort (v1
 *                           disableLeafSuffixVariants).
 *   ctx.agent.transform   — rewrite {provider, base, variant=effort} refs
 *                           to the proven sibling model and CLEAR the
 *                           variant: the v2 resolver errors with
 *                           VariantUnavailableError when a variant stays
 *                           set on a model that no longer declares it
 *                           (v1 could leave it dangling because its variant
 *                           lookup was tolerant).
 *
 * Reasoning gate: v1 tested `model.reasoning === true` from the raw config;
 * v2 Model.Info surfaces no reasoning flag. The equivalent declaration
 * signal is used instead — a rewrite only happens when the base declares
 * the effort as a native variant, or base/sibling carries variant or
 * reasoning-compatibility declarations. Undeclared size-suffix families
 * (qwen → qwen-max) still never rewrite.
 *
 * OCP-V2-GAP: v1 also rewrote `command.<name>.model` refs. The v2 Command
 * schema carries no per-command model/variant and the command editor is
 * add-only, so command variant resolution has no transform target — it is
 * dropped until upstream exposes command model config.
 *
 * Shared logic stays in plugins/shared/model-variants.ts (effort vocabulary,
 * suffix parsing); the config-object mutators there are v1-shaped and are
 * no longer called from this entry.
 */

const EFFORT_SET = new Set<string>(MODEL_VARIANT_EFFORTS)

interface CatalogModel {
  readonly providerID: string
  readonly id: string
  readonly modelID: string
  readonly variantIDs: ReadonlySet<string>
  /** True when the model declares reasoning capability beyond an effort name. */
  readonly reasoningDeclared: boolean
}

interface ModelRefLike {
  providerID: string
  id: string
  variant?: string
}

/** v2 ModelInfo structural slice used for sibling lookup. */
interface ModelInfoLike {
  providerID: string
  id: string
  modelID: string
  variants?: ReadonlyArray<{ id: string }>
  compatibility?: { reasoningField?: string }
}

function toCatalog(models: readonly ModelInfoLike[]): ReadonlyMap<string, CatalogModel[]> {
  const byProvider = new Map<string, CatalogModel[]>()
  for (const model of models) {
    const entry: CatalogModel = {
      providerID: model.providerID,
      id: model.id,
      modelID: model.modelID,
      variantIDs: new Set((model.variants ?? []).map((v) => v.id)),
      reasoningDeclared:
        (model.variants ?? []).length > 0 || typeof model.compatibility?.reasoningField === "string",
    }
    const list = byProvider.get(model.providerID)
    if (list) list.push(entry)
    else byProvider.set(model.providerID, [entry])
  }
  return byProvider
}

/** Resolve `<provider>/<base>` + effort variant to the provider's sibling model, or null. */
function resolveSiblingRef(
  catalog: ReadonlyMap<string, CatalogModel[]>,
  ref: ModelRefLike,
): ModelRefLike | null {
  const variant = ref.variant
  if (!variant || !EFFORT_SET.has(variant)) return null
  // Already suffixed — never double-suffix.
  if (effortSuffix(ref.id)) return null

  const entries = catalog.get(ref.providerID)
  if (!entries || entries.length === 0) return null

  const base = entries.find((m) => m.id === ref.id)
  if (!base) return null

  const suffix = `${ref.id}-${variant}`
  // Config-key sibling wins; fall back to a unique provider-facing api id
  // match (`<base.modelID>-<variant>`), mirroring the v1 candidate rule.
  const exact = entries.find((m) => m.id === suffix)
  const apiMatches = exact ? [] : entries.filter((m) => m.modelID === `${base.modelID}-${variant}`)
  const sibling = exact ?? (apiMatches.length === 1 ? apiMatches[0] : undefined)
  if (!sibling) return null

  // Conservative gate: only rewrite on a declared reasoning/variant signal
  // (see header) so size-suffix families are never guessed.
  const declared = base.variantIDs.has(variant) || base.reasoningDeclared || sibling.reasoningDeclared
  if (!declared) return null

  // Clear the variant: on v2 the effort lives in the model ID and a stale
  // variant ref fails VariantUnavailableError at resolution.
  return { providerID: ref.providerID, id: sibling.id }
}

const plugin: Plugin.Plugin = {
  id: "model-variants",
  async setup(ctx) {
    // Leaf stripping needs no external data — pure editor logic, replay-safe.
    await ctx.model.transform((editor) => {
      for (const model of editor.list()) {
        if (!effortSuffix(String(model.id))) continue
        editor.update(String(model.providerID), String(model.id), (m) => {
          m.variants = m.variants.filter((v) => !EFFORT_SET.has(String(v.id)))
        })
      }
    })

    // Preload the catalog, capture it for the agent transform, refresh on
    // out-of-band model changes + reload (the documented transform pattern).
    let catalog = toCatalog((await ctx.model.list().catch(() => ({ data: [] as ModelInfoLike[] }))).data as ModelInfoLike[])

    await ctx.agent.transform((editor) => {
      for (const agent of editor.list()) {
        const ref = agent.model
        if (!ref) continue
        const next = resolveSiblingRef(catalog, { providerID: String(ref.providerID), id: String(ref.id), variant: ref.variant ? String(ref.variant) : undefined })
        if (!next) continue
        editor.update(String(agent.id), (a) => {
          // Model.Ref fields are compile-time brands only; runtime values
          // are plain strings, so the structural cast is safe.
          if (a.model) a.model = next as unknown as typeof a.model
        })
      }
    })

    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      void ctx.model
        .list()
        .then((res) => {
          catalog = toCatalog(res.data as ModelInfoLike[])
          return ctx.agent.reload()
        })
        .catch(() => {
          // Refresh failed — the setup-time catalog stays; fail open.
        })
    }
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type !== "model.updated") continue
          if (event.location && event.location.directory !== ctx.location.directory) continue
          // Coalesce catalog churn (provider discovery fires in bursts).
          clearTimeout(timer)
          timer = setTimeout(refresh, 250)
        }
      } catch {
        // Subscription ended; cleanup below aborts the signal.
      }
    })()

    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  },
}

export default plugin
