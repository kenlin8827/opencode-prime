import {
  allocateModelKey,
  catalogModels,
  sdkCatalogModels,
  catalogCapabilities,
  catalogLimit,
  deriveModelKey,
  humanizeModelName,
  importedModelDef,
  enrichModelDef,
  parseModelList,
  ensureBaseReasoningOptions,
} from "../plugins/tui/provider-wizard"
import { listConnections, planDisconnect } from "../plugins/shared/provider-creds"

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

section("deriveModelKey trims namespace prefixes")

assert(deriveModelKey("cx/gpt-5.6-luna") === "gpt-5.6-luna", "slash suffix becomes bare model key")
assert(deriveModelKey("qwen-large") === "qwen-large", "ids without slash stay intact")
assert(deriveModelKey("foo/") === "foo", "trailing slash is dropped")

section("humanizeModelName shortens display label")

assert(humanizeModelName("cx/gpt-5.6-luna", "fallback") === "gpt-5.6-luna", "prefix removed from name")
assert(humanizeModelName("GPT 5.6 Luna", "fallback") === "GPT 5.6 Luna", "plain names untouched")
assert(humanizeModelName(undefined, "gpt-5.6-luna") === "gpt-5.6-luna", "fallback used when remote name missing")

section("allocateModelKey enforces uniqueness")

const models: Record<string, { id: string }> = {}

let result = allocateModelKey(models, "gpt-5.6-luna", "cx/gpt-5.6-luna")
assert(!result.duplicate && result.key === "gpt-5.6-luna", "first insert keeps short key")
models[result.key] = { id: "cx/gpt-5.6-luna" }

result = allocateModelKey(models, "gpt-5.6-luna", "cx/gpt-5.6-luna")
assert(result.duplicate, "same remote id detected as duplicate")

result = allocateModelKey(models, "gpt-5.6-luna", "cx/gpt-5.6-terra")
assert(!result.duplicate && result.key === "gpt-5.6-luna-2", "conflicting id receives numeric suffix")

section("catalog capabilities conservatively enable image input")

const catalog = [
  { id: "openai/gpt-4o", capabilities: { input: ["text", "image"], output: ["text"] }, limit: { context: 128000, output: 16384 }, reasoning: true, temperature: true, reasoningOptions: [{ type: "effort", values: ["low", "high"] }] },
  { id: "openai/gpt-5.6-luna", capabilities: { input: ["text", "image", "pdf"], output: ["text"] }, limit: { context: 1050000, output: 128000 }, reasoning: true, reasoningOptions: [{ type: "effort", values: ["low", "high"] }] },
  { id: "deepseek/deepseek-chat", capabilities: { input: ["text"], output: ["text"] } },
  { id: "acme/no-tools", capabilities: { input: ["text"], output: ["text"] }, toolCall: false },
]

