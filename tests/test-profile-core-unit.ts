import { applyProfile, createCustomProfile, ensureNativeAgents, listModelRefs, parseProfileSubcommand, stripModelRefs } from "../plugins/shared/profile-core"
let passed = 0; let failed = 0
const assert = (value: unknown, message: string) => value ? (passed++, console.log(`  ✅ ${message}`)) : (failed++, console.error(`  ❌ ${message}`))
assert(parseProfileSubcommand({ input: "profile.switch reset" }) === "reset", "parses input source")
assert(parseProfileSubcommand({ payload: "/profile apply fast" }) === "apply", "parses payload source")
assert(parseProfileSubcommand({ data: { args: "profile list" } }) === "list", "parses data.args source")
const custom = createCustomProfile("fast/model", "strong/model")
assert(JSON.stringify(custom.tiers) === JSON.stringify({ flash: "fast/model", standard: "fast/model", pro: "strong/model", max: "strong/model", vision: "fast/model" }), "two custom model picks expand to the five-tier defaults")
// ─── v1-shaped config (legacy agent / small_model read surface) ──────
const config: any = { model: "p/root", small_model: "p/small", agent: { a: { model: "p/a", keep: true }, b: {} } }
assert(listModelRefs(config).length === 3 && stripModelRefs(config) === 3 && config.agent.a.keep, "reset lists and strips only model refs on v1-shaped config")
const applied: any = { agent: { a: {}, b: {} } }; const result = applyProfile(applied, { tiers: { standard: "p/model" } }, { a: "standard" })
assert(result.updated === 1 && applied.agents?.a?.model === "p/model" && !("agent" in applied), "applyProfile migrates legacy agent map to native agents on write")
assert((result.patch.agents as any)?.a?.model === "p/model", "applyProfile creates the expected native patch")
// ─── v2-native config (agents record, title small-slot, #variant refs) ──
const native: any = { model: "p/root", agents: { a: { model: "p/a#high", keep: true }, title: { model: "p/small" } } }
const refs = listModelRefs(native)
assert(refs.length === 3 && refs.includes("agents.a → p/a#high") && refs.includes("agents.title → p/small"), "listModelRefs reads native agents incl. the title slot")
assert(stripModelRefs(native) === 3 && native.agents.a.keep, "stripModelRefs strips native agents.*.model, keeps other fields")
const nativeApplied: any = { agents: { fast: { model: "old/b#high" } }, providers: { p: { models: { m: { id: "m", reasoning: true }, "m-high": { id: "m-high", reasoning: true } } } } }
const r2 = applyProfile(nativeApplied, { tiers: { standard: "p/m", flash: "p/small" } }, { fast: "standard" })
assert(r2.updated === 1 && nativeApplied.agents.fast.model === "p/m-high", "native apply resolves #variant to the provider's suffixed sibling")
assert(nativeApplied.model === "p/m" && nativeApplied.agents.title.model === "p/small" && !("small_model" in nativeApplied), "standard → root model; flash → agents.title.model")
const paramApplied: any = { agents: { fast: { model: "old/x#low" } } }
applyProfile(paramApplied, { tiers: { standard: "p/gpt" } }, { fast: "standard" })
assert(paramApplied.agents.fast.model === "p/gpt#low", "parameter-style router (no sibling) keeps base ref with #variant")
// ─── migration faithfulness (mirrors merger.ts normalizeLegacyAgent) ──
const legacy: any = { agent: { e: { model: "p/m", variant: "high", prompt: "P", disable: true, temperature: 0.3, tools: { bash: false } } }, small_model: "p/s" }
const migrated = ensureNativeAgents(legacy)
const entry = migrated.e
assert(entry.model === "p/m#high" && entry.system === "P" && entry.disabled === true && !("prompt" in entry) && !("variant" in entry) && !("tools" in entry) && !("temperature" in entry), "legacy fields migrate to native keys")
assert((entry.request as any).body.temperature === 0.3, "temperature moves into request.body")
assert(JSON.stringify(migrated.e.permissions).includes('"action":"shell"'), "tools map converts to permission rules (bash→shell)")
assert(migrated.title.model === "p/s" && !("agent" in legacy) && !("small_model" in legacy), "small_model folds into agents.title.model; legacy keys removed")
console.log(`Passed: ${passed}, Failed: ${failed}`); if (failed) process.exit(1)
