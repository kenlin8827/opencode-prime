/**
 * E2E Guard Plugin — Unit Tests (no API dependency)
 *
 * Coverage:
 *   - state resolution: project config `e2eGuard` field > default off
 *   - command hook: /e2e-guard on|off|status, help message
 *   - protocol & instructions: protocol loads, includes feat/fix triggers,
 *     test gap & supplement detection, ask interaction requirements
 *   - system prompt transform hook: injects on 'on', strips on 'off',
 *     idempotent for prompt caching
 *
 * Run: bun run tests/test-e2e-guard-unit.ts   (or: npx tsx tests/test-e2e-guard-unit.ts)
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  normalizeState,
  getState,
  setProjectDir,
  isEnabled,
} from "../plugins/e2e-guard/e2e-guard-config"
import {
  COMMAND_NAME,
  makeCommandHook,
} from "../plugins/e2e-guard/e2e-guard-command"
import {
  getProtocol,
  getGuardPrompt,
  MARKER,
  MARKER_ON,
} from "../plugins/e2e-guard/e2e-guard-instructions"
import { isPrimaryAgent, makeSystemHook } from "../plugins/e2e-guard/e2e-guard-system-inject"

let passed = 0
let failed = 0

function assert(cond: unknown, label: string) {
  if (cond) {
    passed++
  } else {
    failed++
    console.error(`  ✗ FAIL: ${label}`)
  }
}

function assertEq(actual: unknown, expected: unknown, label: string) {
  assert(actual === expected, `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
}

// Fake plugin client — only app.log is used.
const fakeClient = { app: { log: async () => {} } } as any

// ─── State resolution ────────────────────────────────────────────────

console.log("\n== normalizeState ==")
assertEq(normalizeState("on"), "on", "'on'")
assertEq(normalizeState("enabled"), "on", "'enabled'")
assertEq(normalizeState("off"), "off", "'off'")
assertEq(normalizeState("false"), "off", "'false'")
assertEq(normalizeState(true), "on", "boolean true")
assertEq(normalizeState("bogus"), null, "unknown string → null")
assertEq(normalizeState(42), null, "non-string/boolean → null")

// ─── Project switch resolution ───────────────────────────────────────

console.log("\n== project switch ==")
const tmp = mkdtempSync(join(tmpdir(), "e2e-guard-test-"))
setProjectDir(tmp)

assertEq(getState(), "off", "default state is OFF")
assert(!isEnabled(), "isEnabled false by default")

// A hand-written JSONC config field is honored (comments tolerated on read).
rmSync(join(tmp, ".opencode"), { recursive: true, force: true })
writeFileSync(join(tmp, "opencode.jsonc"), `{
  // project config with JSONC comments
  "e2eGuard": "on",
}`)
assertEq(getState(), "on", "config field e2eGuard honored")
assert(isEnabled(), "isEnabled when on")

writeFileSync(join(tmp, "opencode.jsonc"), `{ "e2eGuard": true }`)
assertEq(getState(), "on", "boolean true config field honored")

// ─── Protocol & Instructions ─────────────────────────────────────────

console.log("\n== protocol & instructions ==")
const proto = getProtocol()
assert(proto.includes("feat") && proto.includes("fix"), "protocol specifies feat/fix triggers")
assert(proto.includes("Targeted E2E") && proto.includes("Full E2E"), "protocol differentiates targeted vs full")
assert(proto.includes("ask") || proto.includes("Interactive"), "protocol requires interactive ask")
assert(proto.includes("Test Gap") || proto.includes("Supplement"), "protocol includes test gap / case supplement check")

const prompt = getGuardPrompt()
assert(prompt.startsWith(`\n\n${MARKER_ON}`), "prompt starts with MARKER_ON")
assert(prompt.includes(proto), "prompt includes full protocol")

// ─── System Hook Injection & Strip ───────────────────────────────────

console.log("\n== primary agent filter & system hook ==")
assert(isPrimaryAgent({}), "empty input is primary")
assert(isPrimaryAgent({ agent: "code" }), "code is primary")
assert(isPrimaryAgent({ agent: "build" }), "build is primary")
assert(isPrimaryAgent({ agent: "architect" }), "architect is primary")
assert(!isPrimaryAgent({ agent: "explore" }), "explore is not primary")
assert(!isPrimaryAgent({ agent: "researcher" }), "researcher is not primary")
assert(!isPrimaryAgent({ agent: "code", parentID: "parent-123" }), "subagent with parentID is not primary")

const systemHook = makeSystemHook(fakeClient)

// 1. When switch is ON + primary agent: injects protocol
writeFileSync(join(tmp, "opencode.jsonc"), `{ "e2eGuard": "on" }`)
const sysState1 = { system: ["You are an assistant."] }
await systemHook({ agent: "code" }, sysState1)
assert(sysState1.system[0].includes(MARKER_ON), "system hook injects MARKER_ON when guard is ON and agent is primary")
assert(sysState1.system[0].includes("feat"), "system hook injects protocol body")

// 2. Subsequent call (Scenario A: prompt rebuilt each turn; Scenario B
// hypothetical: prompt persists — strip+re-inject produces identical
// content either way). Length-stable under B; grows by fragment size
// under A. Either way, the marker is present.
const lenBefore = sysState1.system[0].length
const sysState1b = { system: ["You are an assistant."] }
await systemHook({ agent: "code" }, sysState1b)
assert(sysState1b.system[0].includes(MARKER_ON), "subsequent call (fresh prompt) still injects — Scenario A: provider cache keeps system prompt warm because content is identical")
// Same-object replay (Scenario B hypothetical): strip + re-inject → identical length.
await systemHook({ agent: "code" }, sysState1)
assertEq(sysState1.system[0].length, lenBefore, "same-object replay (Scenario B): strip+re-inject is byte-stable → provider cache hit")

// 3. Subagent session: does NOT inject, strips if present
const subagentSys = { system: ["You are an assistant." + getGuardPrompt()] }
await systemHook({ agent: "explore", parentID: "p1" }, subagentSys)
assert(!subagentSys.system[0].includes(MARKER), "subagent session strips e2e guard marker")

// 4. When switch is flipped OFF: strips marker and protocol
writeFileSync(join(tmp, "opencode.jsonc"), `{ "e2eGuard": "off" }`)
await systemHook({ agent: "code" }, sysState1)
assert(!sysState1.system[0].includes(MARKER), "system hook strips marker and protocol when guard is OFF")
assert(sysState1.system[0] === "You are an assistant.", "prompt restored cleanly")

// 5. When switch is OFF and prompt is clean: no-op
await systemHook({ agent: "code" }, sysState1)
assert(sysState1.system[0] === "You are an assistant.", "prompt remains clean")

// ─── Command Hook ────────────────────────────────────────────────────

console.log("\n== e2e-guard command ==")
const cmdHook = makeCommandHook()
const runCmd = async (args: string | undefined) => {
  const output: { parts?: { type: string; text: string }[] } = {}
  await cmdHook({ command: COMMAND_NAME, arguments: args }, output as any)
  return output
}

// status command
let cOut = await runCmd("status")
assert(cOut.parts?.[0].text.includes("gate: off"), "status shows gate: off")

// on command
cOut = await runCmd("on")
assertEq(getState(), "on", "command 'on' sets state to on")
assert(cOut.parts?.[0].text.includes("Gate ON"), "command 'on' output confirms change")

// status command after on
cOut = await runCmd("status")
assert(cOut.parts?.[0].text.includes("gate: on"), "status shows gate: on")

// off command
cOut = await runCmd("off")
assertEq(getState(), "off", "command 'off' sets state to off")
assert(cOut.parts?.[0].text.includes("Gate OFF"), "command 'off' output confirms change")

// help on unknown subcommand
cOut = await runCmd("help")
assert(cOut.parts?.[0].text.includes("Usage"), "unknown subcommand shows usage")

// unrelated command
const otherOut: { parts?: unknown } = {}
await cmdHook({ command: "other", arguments: "" }, otherOut as any)
assert(otherOut.parts === undefined, "unrelated command hook call is a no-op")

// ─── Cleanup & summary ───────────────────────────────────────────────

rmSync(tmp, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
