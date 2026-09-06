/**
 * model-catalog — third-party/public model metadata + provider live-model SWR cache.
 *
 * Public catalog data (models.dev) is useful for conservative capability and
 * price hints.  Provider live `/models` data is authoritative for private
 * routers.  Both are cached with stale-while-revalidate semantics so `/provider`
 * stays fast and works offline with the last known-good snapshot.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { createHash } from "node:crypto"

export const MODELS_DEV_MODELS_URL = "https://models.dev/models.json"
export const MODELS_OPENCODE_API_URL = "https://models.opencode.ai/api.json"
export const MODEL_CATALOG_FRESH_MS = 24 * 60 * 60 * 1000
export const MODEL_CATALOG_STALE_MS = 7 * 24 * 60 * 60 * 1000

export type ModelPrice = { input: number; cached: number; output: number; cacheWrite?: number }
export type RemoteModel = { id: string; name: string }

export type PublicModelMeta = {
  id: string
  name?: string
  family?: string
  capabilities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; input?: number; output?: number }
  reasoning?: boolean
  reasoningOptions?: Array<Record<string, unknown>>
  temperature?: boolean
  toolCall?: boolean
  structuredOutput?: boolean
  cost?: ModelPrice
  provider?: { npm?: string; api?: string }
  variants?: Record<string, Record<string, unknown>>
  sources?: string[]
}

export type PublicModelCatalog = {
  ts: number
  models: Record<string, PublicModelMeta>
  prices: Record<string, ModelPrice>
  lastError?: { ts: number; message: string }
}

type LiveProviderEntry = {
  ts: number
  npm: string
  baseURL: string
  authHash: string
  models: RemoteModel[]
  lastError?: { ts: number; message: string }
}

type CatalogDiskCache = {
  version: 1
  public?: PublicModelCatalog
  live?: Record<string, LiveProviderEntry>
}

type FetchLike = typeof fetch

let diskCache: CatalogDiskCache | undefined
let publicRefreshInFlight: Promise<PublicModelCatalog> | undefined
const liveRefreshInFlight = new Map<string, Promise<RemoteModel[]>>()

function defaultCachePath(): string {
  if (process.env.OCP_MODEL_CATALOG_PATH) return process.env.OCP_MODEL_CATALOG_PATH
  // Backward-compatible read path for the former /usage-only cache.  New
  // writes always use the unified catalog file below.
  if (process.env.OCP_MODELSDEV_PATH) return process.env.OCP_MODELSDEV_PATH
  const base = process.env.XDG_CONFIG_HOME || (process.platform === "win32" ? `${process.env.USERPROFILE || homedir()}\\.config` : `${homedir()}/.config`)
  return join(base, "opencode", "model-catalog-cache.json")
}

export function modelCatalogCachePath(): string {
  return defaultCachePath()
}

function nowMs(now?: () => number): number {
  return now ? now() : Date.now()
}

function emptyCache(): CatalogDiskCache {
  return { version: 1, live: {} }
}

function loadDiskCache(): CatalogDiskCache {
  if (diskCache) return diskCache
  try {
    const path = modelCatalogCachePath()
    if (!existsSync(path)) return (diskCache = emptyCache())
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as CatalogDiskCache & {
      prices?: Record<string, ModelPrice>
      pageIds?: Record<string, string>
      ts?: number
    }
    if (!parsed || (parsed.version !== 1 && !(typeof parsed.ts === "number" && parsed.prices))) return (diskCache = emptyCache())
    parsed.live ??= {}
    // Migrate the old usage cache shape in memory. This keeps existing users'
    // simulated pricing working while the next refresh upgrades the file.
    if (!parsed.public && parsed.prices && typeof parsed.ts === "number") {
      const models: Record<string, PublicModelMeta> = {}
      for (const id of Object.values(parsed.pageIds ?? {})) models[id] = { id }
      parsed.public = { ts: parsed.ts, models, prices: parsed.prices }
    }
    return (diskCache = parsed)
  } catch {
    return (diskCache = emptyCache())
  }
}

function saveDiskCache(cache: CatalogDiskCache): void {
  try {
    const path = modelCatalogCachePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path + ".tmp", JSON.stringify(cache), "utf-8")
    renameSync(path + ".tmp", path)
  } catch {
    // Cache writes are best-effort; callers still receive fresh in-memory data.
  }
}

export function resetModelCatalogCacheForTests(): void {
  diskCache = undefined
  publicRefreshInFlight = undefined
  liveRefreshInFlight.clear()
}

const strArray = (value: unknown): string[] | undefined => Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : undefined

function normalizeModalities(value: unknown): string[] | undefined {
  const arr = strArray(value)
  if (arr) return arr.filter((m) => ["text", "audio", "image", "video", "pdf"].includes(m))
  if (value && typeof value === "object") {
    const on = ["text", "audio", "image", "video", "pdf"].filter((m) => (value as Record<string, unknown>)[m] === true)
    return on.length ? on : undefined
  }
  return undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function parseModelsDevModels(body: unknown): Record<string, PublicModelMeta> {
  const out: Record<string, PublicModelMeta> = {}
  if (!body || typeof body !== "object" || Array.isArray(body)) return out
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const model = value as Record<string, unknown>
    const id = typeof model.id === "string" && model.id ? model.id : key
    const modalities = model.modalities ?? model.capabilities
    const caps = modalities && typeof modalities === "object"
      ? {
          input: normalizeModalities((modalities as { input?: unknown }).input),
          output: normalizeModalities((modalities as { output?: unknown }).output),
        }
      : undefined
    const limitRaw = model.limit && typeof model.limit === "object" ? model.limit as Record<string, unknown> : undefined
    const limit = limitRaw
      ? { context: finiteNumber(limitRaw.context), input: finiteNumber(limitRaw.input), output: finiteNumber(limitRaw.output) }
      : undefined
    const meta: PublicModelMeta = { id }
    if (typeof model.name === "string") meta.name = model.name
    if (typeof model.family === "string") meta.family = model.family
    if (caps?.input || caps?.output) meta.capabilities = caps
    if (limit && (limit.context !== undefined || limit.input !== undefined || limit.output !== undefined)) meta.limit = limit
    if (typeof model.reasoning === "boolean") meta.reasoning = model.reasoning
    if (Array.isArray(model.reasoning_options)) meta.reasoningOptions = model.reasoning_options.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object" && !Array.isArray(x))
    if (model.temperature === true) meta.temperature = true
    if (model.tool_call === false) meta.toolCall = false
    if (model.structured_output === true) meta.structuredOutput = true
    out[id] = meta
  }
  return out
}

function normalizePublicModel(id: string, model: Record<string, unknown>, source: string): PublicModelMeta {
  const meta: PublicModelMeta = { id, sources: [source] }
  for (const field of ["name", "family"] as const) if (typeof model[field] === "string") meta[field] = model[field] as string
  if (model.reasoning === true || model.reasoning === false) meta.reasoning = model.reasoning as boolean
  if (model.temperature === true || model.temperature === false) meta.temperature = model.temperature as boolean
  if (model.tool_call === true || model.tool_call === false) meta.toolCall = model.tool_call as boolean
  if (model.structured_output === true || model.structured_output === false) meta.structuredOutput = model.structured_output as boolean
  if (model.cost && typeof model.cost === "object") {
    const c = model.cost as Record<string, unknown>
    const input = finiteNumber(c.input)
    const output = finiteNumber(c.output)
    if (input !== undefined && output !== undefined) {
      meta.cost = { input, output, cached: finiteNumber(c.cache_read) ?? 0, cacheWrite: finiteNumber(c.cache_write) }
    }
  }
  if (Array.isArray(model.reasoning_options)) meta.reasoningOptions = model.reasoning_options.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object" && !Array.isArray(x))
  if (model.provider && typeof model.provider === "object") {
    const p = model.provider as Record<string, unknown>
    meta.provider = {
      npm: typeof p.npm === "string" ? p.npm : undefined,
      api: typeof p.api === "string" ? p.api : undefined,
    }
  }
  if (model.variants && typeof model.variants === "object" && !Array.isArray(model.variants)) meta.variants = model.variants as Record<string, Record<string, unknown>>
  const modalities = model.modalities ?? model.capabilities
  if (modalities && typeof modalities === "object") {
    const capabilities = {
      input: normalizeModalities((modalities as { input?: unknown }).input),
      output: normalizeModalities((modalities as { output?: unknown }).output),
    }
    if (capabilities.input || capabilities.output) meta.capabilities = capabilities
  }
  if (model.limit && typeof model.limit === "object") {
    const l = model.limit as Record<string, unknown>
    const limit = { context: finiteNumber(l.context), input: finiteNumber(l.input), output: finiteNumber(l.output) }
    if (limit.context !== undefined || limit.input !== undefined || limit.output !== undefined) meta.limit = limit
  }
  return meta
}

/** Parse models.opencode.ai's provider-keyed catalog into the standard shape. */
export function parseOpenCodeApi(body: unknown): Record<string, PublicModelMeta> {
  const out: Record<string, PublicModelMeta> = {}
  if (!body || typeof body !== "object" || Array.isArray(body)) return out
  for (const [providerKey, providerValue] of Object.entries(body as Record<string, unknown>)) {
    if (!providerValue || typeof providerValue !== "object") continue
    const provider = providerValue as Record<string, unknown>
    const models = provider.models
    if (!models || typeof models !== "object" || Array.isArray(models)) continue
    for (const [modelKey, modelValue] of Object.entries(models as Record<string, unknown>)) {
      if (!modelValue || typeof modelValue !== "object" || Array.isArray(modelValue)) continue
      const model = modelValue as Record<string, unknown>
      const modelID = typeof model.id === "string" && model.id ? model.id : modelKey
      // Some catalog payloads key a provider as `openai` but return model.id
      // as `openai/gpt-x`; do not duplicate the provider prefix.
      const ref = modelID.includes("/") ? modelID : `${providerKey}/${modelID}`
      const meta = normalizePublicModel(ref, model, "models.opencode.ai")
      meta.provider = {
        npm: meta.provider?.npm ?? (typeof provider.npm === "string" ? provider.npm : undefined),
        api: meta.provider?.api ?? (typeof provider.api === "string" ? provider.api : undefined),
      }
      out[ref] = meta
    }
  }
  return out
}

