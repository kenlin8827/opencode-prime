/// <reference types="bun" />
import type { Context } from "@opencode/plugin/tui/context"
import type { ModelInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import { appKeymapLayer } from "../_keymap-app"

/**
 * Provider Wizard — TUI dialog-based provider configuration.
 *
 * v2 migration: promise-based dialogs with async-loop menu levels. Each
 * level resolves a navigation tag for its parent loop:
 *   "back"  — Esc / cancel: the parent re-presents itself
 *   { detail: id } — after a save, the parent jumps to that provider's
 *                    detail level instead of re-showing its own list
 *
 * OCP-V2-GAP: the compat host's `renderFilter: false` (form sheets hid the
 * type-to-filter box; single-Esc close). v2's select dialog always shows
 * its filter — typing on a form sheet now filters rows instead of being
 * inert. Cosmetic; every row remains reachable by arrow+Enter.
 *
 * The single provider management entry point: `/provider` opens a native
 * dialog wizard. Registered as a CLI-only plugin in `cli.json` (v2 TUI
 * plugin list).
 *
 * Entry points:
 *   /provider               — slash command (opens the wizard)
 *   /disconnect             — slash command (TUI only, keymap: one menu
 *                             row, instant dialogs; <id> jumps to
 *                             confirm; --all asks once)
 *   command palette         — "Provider setup wizard"
 *
 * Flow — two dialog levels:
 *   Level 1: select — "➕ Add custom provider" (blank), "📦 Add preset
 *            provider" (imports a providers/ definition file into the
 *            config) and "🔌 Manage connections…" pinned on top without
 *            category headers, then the providers stored in the
 *            opencode.jsonc `provider` node;
 *            `current` keeps the cursor on the first provider so picking
 *            stays one key away. Presets enter the list only via 📦.
 *   Level 2 (provider detail): select —
 *     ⚙ Basic settings — shared settings form (name / npm / baseURL /
 *     apiKey); add mode prepends an editable id row and creates the
 *     provider on 💾. npm picks
 *     @ai-sdk/openai-compatible / @ai-sdk/anthropic — the SDK package
 *     decides the API protocol (opencode has no `type`). Draft-based:
 *     fields mutate in memory, 💾 saves once; empty apiKey keeps the
 *     stored key, a literal secret is never pre-filled. Literal keys go
 *     to opencode's auth.json — the store the official /connect command
 *     uses — while {env:VAR} refs stay in options.apiKey.
 *     fetch:      prompts a glob pattern (default *) and imports matching
 *                 models from the live `{baseURL}/models` (openai) or
 *                 `{baseURL}/v1/models` (anthropic) response; additive —
 *                 existing keys are skipped, never overwritten or deleted.
 *                 The live OpenCode model catalog supplements imported entries
 *                 with explicitly declared image capabilities when IDs match.
 *     ── Models ──         one list mirroring the config node (natural
 *                          order); click opens the model form, 🗑 removes
 *                          the config entry
 *     ➕ Add model…        form sheet: identity / capabilities / limits
 *     📥 Fetch models…     import remote models by glob pattern
 *     🗑 Clear models…    remove models matching a glob pattern (* = all)
 *     🔌 Disconnect…     remove the stored credential and clear apiKey —
 *                         the provider definition and models stay, so
 *                         reconnecting is one ⚙ Basic settings form away
 *     🗑 Delete provider…  confirm, then drop the whole config entry
 *   Writes go through atomic opencode.jsonc saves (forms on 💾); the
 *   saved provider is compacted — fields equal to host parse defaults
 *   are omitted so the file stays short and hand-editable.
 *
 * Changes require a location reload / opencode restart to take effect.
 *
 * Note: this is a TUI-only module. It only runs inside the TUI; headless
 * sessions have no /provider equivalent (headless disconnect:
 * /disconnect, which shares plugins/shared/provider-creds.ts with this
 * wizard).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { tr, initI18n, refreshLocale, languageOption, switchLanguage, SWITCH_LANG, parseSlashArgs, type DialogOption } from "../i18n"
import {
  CONFIG_FILE,
  readConfig,
  writeConfigAtomic,
  writeAuth,
  readAuth,
  authKey,
  naturalCmp,
  listConnections,
  readConnections,
  disconnectProvider,
  type ModelDef,
  type ProviderDef,
  type OpenCodeConfig,
  type ConnectionInfo,
} from "../../shared/provider-creds"
import { fetchModelsDevModelCatalog, fetchProviderModelsCached } from "../../shared/model-catalog"

/** Navigation result a dialog level hands back to its parent loop. */
type Nav = "back" | { detail: string }

const CONFIG_DIR = join(homedir(), ".config", "opencode")
const PROVIDERS_DIR = join(CONFIG_DIR, "providers")
const PLUGIN_ID = "opencode-prime.provider"
const ADD_PROVIDER = "__add_provider__"
const ADD_PRESET = "__add_preset__"
const MANAGE_CONNECTIONS = "__manage_connections__"
const EDIT_SETTINGS = "__edit_settings__"
const EDIT_ID = "__edit_id__"
const DELETE_PROVIDER = "__delete_provider__"
const DISCONNECT = "__disconnect__"
const SAVE_PROVIDER = "__save_provider__"
const EDIT_NAME = "__edit_name__"
const EDIT_NPM = "__edit_npm__"
const EDIT_BASE_URL = "__edit_base_url__"
const EDIT_API_KEY = "__edit_api_key__"
const FETCH_MODELS = "__fetch_models__"
const ADD_MODEL = "__add_model__"
const CLEAR_MODELS = "__clear_models__"
const MODEL_PREFIX = "model:"
const FIELD_KEY = "__field_key__"
const FIELD_ID = "__field_id__"
const FIELD_NAME = "__field_name__"
const FIELD_STATUS = "__field_status__"
const FIELD_ATTACHMENT = "__field_attachment__"
const FIELD_TEMPERATURE = "__field_temperature__"
const FIELD_REASONING = "__field_reasoning__"
const FIELD_TOOLCALL = "__field_toolcall__"
const FIELD_MODAL_IN = "__field_modal_in__"
const FIELD_MODAL_OUT = "__field_modal_out__"
const FIELD_CONTEXT = "__field_context__"
const FIELD_OUTPUT = "__field_output__"
const SAVE_MODEL = "__save_model__"
const DELETE_MODEL = "__delete_model__"

// ─── Model import helpers (exported for unit tests) ─────────────────────

/** Strip namespace prefixes (e.g. `cx/`) from remote model IDs. */
export function deriveModelKey(remoteId: string): string {
  const trimmed = remoteId.trim()
  if (!trimmed) return remoteId
  const slash = trimmed.lastIndexOf("/")
  if (slash === -1 || slash === trimmed.length - 1) {
    return slash === trimmed.length - 1 ? trimmed.slice(0, -1) : trimmed
  }
  return trimmed.slice(slash + 1)
}

/** Remove namespace prefixes from display names; fallback to provided default. */
export function humanizeModelName(remoteName: string | undefined, fallback: string): string {
  const source = (remoteName ?? "").trim() || fallback
  const slash = source.lastIndexOf("/")
  if (slash === -1 || slash === source.length - 1) {
    return slash === source.length - 1 ? source.slice(0, -1) : source
  }
  return source.slice(slash + 1)
}

/** Ensure model keys are unique; duplicate IDs are treated as already imported. */
export function allocateModelKey(
  models: Record<string, ModelDef>,
  baseKey: string,
  remoteId: string,
): { key: string; duplicate: boolean } {
  const existing = models[baseKey]
  if (!existing) {
    return { key: baseKey, duplicate: false }
  }
  if (existing.id === remoteId) {
    return { key: baseKey, duplicate: true }
  }
  let suffix = 2
  let candidate = `${baseKey}-${suffix}`
  while (models[candidate]) {
    if (models[candidate].id === remoteId) {
      return { key: candidate, duplicate: true }
    }
    suffix++
    candidate = `${baseKey}-${suffix}`
  }
  return { key: candidate, duplicate: false }
}

/**
 * models.dev provider-agnostic catalog (models.json) — the open model
 * database opencode's built-in providers consume. Keys are canonical
 * "author/model" IDs, so a remote "vendor/gpt-x" matches by bare ID
 * suffix without any normalization. The shared model-catalog module owns
 * the models.dev fetch and stale-while-revalidate disk cache; this wizard
 * only converts its normalized records to the conservative fields it writes.
 */
/** opencode's modality vocabulary; catalog-specific values like "file" are dropped. */
const MODALITY_NAMES = ["text", "audio", "image", "video", "pdf"]

type CatalogModel = {
  id?: string
  capabilities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; output?: number }
  reasoning?: boolean
  reasoningOptions?: Array<Record<string, unknown>>
  variants?: Record<string, Record<string, unknown>>
  temperature?: boolean
  toolCall?: boolean
}

const strArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined

/** Accept both modality shapes seen in the wild: string arrays and boolean maps. */
const normalizeModalities = (value: unknown): string[] | undefined => {
  const arr = strArray(value)
  if (arr) return arr.filter((m) => MODALITY_NAMES.includes(m))
  if (value && typeof value === "object") {
    const on = MODALITY_NAMES.filter((m) => (value as Record<string, unknown>)[m] === true)
    return on.length ? on : undefined
  }
  return undefined
}

