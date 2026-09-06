/**
 * Model Variants Plugin — resolves suffix-style reasoning models in memory.
 *
 * OpenCode supports model `variants` natively, but private routers often expose
 * reasoning effort as sibling model IDs (`model-low`, `model-high`).  This
 * plugin runs in the `config` hook and rewrites agent/command model refs to an
 * existing suffix sibling when the agent/command has a matching `variant`.
 *
 * It never writes opencode.jsonc: profiles stay readable as tier → base model,
 * while runtime config gets the concrete model ID the router expects.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { applyModelVariantResolution } from "./shared/model-variants"

export const ModelVariantsPlugin: Plugin = async () => ({
  config: async (config) => {
    applyModelVariantResolution(config as Parameters<typeof applyModelVariantResolution>[0])
  },
})