assert(
  JSON.stringify(catalogCapabilities("gateway/gpt-4o", catalog)) === JSON.stringify({ input: ["text", "image"], output: ["text"] }),
  "namespaced remote ID matches a catalog model by bare ID",
)
assert(catalogCapabilities("deepseek/deepseek-chat", catalog) === undefined, "text-only catalog model does not claim attachment support")
assert(catalogCapabilities("unknown", catalog) === undefined, "unknown model remains capability-unknown")
assert(
  catalogCapabilities("gateway/gpt-4o", [
    { id: "other/gpt-4o", capabilities: { input: ["text", "image"] } },
    { id: "gateway/gpt-4o", capabilities: { input: ["text"] } },
  ]) === undefined,
  "exact text-only ID takes precedence over an earlier bare-ID vision match",
)
assert(
  catalogCapabilities("gateway/gpt-4o", [
    { id: "one/gpt-4o", capabilities: { input: ["text", "image"] } },
    { id: "two/gpt-4o", capabilities: { input: ["text"] } },
  ]) === undefined,
  "ambiguous bare IDs remain capability-unknown",
)
assert(
  JSON.stringify(catalogCapabilities("cx/gpt-5.6-luna-xhigh", catalog)) === JSON.stringify({ input: ["text", "image", "pdf"], output: ["text"] }),
  "reasoning-effort suffix (-xhigh) stripped as last-resort fallback",
)
assert(
  JSON.stringify(catalogCapabilities("cx/gpt-5.6-luna-max", catalog)) === JSON.stringify({ input: ["text", "image", "pdf"], output: ["text"] }),
  "reasoning-effort suffix (-max) stripped as last-resort fallback",
)
assert(
  catalogCapabilities("v/qwen-max", [
    { id: "alibaba/qwen-max", capabilities: { input: ["text"] } },
    { id: "alibaba/qwen", capabilities: { input: ["text", "image"] } },
  ]) === undefined,
  "real -max model name wins over stripped base — no false vision claim",
)
assert(
  catalogCapabilities("v/gpt-x-high", [
    { id: "a/gpt-x", capabilities: { input: ["text", "image"] } },
    { id: "b/gpt-x", capabilities: { input: ["text"] } },
  ]) === undefined,
  "ambiguous stripped base stays unknown",
)
assert(catalogCapabilities("v/unknown-low", catalog) === undefined, "stripped base absent → no match")
assert(catalogCapabilities("v/qwen-mini", catalog) === undefined, "size suffixes (mini) are NOT stripped")
assert(
  JSON.stringify(catalogLimit("gateway/gpt-4o", catalog)) === JSON.stringify({ context: 128000, output: 16384 }),
  "catalog limits matched by bare ID",
)
assert(catalogLimit("deepseek/deepseek-chat", catalog) === undefined, "catalog entry without limits yields none")

section("models.dev live models.json (object-keyed) is decoded defensively")

const liveBody = {
  "openai/gpt-5.6-luna": {
    id: "openai/gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    attachment: true,
    reasoning: true,
    temperature: false,
    tool_call: true,
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 1050000, input: 922000, output: 128000 },
  },
  "deepseek/deepseek-chat": {
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 1000000, output: 8000 },
  },
  "acme/no-signal-model": { name: "mystery" },
  "bogus-entry": null,
  data: [{ id: "not-a-model-entry" }],
}
const live = catalogModels(liveBody)
assert(live.length === 3, "object-keyed payload decoded, null/array values skipped")
const luna = live.find((m) => m.id === "openai/gpt-5.6-luna")
assert(
  JSON.stringify(luna?.capabilities) === JSON.stringify({ input: ["text", "image", "pdf"], output: ["text"] }),
  "live modalities decoded verbatim (pdf kept)",
)
assert(
  JSON.stringify(luna?.limit) === JSON.stringify({ context: 1050000, output: 128000 }),
  "live limit.context/output picked, extra input field ignored",
)
assert(luna?.reasoning === true && luna?.temperature === undefined && luna?.toolCall === undefined, "only non-default flags recorded")
assert(live.find((m) => m.id === "deepseek/deepseek-chat")?.limit?.output === 8000, "entry without explicit id keyed by map key")
assert(liveModelsNoThrow(), "catalogModels never throws")

function liveModelsNoThrow(): boolean {
  try {
    catalogModels(null); catalogModels(undefined); catalogModels([]); catalogModels("x"); catalogModels({})
    return true
  } catch {
    return false
  }
}

section("legacy models.dev array payload (architecture shape) still decodes")

const legacyBody = {
  data: [
    null,
    { id: 42 },
    {
      id: "anthropic/claude-opus-4.7-fast",
      architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] },
      context_length: 1_000_000,
      top_provider: { max_completion_tokens: 128_000 },
    },
    {
      id: "deepseek/deepseek-chat",
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      context_length: 1_000_000,
      top_provider: { max_completion_tokens: null },
    },
  ],
}
const parsed = catalogModels(legacyBody)
assert(parsed.length === 2, "legacy entries decoded, malformed ignored")
assert(parsed[0]?.id === "anthropic/claude-opus-4.7-fast", "legacy id preserved")
assert(
  JSON.stringify(parsed[0]?.capabilities) === JSON.stringify({ input: ["text", "image"], output: ["text"] }),
  "file modality dropped, known modalities kept",
)
assert(
  JSON.stringify(parsed[0]?.limit) === JSON.stringify({ context: 1_000_000, output: 128_000 }),
  "context_length + max_completion_tokens become the limit pair",
)
assert(parsed[1]?.limit === undefined, "missing max_completion_tokens → no limit")

