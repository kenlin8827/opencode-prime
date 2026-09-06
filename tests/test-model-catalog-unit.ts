/**
 * model-catalog SWR helpers — Unit Tests
 *
 * Run: bun tests/test-model-catalog-unit.ts
 */

import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  MODEL_CATALOG_FRESH_MS,
  MODEL_CATALOG_STALE_MS,
  fetchModelsDevModelCatalog,
  fetchProviderModelsCached,
  getPublicModelCatalog,
  mergePublicCatalog,
  parseModelsDevModels,
  parseOpenCodeApi,
  parseProviderModelList,
  mergePublicSources,
  resetModelCatalogCacheForTests,
} from "../plugins/shared/model-catalog"

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string): void {
  if (cond) { console.log(`  ✅ ${msg}`); passed++ }
  else { console.error(`  ❌ ${msg}`); failed++ }
}

function section(title: string): void {
  console.log(`\n${"═".repeat(60)}`)
  console.log(`  ${title}`)
  console.log(`${"═".repeat(60)}`)
}

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, statusText: ok ? "OK" : "FAIL", json: async () => body } as Response
}

section("models.dev parsers")

const models = parseModelsDevModels({
  "openai/gpt-x": {
    id: "openai/gpt-x",
    name: "GPT X",
    family: "gpt",
    reasoning: true,
    reasoning_options: [{ type: "effort", values: ["low", "high"] }],
    temperature: true,
    tool_call: false,
    structured_output: true,
    modalities: { input: ["text", "image", "file"], output: ["text"] },
    limit: { context: 100, input: 90, output: 10 },
  },
  bogus: null,
})
assert(models["openai/gpt-x"]?.reasoning === true, "reasoning boolean parsed")
assert(models["openai/gpt-x"]?.reasoningOptions?.[0]?.type === "effort", "reasoning_options preserved")
assert(JSON.stringify(models["openai/gpt-x"]?.capabilities?.input) === JSON.stringify(["text", "image"]), "known modalities kept and file dropped")
assert(models["openai/gpt-x"]?.toolCall === false && models["openai/gpt-x"]?.structuredOutput === true, "tool/structured flags parsed")

const prices = { "openai/gpt-x": { input: 1, output: 2, cached: 0.1, cacheWrite: 0.2 } }
const merged = mergePublicCatalog(models, prices, 123)
assert(merged.ts === 123 && merged.models["openai/gpt-x"]?.cost?.output === 2, "price merged into public model meta")

const openCode = parseOpenCodeApi({
  openai: {
    npm: "@ai-sdk/openai-compatible",
    models: {
      "gpt-x": {
        id: "gpt-x",
        reasoning_options: [{ type: "effort", values: ["low", "high"] }],
        variants: { low: { reasoningEffort: "low" } },
        provider: { npm: "@ai-sdk/openai-compatible", api: "https://api.example.test/v1" },
        cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
      },
    },
  },
})
const fieldMerged = mergePublicSources(models, openCode, prices)
assert(fieldMerged["openai/gpt-x"]?.capabilities?.input?.includes("image") === true, "models.dev capability survives source merge")
assert(fieldMerged["openai/gpt-x"]?.reasoningOptions?.[0]?.type === "effort", "models.opencode reasoning metadata is merged")
assert(fieldMerged["openai/gpt-x"]?.variants?.low?.reasoningEffort === "low", "models.opencode variants are merged")
assert(fieldMerged["openai/gpt-x"]?.provider?.npm === "@ai-sdk/openai-compatible", "provider SDK metadata is merged")
  assert(fieldMerged["openai/gpt-x"]?.cost?.cached === 0.1, "OpenCode cost is normalized into standard model metadata")

section("provider /models parser")

assert(JSON.stringify(parseProviderModelList({ data: [{ id: "a", name: "A" }, { id: "b" }, null] })) === JSON.stringify([{ id: "a", name: "A" }, { id: "b", name: "b" }]), "OpenAI-style data list decoded")
assert(parseProviderModelList({ data: {} }).length === 0, "malformed provider list yields empty")

