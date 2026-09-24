/**
 * DeepSeek Anchor Plugin — Unit Tests (no API dependency)
 *
 * Methodology inspired by dsh-anchored-standard:
 *   - anchor-turn: verify injected anchor text and idempotency
 *   - context-gate: verify phase state machine (promoteOn, compaction reset)
 *   - deliberation-gate: verify reasoning depth gate (minChars, deny)
 *   - zero-tool-bootstrap: verify first-turn zero tools, second-turn restore
 *
 * Sandbox layout (global-only config — deepseek-anchor is a USER preference,
 * follows the user, no project-level support):
 *   <tmp>/global-ocp.json   ← OCP_CONFIG_PATH override for global config
 *
 * Run: npx tsx tests/test-anchor-unit.ts
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

// Sandbox the OCP global config to a tmp file via OCP_CONFIG_PATH.
const tmp = mkdtempSync(join(tmpdir(), "anchor-test-"))
const globalCfg = join(tmp, "global-ocp.json")
process.env.OCP_CONFIG_PATH = globalCfg

// OCP_CONFIG_PATH is read at call time by ocpConfigPath() (see
// plugins/shared/ocp-config.ts), so setting it here before any
// v2 migration: hooks are captured from Plugin.setup(fakeCtx); the shim
// returned by loadPlugin preserves each section's v1 call convention.
// ESM hoists the imports regardless.
import { DeepSeekAnchorPlugin, handleAnchorEvent } from "../plugins/deepseek-anchor/deepseek-anchor"
import {
  isEnabled,
  getMode,
  setMode,
  COMMAND_NAME,
  parseModeArg,
} from "../plugins/deepseek-anchor/deepseek-anchor-config"
import { writeOcpField } from "../plugins/shared/ocp-config"

// ─── Test framework ───────────────────────────────────────────────────────

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

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeModel(opts: { providerID?: string; modelID?: string; apiID?: string }): any {
  return {
    providerID: opts.providerID ?? "",
    modelID: opts.modelID ?? "",
    api: opts.apiID ? { id: opts.apiID } : undefined,
  }
}

type Hook = (e: any) => Promise<void>
const pluginCleanups: Array<() => Promise<unknown>> = []
async function loadPlugin(session: any = {}): Promise<any> {
  // V2: run setup() against a fake ctx, capture the registered hooks, and
  // expose v1-shaped call conveniences (the sections keep their assertions):
  //   sysHook(input, output)  -> "context" hook with mutable SystemPart[]
  //   toolHook(event)         -> tool execute.before (same fields in v2)
  //   eventHook({event})      -> push into the ctx.event.subscribe loop
  //   commands                -> editor.add payloads from ctx.command.transform
  const sessionHooks = new Map<string, Hook>()
  const toolHooks = new Map<string, Hook>()
  const commands: Array<{ name: string; description?: string; execute: (i: any) => Promise<void> }> = []
  const eventQueue: unknown[] = []
  const ctx: any = {
    location: { directory: process.cwd() },
    session: {
      hook: async (name: string, cb: Hook) => { sessionHooks.set(name, cb); return { dispose: async () => {} } },
      get: session.get,
      synthetic: async () => {},
    },
    tool: {
      hook: async (name: string, cb: Hook) => { toolHooks.set(name, cb); return { dispose: async () => {} } },
      transform: async () => ({ dispose: async () => {} }),
    },
    command: {
      transform: async (cb: (editor: { add: (d: never) => void }) => void) => {
        cb({ add: (d: never) => { commands.push(d as never) } })
        return { dispose: async () => {} }
      },
    },
    event: {
      // Finite iterator: the entry loop drains the preloaded queue and
      // exits; event() dispatches handleAnchorEvent directly (same
      // function the loop body calls in production).
      subscribe: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<unknown>> =>
            eventQueue.length
              ? { done: false, value: eventQueue.shift() }
              : { done: true, value: undefined },
        }),
      }),
    },
  }
  const cleanup = await DeepSeekAnchorPlugin.setup(ctx)
  // Teardown: release the pending event subscription first so the plugin's
  // for-await loop exits, then run the plugin's own cleanup.
  pluginCleanups.push(cleanup)
  const realContext = sessionHooks.get("context")!
  const sysHook = async (input: any, output: { system: string[] }): Promise<void> => {
    const parts = output.system.map((text) => ({ type: "text" as const, text }))
    // Host mapping: v1 model triple -> v2 Model.Ref {id, providerID}.
    // First NON-EMPTY of modelID/id/api.id (the v1 mock fills only one leg).
    const nonEmpty = (...vals: unknown[]): string | undefined =>
      vals.find((v): v is string => typeof v === "string" && v !== "")
    const model = input.model
      ? { providerID: nonEmpty(input.model.providerID), id: nonEmpty(input.model.modelID, input.model.id, input.model.api?.id) }
      : undefined
    await realContext({ sessionID: input.sessionID, agent: input.agent, model, system: parts })
    parts.forEach((p, i) => { output.system[i] = p.text })
  }
  return {
    "experimental.chat.system.transform": sysHook,
    "tool.execute.before": toolHooks.get("execute.before")!,
    event: async (input: { event: unknown }) => {
      handleAnchorEvent(input.event)
    },
    commands,
    cleanup,
  }
}

function resetGlobalConfig(): void {
  writeFileSync(globalCfg, "{}")
}

// ═════════════════════════════════════════════════════════════════════════
//  1. Anchor injection & content validation (dsh: anchor-turn)
// ═════════════════════════════════════════════════════════════════════════

async function test01_AnchorInjection() {
  section("01: Anchor prompt injection (dsh: anchor-turn)")
  const plugin = await loadPlugin()
  const hook = plugin["experimental.chat.system.transform"]
  setMode("on")

  const output = { system: ["You are an AI assistant."] }
  await hook(
    { sessionID: "anchor-1", model: makeModel({ providerID: "deepseek", modelID: "deepseek-v4-pro" }) },
    output,
  )

  const prompt = output.system[0]
  assert(prompt.includes("[DEEPSEEK REASONING ANCHOR]"), "MARKER injected")
  assert(prompt.includes("Session anchor"), "Contains Session anchor directive")
  assert(prompt.includes("Restate the goal"), "Step 1: restate goal")
  assert(prompt.includes("key constraints"), "Step 2: list constraints")
  assert(prompt.includes("State your intended approach"), "Step 3: state approach")
  assert(prompt.includes("HARD RULE"), "HARD RULE present")
  assert(prompt.includes("MUST NOT invoke any tool"), "Tool prohibition present")
  assert(prompt.length > "You are an AI assistant.".length, "Prompt length increased")
}

// ═════════════════════════════════════════════════════════════════════════
//  2. Idempotency — OpenCode rebuilds output.system fresh every step, so
//  "already injected" is tracked per session in memory, not via the MARKER
//  in the incoming system (dsh: context-gate)
// ═════════════════════════════════════════════════════════════════════════

async function test02_Idempotency() {
  section("02: Idempotency — inject once per session (dsh: context-gate)")
  const plugin = await loadPlugin()
  const hook = plugin["experimental.chat.system.transform"]
  setMode("on")

  const base = "You are an AI."

  // First step — inject
  const out1 = { system: [base] }
  await hook(
    { sessionID: "idem-1", model: makeModel({ providerID: "deepseek", modelID: "deepseek-v4-pro" }) },
    out1,
  )
  assert(out1.system[0].includes("[DEEPSEEK REASONING ANCHOR]"), "First step → anchor injected")

  // Second step — OpenCode passes a FRESH system (no marker present).
  // The plugin must recognize the session and stay a no-op.
  const out2 = { system: [base] }
  await hook(
    { sessionID: "idem-1", model: makeModel({ providerID: "deepseek", modelID: "deepseek-v4-pro" }) },
    out2,
  )
  assert(out2.system[0] === base, "Second step (fresh system) → content unchanged (idempotent)")
}

// ═════════════════════════════════════════════════════════════════════════
//  3. Model detection — DeepSeek V4 Pro only (3-layer identification)
// ═════════════════════════════════════════════════════════════════════════

async function test03_ModelDetection() {
  section("03: Model detection — DeepSeek V4 Pro only (providerID / modelID / api.id)")
  const plugin = await loadPlugin()
  const hook = plugin["experimental.chat.system.transform"]
  setMode("on")

  // DeepSeek V4 Pro — modelID
  let out = { system: ["base"] }
  await hook({ sessionID: "d1", model: makeModel({ providerID: "deepseek", modelID: "deepseek-v4-pro" }) }, out)
  assert(out.system[0].includes("[DEEPSEEK REASONING ANCHOR]"), "deepseek/deepseek-v4-pro → activated")

  // DeepSeek V4 Pro — modelID only (no providerID)
  out = { system: ["base"] }
  await hook({ sessionID: "d2", model: makeModel({ modelID: "deepseek-v4-pro" }) }, out)
  assert(out.system[0].includes("[DEEPSEEK REASONING ANCHOR]"), "modelID='deepseek-v4-pro' → activated")

  // DeepSeek V4 Pro — api.id
  out = { system: ["base"] }
  await hook({ sessionID: "d3", model: makeModel({ apiID: "ds/deepseek-v4-pro" }) }, out)
  assert(out.system[0].includes("[DEEPSEEK REASONING ANCHOR]"), "api.id='ds/deepseek-v4-pro' → activated")

  // Case-insensitive + separator variant
  out = { system: ["base"] }
  await hook({ sessionID: "d4", model: makeModel({ modelID: "DeepSeek_V4_Pro" }) }, out)
  assert(out.system[0].includes("[DEEPSEEK REASONING ANCHOR]"), "'DeepSeek_V4_Pro' → activated")

  // Other DeepSeek models — providerID alone is not sufficient
  out = { system: ["base"] }
  await hook({ sessionID: "d5", model: makeModel({ providerID: "deepseek" }) }, out)
  assert(!out.system[0].includes("[DEEPSEEK REASONING ANCHOR]"), "providerID='deepseek' alone → skipped")

  out = { system: ["base"] }
  await hook({ sessionID: "d6", model: makeModel({ providerID: "deepseek", modelID: "deepseek-v4-flash" }) }, out)
  assert(!out.system[0].includes("[DEEPSEEK REASONING ANCHOR]"), "deepseek/deepseek-v4-flash → skipped")

  out = { system: ["base"] }
  await hook({ sessionID: "d7", model: makeModel({ providerID: "deepseek", modelID: "deepseek-chat" }) }, out)
  assert(!out.system[0].includes("[DEEPSEEK REASONING ANCHOR]"), "deepseek/deepseek-chat → skipped")

  // Non-DeepSeek
  out = { system: ["base"] }
  await hook({ sessionID: "d8", model: makeModel({ providerID: "openai", modelID: "gpt-4o" }) }, out)
  assert(!out.system[0].includes("[DEEPSEEK REASONING ANCHOR]"), "openai/gpt-4o → skipped")

  // Empty model object
  out = { system: ["base"] }
  await hook({ sessionID: "d9", model: {} }, out)
  assert(!out.system[0].includes("[DEEPSEEK REASONING ANCHOR]"), "Empty model → skipped")

  // Undefined model
  out = { system: ["base"] }
  await hook({ sessionID: "d10", model: undefined }, out)
  assert(!out.system[0].includes("[DEEPSEEK REASONING ANCHOR]"), "Undefined model → skipped")
}

// ═════════════════════════════════════════════════════════════════════════
//  4. First-turn tool block (dsh: deliberation-gate deny)
// ═════════════════════════════════════════════════════════════════════════

async function test04_FirstTurnToolBlock() {
  section("04: First-turn tool block (dsh: deliberation-gate deny)")
  const plugin = await loadPlugin()
  const sysHook = plugin["experimental.chat.system.transform"]
  const toolHook = plugin["tool.execute.before"]
  setMode("on")

  // Inject anchor → add session to anchoredSessions
  const sysOut = { system: ["You are a helpful assistant."] }
  await sysHook(
    { sessionID: "block-1", model: makeModel({ providerID: "deepseek", modelID: "deepseek-v4-pro" }) },
    sysOut,
  )

  // Attempt tool call → should be blocked
  let blocked = false
  let errMsg = ""
  try {
    await toolHook({ sessionID: "block-1", tool: "bash" })
  } catch (e: any) {
    blocked = true
    errMsg = e?.message ?? String(e)
  }
  assert(blocked, "bash blocked")
  assert(errMsg.includes("HARD RULE violated"), "Error message includes 'HARD RULE violated'")

  // Verify multiple tools are all blocked
  for (const tool of ["str_replace_editor", "read_file", "write_file", "grep_search", "bash"]) {
    let tb = false
    try {
      await toolHook({ sessionID: "block-1", tool })
    } catch {
      tb = true
    }
    assert(tb, `Tool '${tool}' blocked`)
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  5. Second-turn tool restore (dsh: context-gate promotion)
// ═════════════════════════════════════════════════════════════════════════

async function test05_SecondTurnToolRestore() {
  section("05: Second-turn tool restore (dsh: promotion)")
  const plugin = await loadPlugin()
  const sysHook = plugin["experimental.chat.system.transform"]
  const toolHook = plugin["tool.execute.before"]
  setMode("on")

  // First turn — inject anchor (fresh system)
  const out1 = { system: ["You are a helpful assistant."] }
  await sysHook(
    { sessionID: "restore-1", model: makeModel({ providerID: "deepseek", modelID: "deepseek-v4-pro" }) },
    out1,
  )

  // Anchored generation: tool call is blocked
  let blocked = false
  try {
    await toolHook({ sessionID: "restore-1", tool: "bash" })
  } catch {
    blocked = true
  }
  assert(blocked, "Anchored generation → bash blocked")

  // Next generation step — OpenCode passes a FRESH system again; the plugin
  // recognizes the session and lifts the tool block without re-injecting.
  const out2 = { system: ["You are a helpful assistant."] }
  await sysHook(
    { sessionID: "restore-1", model: makeModel({ providerID: "deepseek", modelID: "deepseek-v4-pro" }) },
    out2,
  )
  assert(out2.system[0] === "You are a helpful assistant.", "No re-injection on later steps")

  // Tool should pass now
  let toolPasses = true
  try {
    await toolHook({ sessionID: "restore-1", tool: "bash" })
  } catch {
    toolPasses = false
  }
  assert(toolPasses, "Second-generation bash call passes")
}

// ═════════════════════════════════════════════════════════════════════════
//  6. Plugin disabled — no-op (dsh: context-gate enabled=false A/B test)
// ═════════════════════════════════════════════════════════════════════════

async function test06_DisabledNoop() {
  section("06: Plugin disabled — no-op (dsh: enabled=false A/B)")
  const plugin = await loadPlugin()
  const sysHook = plugin["experimental.chat.system.transform"]
  const toolHook = plugin["tool.execute.before"]
  setMode("off")

  const out = { system: ["You are a helpful assistant."] }
  await sysHook(
    { sessionID: "dis-1", model: makeModel({ providerID: "deepseek", modelID: "deepseek-v4-pro" }) },
    out,
  )
  assert(!out.system[0].includes("[DEEPSEEK REASONING ANCHOR]"), "Disabled → no injection")

  let tp = true
  try {
    await toolHook({ sessionID: "dis-1", tool: "bash" })
  } catch {
    tp = false
  }
  assert(tp, "Disabled → tools not blocked")

  setMode("on")
}

// ═════════════════════════════════════════════════════════════════════════
//  7. Multi system fragment injection
// ═════════════════════════════════════════════════════════════════════════

async function test07_MultiFragment() {
  section("07: Multi system fragment injection")
  const plugin = await loadPlugin()
  const hook = plugin["experimental.chat.system.transform"]
  setMode("on")

  const output = {
    system: ["Fragment A.", "Fragment B.", "Fragment C."],
  }
  await hook(
    { sessionID: "multi-1", model: makeModel({ providerID: "deepseek", modelID: "deepseek-v4-pro" }) },
    output,
  )
  for (let i = 0; i < 3; i++) {
    assert(output.system[i].includes("[DEEPSEEK REASONING ANCHOR]"), `fragment[${i}] contains MARKER`)
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  8. Config & command parsing
// ═════════════════════════════════════════════════════════════════════════

async function test08_ConfigAndCommand() {
  section("08: Config & command parsing")
  setMode("on")

  assert(parseModeArg("on") === "on", "parseModeArg('on') → 'on'")
  assert(parseModeArg("off") === "off", "parseModeArg('off') → 'off'")
  assert(parseModeArg("ON") === "on", "Case-insensitive")
  assert(parseModeArg("invalid") === null, "Invalid arg → null")
  assert(parseModeArg("") === null, "Empty string → null")

  setMode("off")
  assert(getMode() === "off" && !isEnabled(), "off → isEnabled=false")
  setMode("on")
  assert(getMode() === "on" && isEnabled(), "on → isEnabled=true")

  assert(COMMAND_NAME === "deepseek-anchor", "COMMAND_NAME correct")
}

// ═════════════════════════════════════════════════════════════════════════
//  9. Config hook — command registration
// ═════════════════════════════════════════════════════════════════════════

async function test09_CommandRegistration() {
  section("09: Command registration (v2 ctx.command.transform)")
  const plugin = await loadPlugin()
  const cmd = plugin.commands.find((c: any) => c.name === COMMAND_NAME)
  assert(!!cmd, "Command registered via editor.add")
  assert((cmd?.description ?? "").includes("DeepSeek"), "Description includes 'DeepSeek'")
  assert(typeof cmd?.execute === "function", "execute() present")
}

// ═════════════════════════════════════════════════════════════════════════
//  10. Config resolution — global `~/.config/opencode/ocp.json` only,
//      default off (deepseek-anchor is a user preference, no project scope)
// ═════════════════════════════════════════════════════════════════════════

async function test10_ConfigResolution() {
  section("10: Config resolution — global only (default off)")

  // Empty global config → default off
  resetGlobalConfig()
  assert(getMode() === "off", "empty global → off (default)")

  // Global "on" → on
  writeOcpField("deepSeekAnchor", "on")
  assert(getMode() === "on", `global "on" → on`)

  // Global "off" → off
  resetGlobalConfig()
  writeOcpField("deepSeekAnchor", "off")
  assert(getMode() === "off", `global "off" → off`)

  // Global boolean true → on
  resetGlobalConfig()
  writeOcpField("deepSeekAnchor", true)
  assert(getMode() === "on", "global boolean true → on")

  // Global boolean false → off
  resetGlobalConfig()
  writeOcpField("deepSeekAnchor", false)
  assert(getMode() === "off", "global boolean false → off")

  // Global unrecognized → default off
  resetGlobalConfig()
  writeOcpField("deepSeekAnchor", "maybe")
  assert(getMode() === "off", `global "maybe" → off (unrecognized → default)`)

  // setMode round-trip via global
  resetGlobalConfig()
  setMode("on")
  assert(getMode() === "on", "setMode('on') → on (round-trip via global)")

  resetGlobalConfig()
  setMode("off")
  assert(getMode() === "off", "setMode('off') → off (round-trip via global)")
}

// ═════════════════════════════════════════════════════════════════════════
//  11. Event hook — session.deleted cleanup + subagent filter via scopedForAgent()
// ═════════════════════════════════════════════════════════════════════════

async function test11_EventHook() {
  section("11: Event hook — session.deleted cleanup + subagent filter via scopedForAgent()")
  // scopedForAgent() (plugin-scope.json `*` deny "subagent:*") is the sole source
  // of subagent filtering — session.get returns parentID for subagent
  // detection. Primary sessions (parentID="") get the anchor; subagent
  // sessions (parentID set) do not.
  const parentMap: Record<string, string> = { s2: "p1" } // s2 is a subagent
  // V2 session view: scopedForCall/parentID detection uses session.get({sessionID}).
  const mockSession: any = {
    synthetic: async () => {},
    get: async ({ sessionID }: { sessionID: string }) => ({ parentID: parentMap[sessionID] ?? "" }),
  }
  const plugin = await loadPlugin(mockSession)
  const eventHook = plugin["event"]
  const sysHook = plugin["experimental.chat.system.transform"]
  const toolHook = plugin["tool.execute.before"]
  setMode("on")

  // session.created events no longer drive any plugin state (subagent
  // tracking was removed — scoped() handles it via session.get). Make sure
  // the event handler still doesn't throw.
  try {
    await eventHook({ event: { type: "session.created", properties: { info: { id: "s1" } } } })
    await eventHook({ event: { type: "session.created", properties: { info: { parentID: "p1", id: "s2" } } } })
    assert(true, "session.created events handled without state mutation")
  } catch {
    assert(false, "session.created should not throw")
  }

  // Subagent session must not be anchored nor tool-blocked (scoped() denies it)
  const out = { system: ["base"] }
  await sysHook({ sessionID: "s2", model: makeModel({ providerID: "deepseek", modelID: "deepseek-v4-pro" }) }, out)
  assert(!out.system[0].includes("[DEEPSEEK REASONING ANCHOR]"), "Subagent session → no injection")
  let toolPasses = true
  try {
    await toolHook({ sessionID: "s2", tool: "bash" })
  } catch {
    toolPasses = false
  }
  assert(toolPasses, "Subagent session → tools not blocked")

  // Primary session (no parentID) on the same model → anchor DOES inject
  const primaryOut = { system: ["base"] }
  await sysHook({ sessionID: "s3", model: makeModel({ providerID: "deepseek", modelID: "deepseek-v4-pro" }) }, primaryOut)
  assert(primaryOut.system[0].includes("[DEEPSEEK REASONING ANCHOR]"), "Primary session → anchor injected")

  // Non-target event — should skip
  try {
    await eventHook({ event: { type: "message.updated", properties: {} } })
    assert(true, "Non-target event skipped")
  } catch {
    assert(false, "Non-target event should not throw")
  }

  // session.deleted cleans up injectedSessions (anchor state)
  await eventHook({ event: { type: "session.deleted", properties: { info: { id: "s3" } } } })

  // After cleanup, a new target-model session with same ID → anchor re-injects
  const outAfter = { system: ["base"] }
  await sysHook({ sessionID: "s3", model: makeModel({ providerID: "deepseek", modelID: "deepseek-v4-pro" }) }, outAfter)
  assert(outAfter.system[0].includes("[DEEPSEEK REASONING ANCHOR]"), "After session.deleted cleanup → re-injects")
}

// ═════════════════════════════════════════════════════════════════════════
//  12. Structural invariants — deepseek-anchor is GLOBAL ONLY.
//      Round-2 simplification pivot: no project-level read or write, ever.
//      getMode()/setMode() route exclusively through OCP_CONFIG_PATH
//      (global). These three tests lock the structural pivot so a future
//      "add project override" patch can't silently regress it.
// ═════════════════════════════════════════════════════════════════════════

async function test12_StructuralInvariants() {
  section("12: Structural invariants — global-only (no project read/write)")

  // P1 — Negative: project-level key is ignored (read-path contract).
  // getMode() reads exclusively via ocpConfigPath() → OCP_CONFIG_PATH;
  // it never looks at <cwd>/.ocp/. A project file with deepSeekAnchor="on"
  // must NOT flip the mode when global is empty.
  const projectCfg = join(tmp, ".ocp", "ocp.json")
  mkdirSync(dirname(projectCfg), { recursive: true })
  writeFileSync(projectCfg, JSON.stringify({ deepSeekAnchor: "on" }))
  resetGlobalConfig()
  assert(getMode() === "off", "project-level key ignored — global empty wins")

  // P2 — Negative: setMode never writes <cwd>/.ocp/ (write-path contract).
  // setMode() routes through writeOcpField → OCP_CONFIG_PATH (globalCfg in
  // tmp), never to cwd. Snapshot the live <cwd>/.ocp/ocp.json (a real file
  // in this repo) instead of deleting it; the snapshot must be unchanged.
  const cwdProjectCfg = join(process.cwd(), ".ocp", "ocp.json")
  const beforeContent = existsSync(cwdProjectCfg)
    ? readFileSync(cwdProjectCfg, "utf8")
    : null
  resetGlobalConfig()
  setMode("on")
  const afterContent = existsSync(cwdProjectCfg)
    ? readFileSync(cwdProjectCfg, "utf8")
    : null
  assert(
    afterContent === beforeContent,
    "setMode never writes <cwd>/.ocp/ocp.json (snapshot unchanged)",
  )
  setMode("off") // leave global empty for downstream tests

  // P3 — setMode returns false on IO failure (boolean contract).
  // The command hook surfaces `!ok` to the user; writeOcpField must catch
  // the EPERM/EACCES and return false instead of throwing. Force IO
  // failure by pointing OCP_CONFIG_PATH at a chmod'd read-only file.
  const roFile = join(tmp, "ro-ocp.json")
  writeFileSync(roFile, "{}")
  try {
    chmodSync(roFile, 0o400)
  } catch {
    /* chmod not supported on this fs — see probe below */
  }
  const prevPath = process.env.OCP_CONFIG_PATH
  process.env.OCP_CONFIG_PATH = roFile
  try {
    // Confirm chmod took effect: a probe write must fail, otherwise the
    // assertion below is testing nothing.
    let chmodHonored = true
    try {
      writeFileSync(roFile, "probe")
      chmodHonored = false
    } catch {
      /* expected — chmod was honored */
    }
    const ok = setMode("on")
    assert(
      ok === false && chmodHonored,
      "setMode returns false on permission denied",
    )
  } finally {
    process.env.OCP_CONFIG_PATH = prevPath
    try {
      chmodSync(roFile, 0o600)
    } catch {
      /* nothing to clean up */
    }
  }
}

// ─── Main entry ───────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗")
  console.log("║  DeepSeek Anchor — Unit Tests (no API)                  ║")
  console.log("╚══════════════════════════════════════════════════════════╝")

  try {
    await test01_AnchorInjection()
    await test02_Idempotency()
    await test03_ModelDetection()
    await test04_FirstTurnToolBlock()
    await test05_SecondTurnToolRestore()
    await test06_DisabledNoop()
    await test07_MultiFragment()
    await test08_ConfigAndCommand()
    await test09_CommandRegistration()
    await test10_ConfigResolution()
    await test11_EventHook()
    await test12_StructuralInvariants()
  } finally {
    for (const c of pluginCleanups) { try { await c() } catch { /* teardown best-effort */ } }
    rmSync(tmp, { recursive: true, force: true })
    delete process.env.OCP_CONFIG_PATH
  }

  console.log(`\n${"═".repeat(60)}`)
  console.log(`  Result: ${passed} passed / ${failed} failed`)
  console.log(`${"═".repeat(60)}`)
  if (failed > 0) process.exit(1)
}

main()