const normalizeLimit = (value: unknown): { context: number; output: number } | undefined => {
  if (!value || typeof value !== "object") return undefined
  const limit = value as { context?: unknown; output?: unknown }
  if (typeof limit.context !== "number" || !Number.isFinite(limit.context) || limit.context <= 0) return undefined
  if (typeof limit.output !== "number" || !Number.isFinite(limit.output) || limit.output <= 0) return undefined
  return { context: limit.context, output: limit.output }
}

/** Decode one catalog entry's shared fields (used by both payload shapes). */
const catalogEntry = (id: string, model: Record<string, unknown>): CatalogModel => {
  const caps = model.modalities ?? model.capabilities
  const capabilities =
    caps && typeof caps === "object"
      ? {
          input: normalizeModalities((caps as { input?: unknown }).input),
          output: normalizeModalities((caps as { output?: unknown }).output),
        }
      : undefined
  const limit = normalizeLimit(model.limit)
  const entry: CatalogModel = { id }
  if (capabilities?.input || capabilities?.output) entry.capabilities = capabilities
  if (limit) entry.limit = limit
  // Only non-default values are worth recording: opencode already defaults
  // reasoning/temperature to false and tool_call to true.
  if (model.reasoning === true) entry.reasoning = true
  if (model.temperature === true) entry.temperature = true
  if (model.tool_call === false) entry.toolCall = false
  return entry
}

/** True when a decoded entry carries at least one usable signal. */
const catalogEntryUsable = (entry: CatalogModel): boolean =>
  entry.capabilities !== undefined || entry.limit !== undefined ||
  entry.reasoning !== undefined || entry.temperature !== undefined || entry.toolCall !== undefined

/**
 * Decode a models.dev `models.json` payload defensively. Two shapes are
 * accepted: the live object-keyed form (`{ "author/model": {...} }`) and
 * the older array form (`{ data: [{ id, architecture: {...} }] }`).
 */
export function catalogModels(body: unknown): CatalogModel[] {
  if (!body || typeof body !== "object") return []
  if (!Array.isArray(body)) {
    const entries = Object.entries(body as Record<string, unknown>).flatMap(([key, model]): CatalogModel[] => {
      if (!model || typeof model !== "object" || Array.isArray(model)) return []
      const id = typeof (model as { id?: unknown }).id === "string" ? (model as { id: string }).id : key
      return [catalogEntry(id, model as Record<string, unknown>)]
    })
    // Recognized as the live shape when at least one entry carried a signal
    // (a `{ data: [...] }` body yields none — its only value is an array).
    if (entries.some(catalogEntryUsable)) return entries
  }
  return catalogModelsLegacyArray(body)
}

/**
 * Decode the older models.dev array payload (`{ data: [...] }` with
 * `architecture.input_modalities` / `context_length` / `top_provider`).
 */
export function catalogModelsLegacyArray(body: unknown): CatalogModel[] {
  const list = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(list)) return []
  return list.flatMap((model): CatalogModel[] => {
    if (!model || typeof model !== "object") return []
    const m = model as {
      id?: unknown
      architecture?: { input_modalities?: unknown; output_modalities?: unknown }
      modalities?: { input?: unknown; output?: unknown }
      limit?: unknown
      reasoning?: unknown
      temperature?: unknown
      tool_call?: unknown
    }
    if (typeof m.id !== "string") return []
    const arch = m.architecture
    const normalized: Record<string, unknown> = {
      modalities: m.modalities ?? (arch
        ? { input: arch.input_modalities, output: arch.output_modalities }
        : undefined),
      limit: m.limit,
      reasoning: m.reasoning,
      temperature: m.temperature,
      tool_call: m.tool_call,
    }
    if (!normalized.limit) {
      // legacy shape carries limits as context_length + top_provider
      const top = (model as { top_provider?: { max_completion_tokens?: unknown } }).top_provider
      const context = (model as { context_length?: unknown }).context_length
      const output = top?.max_completion_tokens
      if (typeof context === "number" && typeof output === "number") {
        normalized.limit = { context, output }
      }
    }
    const entry = catalogEntry(m.id, normalized)
    return [entry]
  })
}

/**
 * Decode the host's live model catalog (v2 `ModelInfo[]` from the plugin
 * data cache) into conservative import metadata. Every step tolerates
 * absence; an empty list just means no host-catalog fields.
 */
export function sdkCatalogModels(models: readonly ModelInfo[]): CatalogModel[] {
  return models.flatMap((m): CatalogModel[] => {
    if (typeof m.id !== "string" || !m.id) return []
    const entry: CatalogModel = { id: m.id }
    const capabilities = m.capabilities
      ? { input: normalizeModalities(m.capabilities.input), output: normalizeModalities(m.capabilities.output) }
      : undefined
    if (capabilities?.input || capabilities?.output) entry.capabilities = capabilities
    const limit = normalizeLimit(m.limit && { context: m.limit.context, output: m.limit.output })
    if (limit) entry.limit = limit
    // v2 variants are effort/named overlays; effort ids double as the
    // reasoning-effort ladder the legacy reasoning_options encoded.
    if (m.variants?.length) {
      entry.variants = Object.fromEntries(m.variants.map((v) => [v.id, v.settings ?? {}]))
    }
    return [entry]
  })
}

let catalogCache: Promise<CatalogModel[]> | undefined

/**
 * Fetch the model catalog, cached per session, in two fallback layers:
 *   1. the host's own live model catalog (ctx.data.location.model) when
 *      reachable;
 *   2. the models.dev database (the open dataset opencode itself consumes).
 * Best-effort by construction: every failure short-circuits to the next
 * layer and ultimately to an empty catalog, so a broken/unreachable
 * catalog NEVER blocks or alters the remote model fetch — imports just
 * fall back to conservative text-only defaults.
 */
export function fetchCatalog(ctx: Context): Promise<CatalogModel[]> {
  catalogCache ??= (async () => {
    let fromSdk: CatalogModel[] = []
    try {
      const location = ctx.location
      await ctx.data.location.model.sync(location)
      fromSdk = sdkCatalogModels(ctx.data.location.model.list(location) ?? [])
    } catch {
      // host catalog unavailable — public catalog still fills metadata
    }
    let fromPublic: CatalogModel[] = []
    try {
      fromPublic = (await fetchModelsDevModelCatalog()).map((model): CatalogModel => ({
        id: model.id,
        capabilities: model.capabilities,
        limit: model.limit && typeof model.limit.context === "number" && typeof model.limit.output === "number"
          ? { context: model.limit.context, output: model.limit.output }
          : undefined,
        reasoning: model.reasoning === true ? true : undefined,
        reasoningOptions: model.reasoningOptions,
        variants: model.variants,
        temperature: model.temperature === true ? true : undefined,
        toolCall: model.toolCall === false ? false : undefined,
      }))
    } catch {
      // public catalog unavailable — keep any host catalog fields
    }
    const merged = new Map<string, CatalogModel>()
    const publicByBare = new Map<string, CatalogModel>()
    for (const entry of fromPublic) {
      if (entry.id) publicByBare.set(deriveModelKey(entry.id), entry)
      merged.set(entry.id!, { ...entry })
    }
    for (const entry of fromSdk) {
      const previous = merged.get(entry.id!)
      const bareFill = entry.id ? publicByBare.get(deriveModelKey(entry.id)) : undefined
      merged.set(entry.id!, {
        ...previous,
        ...entry,
        capabilities: entry.capabilities ?? previous?.capabilities ?? bareFill?.capabilities,
        limit: entry.limit ?? previous?.limit ?? bareFill?.limit,
        reasoning: entry.reasoning ?? previous?.reasoning ?? bareFill?.reasoning,
        reasoningOptions: entry.reasoningOptions ?? previous?.reasoningOptions ?? bareFill?.reasoningOptions,
        variants: entry.variants ?? previous?.variants ?? bareFill?.variants,
        temperature: entry.temperature ?? previous?.temperature ?? bareFill?.temperature,
        toolCall: entry.toolCall ?? previous?.toolCall ?? bareFill?.toolCall,
      })
    }
    return [...merged.values()]
  })()
  return catalogCache
}

/**
 * Reasoning-effort variants some gateways expose as standalone model IDs
 * ("gpt-5.6-luna-xhigh"). Stripped ONLY as a last-resort fallback: exact
 * IDs and real model names like "qwen-max" keep precedence. A single
 * trailing segment is removed — compounds are not guessed.
 */
const EFFORT_SUFFIXES = new Set(["none", "low", "medium", "high", "xhigh", "max"])

const stripEffortSuffix = (id: string): string | undefined => {
  const dash = id.lastIndexOf("-")
  if (dash <= 0) return undefined
  const suffix = id.slice(dash + 1)
  return EFFORT_SUFFIXES.has(suffix) ? id.slice(0, dash) : undefined
}

/**
 * Unique catalog match for a remote model ID, tried from most to least
 * specific; a level with AMBIGUOUS hits stops the ladder (conflicting
 * catalog data must not be guessed past):
 *   1. exact ID;
 *   2. bare ID (namespace prefix removed), exactly one hit;
 *   3. bare ID minus one trailing reasoning-effort suffix, exactly one hit.
 */
function catalogMatch(remoteID: string, catalog: readonly CatalogModel[]): CatalogModel | undefined {
  const bareID = deriveModelKey(remoteID)
  const levels: string[] = [remoteID, bareID]
  const stripped = stripEffortSuffix(bareID)
  if (stripped && stripped !== bareID) levels.push(stripped)
  for (const level of levels) {
    const matches = level === remoteID
      ? catalog.filter((model) => model.id === remoteID)
      : catalog.filter((model) => typeof model.id === "string" && deriveModelKey(model.id) === level)
    if (matches.length > 1) return undefined // ambiguous — stay unknown
    if (matches.length === 1) return matches[0]
  }
  return undefined
}

