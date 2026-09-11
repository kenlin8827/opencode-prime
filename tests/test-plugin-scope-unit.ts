/**
 * Unit tests for the plugin scope policy file and its runtime gate.
 * Run: bun tests/test-plugin-scope-unit.ts
 */
import fs from "node:fs"
import path from "node:path"
import { scoped, detectAgent } from "../plugins/shared/plugin-scope"

const repoDir = path.resolve(import.meta.dir, "..")
const scopePath = path.join(repoDir, "plugin-scope.json")

let pass = 0
let fail = 0
function check(name: string, ok: boolean) {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}`)
  }
}

const scope = JSON.parse(fs.readFileSync(scopePath, "utf8"))

// --- Policy file shape -------------------------------------------------------
check("plugin-scope.json parses with identifiers and plugins sections", !!scope.identifiers && !!scope.plugins)
check("identifiers.lite is a contains rule", typeof scope.identifiers.lite?.contains === "string")
check("identifiers.utility is a startsWith rule", typeof scope.identifiers.utility?.startsWith === "string")
const star = scope.plugins["*"]
check("default policy denies lite, utility and all subagent steps", Array.isArray(star?.deny) && ["lite", "utility", "subagent:*"].every((e) => star.deny.includes(e)))
const profiler = scope.plugins["project-profiler"]
check("project-profiler overrides the default: subagent steps AND lite allowed, utility still denied", Array.isArray(profiler?.deny) && !profiler.deny.includes("subagent:*") && !profiler.deny.includes("lite") && profiler.deny.includes("utility"))

// --- Public surface ------------------------------------------------------------
const gateApi = (await import("../plugins/shared/plugin-scope")) as Record<string, unknown>
check("plugin-scope exposes only the gate API (identifier texts stay encapsulated)", typeof gateApi.identifierText === "undefined" && typeof gateApi.detectAgent === "function" && typeof gateApi.scoped === "function")

// --- Text identification (sync) --------------------------------------------------
const liteSystem = ["<!-- lite-mode -->\nYou are lite."]
const utilitySystem = ["You are a title generator. Produce a short title."]
const normalSystem = ["You are build, a routing agent.", "Some other system block"]

check("detectAgent identifies lite sessions", detectAgent(liteSystem) === "lite")
check("detectAgent identifies utility calls", detectAgent(utilitySystem) === "utility")
check("detectAgent returns null for normal chat", detectAgent(normalSystem) === null)
check("detectAgent returns null for empty/undefined input", detectAgent(undefined) === null && detectAgent([]) === null)

// --- Gate: text-identified contexts ---------------------------------------------
check("scoped blocks injection for lite sessions", (await scoped(undefined, liteSystem, "sdd")) === false)
check("scoped blocks injection for utility calls", (await scoped(undefined, utilitySystem, "adr-guard")) === false)
check("scoped allows injection for normal chat steps", (await scoped(undefined, normalSystem, "sdd")) === true)
check("scoped allows when the system is empty/undefined", (await scoped(undefined, undefined, "sdd")) === true && (await scoped(undefined, [], "sdd")) === true)
check("scoped treats non-string entries safely", (await scoped(undefined, [42, null], "sdd")) === true)
check("scoped blocks when only a bare sentinel entry is present", (await scoped(undefined, ["<!-- lite-mode -->"], "goal")) === false)

// --- Gate: subagent state via session parentID (fake client) ---------------------
const subagentClient = { session: { get: async () => ({ data: { parentID: "parent-session" } }) } }
const primaryClient = { session: { get: async () => ({ data: { parentID: "" } }) } }
let callCount = 0
const countingClient = { session: { get: async () => { callCount++; return { data: { parentID: "parent-session" } } } } }

check("scoped blocks subagent steps (parentID ground truth)", (await scoped({ sessionID: "sub-1" }, normalSystem, "sdd", subagentClient)) === false)
// Why project-profiler now ALSO allows "lite" (was denied up to 2026-09-10):
//   prompts/lite.md promotes tgrep_search to "the default" for codebase-wide
//   text/regex search (replacing earlier @explore delegation). Without the
//   [PROJECT CAPABILITIES] block, Lite is forced to either probe `tgrep status`
//   or default blind to `freshness="current"` — the block is the cheaper,
//   single-source-of-truth path shared with subagents. Utility (title-generator,
//   ~30k tok saved per session) stays denied — it never touches code search,
//   so the block would be pure overhead there. If you revert this, also revert
//   the Lite prompt's anti-pattern bullet or the two will silently fight each
//   other.
check("project-profiler injects into subagent steps via its override", (await scoped({ sessionID: "sub-profiler" }, normalSystem, "project-profiler", subagentClient)) === true)
check("project-profiler now allows lite sessions (Lite needs backend state for tgrep_search routing)", (await scoped(undefined, liteSystem, "project-profiler")) === true)
check("scoped allows primary sessions with a client present", (await scoped({ sessionID: "pri-1" }, normalSystem, "sdd", primaryClient)) === true)
check("scoped falls open without sessionID/client", (await scoped(undefined, normalSystem, "sdd")) === true)
await scoped({ sessionID: "sub-cache" }, normalSystem, "sdd", countingClient)
await scoped({ sessionID: "sub-cache" }, normalSystem, "goal", countingClient)
check("parentID lookups are cached per sessionID", callCount === 1)

// --- Scope entry grammar -----------------------------------------------------------
// Deny "subagent:*" must also cover a named identity inside the subagent state.
check("subagent:* covers any identity in the subagent state", (await scoped({ sessionID: "sub-lite" }, liteSystem, "sdd", subagentClient)) === false)
// Grammar is exercised indirectly: "lite" matches identity, "subagent:*" matches state.

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