section("public catalog SWR cache")

const tmp = mkdtempSync(join(tmpdir(), "ocp-model-catalog-"))
process.env.OCP_MODEL_CATALOG_PATH = join(tmp, "cache.json")
resetModelCatalogCacheForTests()
let now = 1_000_000
let publicCalls = 0
const publicFetcher = async (url: RequestInfo | URL): Promise<Response> => {
  publicCalls++
  const text = String(url)
  if (text.includes("models.json")) return jsonResponse({ "lab/model-a": { modalities: { input: ["text"], output: ["text"] }, limit: { context: 10, output: 2 }, reasoning: true } })
  return jsonResponse({ lab: { models: { "model-a": { cost: { input: 1, output: 3 } } } } })
}

const fresh = await getPublicModelCatalog({ fetcher: publicFetcher as typeof fetch, now: () => now })
assert(Object.keys(fresh.models).length === 1 && publicCalls === 2, "cold public fetch reads both merged public endpoints")
const freshAgain = await getPublicModelCatalog({ fetcher: publicFetcher as typeof fetch, now: () => now + MODEL_CATALOG_FRESH_MS / 2 })
assert(freshAgain === fresh && publicCalls === 2, "fresh cache returns without network")
now += MODEL_CATALOG_FRESH_MS + 1
await getPublicModelCatalog({ fetcher: publicFetcher as typeof fetch, now: () => now })
assert(publicCalls === 4, "stale public cache returns old data and starts refresh")
const list = await fetchModelsDevModelCatalog({ fetcher: publicFetcher as typeof fetch, now: () => now })
assert(list.some((m) => m.id === "lab/model-a"), "public catalog list helper returns model array")

section("provider live-model SWR cache")

resetModelCatalogCacheForTests()
now = 5_000_000
let liveCalls = 0
const liveFetcher = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  liveCalls++
  const headers = init?.headers as Record<string, string>
  assert(String(url).endsWith("/models"), "openai-compatible provider uses /models")
  assert(headers.Authorization === "Bearer sk-test", "api key sent as bearer token")
  return jsonResponse({ data: [{ id: "cx/gpt-low" }] })
}
const live = await fetchProviderModelsCached({ npm: "@ai-sdk/openai-compatible", baseURL: "https://example.test/v1/", apiKey: "sk-test", fetcher: liveFetcher as typeof fetch, now: () => now })
assert(live[0]?.id === "cx/gpt-low" && liveCalls === 1, "cold live provider fetch cached")
await fetchProviderModelsCached({ npm: "@ai-sdk/openai-compatible", baseURL: "https://example.test/v1/", apiKey: "sk-test", fetcher: liveFetcher as typeof fetch, now: () => now + MODEL_CATALOG_FRESH_MS / 2 })
assert(liveCalls === 1, "fresh live provider cache avoids network")

resetModelCatalogCacheForTests()
let anthropicUrl = ""
const anthropicFetcher = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  anthropicUrl = String(url)
  const headers = init?.headers as Record<string, string>
  assert(headers["x-api-key"] === "sk-anthropic" && headers["anthropic-version"] === "2023-06-01", "anthropic headers set")
  return jsonResponse({ data: [{ id: "claude" }] })
}
await fetchProviderModelsCached({ npm: "@ai-sdk/anthropic", baseURL: "https://anthropic.test", apiKey: "sk-anthropic", fetcher: anthropicFetcher as typeof fetch, now: () => now })
assert(anthropicUrl.endsWith("/v1/models"), "anthropic provider uses /v1/models")

rmSync(tmp, { recursive: true, force: true })
delete process.env.OCP_MODEL_CATALOG_PATH
resetModelCatalogCacheForTests()

console.log(`\nPassed: ${passed}, Failed: ${failed}`)
if (failed > 0) process.exit(1)