function bareID(ref: string): string {
  const slash = ref.lastIndexOf("/")
  return slash >= 0 ? ref.slice(slash + 1) : ref
}

function mergeMeta(base: PublicModelMeta, addition: PublicModelMeta): PublicModelMeta {
  const next: PublicModelMeta = { ...base }
  for (const key of ["name", "family", "reasoning", "reasoningOptions", "temperature", "toolCall", "structuredOutput", "provider", "variants", "cost"] as const) {
    const value = addition[key]
    if (value !== undefined && (next[key] === undefined || (Array.isArray(value) && value.length > 0))) (next as Record<string, unknown>)[key] = value
  }
  if (addition.capabilities) next.capabilities = {
    input: next.capabilities?.input ?? addition.capabilities.input,
    output: next.capabilities?.output ?? addition.capabilities.output,
  }
  if (addition.limit) next.limit = {
    context: next.limit?.context ?? addition.limit.context,
    input: next.limit?.input ?? addition.limit.input,
    output: next.limit?.output ?? addition.limit.output,
  }
  next.sources = [...new Set([...(next.sources ?? []), ...(addition.sources ?? [])])]
  return next
}

/** Field-level merge: complementary sources enrich one standard record. */
export function mergePublicSources(
  modelsDev: Record<string, PublicModelMeta>,
  modelsOpenCode: Record<string, PublicModelMeta>,
  prices: Record<string, ModelPrice>,
): Record<string, PublicModelMeta> {
  const merged: Record<string, PublicModelMeta> = { ...modelsDev }
  for (const [ref, meta] of Object.entries(modelsOpenCode)) {
    const exact = merged[ref]
    if (exact) {
      merged[ref] = mergeMeta(exact, meta)
      continue
    }
    const candidates = Object.keys(merged).filter((id) => bareID(id) === bareID(ref))
    if (candidates.length === 1) merged[candidates[0]!] = mergeMeta(merged[candidates[0]!]!, meta)
    else merged[ref] = meta
  }
  for (const [ref, cost] of Object.entries(prices)) {
    const slash = ref.indexOf("/")
    const id = slash >= 0 ? ref.slice(slash + 1) : ref
    const existing = merged[ref] ?? merged[id] ?? Object.values(merged).find((model) => bareID(model.id) === id)
    if (existing && !existing.cost) existing.cost = cost
  }
  return merged
}