section("SDK model.list payload (boolean maps or arrays) is decoded")

const sdkBoolMap = sdkCatalogModels({
  data: {
    data: [
      { id: "anthropic/claude-sonnet-5", capabilities: { input: { text: true, image: true, video: false }, output: { text: true } }, limit: { context: 1000000, output: 64000 } },
      { id: "xai/grok-4" },
      null,
      { id: 42 },
    ],
  },
})
assert(sdkBoolMap.length === 2, "SDK envelope decoded, malformed skipped")
assert(
  JSON.stringify(sdkBoolMap[0]?.capabilities) === JSON.stringify({ input: ["text", "image"], output: ["text"] }),
  "boolean-map capabilities normalized to modality arrays",
)
assert(
  JSON.stringify(sdkBoolMap[0]?.limit) === JSON.stringify({ context: 1000000, output: 64000 }),
  "SDK limit pair normalized",
)
assert(
  JSON.stringify(sdkCatalogModels({ data: { all: [{ id: "a/b", modalities: { input: ["text", "image"], output: ["text"] } }] } })[0]?.capabilities)
    === JSON.stringify({ input: ["text", "image"], output: ["text"] }),
  "{ all } envelope and modalities-style entries also decode",
)
assert(sdkCatalogModels(undefined).length === 0 && sdkCatalogModels({ data: {} }).length === 0, "missing SDK catalog yields empty, never throws")

section("importedModelDef + enrichModelDef apply catalog-proven data only")

const vision = importedModelDef({ id: "gateway/gpt-4o", name: "Gateway GPT-4o" }, "gpt-4o", catalog)
assert(vision.attachment === true, "catalog-proven image model enables attachments")
assert(JSON.stringify(vision.modalities) === JSON.stringify({ input: ["text", "image"], output: ["text"] }), "catalog modalities are preserved")
assert(JSON.stringify(vision.limit) === JSON.stringify({ context: 128000, output: 16384 }), "catalog limits are written")
assert(vision.reasoning === true && vision.temperature === true, "non-default reasoning/temperature flags written")
assert((vision.variants as any)?.low?.reasoningEffort === "low" && (vision.variants as any)?.high?.reasoningEffort === "high", "reasoning effort metadata becomes native variants")

const noTools = importedModelDef({ id: "acme/no-tools", name: "NoTools" }, "no-tools", catalog)
assert(noTools.tool_call === false, "catalog-proven missing tool support written")
assert(noTools.reasoning === undefined && noTools.temperature === undefined, "default-valued flags omitted")

const unknown = importedModelDef({ id: "unknown", name: "Unknown" }, "unknown", catalog)
assert(unknown.attachment === undefined && unknown.modalities === undefined && unknown.limit === undefined, "unknown model stays conservatively text-only")

const staleEntry: Record<string, unknown> = { name: "gpt-4o", id: "gateway/gpt-4o" }
assert(enrichModelDef(staleEntry, "gateway/gpt-4o", catalog) === true, "stale text-only entry gets enriched")
assert(staleEntry.attachment === true && typeof staleEntry.modalities === "object", "enrichment adds attachment + modalities")
assert(JSON.stringify(staleEntry.limit) === JSON.stringify({ context: 128000, output: 16384 }), "enrichment adds missing limits")

