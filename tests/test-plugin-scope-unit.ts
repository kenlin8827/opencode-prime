/**
 * Unit tests for the plugin scope policy file and its runtime gate.
 * Run: bun tests/test-plugin-scope-unit.ts
 */
import fs from "node:fs"
import path from "node:path"
import { detectAgent } from "../plugins/shared/plugin-scope"
import { scopedForAgent, type V2Session } from "../plugins/shared/agent-scope"

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
const memoryPolicy = scope.plugins["project-memory"]
check("project-memory overrides the default: lite allowed, utility and subagent steps still denied", Array.isArray(memoryPolicy?.deny) && !memoryPolicy.deny.includes("lite") && memoryPolicy.deny.includes("utility") && memoryPolicy.deny.includes("subagent:*"))

// --- Public surface ------------------------------------------------------------
const gateApi = (await import("../plugins/shared/plugin-scope")) as Record<string, unknown>
check("plugin-scope exposes only the gate API (identifier texts stay encapsulated)", typeof gateApi.identifierText === "undefined" && typeof gateApi.detectAgent === "function" && typeof gateApi.evaluateScope === "function")
check("v1 gate entry points are gone (agent-scope is the only gate)", typeof gateApi.scoped === "undefined" && typeof gateApi.scopedForTool === "undefined")

// --- Text identification (sync) --------------------------------------------------
const liteSystem = ["<!-- lite-mode -->\nYou are lite."]
const utilitySystem = ["You are a title generator. Produce a short title."]
const normalSystem = ["You are build, a routing agent.", "Some other system block"]

check("detectAgent identifies lite sessions", detectAgent(liteSystem) === "lite")
check("detectAgent identifies utility calls", detectAgent(utilitySystem) === "utility")
check("detectAgent returns null for normal chat", detectAgent(normalSystem) === null)
check("detectAgent returns null for empty/undefined input", detectAgent(undefined) === null && detectAgent([]) === null)

// --- Gate: text-identified contexts ---------------------------------------------
check("gate blocks injection for lite sessions", (await scopedForAgent({ system: liteSystem }, "sdd")) === false)
check("gate blocks injection for utility calls", (await scopedForAgent({ system: utilitySystem }, "adr")) === false)
check("gate allows injection for normal chat steps", (await scopedForAgent({ system: normalSystem }, "sdd")) === true)
check("gate allows when the system is empty/undefined", (await scopedForAgent({ system: undefined }, "sdd")) === true && (await scopedForAgent({ system: [] }, "sdd")) === true)
check("gate treats non-string entries safely", (await scopedForAgent({ system: [42, null] }, "sdd")) === true)
check("gate blocks when only a bare sentinel entry is present", (await scopedForAgent({ system: ["<!-- lite-mode -->"] }, "goal")) === false)

// --- Gate: subagent state via session parentID (fake v2 session domain) ----------
const subagentSession = { get: async () => ({ parentID: "parent-session" }) } as unknown as V2Session
const primarySession = { get: async () => ({ parentID: "" }) } as unknown as V2Session
let callCount = 0
const countingSession = { get: async () => { callCount++; return { parentID: "parent-session" } } } as unknown as V2Session

check("gate blocks subagent steps (parentID ground truth)", (await scopedForAgent({ sessionID: "sub-1", system: normalSystem }, "sdd", subagentSession)) === false)
// Why project-profiler now ALSO allows "lite" (was denied up to 2026-09-10):
//   prompts/lite.md promotes tgrep_search to "the default" for codebase-wide
//   text/regex search (replacing earlier @explore delegation). Without the
//   [PROJECT CAPABILITIES] block, Lite is forced to either probe `tgrep status`
//   or default blind to `noIndex=true` — the block is the cheaper,
//   single-source-of-truth path shared with subagents. Utility (title-generator,
//   ~30k tok saved per session) stays denied — it never touches code search,
//   so the block would be pure overhead there. If you revert this, also revert
//   the Lite prompt's anti-pattern bullet or the two will silently fight each
//   other.
check("project-profiler injects into subagent steps via its override", (await scopedForAgent({ sessionID: "sub-profiler", system: normalSystem }, "project-profiler", subagentSession)) === true)
check("project-profiler now allows lite sessions (Lite needs backend state for tgrep_search routing)", (await scopedForAgent({ system: liteSystem }, "project-profiler")) === true)
check("project-memory now allows lite sessions (curated lessons are Lite's project context)", (await scopedForAgent({ system: liteSystem }, "project-memory")) === true)
check("project-memory still denies subagent steps", (await scopedForAgent({ sessionID: "sub-memory", system: normalSystem }, "project-memory", subagentSession)) === false)
check("gate allows primary sessions with a client present", (await scopedForAgent({ sessionID: "pri-1", system: normalSystem }, "sdd", primarySession)) === true)
check("gate falls open without sessionID/client", (await scopedForAgent({ system: normalSystem }, "sdd")) === true)
await scopedForAgent({ sessionID: "sub-cache", system: normalSystem }, "sdd", countingSession)
await scopedForAgent({ sessionID: "sub-cache", system: normalSystem }, "goal", countingSession)
check("parentID lookups are cached per sessionID", callCount === 1)

// --- Scope entry grammar -----------------------------------------------------------
// Deny "subagent:*" must also cover a named identity inside the subagent state.
check("subagent:* covers any identity in the subagent state", (await scopedForAgent({ sessionID: "sub-lite", system: liteSystem }, "sdd", subagentSession)) === false)
// Grammar is exercised indirectly: "lite" matches identity, "subagent:*" matches state.

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