/** Catalog modalities for a remote model, conservatively requiring proven image input. */
export function catalogCapabilities(
  remoteID: string,
  catalog: readonly CatalogModel[],
): { input: string[]; output: string[] } | undefined {
  const match = catalogMatch(remoteID, catalog)
  const input = match?.capabilities?.input
  if (!match || !Array.isArray(input) || !input.includes("image")) return undefined
  return {
    input: [...input],
    output: Array.isArray(match.capabilities?.output) ? [...match.capabilities.output] : ["text"],
  }
}

/** Catalog token limits for a remote model; only a complete pair is returned. */
export function catalogLimit(
  remoteID: string,
  catalog: readonly CatalogModel[],
): { context: number; output: number } | undefined {
  const limit = catalogMatch(remoteID, catalog)?.limit
  return limit && limit.context && limit.output
    ? { context: limit.context, output: limit.output }
    : undefined
}

/** Record a catalog-proven capability flag when it differs from opencode's default. */
const applyFlag = (entry: ModelDef, flag: "reasoning" | "temperature" | "toolCall", value: boolean | undefined): boolean => {
  if (value === undefined) return false
  if (flag === "toolCall") {
    if (value === false && entry.tool_call === undefined) {
      entry.tool_call = false
      return true
    }
    return false
  }
  if (value === true && entry[flag] === undefined) {
    entry[flag] = true
    return true
  }
  return false
}

/** Convert portable effort metadata into OpenCode's native variant overlays. */
function catalogVariants(match: CatalogModel): Record<string, Record<string, unknown>> | undefined {
  const variants: Record<string, Record<string, unknown>> = { ...(match.variants ?? {}) }
  for (const option of match.reasoningOptions ?? []) {
    if (option.type !== "effort" || !Array.isArray(option.values)) continue
    for (const value of option.values) {
      if (typeof value !== "string" || variants[value]) continue
      variants[value] = { reasoningEffort: value }
    }
  }
  return Object.keys(variants).length ? variants : undefined
}

/** Merge reasoning metadata from all public entries sharing the same bare ID. */
function catalogReasoningOptions(remoteID: string, catalog: readonly CatalogModel[]): Array<Record<string, unknown>> | undefined {
  const bare = deriveModelKey(remoteID)
  const effort = new Set<string>()
  const other: Record<string, unknown>[] = []
  for (const entry of catalog) {
    if (!entry.reasoningOptions?.length || typeof entry.id !== "string") continue
    if (entry.id !== remoteID && deriveModelKey(entry.id) !== bare) continue
    for (const option of entry.reasoningOptions) {
      if (option.type === "effort" && Array.isArray(option.values)) {
        for (const value of option.values) if (typeof value === "string") effort.add(value)
      } else if (option && typeof option === "object" && !Array.isArray(option)) {
        const serialized = JSON.stringify(option)
        if (!other.some((item) => JSON.stringify(item) === serialized)) other.push(option)
      }
    }
  }
  const order = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
  const options: Array<Record<string, unknown>> = effort.size > 0
    ? [{ type: "effort", values: [...effort].sort((a, b) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b))) }]
    : []
  options.push(...other)
  return options.length > 0 ? options : undefined
}

const EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const

/** Infer missing base-model metadata from concrete effort sibling keys. */
export function ensureBaseReasoningOptions(models: Record<string, ModelDef>, catalog: readonly CatalogModel[] = []): number {
  let changed = 0
  for (const [key, model] of Object.entries(models)) {
    if (model.reasoning !== true || model.reasoning_options !== undefined) continue
    const values = EFFORT_VALUES.filter((value) => models[`${key}-${value}`] !== undefined)
    const options = values.length > 0
      ? [{ type: "effort", values: [...values] }]
      : catalogReasoningOptions(typeof model.id === "string" ? model.id : key, catalog)
    if (!options) continue
    model.reasoning_options = options
    changed++
  }
  return changed
}

/** Build a conservative imported model definition from catalog-proven data only. */
export function importedModelDef(
  remote: { id: string; name: string },
  key: string,
  catalog: readonly CatalogModel[],
): ModelDef {
  const entry: ModelDef = { name: humanizeModelName(remote.name, key), id: remote.id }
  const capabilities = catalogCapabilities(remote.id, catalog)
  if (capabilities) {
    entry.attachment = true
    entry.modalities = capabilities
  }
  const limit = catalogLimit(remote.id, catalog)
  if (limit) entry.limit = limit
  const match = catalogMatch(remote.id, catalog)
  if (match) {
    applyFlag(entry, "reasoning", match.reasoning)
    applyFlag(entry, "temperature", match.temperature)
    applyFlag(entry, "toolCall", match.toolCall)
    const reasoningOptions = catalogReasoningOptions(remote.id, catalog)
    if (reasoningOptions) entry.reasoning_options = reasoningOptions
    const variants = catalogVariants(match)
    if (variants) entry.variants = variants
  }
  return entry
}

/**
 * Fill capability fields an existing entry never had, using catalog-proven
 * data. Returns true when anything was added; never overwrites fields the
 * user (or an earlier import) already set.
 */
export function enrichModelDef(
  entry: ModelDef,
  remoteID: string,
  catalog: readonly CatalogModel[],
): boolean {
  let changed = false
  if (entry.attachment === undefined && entry.modalities === undefined) {
    const capabilities = catalogCapabilities(remoteID, catalog)
    if (capabilities) {
      entry.attachment = true
      entry.modalities = capabilities
      changed = true
    }
  }
  if (entry.limit === undefined) {
    const limit = catalogLimit(remoteID, catalog)
    if (limit) {
      entry.limit = limit
      changed = true
    }
  }
  const match = catalogMatch(remoteID, catalog)
  if (match) {
    changed = applyFlag(entry, "reasoning", match.reasoning) || changed
    changed = applyFlag(entry, "temperature", match.temperature) || changed
    changed = applyFlag(entry, "toolCall", match.toolCall) || changed
    const reasoningOptions = catalogReasoningOptions(remoteID, catalog)
    if (entry.reasoning_options === undefined && reasoningOptions) {
      entry.reasoning_options = reasoningOptions
      changed = true
    }
    const variants = catalogVariants(match)
    if (entry.variants === undefined && variants) {
      entry.variants = variants
      changed = true
    }
  }
  return changed
}

const NPM_OPENAI = "@ai-sdk/openai-compatible"
const NPM_ANTHROPIC = "@ai-sdk/anthropic"

// ─── Definition loading (same shape as provider-config.ts) ──────────

function loadDefinitions(): Map<string, { source: string; def: ProviderDef }> {
  const defs = new Map<string, { source: string; def: ProviderDef }>()
  if (!existsSync(PROVIDERS_DIR)) return defs
  let files: string[]
  try {
    files = readdirSync(PROVIDERS_DIR)
  } catch {
    return defs
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue
    try {
      const parsed = JSON.parse(
        readFileSync(join(PROVIDERS_DIR, file), "utf-8"),
      ) as Record<string, ProviderDef>
      for (const [id, def] of Object.entries(parsed)) {
        if (!def || typeof def !== "object" || !def.models) continue
        defs.set(id, { source: file, def })
      }
    } catch {
      // skip invalid definitions silently
    }
  }
  return defs
}

// ─── Small helpers ───────────────────────────────────────────────────

function isEnvToken(value: unknown): boolean {
  return String(value).startsWith("{env:")
}

function resolveEnv(value: string): string {
  return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => process.env[name] ?? "")
}

/** Literal secrets are never echoed; env tokens are safe to display. */
function displayKey(value: unknown): string {
  if (value === undefined) return tr("common.unset")
  return isEnvToken(value) ? String(value) : "••••••••"
}