const userTuned: Record<string, unknown> = { name: "gpt-4o", id: "gateway/gpt-4o", attachment: false }
assert(enrichModelDef(userTuned, "gateway/gpt-4o", catalog) === true, "limit still enriched when modalities are user-set")
assert(userTuned.attachment === false && userTuned.modalities === undefined, "user-set attachment never overwritten")

const completeEntry: Record<string, unknown> = { name: "x", id: "gateway/gpt-4o", attachment: true, modalities: { input: ["text"] }, limit: { context: 1, output: 1 }, reasoning: false, temperature: false, reasoning_options: [{ type: "effort", values: ["low", "high"] }], variants: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } } }
assert(enrichModelDef(completeEntry, "gateway/gpt-4o", catalog) === false, "nothing to add → not changed")

const baseWithSiblings: Record<string, any> = {
  "gpt-5.6-luna": { reasoning: true },
  "gpt-5.6-luna-low": { reasoning: true },
  "gpt-5.6-luna-high": { reasoning: true },
}
assert(ensureBaseReasoningOptions(baseWithSiblings) === 1, "base model receives reasoning_options from suffix siblings")

section("listConnections unions credential store and config apiKeys")

const connAuth = {
  "opencode": { type: "api", key: "sk-xxx" },          // official built-in via /connect
  "kimi": { type: "oauth", refresh: "r" },            // oauth entry
  "stale": { type: "api", key: "sk-yyy" },            // leftover, not in config
  "broken": { key: "no-type" },                       // no type — must be ignored
}
const connConfig = {
  provider: {
    kimi: { options: { apiKey: "{env:KIMI_KEY}" } },  // env ref on config side too
    acme: { options: { apiKey: "sk-literal" } },       // config-only literal
    bare: { options: {} },                             // no apiKey — excluded
    nomodels: {},                                      // no options — excluded
  },
}
const conns = listConnections(connConfig as never, connAuth as never)
const byId = Object.fromEntries(conns.map((c) => [c.id, c]))

assert(conns.length === 4, "union yields 4 connections (stale & broken handled)")
assert(byId.opencode.authType === "api" && !byId.opencode.inConfig, "store-only official built-in detected")
assert(byId.kimi.authType === "oauth" && byId.kimi.inConfig, "both sides merge into one entry")
assert(byId.acme.inConfig && byId.acme.authType === undefined, "config-only connection detected")
assert(!conns.some((c) => c.id === "broken"), "typeless auth entries are ignored")
assert(!conns.some((c) => c.id === "bare" || c.id === "nomodels"), "providers without apiKey are excluded")
assert(conns.findIndex((c) => c.id === "acme") < conns.findIndex((c) => c.id === "stale"), "natural id sort")

section("planDisconnect clears both sides, keeps the definition")

const pAuth = { acme: { type: "api", key: "sk-xxx" }, other: { type: "api", key: "sk-yyy" } }
const pConfig = {
  provider: {
    acme: {
      options: { apiKey: "{env:ACME_KEY}", baseURL: "https://api.example.com" },
      models: { "m1": { id: "m1" } },
    },
  },
}
const plan = planDisconnect("acme", pAuth as never, pConfig as never)
assert(plan.authRemoved && plan.configChanged, "both sides reported changed")
assert(pAuth.acme === undefined && pAuth.other !== undefined, "only the target auth entry removed")
assert(pConfig.provider.acme.options.apiKey === undefined, "config apiKey cleared")
assert(pConfig.provider.acme.options.baseURL === "https://api.example.com", "sibling options untouched")
assert(pConfig.provider.acme.models !== undefined, "models kept")
const noop = planDisconnect("ghost", pAuth as never, pConfig as never)
assert(!noop.authRemoved && !noop.configChanged, "unknown id is a clean no-op")

const pConfig2 = { provider: { solo: { options: { apiKey: "sk-lit" } } } }
planDisconnect("solo", {} as never, pConfig2 as never)
assert(!("options" in pConfig2.provider.solo), "empty options node compacted away")

console.log(`\nPassed: ${passed}, Failed: ${failed}`)
if (failed > 0) process.exit(1)
