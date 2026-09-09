import { clearModelsPlan, compactProvider, globToRegex, planProviderSave } from "../plugins/shared/provider-core"
let passed = 0; let failed = 0
const assert = (value: unknown, message: string) => value ? (passed++, console.log(`  ✅ ${message}`)) : (failed++, console.error(`  ❌ ${message}`))
assert(planProviderSave({ id: "Bad ID", name: "", npm: "x", baseURL: "u", apiKey: "", keySet: false }, "", {}, {}).error === "invalidProviderId", "invalid provider ID is rejected")
assert(planProviderSave({ id: "x", name: "", npm: "x", baseURL: "", apiKey: "", keySet: false }, "", {}, {}).error === "baseURLRequired", "non-Anthropic provider requires baseURL")
const literal = planProviderSave({ id: "x", name: "", npm: "x", baseURL: "u", apiKey: "secret", keySet: false }, "", {}, {})
assert(literal.auth.x?.key === "secret" && literal.config.provider?.x?.options?.apiKey === undefined, "literal key is stored in auth only")
const empty = planProviderSave({ id: "x", name: "", npm: "x", baseURL: "u", apiKey: "", keySet: true }, "x", { provider: { x: { options: { apiKey: "{env:X}" } } } }, { x: { type: "api", key: "old" } })
assert(empty.config.provider?.x?.options?.apiKey === "{env:X}" && empty.auth.x?.key === "old", "empty key does not clear existing secret")
const renamed = planProviderSave({ id: "y", name: "", npm: "x", baseURL: "u", apiKey: "", keySet: true }, "x", { provider: { x: {} } }, { x: { type: "api", key: "old" } })
assert(renamed.auth.y?.key === "old" && !renamed.auth.x, "rename migrates credentials")
const provider = { npm: "@ai-sdk/openai-compatible", name: "", options: {}, models: { a: { id: "a", name: "a", status: "active" } } }; compactProvider(provider)
assert(!provider.name && !provider.options && provider.models.a.id === undefined, "compactProvider removes defaults")
assert(globToRegex("gpt-*").test("gpt-4") && !globToRegex("gpt-*").test("claude"), "globToRegex matches patterns")
const plan = clearModelsPlan({ a: {}, b: {} }, "a"); const cfg = { provider: { p: { models: { a: {}, b: {} } } } }
assert(plan.matched.length === 1 && plan.remove(cfg, "p") === 1 && !cfg.provider.p.models.a, "clearModelsPlan removes matched models")
console.log(`Passed: ${passed}, Failed: ${failed}`); if (failed) process.exit(1)