function globToRegex(glob: string): RegExp {
  let re = ""
  for (const ch of glob) {
    if (ch === "*") re += ".*"
    else if (ch === "?") re += "."
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${re}$`)
}

function toast(
  ctx: Context,
  message: string,
  variant: "info" | "success" | "warning" | "error" = "info",
) {
  ctx.ui.toast.show({ title: tr("provider.toastTitle"), message, variant })
}

/** Atomic save + toast. Returns false (and toasts) on write failure. */
function saveConfig(ctx: Context, config: OpenCodeConfig, id: string): boolean {
  try {
    compactProvider(config.provider?.[id])
    writeConfigAtomic(CONFIG_FILE, config)
    toast(ctx, tr("provider.configSaved", { id }), "success")
    return true
  } catch (err) {
    toast(ctx, tr("provider.writeFailed", { err: (err as Error).message }), "error")
    return false
  }
}

/**
 * Drops fields equal to opencode's parse defaults so the written provider
 * node stays short and hand-editable: npm openai-compatible (host default),
 * id/name = key, status active, tool_call true, other capability switches
 * false, text-only modalities, zero limits. Unknown fields pass through
 * untouched; only the provider being saved is compacted so hand-written
 * overrides on catalog providers elsewhere in the file are never rewritten.
 */
function compactProvider(provider: ProviderDef | undefined): void {
  if (!provider) return
  if (!provider.name) delete provider.name
  if (provider.npm === NPM_OPENAI) delete provider.npm
  delete provider.presetModels // legacy fetch bookkeeping
  if (provider.options && Object.keys(provider.options).length === 0) delete provider.options
  for (const [key, m] of Object.entries(provider.models ?? {})) {
    if (!m.id || m.id === key) delete m.id
    if (!m.name || m.name === key) delete m.name
    if (!m.status || m.status === "active") delete m.status
    if (m.attachment === false) delete m.attachment
    if (m.temperature === false) delete m.temperature
    if (m.reasoning === false) delete m.reasoning
    if (m.tool_call === true) delete m.tool_call
    const mods = m.modalities
    if (mods) {
      const textOnly = (v?: string[]) => !v || (v.length === 1 && v[0] === "text")
      if (textOnly(mods.input)) delete mods.input
      if (textOnly(mods.output)) delete mods.output
      if (Object.keys(mods).length === 0) delete m.modalities
    }
    const limit = m.limit
    if (limit) {
      const ctx = typeof limit.context === "number" ? limit.context : 0
      const out = typeof limit.output === "number" ? limit.output : 0
      const extra = Object.keys(limit).filter((k) => k !== "context" && k !== "output")
      if (!ctx && !out && extra.length === 0) delete m.limit
      else {
        // the host schema requires both when limit is present
        limit.context = ctx
        limit.output = out
      }
    }
  }
}

function readConfigOrToast(ctx: Context): OpenCodeConfig | null {
  try {
    return readConfig(CONFIG_FILE)
  } catch (err) {
    toast(ctx, tr("provider.cannotReadConfig", { path: CONFIG_FILE, err: (err as Error).message }), "error")
    return null
  }
}

// ─── Remote model fetch ──────────────────────────────────────────────

export function parseModelList(body: unknown): Array<{ id: string; name: string }> {
  const raw = Array.isArray(body) ? body : (body as { data?: unknown } | null)?.data
  if (!Array.isArray(raw)) return []
  const out: Array<{ id: string; name: string }> = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const id = (item as { id?: unknown }).id
    if (typeof id !== "string" || !id) continue
    const name = (item as { name?: unknown }).name
    out.push({ id, name: typeof name === "string" && name ? name : id })
  }
  return out
}

async function fetchRemoteModels(
  npm: string,
  baseURL: string,
  apiKey: string,
): Promise<Array<{ id: string; name: string }>> {
  return fetchProviderModelsCached({ npm, baseURL, apiKey })
}

// ─── Busy indicator for long fetches ─────────────────────────────────

/**
 * v1 re-used the compat host's DialogPrompt busy prop (spinner + key
 * swallowing) while a remote fetch ran. v2 has no busy prop. A plugin-drawn
 * panel via `dialog.show(() => jsx(...))` is the documented path, but every
 * `import { jsx } from "@opentui/solid/jsx-runtime"` resolves to a separate
 * physical module from the host's bundled copy — the dual-instance trap
 * causes `useContext(RendererContext)` inside `createElement` to throw "No
 * renderer found" on the host's render loop, killing the TUI (opencode
 * issues #27447 and #33884). A toast bypasses the plugin JSX entirely; the
 * follow-up promise dialog (alert / select) replaces it as soon as the
 * fetch resolves.
 */
function showBusyFetch(ctx: Context, id: string): void {
  toast(ctx, `${tr("provider.fetchingTitle", { id })}\n⏳ ${tr("provider.fetchingBusy")}`, "info")
}

// ─── Level 1: provider list ──────────────────────────────────────────

async function startWizard(ctx: Context): Promise<void> {
  // Cross-window language sync: another window's switch lives only in
  // ocp.json (initI18n ran once behind its `initialized` guard) — re-read
  // the shared config before composing any menu text.
  refreshLocale()
  const config = readConfigOrToast(ctx)
  if (!config) return

  // the list mirrors the opencode.jsonc provider node — definition-file
  // presets are reachable only through the 📦 import picker
  const ids = Object.keys(config.provider ?? {}).sort(naturalCmp)

  let selection = ids[0] as string | undefined
  for (;;) {
    // Rebuilt per iteration: an in-wizard switchLanguage updates the
    // module locale directly, so headers must re-run tr() to follow it.
    const setupCat = tr("provider.setupHeader")
    const connectionsCat = tr("provider.connectionsHeader")
    const configuredCat = tr("provider.configuredHeader")
    const interfaceCat = tr("common.interfaceHeader")
    const options: DialogOption<string>[] = [
      // ── Setup group: add a new provider (custom or preset)
      {
        title: tr("provider.addProvider"),
        value: ADD_PROVIDER,
        description: tr("provider.addProviderDesc"),
        category: setupCat,
      },
      {
        title: tr("provider.addPresetProvider"),
        value: ADD_PRESET,
        description: tr("provider.addPresetProviderDesc"),
        category: setupCat,
      },
      // ── Connections group: manage which providers are wired up
      {
        title: tr("provider.manageConnections"),
        value: MANAGE_CONNECTIONS,
        description: tr("provider.manageConnectionsDesc", { count: listConnections(readConfig(CONFIG_FILE)).length }),
        category: connectionsCat,
      },
      // ── Configured group: edit an existing provider
      ...ids.map((id) => {
        const provider = config.provider?.[id]
        const baseURL = provider?.options?.baseURL
        return {
          title: id,
          value: id,
          description: `${baseURL ? String(baseURL) : tr("common.unset")} · ${tr("common.modelCount", { count: Object.keys(provider?.models ?? {}).length })}`,
          category: configuredCat,
        }
      }),
      // ── Interface group: language switcher
      { ...languageOption(), category: interfaceCat },
    ]
    const pick: string | undefined = await ctx.ui.dialog.select<string>({
      title: tr("provider.setupTitle"),
      placeholder: tr("provider.setupPlaceholder"),
      options,
      // keep the main path (pick a provider) under the cursor
      current: selection,
    })
    // level 1 is the wizard root — Esc just closes it
    if (pick === undefined) return
    selection = pick
    if (pick === SWITCH_LANG) {
      await switchLanguage(ctx)
      continue
    }
    if (pick === ADD_PROVIDER) {
      const nav = await providerForm(ctx, "", { id: "", name: "", npm: NPM_OPENAI, baseURL: "", apiKey: "", keySet: false }, true)
      if (typeof nav === "object") await detailMenu(ctx, nav.detail)
      continue
    }
    if (pick === ADD_PRESET) {
      const nav = await pickPresetProvider(ctx)
      if (typeof nav === "object") await detailMenu(ctx, nav.detail)
      continue
    }
    if (pick === MANAGE_CONNECTIONS) {
      await connectionsMenu(ctx)
      continue
    }
    await detailMenu(ctx, pick)
  }
}

// ─── Level 2: connections list ───────────────────────────────────────

/**
 * All connections on one screen — official built-ins and custom providers
 * share the credential store, so both appear here. Picking one asks for
 * confirmation, then disconnects (credential store entry + config apiKey)
 * and returns to this refreshed list.
 */
async function connectionsMenu(ctx: Context): Promise<void> {
  for (;;) {
    const config = readConfigOrToast(ctx)
    if (!config) return
    const conns = listConnections(config)
    if (conns.length === 0) {
      toast(ctx, tr("provider.connectionsEmpty"), "info")
      return
    }

    const description = (c: ConnectionInfo): string => {
      const typeLabel = c.authType === "oauth"
        ? tr("provider.connTypeOauth")
        : c.authType === "api"
          ? tr("provider.connTypeApi")
          : isEnvToken(c.configKey)
            ? tr("provider.connTypeEnv")
            : tr("provider.connTypeApi")
      const sources = [
        c.authType ? tr("provider.connSourceStore") : "",
        c.inConfig ? tr("provider.connSourceConfig") : "",
      ].filter(Boolean).join(" + ")
      const kind = c.inConfig ? tr("provider.connKindCustom") : tr("provider.connKindExternal")
      return `${typeLabel} · ${sources} · ${kind}`
    }

    const pick = await ctx.ui.dialog.select<string>({
      title: tr("provider.connectionsTitle"),
      placeholder: tr("provider.connectionsPlaceholder"),
      options: conns.map((c) => ({ title: c.id, value: c.id, description: description(c) })),
    })
    if (pick === undefined) return // Esc → level 1 loop re-presents
    await confirmDisconnect(ctx, pick)
  }
}

// ─── Level 1.5: preset providers (providers/ definition files) ────

/** Picker listing every preset; already-added ones jump to their details. */
async function pickPresetProvider(ctx: Context): Promise<Nav> {
  const config = readConfigOrToast(ctx)
  if (!config) return "back"
  // actionable first: presets not yet in the config sort above added
  // ones; natural id order within each group
  const presets = [...loadDefinitions().entries()].sort(([a], [b]) => {
    const done = (config.provider?.[a] ? 1 : 0) - (config.provider?.[b] ? 1 : 0)
    return done || naturalCmp(a, b)
  })
  if (presets.length === 0) {
    toast(ctx, tr("provider.noPresetsLeft"), "warning")
    return "back"
  }
  const pick = await ctx.ui.dialog.select<string>({
    title: tr("provider.pickPresetTitle"),
    placeholder: tr("provider.pickPresetPlaceholder"),
    options: presets.map(([id, { source, def }]) => ({
      title: id,
      value: id,
      description: `${source} · ${tr("common.modelCount", { count: Object.keys(def.models ?? {}).length })}${config.provider?.[id] ? ` · ${tr("common.addedMarker")}` : ""}`,
    })),
  })
  if (pick === undefined) return "back"
  if (config.provider?.[pick]) {
    // already imported — go straight to its details
    return { detail: pick }
  }
  // Copies a definition-file provider into the config (additive).
  const def = loadDefinitions().get(pick)?.def
  if (!def) {
    toast(ctx, tr("provider.providerVanished", { id: pick }), "error")
    return "back"
  }
  config.provider = config.provider ?? {}
  config.provider[pick] = def
  if (saveConfig(ctx, config, pick)) return { detail: pick }
  return "back"
}

// ─── Level 2: provider detail menu ───────────────────────────────────────

async function detailMenu(ctx: Context, id: string): Promise<void> {
  for (;;) {
    const config = readConfigOrToast(ctx)
    if (!config) return
    const provider = config.provider?.[id]
    if (!provider) {
      toast(ctx, tr("provider.providerVanished", { id }), "error")
      return
    }
    const options = provider.options ?? {}
    const storedAuthKey = authKey(id)
    // state the store explicitly so users never wonder where the key lives;
    // wording stays domain language — no implementation file names
    const keyDescription =
      options.apiKey !== undefined
        ? isEnvToken(options.apiKey)
          ? String(options.apiKey)
          : `••••••· ${tr("provider.keyInConfig")}`
        : storedAuthKey !== undefined
          ? `••••••· ${tr("provider.keyInCredStore")}`
          : tr("common.unset")
    const entries = Object.entries(provider.models ?? {}).sort(([a], [b]) => naturalCmp(a, b))

    const modelDesc = (m: ModelDef, key: string): string =>
      m.name ? `${m.name} — upstream id: ${m.id ?? key}` : `upstream id: ${m.id ?? key}`

    // The host select dialog renders `category` as bold accent section
    // headers that are NOT focusable options — real grouping, no fake rows.
    const settingsCat = tr("provider.settingsHeader")
    const items: DialogOption<string>[] = [
      {
        title: tr("provider.basicSettings"),
        value: EDIT_SETTINGS,
        description: `${tr("provider.npmLabel")}: ${provider.npm ?? NPM_OPENAI} · ${tr("provider.baseURLLabel")}: ${options.baseURL !== undefined ? String(options.baseURL) : tr("common.unset")} · ${tr("provider.apiKeyLabel")}: ${keyDescription}`,
        category: settingsCat,
      },
    ]

    const modelsCat = tr("provider.modelsHeader")
    for (const [key, m] of entries) {
      items.push({ title: key, value: MODEL_PREFIX + key, description: modelDesc(m, key), category: modelsCat })
    }

    const actionsCat = tr("provider.actionsHeader")
    // opencode's /connect has no logout — offer the missing counterpart here;
    // hidden when nothing credential-ish exists so the row never no-ops
    if (storedAuthKey !== undefined || options.apiKey !== undefined) {
      items.push({ title: tr("provider.disconnect"), value: DISCONNECT, description: tr("provider.disconnectDesc"), category: actionsCat })
    }
    items.push(
      { title: tr("provider.addModel"), value: ADD_MODEL, description: tr("provider.addModelDesc"), category: actionsCat },
      { title: tr("provider.fetchModels"), value: FETCH_MODELS, description: tr("provider.fetchModelsDesc"), category: actionsCat },
      { title: tr("provider.clearModels"), value: CLEAR_MODELS, description: tr("provider.clearModelsDesc"), category: actionsCat },
      { title: tr("provider.deleteProvider"), value: DELETE_PROVIDER, category: actionsCat },
    )

    const pick = await ctx.ui.dialog.select<string>({
      title: tr("provider.detailTitle", { id }),
      placeholder: tr("provider.detailPlaceholder"),
      options: items,
    })
    if (pick === undefined) return // Esc → level 1 loop re-presents

    if (pick === EDIT_SETTINGS) {
      const key = provider.options?.apiKey
      const keyIsEnv = key !== undefined && isEnvToken(key)
      const legacyLiteral = key !== undefined && !keyIsEnv
      const nav = await providerForm(ctx, id, {
        id,
        name: typeof provider.name === "string" ? provider.name : "",
        npm: provider.npm ?? NPM_OPENAI,
        baseURL: provider.options?.baseURL !== undefined ? String(provider.options.baseURL) : "",
        // never pre-fill a literal secret; env tokens are safe to show
        apiKey: keyIsEnv ? String(key) : "",
        keySet: legacyLiteral || storedAuthKey !== undefined,
        keySource: legacyLiteral ? "config" : storedAuthKey !== undefined ? "auth" : undefined,
      })
      // rename on save → follow the new id
      if (typeof nav === "object") id = nav.detail
      continue
    }
    if (pick === DELETE_PROVIDER) {
      const gone = await confirmDeleteProvider(ctx, id)
      if (gone) return
      continue
    }
    if (pick === DISCONNECT) {
      await confirmDisconnect(ctx, id)
      continue
    }
    if (pick === FETCH_MODELS) {
      await promptFetchPattern(ctx, id)
      continue
    }
    if (pick === CLEAR_MODELS) {
      await promptClearPattern(ctx, id)
      continue
    }
    if (pick === ADD_MODEL) {
      await modelForm(ctx, id, {
        key: "",
        id: "",
        name: "",
        status: "",
        attachment: false,
        temperature: false,
        reasoning: false,
        toolCall: true,
        modalitiesIn: ["text"],
        modalitiesOut: ["text"],
        contextLimit: "",
        outputLimit: "",
      })
      continue
    }
    if (pick.startsWith(MODEL_PREFIX)) {
      const key = pick.slice(MODEL_PREFIX.length)
      const m = provider.models?.[key]
      await modelForm(
        ctx,
        id,
        {
          key,
          id: String(m?.id ?? ""),
          name: String(m?.name ?? ""),
          status: typeof m?.status === "string" ? m.status : "",
          attachment: Boolean(m?.attachment),
          temperature: Boolean(m?.temperature),
          reasoning: Boolean(m?.reasoning),
          toolCall: m?.tool_call === undefined ? true : Boolean(m.tool_call),
          modalitiesIn: Array.isArray(m?.modalities?.input) ? [...m.modalities.input] : ["text"],
          modalitiesOut: Array.isArray(m?.modalities?.output) ? [...m.modalities.output] : ["text"],
          contextLimit: typeof m?.limit?.context === "number" ? String(m.limit.context) : "",
          outputLimit: typeof m?.limit?.output === "number" ? String(m.limit.output) : "",
        },
        key,
      )
    }
  }
}

// ─── Level 2 actions: settings form ─────────────────────────────────

/**
 * Shared settings form — one function serves both modes:
 *   · add (isNew): ➕ opens it directly; the id row is editable and the
 *     provider is only created on 💾
 *   · edit: the detail menu ⚙ row opens it pre-filled from config
 * Draft semantics on save: empty name/baseURL clears the field; empty
 * apiKey keeps the existing key (never wipe a secret by accident).
 * Resolves { detail: target } after a successful save, "back" otherwise.
 */
interface ProviderDraft {
  id: string
  name: string
  npm: string
  baseURL: string
  apiKey: string
  // a literal secret is already stored but never pre-filled into the form
  keySet: boolean
  // where keySet lives: opencode's auth.json, or legacy config options.apiKey
  keySource?: "auth" | "config"
}

async function providerForm(ctx: Context, id: string, draft: ProviderDraft, isNew = false): Promise<Nav> {
  const fieldsCat = tr("provider.formFieldsHeader")
  const actionsCat = tr("provider.formActionsHeader")
  const shown = (v: string) => (v ? v : tr("common.unset"))
  // sub-page titles need some id even before the user typed one
  const displayId = isNew ? draft.id || "…" : id
  let selection: string | undefined

  for (;;) {
    const items: DialogOption<string>[] = []
    items.push(
      // id is always editable: editing means renaming the config key +
      // migrating auth; a blank entry falls back to the original id (no rename)
      { title: `id: ${shown(isNew ? draft.id : draft.id || id)}${isNew && !draft.id ? " *" : ""}`, value: EDIT_ID, description: tr("provider.idPlaceholder"), category: fieldsCat },
      { title: `${tr("provider.nameLabel")}: ${shown(draft.name)}`, value: EDIT_NAME, description: tr("provider.editNameDesc"), category: fieldsCat },
      { title: `${tr("provider.npmLabel")}: ${draft.npm}`, value: EDIT_NPM, description: tr("provider.pickNpmPlaceholder"), category: fieldsCat },
      { title: `${tr("provider.baseURLLabel")}: ${shown(draft.baseURL)}${!draft.baseURL && draft.npm !== NPM_ANTHROPIC ? " *" : ""}`, value: EDIT_BASE_URL, description: tr("provider.editBaseURLDesc"), category: fieldsCat },
      { title: `${tr("provider.apiKeyLabel")}: ${draft.apiKey ? displayKey(draft.apiKey) : draft.keySet ? `••••••· ${tr(draft.keySource === "config" ? "provider.keyInConfig" : "provider.keyInCredStore")}` : tr("common.unset")}`, value: EDIT_API_KEY, description: tr("provider.editApiKeyDesc"), category: fieldsCat },
      { title: tr("provider.saveProvider"), value: SAVE_PROVIDER, category: actionsCat },
    )

    const pick = await ctx.ui.dialog.select<string>({
      title: isNew ? tr("provider.addProviderFormTitle") : tr("provider.providerFormTitleEdit", { id }),
      placeholder: tr("provider.providerFormPlaceholder"),
      options: items,
      current: selection,
    })
    // Esc returns to the parent level
    if (pick === undefined) return "back"
    selection = pick

    if (pick === EDIT_ID || pick === EDIT_NAME || pick === EDIT_BASE_URL || pick === EDIT_API_KEY) {
      const field = pick === EDIT_ID ? "id" : pick === EDIT_NAME ? "name" : pick === EDIT_BASE_URL ? "baseURL" : "apiKey"
      if (await promptProviderField(ctx, displayId, draft, field)) return "back"
      continue
    }
    if (pick === EDIT_NPM) {
      if (await pickNpmDraft(ctx, displayId, draft)) return "back"
      continue
    }
    if (pick === SAVE_PROVIDER) {
      const result = saveProviderForm(ctx, id, draft, isNew)
      if (typeof result === "object") return result
      // validation error → redraw (the helper already toasted)
      continue
    }
  }
}

// Resolves false = value applied (form redraws), true = Esc pressed
// (v1 backed out of the whole form, not just the field page).
async function promptProviderField(
  ctx: Context,
  id: string,
  draft: ProviderDraft,
  field: "id" | "name" | "baseURL" | "apiKey",
): Promise<boolean> {
  const titleKey =
    field === "id"
      ? "provider.idTitle"
      : field === "name"
        ? "provider.nameTitle"
        : field === "baseURL"
          ? "provider.baseURLTitle"
          : "provider.apiKeyTitle"
  const placeholderKey =
    field === "id"
      ? "provider.idPlaceholder"
      : field === "name"
        ? "provider.namePlaceholder"
        : field === "baseURL"
          ? "provider.baseURLPlaceholder"
          : "provider.apiKeyPlaceholder"
  const hint =
    field === "apiKey"
      ? draft.apiKey
        ? `current: ${draft.apiKey}`
        : draft.keySet
          ? `current: ${tr(draft.keySource === "config" ? "provider.keyInConfig" : "provider.keyInCredStore")}`
          : tr("common.unset")
      : draft[field]
        ? `current: ${draft[field]}`
        : tr("common.unset")

  const value = await ctx.ui.dialog.prompt({
    title: tr(titleKey, { id }),
    placeholder: tr(placeholderKey, { hint }),
    value: draft[field],
  })
  if (value === undefined) return true
  draft[field] = value.trim()
  return false
}

// Resolves true on Esc (back out of the form — v1 parity).
async function pickNpmDraft(ctx: Context, id: string, draft: ProviderDraft): Promise<boolean> {
  const known = [NPM_OPENAI, NPM_ANTHROPIC]
  // keep a custom package selectable so the user can switch back
  const values = known.includes(draft.npm) ? known : [draft.npm, ...known]
  const pick = await ctx.ui.dialog.select<string>({
    title: tr("provider.pickNpmTitle", { id }),
    placeholder: tr("provider.pickNpmPlaceholder"),
    options: values.map((npm) => ({
      title: npm,
      value: npm,
      description: npm === draft.npm ? tr("common.currentMarker") : "",
    })),
  })
  if (pick === undefined) return true
  draft.npm = pick
  return false
}

/** Validation + write. Returns Nav: { detail } on success, "back" on a
 * validation/write error (the reason already rode a toast; the form loop
 * re-presents itself). */
function saveProviderForm(ctx: Context, id: string, draft: ProviderDraft, isNew = false): Nav {
  const newId = draft.id.trim()
  // rename path: edit mode + user typed a different, non-empty id
  const renamed = !isNew && newId.length > 0 && newId !== id
  const target = isNew || renamed ? newId : id
  if (isNew && !target) {
    toast(ctx, tr("provider.idRequired"), "error")
    return "back"
  }
  if ((isNew || renamed) && !/^[a-z0-9][a-z0-9_-]*$/.test(target)) {
    toast(ctx, tr("provider.invalidProviderId"), "error")
    return "back"
  }
  // openai-compatible packages have no default endpoint — baseURL is
  // mandatory; @ai-sdk/anthropic falls back to api.anthropic.com.
  if (!draft.baseURL && draft.npm !== NPM_ANTHROPIC) {
    toast(ctx, tr("provider.baseURLRequired"), "error")
    return "back"
  }
  const config = readConfigOrToast(ctx)
  if (!config) return "back"
  if (isNew) {
    if (config.provider?.[target]) {
      toast(ctx, tr("provider.providerExists", { id: target }), "error")
      return "back"
    }
    config.provider ??= {}
    config.provider[target] = { models: {} }
  } else if (renamed) {
    if (config.provider?.[target]) {
      toast(ctx, tr("provider.providerExists", { id: target }), "error")
      return "back"
    }
    // carry the full record (npm/options/models/name) to the new key
    config.provider![target] = config.provider![id]
    delete config.provider![id]
    // move the stored credential too — left behind, it would leak the
    // old id and bind to no provider (the /connect-mirrored lookup uses
    // the provider key, so a stale entry is dead weight at best)
    const authNow = readAuth()
    if (authNow[id]) {
      authNow[target] = authNow[id]
      delete authNow[id]
      try {
        writeAuth(authNow)
      } catch (err) {
        toast(ctx, tr("provider.writeFailed", { err: (err as Error).message }), "error")
        return "back"
      }
    }
  }
  const provider = config.provider![target]
  if (draft.name) provider.name = draft.name
  else if (!isNew) delete provider.name
  provider.npm = draft.npm
  delete provider.type // legacy field from older wizard versions
  provider.options ??= {}
  if (draft.baseURL) provider.options.baseURL = draft.baseURL
  else if (!isNew) delete provider.options.baseURL
  // Secrets go to opencode's auth store — the very file /connect writes;
  // the config keeps only {env:VAR} refs. Empty input keeps the stored
  // key — never wipe a secret by accident.
  const auth = readAuth()
  let authDirty = false
  let migrated = false
  if (draft.apiKey) {
    if (isEnvToken(draft.apiKey)) {
      provider.options.apiKey = draft.apiKey
      // env ref wins at runtime; drop any stale secret for this provider
      if (auth[target]) {
        delete auth[target]
        authDirty = true
      }
    } else {
      auth[target] = { type: "api", key: draft.apiKey }
      authDirty = true
      // options.apiKey would override auth.json at runtime — drop it so
      // the credential lives in exactly one place
      delete provider.options.apiKey
    }
  } else if (!isNew && provider.options.apiKey !== undefined && !isEnvToken(provider.options.apiKey)) {
    // migrate a legacy literal from the config into the auth store
    auth[target] = { type: "api", key: String(provider.options.apiKey) }
    authDirty = true
    migrated = true
    delete provider.options.apiKey
  }
  if (authDirty) {
    try {
      writeAuth(auth)
    } catch (err) {
      toast(ctx, tr("provider.writeFailed", { err: (err as Error).message }), "error")
      return "back"
    }
  }
  if (saveConfig(ctx, config, target)) {
    // tell the user the secret changed its home, so the vanishing config
    // entry never looks like data loss
    if (migrated) toast(ctx, tr("provider.keyMigrated"), "info")
    if (renamed) toast(ctx, tr("provider.providerRenamed", { from: id, to: target }), "info")
    return { detail: target }
  }
  return "back"
}

// ─── Level 2 actions: fetch models ───────────────────────────────────

async function promptFetchPattern(ctx: Context, id: string): Promise<void> {
  const value = await ctx.ui.dialog.prompt({
    title: tr("provider.fetchPatternTitle", { id }),
    placeholder: tr("provider.fetchPatternPlaceholder"),
    value: "*",
  })
  if (value === undefined) return
  // The fetch can take up to the remote timeout, so keep an explicit
  // on-screen indicator instead of a silent wait. Every doFetch exit
  // path lands in the detail loop, which replaces this panel.
  showBusyFetch(ctx, id)
  await doFetch(ctx, id, value.trim() || "*")
}

async function doFetch(ctx: Context, id: string, pattern: string): Promise<void> {
  const config = readConfigOrToast(ctx)
  if (!config) return
  const provider = config.provider?.[id]
  if (!provider) {
    toast(ctx, tr("provider.providerVanished", { id }), "error")
    return
  }

  const rawBaseURL = provider.options?.baseURL
  const rawKey = provider.options?.apiKey
  const storedAuthKey = authKey(id)
  if (rawBaseURL === undefined) {
    toast(ctx, tr("provider.fetchNeedsBaseURL"), "warning")
    return
  }
  if (rawKey === undefined && storedAuthKey === undefined) {
    toast(ctx, tr("provider.fetchNeedsKey"), "warning")
    return
  }
  const baseURL = resolveEnv(String(rawBaseURL))
  // options.apiKey (possibly a {env:VAR} ref) wins at runtime; auth.json
  // — shared with /connect — is the fallback
  const apiKey = typeof rawKey === "string" && rawKey ? resolveEnv(rawKey) : storedAuthKey!
  const envRefs: Array<[string, string]> = [[String(rawBaseURL), baseURL]]
  if (typeof rawKey === "string" && rawKey) envRefs.push([rawKey, apiKey])
  for (const [name, value] of envRefs) {
    const match = name.match(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/)
    if (match && !value) {
      toast(ctx, tr("provider.fetchEnvMissing", { name: match[1] }), "error")
      return
    }
  }

  let remote: Array<{ id: string; name: string }>
  let catalog: CatalogModel[]
  try {
    // Remote list and catalog are independent. fetchCatalog never rejects
    // and never blocks the import: an unavailable catalog only means
    // models fall back to conservative text-only defaults.
    const [modelsResult, catalogResult] = await Promise.all([
      fetchRemoteModels(provider.npm ?? NPM_OPENAI, baseURL, apiKey),
      fetchCatalog(ctx),
    ])
    remote = modelsResult
    catalog = catalogResult
  } catch (err) {
    toast(ctx, tr("provider.fetchFailed", { err: (err as Error).message }), "error")
    return
  }

  const re = globToRegex(pattern)
  const matched = remote.filter((m) => re.test(m.id))
  if (matched.length === 0) {
    toast(ctx, tr("provider.fetchNoMatch", { pattern, total: remote.length }), "warning")
    return
  }

  provider.models ??= {}
  const models = provider.models
  // Additive import: existing keys (user-added, presets, earlier fetches)
  // are never overwritten — duplicates only get catalog fields they never
  // had (enriched); everything user-set is left untouched.
  let added = 0
  let enriched = 0
  let skipped = 0
  for (const m of matched) {
    const candidate = deriveModelKey(m.id)
    const { key, duplicate } = allocateModelKey(models, candidate, m.id)
    if (duplicate) {
      if (enrichModelDef(models[key], m.id, catalog)) enriched++
      else skipped++
      continue
    }
    models[key] = importedModelDef(m, key, catalog)
    added++
  }
  enriched += ensureBaseReasoningOptions(models, catalog)
  // legacy fetch bookkeeping — no longer written
  delete provider.presetModels

  if (added === 0 && enriched === 0) {
    toast(ctx, tr("provider.fetchNoNew", { skipped, id }), "info")
  } else {
    try {
      compactProvider(provider)
      writeConfigAtomic(CONFIG_FILE, config)
      toast(ctx, tr("provider.fetchImported", { added, enriched, skipped, id, pattern }), "success")
    } catch (err) {
      toast(ctx, tr("provider.writeFailed", { err: (err as Error).message }), "error")
    }
  }
}

// ─── Level 2 actions: add/remove models ──────────────────────────────

async function promptClearPattern(ctx: Context, id: string): Promise<void> {
  const value = await ctx.ui.dialog.prompt({
    title: tr("provider.clearModelsPatternTitle", { id }),
    placeholder: tr("provider.clearModelsPatternPlaceholder"),
    value: "*",
  })
  if (value === undefined) return
  await doClearModels(ctx, id, value.trim() || "*")
}

async function doClearModels(ctx: Context, id: string, pattern: string): Promise<void> {
  const config = readConfigOrToast(ctx)
  if (!config) return
  const models = config.provider?.[id]?.models ?? {}
  const allKeys = Object.keys(models)
  if (allKeys.length === 0) {
    toast(ctx, tr("provider.noModelsToClear", { id }), "info")
    return
  }

  const re = globToRegex(pattern)
  const matched = allKeys.filter((key) => re.test(key))
  if (matched.length === 0) {
    toast(ctx, tr("provider.clearModelsNoMatch", { id, pattern }), "warning")
    return
  }

  const confirmed = await ctx.ui.dialog.confirm({
    title: tr("provider.clearModelsTitle", { id }),
    message: tr("provider.clearModelsConfirm", { id, count: matched.length, pattern }),
  })
  if (confirmed !== true) return
  for (const key of matched) {
    delete config.provider![id].models![key]
  }
  if (saveConfig(ctx, config, id)) {
    toast(ctx, tr("provider.modelsCleared", { id, count: matched.length, pattern }), "success")
  }
}

/** Returns true when the provider was deleted (parent level should back out). */
async function confirmDeleteProvider(ctx: Context, id: string): Promise<boolean> {
  const config = readConfigOrToast(ctx)
  if (!config) return false
  const confirmed = await ctx.ui.dialog.confirm({
    title: tr("provider.deleteProviderTitle", { id }),
    message: tr("provider.deleteProviderConfirm", { id }),
  })
  if (confirmed !== true) return false
  delete config.provider![id]
  // also drop the /connect-shared credential, best-effort — the
  // config is gone anyway, a leftover secret is harmless
  const auth = readAuth()
  if (auth[id]) {
    delete auth[id]
    try {
      writeAuth(auth)
    } catch {
      // ignore credential cleanup failure
    }
  }
  // saveConfig's "saved" toast would mislead here — write directly
  try {
    writeConfigAtomic(CONFIG_FILE, config)
    toast(ctx, tr("provider.providerDeleted", { id }), "success")
  } catch (err) {
    toast(ctx, tr("provider.writeFailed", { err: (err as Error).message }), "error")
  }
  return true
}

/**
 * Disconnect — the counterpart /connect lacks: remove the provider's
 * credential without touching its definition. Drops the /connect-shared
 * auth store entry, clears the apiKey field (literal or env ref) in
 * opencode.jsonc, and keeps models so reconnecting is one form away.
 */
async function confirmDisconnect(ctx: Context, id: string): Promise<void> {
  const confirmed = await ctx.ui.dialog.confirm({
    title: tr("provider.disconnectTitle", { id }),
    message: tr("provider.disconnectConfirm", { id }),
  })
  if (confirmed !== true) return
  // single source of truth — the /disconnect command runs the same path
  const result = disconnectProvider(id)
  if (result.ok) {
    toast(ctx, tr("provider.disconnected", { id }), "success")
  } else {
    toast(ctx, tr("provider.writeFailed", { err: result.error ?? "unknown" }), "error")
  }
}

/**
 * /disconnect --all — one confirmation for every connection, then each
 * id goes through the same disconnectProvider path as a single
 * disconnect. Provider definitions and models stay; the refreshed
 * connections list shows what is left (usually nothing).
 */
async function confirmDisconnectAll(ctx: Context): Promise<void> {
  const conns = readConnections()
  if (conns.length === 0) {
    toast(ctx, tr("provider.connectionsEmpty"), "info")
    return
  }
  const confirmed = await ctx.ui.dialog.confirm({
    title: tr("provider.disconnectAllTitle"),
    message: tr("provider.disconnectAllConfirm", { count: conns.length }),
  })
  if (confirmed !== true) return
  let ok = 0
  for (const c of conns) {
    if (disconnectProvider(c.id).ok) ok++
  }
  toast(ctx, tr("provider.disconnectAllDone", { ok, count: conns.length }), ok === conns.length ? "success" : "warning")
}

// ─── Level 2 actions: model form (add / edit) ──────────────────────
//
// Select-as-form: one dialog "sheet" grouped into identity /
// capabilities / limits; picking a text field opens a prompt and
// returns to the sheet, capability rows toggle on click. No native
// multi-field form exists in the host.

interface ModelDraft {
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

const MODALITIES = ["text", "audio", "image", "video", "pdf"]

async function modelForm(ctx: Context, id: string, draft: ModelDraft, origKey?: string): Promise<void> {
  const editing = origKey !== undefined
  let selection: string | undefined
  for (;;) {
    const fieldsCat = tr("provider.formFieldsHeader")
    const capsCat = tr("provider.formCapsHeader")
    const limitsCat = tr("provider.formLimitsHeader")
    const actionsCat = tr("provider.formActionsHeader")
    const shown = (v: string) => (v ? v : tr("common.unset"))
    const onOff = (v: boolean) => (v ? "on" : "off")

    const items: DialogOption<string>[] = [
      { title: `key: ${shown(draft.key)}${!draft.key ? " *" : ""}`, value: FIELD_KEY, description: tr("provider.modelKeyPlaceholder"), category: fieldsCat },
      { title: `id: ${shown(draft.id)}`, value: FIELD_ID, description: tr("provider.modelIdPlaceholder"), category: fieldsCat },
      { title: `name: ${shown(draft.name)}`, value: FIELD_NAME, description: tr("provider.modelNamePlaceholder"), category: fieldsCat },
      { title: `status: ${draft.status || "active"}`, value: FIELD_STATUS, description: tr("provider.fieldStatusDesc"), category: fieldsCat },
      { title: `attachment: ${onOff(draft.attachment)}`, value: FIELD_ATTACHMENT, description: tr("provider.capAttachmentDesc"), category: capsCat },
      { title: `temperature: ${onOff(draft.temperature)}`, value: FIELD_TEMPERATURE, description: tr("provider.capTemperatureDesc"), category: capsCat },
      { title: `reasoning: ${onOff(draft.reasoning)}`, value: FIELD_REASONING, description: tr("provider.capReasoningDesc"), category: capsCat },
      { title: `tool_call: ${onOff(draft.toolCall)}`, value: FIELD_TOOLCALL, description: tr("provider.capToolCallDesc"), category: capsCat },
      { title: `modalities.input: ${draft.modalitiesIn.join(", ") || tr("common.unset")}`, value: FIELD_MODAL_IN, category: capsCat },
      { title: `modalities.output: ${draft.modalitiesOut.join(", ") || tr("common.unset")}`, value: FIELD_MODAL_OUT, category: capsCat },
      { title: `limit.context: ${shown(draft.contextLimit)}`, value: FIELD_CONTEXT, description: tr("provider.limitContextPlaceholder"), category: limitsCat },
      { title: `limit.output: ${shown(draft.outputLimit)}`, value: FIELD_OUTPUT, description: tr("provider.limitOutputPlaceholder"), category: limitsCat },
      { title: tr("provider.saveModel"), value: SAVE_MODEL, category: actionsCat },
    ]
    if (editing) items.push({ title: tr("provider.deleteModel"), value: DELETE_MODEL, category: actionsCat })

    const pick = await ctx.ui.dialog.select<string>({
      title: editing
        ? tr("provider.modelFormTitleEdit", { id, key: origKey! })
        : tr("provider.modelFormTitleAdd", { id }),
      placeholder: tr("provider.modelFormPlaceholder"),
      options: items,
      current: selection,
    })
    if (pick === undefined) return // Esc → detail loop
    selection = pick

    if (pick === FIELD_KEY || pick === FIELD_ID || pick === FIELD_NAME || pick === FIELD_CONTEXT || pick === FIELD_OUTPUT) {
      const field = pick === FIELD_KEY ? "key" : pick === FIELD_ID ? "id" : pick === FIELD_NAME ? "name" : pick === FIELD_CONTEXT ? "contextLimit" : "outputLimit"
      const placeholder = pick === FIELD_KEY ? tr("provider.modelKeyPlaceholder") : pick === FIELD_ID ? tr("provider.modelIdPlaceholder") : pick === FIELD_NAME ? tr("provider.modelNamePlaceholder") : tr("provider.limitContextPlaceholder")
      const value = await ctx.ui.dialog.prompt({
        title: tr("provider.modelFieldTitle", { id, field }),
        placeholder,
        value: draft[field as "key" | "id" | "name" | "contextLimit" | "outputLimit"],
      })
      if (value === undefined) return // v1: Esc on a field page backs out to the detail menu
      draft[field as "key" | "id" | "name" | "contextLimit" | "outputLimit"] = value.trim()
      continue
    }
    if (pick === FIELD_STATUS) {
      // deprecated hides the model from suggestions — soft disable
      const order = ["", "deprecated", "alpha"]
      draft.status = order[(order.indexOf(draft.status) + 1) % order.length]
      continue
    }
    if (pick === FIELD_ATTACHMENT) { draft.attachment = !draft.attachment; continue }
    if (pick === FIELD_TEMPERATURE) { draft.temperature = !draft.temperature; continue }
    if (pick === FIELD_REASONING) { draft.reasoning = !draft.reasoning; continue }
    if (pick === FIELD_TOOLCALL) { draft.toolCall = !draft.toolCall; continue }
    if (pick === FIELD_MODAL_IN) { if (await modalitiesEdit(ctx, id, draft, "modalitiesIn")) return; continue }
    if (pick === FIELD_MODAL_OUT) { if (await modalitiesEdit(ctx, id, draft, "modalitiesOut")) return; continue }
    if (pick === SAVE_MODEL) {
      const saved = saveModelForm(ctx, id, draft, origKey)
      if (saved) return
      continue
    }
    if (pick === DELETE_MODEL && origKey !== undefined) {
      const config = readConfigOrToast(ctx)
      if (!config) return
      const confirmed = await ctx.ui.dialog.confirm({
        title: tr("provider.removeModelTitle", { id }),
        message: tr("provider.removeModelConfirm", { id, key: origKey }),
      })
      if (confirmed !== true) continue
      delete config.provider![id].models![origKey]
      if (saveConfig(ctx, config, id)) {
        toast(ctx, tr("provider.modelRemoved", { id, key: origKey }), "success")
      }
      return
    }
  }
}

// Modality multi-toggle sheet: rows toggle in place; Esc backs out of the
// whole model form to the detail menu (v1 onBack semantics — every Esc
// level inside the sheet routed to the parent, not the sheet's caller).
async function modalitiesEdit(
  ctx: Context,
  id: string,
  draft: ModelDraft,
  field: "modalitiesIn" | "modalitiesOut",
): Promise<boolean> {
  const dir = field === "modalitiesIn" ? "input" : "output"
  let focus: string | undefined
  for (;;) {
    const pick = await ctx.ui.dialog.select<string>({
      title: tr("provider.modelFieldTitle", { id, field: `modalities.${dir}` }),
      placeholder: tr("provider.modalitiesPlaceholder"),
      options: MODALITIES.map((m) => ({
        title: `${m}: ${draft[field].includes(m) ? "on" : "off"}`,
        value: m,
      })),
      current: focus,
    })
    if (pick === undefined) return true // Esc → back out of the model form (v1 parity)
    const list = draft[field]
    draft[field] = list.includes(pick)
      ? list.filter((m) => m !== pick)
      : [...MODALITIES.filter((m) => m === pick || list.includes(m))]
    // keep the cursor on the toggled row
    focus = pick
  }
}

/** Returns true when the model was saved (the caller's loop closes). */
function saveModelForm(ctx: Context, id: string, draft: ModelDraft, origKey?: string): boolean {
  const key = draft.key
  // opencode parses refs on the FIRST slash, so the key may contain '/'
  // for nested ids (e.g. 'vendor/gpt-5.6') — only spaces, edge slashes
  // and '//' are rejected.
  if (!key || /\s/.test(key) || key.startsWith("/") || key.endsWith("/") || key.includes("//")) {
    toast(ctx, tr("provider.invalidKey"), "error")
    return false
  }
  const ctxLimit = draft.contextLimit ? Number(draft.contextLimit) : 0
  const out = draft.outputLimit ? Number(draft.outputLimit) : 0
  if (
    (draft.contextLimit && (!Number.isInteger(ctxLimit) || ctxLimit < 0)) ||
    (draft.outputLimit && (!Number.isInteger(out) || out < 0))
  ) {
    toast(ctx, tr("provider.invalidNumber"), "error")
    return false
  }
  const config = readConfigOrToast(ctx)
  if (!config) return true
  const models = config.provider?.[id]?.models
  if (!models) {
    toast(ctx, tr("provider.addModelFailed", { err: `provider '${id}' has no models section` }), "error")
    return true
  }
  if (models[key] && key !== origKey) {
    toast(ctx, tr("provider.modelExists", { id, key }), "error")
    return false
  }
  // Spread the existing entry so fields the form does not manage
  // (options, headers, variants, …) survive edits and renames.
  const existing: ModelDef = origKey !== undefined ? (models[origKey] ?? {}) : {}
  const entry: ModelDef = { ...existing, name: draft.name || key, id: draft.id || key }
  if (draft.status && draft.status !== "active") entry.status = draft.status
  else delete entry.status
  // Record capability fields only when they differ from the host
  // defaults (attachment/temperature/reasoning=false, tool_call=true)
  // to keep opencode.jsonc minimal.
  if (draft.attachment) entry.attachment = true
  else delete entry.attachment
  if (draft.temperature) entry.temperature = true
  else delete entry.temperature
  if (draft.reasoning) entry.reasoning = true
  else delete entry.reasoning
  if (!draft.toolCall) entry.tool_call = false
  else delete entry.tool_call
  const modsIn = draft.modalitiesIn.length ? draft.modalitiesIn : ["text"]
  const modsOut = draft.modalitiesOut.length ? draft.modalitiesOut : ["text"]
  const textOnly = (list: string[]) => list.length === 1 && list[0] === "text"
  if (!(textOnly(modsIn) && textOnly(modsOut))) entry.modalities = { input: modsIn, output: modsOut }
  else delete entry.modalities
  const limit: { context?: number; output?: number } = {}
  if (ctxLimit) limit.context = ctxLimit
  if (out) limit.output = out
  if (limit.context || limit.output) entry.limit = limit
  else delete entry.limit
  if (origKey !== undefined && origKey !== key) delete models[origKey]
  models[key] = entry
  if (saveConfig(ctx, config, id)) {
    toast(ctx, tr("provider.modelAdded", { id, key }), "success")
  }
  return true
}

// ─── Plugin entry ────────────────────────────────────────────────────

const plugin: Plugin.Definition = {
  id: PLUGIN_ID,
  setup(ctx: Context) {
    initI18n()
    appKeymapLayer(ctx, () => ({
      mode: "global",
      commands: [
        {
          id: "provider.wizard",
          title: tr("provider.cmdTitle"),
          description: tr("provider.cmdDesc"),
          group: "Provider",
          palette: true,
          slash: { name: "provider" },
          run() {
            void startWizard(ctx)
          },
        },
        // TUI-only /disconnect — the official /connect's counterpart, same
        // keymap-only shape: ONE slash-menu row that dispatches instantly
        // client-side (no Enter → server roundtrip). No config command is
        // registered, so nothing duplicates.
        {
          id: "provider.disconnect",
          title: tr("provider.cmdDisconnectTitle"),
          description: tr("provider.cmdDisconnectDesc"),
          group: "Provider",
          palette: true,
          slash: { name: "disconnect" },
          async run(input?: string) {
            const sub = parseSlashArgs(input, ["provider.disconnect", "disconnect", "/disconnect"])
            if (!sub) {
              await connectionsMenu(ctx)
              return
            }
            if (sub === "--all" || sub === "all") {
              await confirmDisconnectAll(ctx)
              return
            }
            if (!readConnections().some((c) => c.id === sub)) {
              toast(ctx, tr("provider.connNotFound", { id: sub }), "warning")
              await connectionsMenu(ctx)
              return
            }
            // jump straight to the confirm for that id, then the list loop refreshes
            await confirmDisconnect(ctx, sub)
            await connectionsMenu(ctx)
          },
        },
      ],
    }))
  },
}

export default plugin
