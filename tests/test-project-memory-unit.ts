/**
 * Project Memory Plugin — Unit Tests (no API dependency)
 *
 * Coverage:
 *   - state resolution: project config `projectMemory` field > default off
 *   - draft capture: format, dir/header creation, append
 *   - fragment builder: within-cap full inject, over-cap pointer, authority line
 *   - system prompt transform hook: injects on 'on' + file, strips on 'off',
 *     missing-file no-op, byte-stable on same-object replay
 *   - command hook: /memory capture <text> writes draft; status reports gate
 *   - switch upsert via applySwitchesToConfigContent (on)
 *
 * Run: bun run tests/test-project-memory-unit.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  appendDraft,
  countEntries,
  draftPath,
  formatDraftEntry,
  getState,
  isEnabled,
  memoryBaseDir,
  memoryPath,
  normalizeState,
  projectKey,
  readMemory,
  setProjectDir,
} from "../plugins/project-memory/project-memory-config"
import {
  COMMAND_NAME,
  makeCommandHook,
  parseCaptureArgs,
  statusText,
} from "../plugins/project-memory/project-memory-command"
import {
  INJECT_CHAR_CAP,
  MARKER,
  buildFragment,
  makeSystemHook,
} from "../plugins/project-memory/project-memory-system-inject"
import { applySwitchesToConfigContent } from "../plugins/project-manager/project-manager-scaffold"

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

const fakeClient = {
  app: { log: async () => {} },
  session: { prompt: async () => {} },
} as any

const handled = () => {
  throw new Error("handled")
}
const runHandled = async (fn: () => Promise<unknown>) => {
  try {
    await fn()
    return false
  } catch (err) {
    return String((err as Error).message) === "handled"
  }
}

// ─── normalizeState ──────────────────────────────────────────────────

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
const tmp = mkdtempSync(join(tmpdir(), "project-memory-test-"))
// Sandbox the ocp user-level config root → memory files land under tmp,
// never in the real ~/.config/opencode. Pin language to en so English
// token assertions are deterministic (the real user config may say zh-CN).
process.env.OCP_CONFIG_PATH = join(tmp, "ocp.jsonc")
writeFileSync(join(tmp, "ocp.jsonc"), `{ "language": "en" }`)
setProjectDir(tmp)
mkdirSync(memoryBaseDir(), { recursive: true })

// projectKey: stable, path-hashed, readable basename.
const key1 = projectKey("D:\\OpenHub\\some-project")
assertEq(key1, projectKey("D:/OpenHub/some-project"), "projectKey stable across path spelling")
assert(key1.startsWith("some-project-"), "projectKey keeps readable basename")
assert(key1 !== projectKey("D:\\Other\\some-project"), "projectKey differs by full path")
assert(!projectKey("/tmp/we!rd name").includes("!"), "projectKey sanitizes basename")
// Bug guarded (P2 #9): on Windows, `C:\Foo` and `c:\foo` previously
// produced different keys despite sharing the same on-disk project —
// the readable basename came from the case-preserved path while the
// hash was case-insensitive. Same project, two memory dirs.
if (process.platform === "win32") {
  assertEq(projectKey("C:\\OpenHub\\Foo"), projectKey("c:\\openhub\\foo"), "Windows case-insensitive project key")
}

assertEq(getState(), "off", "default state is OFF")
assert(!isEnabled(), "isEnabled false by default")

writeFileSync(join(tmp, "opencode.jsonc"), `{
  // comment
  "projectMemory": "on",
}`)
assertEq(getState(), "on", "config field projectMemory honored (comments tolerated)")
assert(isEnabled(), "isEnabled when on")

writeFileSync(join(tmp, "opencode.jsonc"), `{ "projectMemory": false }`)
assertEq(getState(), "off", "boolean false honored")

// ─── Draft capture ───────────────────────────────────────────────────

console.log("\n== draft ==")
rmSync(draftPath(), { force: true })

assertEq(
  formatDraftEntry("use npm not pnpm", new Date("2026-09-11T10:00:00Z")),
  "- [2026-09-11] use npm not pnpm\n",
  "formatDraftEntry emits dated bullet",
)

const createdPath = appendDraft("bun test needs --preload for opentui")
assertEq(createdPath, draftPath(), "appendDraft returns draft path")
assert(existsSync(draftPath()), "draft file created")
assert(!readFileSync(draftPath(), "utf-8").includes("undefined"), "draft dir created (no error text)")
appendDraft("second lesson")
const draft = readFileSync(draftPath(), "utf-8")
assert(draft.startsWith("#"), "draft has header")
assertEq(countEntries(draft), 2, "two entries appended")
assert(draft.includes("- [") && draft.includes("second lesson"), "entry content present")

// Bug guarded (P1 #1 in the audit): two concurrent `/memory capture`
// invocations previously both passed the existsSync check and both
// appended the DRAFT_HEADER, leaving the file with a duplicated header.
// The fix uses writeFileSync `wx` (exclusive create) so only the first
// writer's combined (header + entry) write wins; losers fall through to
// appendFileSync against the now-existing file. Simulate the race by
// deleting + calling appendDraft twice in the same tick (the wx/EEXIST
// path is the actual unit under test).
rmSync(draftPath(), { force: true })
appendDraft("first")
appendDraft("second")
const raced = readFileSync(draftPath(), "utf-8")
const headerCount = (raced.match(/^# Project memory — drafts \(pending review\)$/gm) ?? []).length
assertEq(headerCount, 1, "concurrent appendDraft → single header, not duplicated")
assertEq(countEntries(raced), 2, "concurrent appendDraft → both entries landed")

// ─── readMemory ──────────────────────────────────────────────────────

console.log("\n== readMemory ==")
assertEq(readMemory(), null, "missing memory.md → null")
writeFileSync(memoryPath(), "   \n", "utf-8")
assertEq(readMemory(), null, "empty memory.md → null")
writeFileSync(memoryPath(), "- [2026-09-11] lesson A\n- [2026-09-11] lesson B\n", "utf-8")
assertEq(countEntries(readMemory() ?? ""), 2, "memory.md entry count (promoted entries keep dated-bullet form)")

// ─── Fragment builder ────────────────────────────────────────────────

console.log("\n== buildFragment ==")
const mpath = memoryPath()
const frag = buildFragment("- [2026-09-11] lesson A", mpath)
assert(frag.startsWith(`\n\n${MARKER}\n\n`), "fragment starts with blank-line + marker")
assert(frag.includes("- [2026-09-11] lesson A"), "fragment includes content")
assert(frag.includes("AGENTS.md is authoritative"), "fragment states authority order")
assert(frag.includes(mpath), "fragment names the absolute memory path")
const big = "x".repeat(INJECT_CHAR_CAP + 1)
const pointer = buildFragment(big, mpath)
assert(pointer.includes("over the") && pointer.includes("injection cap"), "over-cap → pointer mode")
assert(!pointer.includes(big), "over-cap → content NOT injected")

// ─── System hook injection & strip ───────────────────────────────────

console.log("\n== system hook ==")
writeFileSync(join(tmp, "opencode.jsonc"), `{ "projectMemory": "on" }`)
writeFileSync(memoryPath(), "- lesson A\n- lesson B\n", "utf-8")
const systemHook = makeSystemHook(fakeClient)

const st1 = { system: ["You are an assistant."] }
await systemHook({ sessionID: undefined }, st1)
assert(st1.system[0].includes(MARKER), "injects when ON + file exists")
assert(st1.system[0].includes("- lesson A"), "injected body includes content")

// Scenario B byte-stability: same-object replay → strip + re-inject identical.
const lenBefore = st1.system[0].length
await systemHook({ sessionID: undefined }, st1)
assertEq(st1.system[0].length, lenBefore, "same-object replay is byte-stable → provider cache hit")

// File missing → stale block stripped, prompt restored cleanly.
writeFileSync(memoryPath(), "", "utf-8")
await systemHook({ sessionID: undefined }, st1)
assert(!st1.system[0].includes(MARKER), "empty file strips stale block")
assertEq(st1.system[0], "You are an assistant.", "prompt restored cleanly after strip")

// Switch OFF → strips, no inject.
writeFileSync(join(tmp, "opencode.jsonc"), `{ "projectMemory": "off" }`)
writeFileSync(memoryPath(), "- lesson A\n", "utf-8")
const st2 = { system: ["Base." + buildFragment("- lesson A")] }
await systemHook({ sessionID: undefined }, st2)
assert(!st2.system[0].includes(MARKER), "OFF strips marker")
assertEq(st2.system[0], "Base.", "OFF restores clean prompt")

// OFF + clean → no-op.
await systemHook({ sessionID: undefined }, st2)
assertEq(st2.system[0], "Base.", "OFF + clean stays clean")

// ─── Command hook ────────────────────────────────────────────────────

console.log("\n== command ==")
assertEq(parseCaptureArgs('capture "use npm"').sub, "capture", "sub parsed")
assertEq(parseCaptureArgs('capture "use npm"').rest, '"use npm"', "rest keeps quotes for unquote")
assertEq(parseCaptureArgs(undefined).sub, "", "undefined args → empty sub (help)")

const cmdHook = makeCommandHook(fakeClient, handled)
assert(!(await runHandled(() => cmdHook({ command: "other", arguments: "x" }))), "non-/memory commands ignored")

let replied = ""
const promptClient = {
  app: { log: async () => {} },
  session: {
    prompt: async ({ body }: any) => {
      replied = body.parts[0].text
    },
  },
} as any
const cmdHook2 = makeCommandHook(promptClient, handled)
rmSync(draftPath(), { force: true })
await runHandled(() => cmdHook2({ command: COMMAND_NAME, arguments: 'capture "quoted lesson"', sessionID: "s1" }))
assert(replied.includes("Captured"), "capture confirms")
assert(readFileSync(draftPath(), "utf-8").includes("- [") && readFileSync(draftPath(), "utf-8").includes("quoted lesson"), "unquoted lesson landed in draft")
assert(!readFileSync(draftPath(), "utf-8").includes('"quoted'), "surrounding quotes stripped")

await runHandled(() => cmdHook2({ command: COMMAND_NAME, arguments: "capture", sessionID: "s1" }))
assert(replied.includes("Nothing to capture"), "empty capture → usage hint")

await runHandled(() => cmdHook2({ command: COMMAND_NAME, arguments: "status", sessionID: "s1" }))
assert(replied.includes("gate:"), "status reports gate")

writeFileSync(join(tmp, "opencode.jsonc"), `{ "projectMemory": "on" }`)
writeFileSync(memoryPath(), "- lesson A\n", "utf-8")
assert(statusText().includes("gate: on"), "statusText reflects config")
assert(statusText().includes("ACTIVE"), "statusText reports ACTIVE when on + file")
assert(statusText().includes("1 pending"), "statusText counts draft entries")

// zh-CN locale smoke: same tokens survive, prose translates.
writeFileSync(join(tmp, "ocp.jsonc"), `{ "language": "zh-CN" }`)
const zhStatus = statusText()
assert(zhStatus.includes("gate: on") && zhStatus.includes("ACTIVE"), "zh status keeps locale-invariant tokens")
assert(zhStatus.includes("待整理"), "zh status prose translated")
await runHandled(() => cmdHook2({ command: COMMAND_NAME, arguments: "capture zh lesson", sessionID: "s1" }))
assert(replied.includes("已捕获到"), "zh capture confirms in Chinese")
writeFileSync(join(tmp, "ocp.jsonc"), `{ "language": "en" }`)

// ─── Switch upsert in project config ─────────────────────────────────

console.log("\n== applySwitchesToConfigContent ==")
const base = '{\n  // "projectMemory": "off",      // on | off — inject\n}'
assert(applySwitchesToConfigContent(base, { projectMemory: "on" }).includes('\n  "projectMemory": "on",'), "on → active line")
const absent = applySwitchesToConfigContent("{}\n", { projectMemory: "on" })
assert(absent.includes('"projectMemory": "on"'), "absent key → appended before closing brace")

// ─── Summary ─────────────────────────────────────────────────────────

rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
