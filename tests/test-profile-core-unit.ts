import { applyProfile, listModelRefs, parseProfileSubcommand, stripModelRefs } from "../plugins/shared/profile-core"
let passed = 0; let failed = 0
const assert = (value: unknown, message: string) => value ? (passed++, console.log(`  ✅ ${message}`)) : (failed++, console.error(`  ❌ ${message}`))
assert(parseProfileSubcommand({ input: "profile.switch reset" }) === "reset", "parses input source")
assert(parseProfileSubcommand({ payload: "/profile apply fast" }) === "apply", "parses payload source")
assert(parseProfileSubcommand({ data: { args: "profile list" } }) === "list", "parses data.args source")
const config: any = { model: "p/root", small_model: "p/small", agent: { a: { model: "p/a", keep: true }, b: {} } }
assert(listModelRefs(config).length === 3 && stripModelRefs(config) === 3 && config.agent.a.keep, "reset lists and strips only model refs")
const applied: any = { agent: { a: {}, b: {} } }; const result = applyProfile(applied, { tiers: { standard: "p/model" } }, { a: "standard" })
assert(result.updated === 1 && applied.agent.a.model === "p/model" && result.patch.agent?.a?.model === "p/model", "applyProfile creates the expected patch")
console.log(`Passed: ${passed}, Failed: ${failed}`); if (failed) process.exit(1)