export function mergePublicCatalog(models: Record<string, PublicModelMeta>, prices: Record<string, ModelPrice>, ts = Date.now(), openCodeModels: Record<string, PublicModelMeta> = {}): PublicModelCatalog {
  return { ts, models: mergePublicSources(models, openCodeModels, prices), prices }
}

async function refreshPublicCatalog(fetcher: FetchLike, now?: () => number): Promise<PublicModelCatalog> {
  const cache = loadDiskCache()
  try {
    const safeFetch = async (url: string): Promise<Response | undefined> => {
      try {
        return await fetcher(url, { signal: AbortSignal.timeout(15_000) })
      } catch (error) {
        console.warn(`[model-catalog] ${url} unavailable: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    }
    const [modelsRes, openCodeRes] = await Promise.all([
      safeFetch(MODELS_DEV_MODELS_URL),
      safeFetch(MODELS_OPENCODE_API_URL),
    ])
    let models: Record<string, PublicModelMeta> = {}
    let openCodeModels: Record<string, PublicModelMeta> = {}
    if (modelsRes?.ok) {
      try { models = parseModelsDevModels(await modelsRes.json()) }
      catch (error) { console.warn(`[model-catalog] models.dev payload invalid: ${error instanceof Error ? error.message : String(error)}`) }
    }
    if (openCodeRes?.ok) {
      try { openCodeModels = parseOpenCodeApi(await openCodeRes.json()) }
      catch (error) { console.warn(`[model-catalog] models.opencode.ai payload invalid: ${error instanceof Error ? error.message : String(error)}`) }
    }
    if (modelsRes && !modelsRes.ok) console.warn(`[model-catalog] models.dev/models.json HTTP ${modelsRes.status}; continuing with other sources`)
    if (openCodeRes && !openCodeRes.ok) console.warn(`[model-catalog] models.opencode.ai/api.json HTTP ${openCodeRes.status}; continuing with models.dev`)
    if (Object.keys(models).length === 0 && Object.keys(openCodeModels).length === 0) throw new Error("all public model sources returned no usable models")
    const prices = Object.fromEntries(Object.entries(openCodeModels).flatMap(([id, model]) => model.cost ? [[id, model.cost] as const] : []))
    const next = mergePublicCatalog(models, prices, nowMs(now), openCodeModels)
    cache.public = next
    saveDiskCache(cache)
    return next
  } catch (err) {
    const lastError = { ts: nowMs(now), message: err instanceof Error ? err.message : String(err) }
    if (cache.public) {
      cache.public = { ...cache.public, lastError }
      saveDiskCache(cache)
      return cache.public
    }
    return { ts: 0, models: {}, prices: {}, lastError }
  }
}

export async function getPublicModelCatalog(options: { refresh?: boolean; waitForRefresh?: boolean; fetcher?: FetchLike; now?: () => number } = {}): Promise<PublicModelCatalog> {
  const fetcher = options.fetcher ?? fetch
  const cache = loadDiskCache()
  const current = cache.public
  const age = current ? nowMs(options.now) - current.ts : Number.POSITIVE_INFINITY
  if (!options.refresh && current && age < MODEL_CATALOG_FRESH_MS) return current
  if (!options.refresh && current && age < MODEL_CATALOG_STALE_MS && !options.waitForRefresh) {
    publicRefreshInFlight ??= refreshPublicCatalog(fetcher, options.now).finally(() => { publicRefreshInFlight = undefined })
    return current
  }
  publicRefreshInFlight ??= refreshPublicCatalog(fetcher, options.now).finally(() => { publicRefreshInFlight = undefined })
  return await publicRefreshInFlight
}

export async function fetchModelsDevModelCatalog(options: { fetcher?: FetchLike; now?: () => number } = {}): Promise<PublicModelMeta[]> {
  const catalog = await getPublicModelCatalog({ fetcher: options.fetcher, now: options.now })
  return Object.values(catalog.models)
}

/** Find a public price by exact provider/model first, then by unique bare model ID. */
export function publicModelPrice(catalog: PublicModelCatalog, providerID: string, modelID: string): ModelPrice | null {
  const exact = catalog.prices[`${providerID}/${modelID}`]
  if (exact) return exact
  let best: ModelPrice | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (const [key, price] of Object.entries(catalog.prices)) {
    const slash = key.indexOf("/")
    if (slash < 0 || key.slice(slash + 1) !== modelID) continue
    const score = price.input + price.output * 4
    if (score < bestScore) {
      best = price
      bestScore = score
    }
  }
  return best
}

/** Return the canonical public catalog ID for a model, when one is known. */
export function publicModelPageID(catalog: PublicModelCatalog, modelID: string): string | null {
  if (catalog.models[modelID]) return modelID
  const matches = Object.keys(catalog.models).filter((id) => id.slice(id.indexOf("/") + 1) === modelID)
  return matches.length === 1 ? matches[0]! : null
}

export function parseProviderModelList(body: unknown): RemoteModel[] {
  const raw = Array.isArray(body) ? body : (body as { data?: unknown } | null)?.data
  if (!Array.isArray(raw)) return []
  const out: RemoteModel[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const id = (item as { id?: unknown }).id
    if (typeof id !== "string" || !id) continue
    const name = (item as { name?: unknown }).name
    out.push({ id, name: typeof name === "string" && name ? name : id })
  }
  return out
}

function liveCacheKey(npm: string, baseURL: string, apiKey: string): string {
  const authHash = createHash("sha256").update(apiKey).digest("hex").slice(0, 16)
  return `${npm}\n${baseURL.replace(/\/+$/, "")}\n${authHash}`
}

async function refreshProviderModels(input: { npm: string; baseURL: string; apiKey: string; fetcher: FetchLike; now?: () => number }): Promise<RemoteModel[]> {
  const cache = loadDiskCache()
  cache.live ??= {}
  const key = liveCacheKey(input.npm, input.baseURL, input.apiKey)
  const base = input.baseURL.replace(/\/+$/, "")
  const headers: Record<string, string> = {}
  const isAnthropic = input.npm === "@ai-sdk/anthropic"
  const url = isAnthropic ? `${base}/v1/models` : `${base}/models`
  if (isAnthropic) {
    headers["x-api-key"] = input.apiKey
    headers["anthropic-version"] = "2023-06-01"
  } else {
    headers.Authorization = `Bearer ${input.apiKey}`
  }
  try {
    const res = await input.fetcher(url, { headers, signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`)
    const models = parseProviderModelList(await res.json())
    cache.live[key] = { ts: nowMs(input.now), npm: input.npm, baseURL: base, authHash: key.split("\n")[2]!, models }
    saveDiskCache(cache)
    return models
  } catch (err) {
    const existing = cache.live[key]
    if (existing) {
      existing.lastError = { ts: nowMs(input.now), message: err instanceof Error ? err.message : String(err) }
      saveDiskCache(cache)
      return existing.models
    }
    throw err
  }
}

export async function fetchProviderModelsCached(input: { npm: string; baseURL: string; apiKey: string; refresh?: boolean; waitForRefresh?: boolean; fetcher?: FetchLike; now?: () => number }): Promise<RemoteModel[]> {
  const fetcher = input.fetcher ?? fetch
  const cache = loadDiskCache()
  const key = liveCacheKey(input.npm, input.baseURL, input.apiKey)
  const current = cache.live?.[key]
  const age = current ? nowMs(input.now) - current.ts : Number.POSITIVE_INFINITY
  if (!input.refresh && current && age < MODEL_CATALOG_FRESH_MS) return current.models
  if (!input.refresh && current && age < MODEL_CATALOG_STALE_MS && !input.waitForRefresh) {
    if (!liveRefreshInFlight.has(key)) liveRefreshInFlight.set(key, refreshProviderModels({ ...input, fetcher }).finally(() => { liveRefreshInFlight.delete(key) }))
    return current.models
  }
  if (!liveRefreshInFlight.has(key)) liveRefreshInFlight.set(key, refreshProviderModels({ ...input, fetcher }).finally(() => { liveRefreshInFlight.delete(key) }))
  return await liveRefreshInFlight.get(key)!
}
