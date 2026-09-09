/**
 * Provider wizard core: side-effect-free provider/model transformations.
 * This module is the documented export boundary shared by the TUI wizard and
 * the future CLI wizard; callers own persistence and user-facing messages.
 */

import type { AuthEntry, ModelDef, OpenCodeConfig, ProviderDef } from "./provider-creds"

export type { ModelDef, OpenCodeConfig, ProviderDef }

export interface ProviderDraft {
  id: string
  name: string
  npm: string
  baseURL: string
  apiKey: string
  keySet: boolean
  keySource?: "auth" | "config"
}

export interface ModelDraft {
  key: string
  id: string
  name: string
  status: string
  attachment: boolean
  temperature: boolean
  reasoning: boolean
  toolCall: boolean
  modalitiesIn: string[]
  modalitiesOut: string[]
  contextLimit: string
  outputLimit: string
}

export const NPM_OPENAI = "@ai-sdk/openai-compatible"
export const NPM_ANTHROPIC = "@ai-sdk/anthropic"

export function validateProviderId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(id)
}

export function globToRegex(glob: string): RegExp {
  let source = ""
  for (const char of glob) {
    if (char === "*") source += ".*"
    else if (char === "?") source += "."
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${source}$`)
}

export function compactProvider(provider: ProviderDef | undefined): void {
  if (!provider) return
  if (!provider.name) delete provider.name
  if (provider.npm === NPM_OPENAI) delete provider.npm
  delete provider.presetModels
  if (provider.options && Object.keys(provider.options).length === 0) delete provider.options
  for (const [key, model] of Object.entries(provider.models ?? {})) {
    if (!model.id || model.id === key) delete model.id
    if (!model.name || model.name === key) delete model.name
    if (!model.status || model.status === "active") delete model.status
    if (model.attachment === false) delete model.attachment
    if (model.temperature === false) delete model.temperature
    if (model.reasoning === false) delete model.reasoning
    if (model.tool_call === true) delete model.tool_call
    const modalities = model.modalities
    if (modalities) {
      const textOnly = (value?: string[]) => !value || (value.length === 1 && value[0] === "text")
      if (textOnly(modalities.input)) delete modalities.input
      if (textOnly(modalities.output)) delete modalities.output
      if (Object.keys(modalities).length === 0) delete model.modalities
    }
    const limit = model.limit
    if (limit) {
      const context = typeof limit.context === "number" ? limit.context : 0
      const output = typeof limit.output === "number" ? limit.output : 0
      const extra = Object.keys(limit).filter((name) => name !== "context" && name !== "output")
      if (!context && !output && extra.length === 0) delete model.limit
      else {
        limit.context = context
        limit.output = output
      }
    }
  }
}

export interface ClearModelsPlan {
  matched: string[]
  remove(config: OpenCodeConfig, providerId: string): number
}

export function clearModelsPlan(models: Record<string, ModelDef>, pattern: string): ClearModelsPlan {
  const matcher = globToRegex(pattern)
  const matched = Object.keys(models).filter((key) => matcher.test(key))
  return {
    matched,
    remove(config, providerId) {
      const target = config.provider?.[providerId]?.models
      if (!target) return 0
      for (const key of matched) delete target[key]
      return matched.length
    },
  }
}

export function allocateModelKey(
  models: Record<string, ModelDef>,
  baseKey: string,
  remoteId: string,
): { key: string; duplicate: boolean } {
  const existing = models[baseKey]
  if (!existing) return { key: baseKey, duplicate: false }
  if (existing.id === remoteId) return { key: baseKey, duplicate: true }
  let suffix = 2
  let candidate = `${baseKey}-${suffix}`
  while (models[candidate]) {
    if (models[candidate].id === remoteId) return { key: candidate, duplicate: true }
    suffix++
    candidate = `${baseKey}-${suffix}`
  }
  return { key: candidate, duplicate: false }
}

export interface CatalogModel {
  id?: string
  capabilities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; output?: number }
  reasoning?: boolean
  temperature?: boolean
  toolCall?: boolean
}

const effortSuffixes = new Set(["none", "low", "medium", "high", "xhigh", "max"])

function catalogMatch(remoteId: string, catalog: readonly CatalogModel[]): CatalogModel | undefined {
  const bare = remoteId.slice(remoteId.lastIndexOf("/") + 1)
  const levels = [remoteId, bare]
  const dash = bare.lastIndexOf("-")
  if (dash > 0 && effortSuffixes.has(bare.slice(dash + 1))) levels.push(bare.slice(0, dash))
  for (const level of levels) {
    const matches = catalog.filter((model) => level === remoteId ? model.id === remoteId : model.id?.slice(model.id.lastIndexOf("/") + 1) === level)
    if (matches.length > 1) return undefined
    if (matches.length === 1) return matches[0]
  }
  return undefined
}

export { catalogMatch }

export function applyFlag(entry: ModelDef, flag: "reasoning" | "temperature" | "toolCall", value: boolean | undefined): boolean {
  if (value === undefined) return false
  if (flag === "toolCall") {
    if (value === false && entry.tool_call === undefined) {
      entry.tool_call = false
      return true
    }
    return false
  }
  if (value && entry[flag] === undefined) {
    entry[flag] = true
    return true
  }
  return false
}

export interface ProviderSaveResult {
  config: OpenCodeConfig
  auth: Record<string, AuthEntry>
  error?: "idRequired" | "invalidProviderId" | "baseURLRequired" | "providerExists"
  warnings?: ("migrated" | "renamed")[]
}

export function planProviderSave(
  draft: ProviderDraft,
  existingId: string,
  config: OpenCodeConfig,
  auth: Record<string, AuthEntry>,
): ProviderSaveResult {
  const isNew = !existingId
  const id = draft.id.trim()
  const target = isNew ? id : id && id !== existingId ? id : existingId
  if (isNew && !target) return { config, auth, error: "idRequired" }
  if ((isNew || target !== existingId) && !validateProviderId(target)) return { config, auth, error: "invalidProviderId" }
  if (!draft.baseURL && draft.npm !== NPM_ANTHROPIC) return { config, auth, error: "baseURLRequired" }
  if ((isNew || target !== existingId) && config.provider?.[target]) return { config, auth, error: "providerExists" }
  config.provider ??= {}
  if (isNew) config.provider[target] = { models: {} }
  else if (target !== existingId) {
    config.provider[target] = config.provider[existingId]
    delete config.provider[existingId]
    if (auth[existingId]) {
      auth[target] = auth[existingId]
      delete auth[existingId]
    }
  }
  const provider = config.provider[target]
  if (draft.name) provider.name = draft.name
  else if (!isNew) delete provider.name
  provider.npm = draft.npm
  delete provider.type
  provider.options ??= {}
  if (draft.baseURL) provider.options.baseURL = draft.baseURL
  else if (!isNew) delete provider.options.baseURL
  if (draft.apiKey) {
    if (draft.apiKey.startsWith("{env:")) {
      provider.options.apiKey = draft.apiKey
      delete auth[target]
    } else {
      auth[target] = { type: "api", key: draft.apiKey }
      delete provider.options.apiKey
    }
  } else if (!isNew && provider.options.apiKey !== undefined && !String(provider.options.apiKey).startsWith("{env:")) {
    auth[target] = { type: "api", key: String(provider.options.apiKey) }
    delete provider.options.apiKey
  }
  compactProvider(provider)
  const warnings: ("migrated" | "renamed")[] = []
  if (!draft.apiKey && !isNew && auth[target]?.type === "api" && !provider.options?.apiKey) warnings.push("migrated")
  if (target !== existingId) warnings.push("renamed")
  return { config, auth, warnings }
}
