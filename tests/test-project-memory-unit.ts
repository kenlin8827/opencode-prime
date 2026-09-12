/**
 * Project Memory Plugin — Unit Tests (no API dependency)
 *
 * Coverage:
 *   - state resolution: project config `projectMemory` field > default on
 *   - lesson append: 2 scopes (public / private) with correct paths,
 *     headers, and private auto-gitignore on first capture
 *   - fragment builder: 2 sections, per-section over-cap independence
 *   - system prompt transform hook: injects when any file present, strips
 *     on 'off', byte-stable on replay
 *   - command hook: --public / --private flag parsing, status reports both
 *   - memory_note tool: 2-value scope enum, default public
 *
 * Run: bun run tests/test-project-memory-unit.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  appendLesson,
  countEntries,
  formatMemoryEntry,
  getState,
  isEnabled,
  memoryBaseDir,
  normalizeState,
  privatePath,
  publicPath,
  readPrivate,
  readPublic,
  setProjectDir,
} from "../plugins/project-memory/project-memory-config"
import {
  COMMAND_NAME,
  makeCommandHook,
  parseCaptureArgs,
  statusText,
  formatMtime,
  fileMtimeMs,
} from "../plugins/project-memory/project-memory-command"
import {
  INJECT_CHAR_CAP,
  MARKER,
  buildFragment,
  makeSystemHook,
} from "../plugins/project-memory/project-memory-system-inject"
import { TOOL_NAME, makeCaptureTool } from "../plugins/project-memory/project-memory-tool"
import { applySwitchesToConfigContent } from "../plugins/project-manager/project-manager-scaffold"
import {
  ensureOcpGitignore,
  migrateLegacyProjectArtifacts,
  setProjectDir as setSharedProjectDir,
} from "../plugins/shared/opencode-prime"

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

// session.get stub lets scopedForTool's parentID subagent detection run
// (returns no parentID → "not a subagent"); required by the tool gate.
const fakeClient = {
  app: { log: async () => {} },
  session: {
    prompt: async () => {},
    get: async () => ({ data: {} }),
  },
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
// Sandbox the ocp user-level config (drives i18n / language only here;
// memory files all live inside `<tmp>` since the plugin is project-scoped).
// ADR 0004 v2: runtime reads `ocp.json` only — the fixture uses that name.
process.env.OCP_CONFIG_PATH = join(tmp, "ocp.json")
writeFileSync(join(tmp, "ocp.json"), `{ "language": "en" }`)
setProjectDir(tmp)
setSharedProjectDir(tmp)
mkdirSync(memoryBaseDir(), { recursive: true })

assertEq(getState(), "on", "default state is ON (opt-out switch)")
assert(isEnabled(), "isEnabled true by default")

// Switch fixtures live at the runtime single source `.ocp/ocp.json`
// (ADR 0004 v2: root/`.opencode` config files are NOT read anymore).
const switchFile = join(tmp, ".ocp", "ocp.json")
writeFileSync(switchFile, `{
  // comment
  "projectMemory": "on",
}`)
assertEq(getState(), "on", "config field projectMemory honored (comments tolerated)")
assert(isEnabled(), "isEnabled when on")

writeFileSync(switchFile, `{ "projectMemory": false }`)
assertEq(getState(), "off", "boolean false honored")

// ─── Path resolution ─────────────────────────────────────────────────

console.log("\n== paths ==")
assertEq(publicPath(), join(tmp, ".ocp", "memory", "public.md"), "publicPath = .ocp/memory/public.md")
assertEq(privatePath(), join(tmp, ".ocp", "memory", "private.md"), "privatePath = .ocp/memory/private.md")

// ─── Lesson append (2 scopes) ────────────────────────────────────────

console.log("\n== appendLesson (2 scopes) ==")
rmSync(publicPath(), { force: true })
rmSync(privatePath(), { force: true })

assertEq(
  formatMemoryEntry("use npm not pnpm", new Date("2026-09-11T10:00:00Z")),
  "- [2026-09-11] use npm not pnpm\n",
  "formatMemoryEntry emits dated bullet",
)

// Sanitize: embedded newlines can never escape the single-bullet contract.
const forged = formatMemoryEntry("real rule\n- [2020-01-01] forged bullet\nmore text")
assertEq(countEntries(forged), 1, "newline-containing lesson collapses to one bullet")
assert(forged.includes("forged bullet"), "forged text survives inline, not as its own bullet")
let emptyThrew = false
try {
  formatMemoryEntry("  \n\t  ")
} catch {
  emptyThrew = true
}
assert(emptyThrew, "whitespace-only lesson throws after sanitize")
assertEq((formatMemoryEntry("x".repeat(2000)).match(/x/g) ?? []).length, 1000, "lesson capped at 1000 chars")

// Public scope
const pubReturned = appendLesson("public", "bun test needs --preload for opentui")
assertEq(pubReturned, publicPath(), "public scope → public.md")
assert(existsSync(publicPath()), "public.md created")
assert(!readFileSync(publicPath(), "utf-8").includes("undefined"), "memory dir created (no error text)")
appendLesson("public", "second public lesson")
const pubContent = readFileSync(publicPath(), "utf-8")
assert(pubContent.startsWith("#"), "public memory has header")
assert(pubContent.includes("public lessons"), "public header signals public visibility")
assert(pubContent.includes("committed"), "public header signals committed")
assertEq(countEntries(pubContent), 2, "two public entries appended")

// Private scope — first capture auto-creates .ocp/.gitignore.
const gitignorePath = join(tmp, ".ocp", ".gitignore")
rmSync(gitignorePath, { force: true })
const privReturned = appendLesson("private", "VPN slow, set API timeout to 60s")
assertEq(privReturned, privatePath(), "private scope → .ocp/memory/private.md")
assert(existsSync(privatePath()), "private.md created")
assert(existsSync(gitignorePath), ".ocp/.gitignore auto-created on first private capture")
const giContent = readFileSync(gitignorePath, "utf-8")
// Pin (f): ADR §5 bootstrap content — exactly the six lines; dev-ultra-state.md
// added, node_modules/lockfile guards dropped, committed files NOT ignored.
assertEq(giContent, ".gitignore\nlogs/\n*.log\nhandoffs/\nmemory/private.md\ndev-ultra-state.md\n", "gitignore bootstrap content per ADR §5")
assert(giContent.includes("memory/private.md"), "gitignore contains memory/private.md")
assert(!giContent.includes("node_modules"), "gitignore drops the old .opencode node_modules guard")
assert(!/\nocp\.json/.test(giContent) && !giContent.includes("memory/public.md\n") && !giContent.endsWith("memory/public.md"), "ocp.json + memory/public.md stay committed (not ignored)")

appendLesson("private", "prefers no semicolons")
const privContent = readFileSync(privatePath(), "utf-8")
assert(privContent.startsWith("#"), "private has header")
assert(privContent.includes("gitignored"), "private header signals gitignored")
assertEq(countEntries(privContent), 2, "two private entries appended")

// Regression: HEAL path — a pre-existing guard-less .ocp/.gitignore
// (user-maintained) must gain `memory/private.md` without clobbering the
// user's lines. The create path is pinned above; this pins the append branch.
writeFileSync(gitignorePath, "user-keep-me\nnotes/\n", "utf-8")
appendLesson("private", "heal path check")
const healed = readFileSync(gitignorePath, "utf-8")
assert(healed.includes("memory/private.md"), "heal: guard appended to existing gitignore (appendLesson)")
assert(healed.includes("user-keep-me"), "heal: user lines survive (appendLesson)")
// Same contract in the shared ensureOcpGitignore: guard missing while
// logs/handoffs present → only the guard line is appended, nothing duplicated.
writeFileSync(gitignorePath, "user-keep-me\nlogs/\nhandoffs/\n", "utf-8")
ensureOcpGitignore(tmp)
const healedShared = readFileSync(gitignorePath, "utf-8")
assert(healedShared.includes("memory/private.md"), "heal(shared): guard appended")
assert(healedShared.includes("dev-ultra-state.md"), "heal(shared): dev-ultra-state.md appended")
assert(healedShared.includes("user-keep-me") && (healedShared.match(/logs\//g) ?? []).length === 1, "heal(shared): user lines kept, logs block not duplicated")

// Concurrency guard (wx/EEXIST) on the public file.
rmSync(publicPath(), { force: true })
appendLesson("public", "first")
appendLesson("public", "second")
const raced = readFileSync(publicPath(), "utf-8")
const pubHeaderCount = (raced.match(/^# Project memory — public lessons \(committed\)$/gm) ?? []).length
assertEq(pubHeaderCount, 1, "concurrent appendLesson(public) → single header")
assertEq(countEntries(raced), 2, "concurrent appendLesson(public) → both entries landed")

// ─── readPublic / readPrivate ────────────────────────────────────────

console.log("\n== read* ==")
rmSync(publicPath(), { force: true })
rmSync(privatePath(), { force: true })
assertEq(readPublic(), null, "missing public.md → null")
assertEq(readPrivate(), null, "missing private.md → null")
writeFileSync(publicPath(), "   \n", "utf-8")
assertEq(readPublic(), null, "empty public.md → null")
writeFileSync(privatePath(), "- [2026-09-12] private A\n", "utf-8")
assertEq(countEntries(readPrivate() ?? ""), 1, "private.md entry count")

// ─── Fragment builder (2 sections) ───────────────────────────────────

console.log("\n== buildFragment (2 sections) ==")
const pubPathStr = publicPath()
const privPathStr = privatePath()

const pubOnly = buildFragment("- [2026-09-12] public L", pubPathStr, null, privPathStr)
assert(pubOnly.startsWith(`\n\n${MARKER}\n\n`), "public-only: starts with marker")
assert(pubOnly.includes("=== Public (") && pubOnly.includes("last edited"), "public-only: Public header carries staleness")
assert(!pubOnly.includes("=== Private"), "public-only: omits Private section")

const privOnly = buildFragment(null, pubPathStr, "- [2026-09-12] private L", privPathStr)
assert(privOnly.includes("=== Private (") && privOnly.includes("last edited"), "private-only: Private header carries staleness")
assert(!privOnly.includes("=== Public"), "private-only: omits Public section")

const both = buildFragment("- public L", pubPathStr, "- private L", privPathStr)
assert(both.includes("=== Public (") && both.includes("=== Private ("), "both: both sections present")
assert((both.match(/---/g) ?? []).length === 1, "both: 2 sections separated by exactly 1 `---`")
// Staleness line lives at the top of the fragment, right after the marker.
assert(both.includes("Project memory last updated:") || both.includes("(Project memory last updated:"), "both: staleness line at top")

assertEq(buildFragment(null, pubPathStr, null, privPathStr), "", "both null → empty (no-op)")

// Per-section over-cap independence.
const huge = "x".repeat(INJECT_CHAR_CAP + 1)
const pubOver = buildFragment(huge, pubPathStr, "- private L", privPathStr)
assert(pubOver.includes("over the") && pubOver.includes("injection cap"), "public over-cap → public pointer mode")
assert(!pubOver.includes("x".repeat(50)), "public over-cap → public content NOT injected")
assert(pubOver.includes("- private L"), "private section still injected when public is over-cap")

const privOver = buildFragment("- public L", pubPathStr, huge, privPathStr)
assert(privOver.includes("over the") && privOver.includes("- public L"), "private over-cap → pointer, public normal")

// ─── System hook injection & strip ───────────────────────────────────

console.log("\n== system hook ==")
writeFileSync(switchFile, `{ "projectMemory": "on" }`)
writeFileSync(publicPath(), "- public L\n", "utf-8")
rmSync(privatePath(), { force: true })
const systemHook = makeSystemHook(fakeClient)

const stPub = { system: ["Base."] }
await systemHook({ sessionID: undefined }, stPub)
assert(stPub.system[0].includes(MARKER), "public-only: injects")
assert(stPub.system[0].includes("=== Public ("), "public-only: Public header has staleness")
assert(!stPub.system[0].includes("=== Private"), "public-only: no Private section")

// Byte-stability: same-object replay → strip + re-inject identical.
const lenBefore = stPub.system[0].length
await systemHook({ sessionID: undefined }, stPub)
assertEq(stPub.system[0].length, lenBefore, "same-object replay is byte-stable")

// Private-only
writeFileSync(publicPath(), "", "utf-8")
writeFileSync(privatePath(), "- private L\n", "utf-8")
const stPriv = { system: ["Base."] }
await systemHook({ sessionID: undefined }, stPriv)
assert(stPriv.system[0].includes("=== Private ("), "private-only: Private header has staleness")
assert(!stPriv.system[0].includes("=== Public"), "private-only: omits Public section")

// Both present → both sections in one block + staleness line at top
writeFileSync(publicPath(), "- public L\n", "utf-8")
const stBoth = { system: ["Base."] }
await systemHook({ sessionID: undefined }, stBoth)
assert(stBoth.system[0].includes("=== Public (") && stBoth.system[0].includes("=== Private ("), "both present → both section headers")
assert(stBoth.system[0].includes("Project memory last updated:"), "both present → staleness line in fragment")

// Both missing → no inject (clean state stays clean)
rmSync(publicPath(), { force: true })
rmSync(privatePath(), { force: true })
const stClean = { system: ["You are an assistant."] }
await systemHook({ sessionID: undefined }, stClean)
assert(!stClean.system[0].includes(MARKER), "both missing → no inject")

// Switch OFF → strips stale block, no inject
writeFileSync(switchFile, `{ "projectMemory": "off" }`)
writeFileSync(publicPath(), "- lesson A\n", "utf-8")
const stOff = { system: ["Base." + buildFragment("- lesson A", publicPath(), null, privatePath())] }
await systemHook({ sessionID: undefined }, stOff)
assert(!stOff.system[0].includes(MARKER), "OFF strips marker")
assertEq(stOff.system[0], "Base.", "OFF restores clean prompt")

// OFF + clean → no-op
await systemHook({ sessionID: undefined }, stOff)
assertEq(stOff.system[0], "Base.", "OFF + clean stays clean")

// ─── Command hook ────────────────────────────────────────────────────

console.log("\n== command ==")

// parseCaptureArgs — flag parsing
assertEq(parseCaptureArgs('note "use npm"').sub, "note", "sub parsed")
assertEq(parseCaptureArgs('note "use npm"').rest, '"use npm"', "rest keeps quotes")
assertEq(parseCaptureArgs('note "use npm"').scope, "public", "default scope = public")
assertEq(parseCaptureArgs('note --private "x"').scope, "private", "--private → private")
assertEq(parseCaptureArgs('note --private "x"').rest, '"x"', "--private: rest stripped of flags")
assertEq(parseCaptureArgs('note --public "x"').scope, "public", "--public explicit")
assertEq(parseCaptureArgs(undefined).sub, "", "undefined args → empty sub")
assertEq(parseCaptureArgs(undefined).scope, "public", "undefined args → public default")
// Regression: only LEADING flags are parsed — a flag word inside the lesson
// body must survive, byte-intact, as content.
assertEq(parseCaptureArgs('note "rule about --private flags"').scope, "public", "mid-lesson --private is content, not a flag")
assertEq(
  parseCaptureArgs('note "rule about --private flags"').rest,
  '"rule about --private flags"',
  "mid-lesson --private survives inside rest",
)
assertEq(parseCaptureArgs('note --private "text"').scope, "private", "leading --private still sets scope")
assertEq(parseCaptureArgs('note --private "text"').rest, '"text"', "leading --private: body intact")
assertEq(parseCaptureArgs('note --PRIVATE "x"').scope, "private", "leading flag still case-insensitive")
// The peel loop claims "last one wins" — pin stacked leading flags.
assertEq(parseCaptureArgs('note --public --private "x"').scope, "private", "stacked leading flags — last wins")
assertEq(parseCaptureArgs('note --public --private "x"').rest, '"x"', "stacked leading flags — body intact")
assertEq(parseCaptureArgs("note --private").rest, "", "flag-only args → empty rest (Nothing to note)")
assertEq(
  parseCaptureArgs('note "a  b"').rest,
  '"a  b"',
  "whitespace inside the lesson body is not collapsed",
)

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

// Default → public
rmSync(publicPath(), { force: true })
rmSync(privatePath(), { force: true })
await runHandled(() => cmdHook2({ command: COMMAND_NAME, arguments: 'note "public rule"', sessionID: "s1" }))
assert(replied.includes("Noted"), "public note confirms")
assert(readFileSync(publicPath(), "utf-8").includes("public rule"), "public note writes to public.md")
assert(!existsSync(privatePath()), "public note does NOT touch private.md")

// --private → private
await runHandled(() => cmdHook2({ command: COMMAND_NAME, arguments: 'note --private "private note"', sessionID: "s1" }))
assert(replied.includes("Noted"), "private note confirms")
assert(readFileSync(privatePath(), "utf-8").includes("private note"), "private note writes to private.md")
assert(!readFileSync(privatePath(), "utf-8").includes('"private'), "surrounding quotes stripped")

// Empty note → usage hint
await runHandled(() => cmdHook2({ command: COMMAND_NAME, arguments: "note", sessionID: "s1" }))
assert(replied.includes("Nothing to note"), "empty note → usage hint")

// Status reports both scopes
await runHandled(() => cmdHook2({ command: COMMAND_NAME, arguments: "status", sessionID: "s1" }))
assert(replied.includes("gate:"), "status reports gate")
assert(replied.includes("public:") && replied.includes("private:"), "status reports both scopes")

// /memory show — preview what's injected
rmSync(publicPath(), { force: true })
rmSync(privatePath(), { force: true })
const showEmpty = (await runHandled(() => cmdHook2({ command: COMMAND_NAME, arguments: "show", sessionID: "s1" })))
  ? replied : ""
assert(showEmpty.includes("No memory captured yet"), "show with empty files → 'No memory captured yet'")
assert(showEmpty.includes("public.md") && showEmpty.includes("private.md"), "show empty mentions both file paths")

writeFileSync(publicPath(), "# Project memory — public lessons (committed)\n\n- [2026-09-12] rule A\n- [2026-09-12] rule B\n", "utf-8")
const showPublicOnly = (await runHandled(() => cmdHook2({ command: COMMAND_NAME, arguments: "show", sessionID: "s1" })))
  ? replied : ""
assert(showPublicOnly.includes("=== Public"), "show with public only → Public section header")
assert(showPublicOnly.includes("rule A") && showPublicOnly.includes("rule B"), "show lists public entries")
assert(showPublicOnly.includes("2 entries"), "show counts public entries")
assert(!showPublicOnly.includes("=== Private"), "show with public only omits Private section header")

writeFileSync(privatePath(), "# Project memory — private notes (gitignored)\n\n- [2026-09-12] note P\n", "utf-8")
const showBoth = (await runHandled(() => cmdHook2({ command: COMMAND_NAME, arguments: "show", sessionID: "s1" })))
  ? replied : ""
assert(showBoth.includes("=== Public") && showBoth.includes("=== Private"), "show with both → both section headers")
assert(showBoth.includes("rule A") && showBoth.includes("note P"), "show lists both scope contents")
assert(showBoth.includes("last edited"), "show includes last-edited timestamp")

// formatMtime + fileMtimeMs edge cases
assertEq(formatMtime(null), "?", "formatMtime(null) → '?'")
assertEq(fileMtimeMs(join(tmp, "does-not-exist")), null, "fileMtimeMs on missing path → null")

writeFileSync(switchFile, `{ "projectMemory": "on" }`)
rmSync(publicPath(), { force: true })
rmSync(privatePath(), { force: true })
assert(
  statusText().includes("both files are missing") || statusText().includes("memory/private"),
  "statusText names the next action when gate on but both files missing",
)
writeFileSync(publicPath(), "# Project memory — public lessons (committed)\n\n- [2026-09-12] public A\n", "utf-8")
const statusOut = statusText()
assert(statusOut.includes("gate: on"), "statusText reflects config")
assert(statusOut.includes("ACTIVE"), "statusText reports ACTIVE")
assert(statusOut.includes("1 entries") || statusOut.includes("1 条"), "statusText counts public entries")

// zh-CN locale smoke
writeFileSync(join(tmp, "ocp.json"), `{ "language": "zh-CN" }`)
const zhStatus = statusText()
assert(zhStatus.includes("gate: on") && zhStatus.includes("ACTIVE"), "zh status keeps locale-invariant tokens")
assert(zhStatus.includes("公开") && zhStatus.includes("私人"), "zh status prose shows public/private in Chinese")
await runHandled(() => cmdHook2({ command: COMMAND_NAME, arguments: 'note --private "中文笔记"', sessionID: "s1" }))
assert(replied.includes("已记入"), "zh private note confirms in Chinese")
writeFileSync(join(tmp, "ocp.json"), `{ "language": "en" }`)

// ─── Switch upsert in project config ─────────────────────────────────

console.log("\n== applySwitchesToConfigContent ==")
const base = '{\n  // "projectMemory": "off",      // on | off — inject\n}'
assert(applySwitchesToConfigContent(base, { projectMemory: "on" }).includes('\n  "projectMemory": "on",'), "on → active line")
const absent = applySwitchesToConfigContent("{}\n", { projectMemory: "on" })
assert(absent.includes('"projectMemory": "on"'), "absent key → appended before closing brace")

// ─── memory_note tool (2-scope) ───────────────────────────────────────

console.log("\n== memory_note tool ==")
const captureTool = makeCaptureTool(fakeClient)
rmSync(publicPath(), { force: true })
rmSync(privatePath(), { force: true })

assertEq(captureTool.description.length > 200, true, "tool description is substantive")
assert(/USE WHEN/.test(captureTool.description), "description has USE WHEN")
assert(/DO NOT USE FOR/.test(captureTool.description), "description has DO NOT USE FOR")
assert(/scope.*public.*private/is.test(captureTool.description), "description explains 2-scope heuristic (public before private)")
assert(/confidence/i.test(captureTool.description), "description explains confidence")
assert(/public\.md/.test(captureTool.description) && /private\.md/.test(captureTool.description), "description names both files")

const mockContext = { metadata: () => {} } as any

// Default scope = public
const r1 = await captureTool.execute({ lesson: "use bun not node", confidence: "high" }, mockContext)
assert(typeof r1 === "object" && r1.title.includes("public") && r1.title.includes("high"), "default scope=public, confidence=high")
assert(typeof r1 === "object" && r1.metadata.path === publicPath(), "default-scope metadata.path is public.md")
assert(typeof r1 === "object" && r1.metadata.scope === "public", "metadata.scope = public")
assert(typeof r1 === "object" && r1.metadata.confidenceRank === 3, "rank = 3 for high")
assert(readFileSync(publicPath(), "utf-8").includes("use bun not node"), "public entry persisted")

// Explicit private scope
const r2 = await captureTool.execute({ lesson: "VPN slow", scope: "private", confidence: "medium" }, mockContext)
assert(typeof r2 === "object" && r2.title.includes("private"), "explicit scope=private")
assert(typeof r2 === "object" && r2.metadata.path === privatePath(), "private metadata.path is private.md")
assert(typeof r2 === "object" && r2.metadata.scope === "private", "metadata.scope = private")
assert(typeof r2 === "object" && r2.metadata.confidenceRank === 2, "rank = 2 for medium")
assert(readFileSync(privatePath(), "utf-8").includes("VPN slow"), "private entry persisted")

// Low confidence still accepted (no hard floor)
const r3 = await captureTool.execute({ lesson: "hunch", scope: "public", confidence: "low" }, mockContext)
assert(typeof r3 === "object" && r3.title.includes("low"), "low confidence accepted")
assert(typeof r3 === "object" && r3.metadata.confidenceRank === 1, "rank = 1 for low")

assertEq(TOOL_NAME, "memory_note", "tool id is stable")

// ─── memory_note tool gate (plugin-scope) ───────────────────────────

// Utility agent (title generator) → denied
const ctxUtility = { agent: "title-generator", metadata: () => {}, sessionID: "utility-sess" } as any
rmSync(publicPath(), { force: true })
const rUtil = await captureTool.execute({ lesson: "should never be saved", scope: "public" }, ctxUtility)
assert(typeof rUtil === "object" && rUtil.title.includes("denied"), "utility agent → title contains 'denied'")
assert(typeof rUtil === "object" && rUtil.output.includes("not available"), "utility agent → output explains denial")
assert(typeof rUtil === "object" && rUtil.metadata.denied === true, "utility agent → metadata.denied = true")
assert(typeof rUtil === "object" && rUtil.metadata.agent === "title-generator", "utility agent → metadata.agent recorded")
assert(!existsSync(publicPath()), "utility agent → no file written (gate prevented append)")

// Title agent name variant → also denied (substring match)
const ctxTitle = { agent: "title", metadata: () => {}, sessionID: "title-sess" } as any
const rTitle = await captureTool.execute({ lesson: "x" }, ctxTitle)
assert(typeof rTitle === "object" && rTitle.title.includes("denied"), "'title' agent name also denied")

// Whitespace-only lesson → tool try/catch surfaces the sanitize throw
rmSync(publicPath(), { force: true })
const rEmpty = await captureTool.execute({ lesson: "  \n\t " }, mockContext)
assert(typeof rEmpty === "object" && rEmpty.title.includes("failed"), "whitespace-only lesson → capture fails")
assert(!existsSync(publicPath()), "whitespace-only lesson → no file written")

// Embedded-newline lesson via the tool → still exactly one bullet on disk
const rForge = await captureTool.execute({ lesson: "rule A\n- [2020-01-01] rule B" }, mockContext)
assert(typeof rForge === "object" && rForge.title.includes("public"), "newline lesson accepted by tool")
assertEq(countEntries(readFileSync(publicPath(), "utf-8")), 1, "newline lesson → single bullet persisted")

// Client threading: non-title agent with sessionID triggers scopedForTool's
// parentID lookup (session.get) — proves `client` reached the gate.
let getCalls = 0
const countingClient = { ...fakeClient, session: { ...fakeClient.session, get: async () => { getCalls++; return { data: {} } } } }
const countingTool = makeCaptureTool(countingClient)
const ctxPlain = { agent: "some-agent", metadata: () => {}, sessionID: "plain-sess" } as any
await countingTool.execute({ lesson: "client path ran" }, ctxPlain)
assert(getCalls > 0, "tool gate invoked client.session.get (parentID subagent detection active)")

// Lite agent → allowed (default behavior)
const ctxLite = { agent: "lite", metadata: () => {}, sessionID: "lite-sess" } as any
rmSync(publicPath(), { force: true })
const rLite = await captureTool.execute({ lesson: "lite allowed this" }, ctxLite)
assert(typeof rLite === "object" && rLite.title.includes("public"), "lite agent → allowed, title is success")
assert(readFileSync(publicPath(), "utf-8").includes("lite allowed this"), "lite agent → entry written")

// Primary agent (build / code / etc., non-title non-lite) → allowed
const ctxBuild = { agent: "build", metadata: () => {}, sessionID: "build-sess" } as any
rmSync(publicPath(), { force: true })
const rBuild = await captureTool.execute({ lesson: "primary build agent allowed" }, ctxBuild)
assert(typeof rBuild === "object" && rBuild.title.includes("public"), "build (primary) agent → allowed")
assert(readFileSync(publicPath(), "utf-8").includes("primary build agent allowed"), "primary agent → entry written")

// No agent field (fail-open) → allowed
rmSync(publicPath(), { force: true })
const rNoCtx = await captureTool.execute({ lesson: "no-ctx allowed" }, { metadata: () => {} } as any)
assert(typeof rNoCtx === "object" && rNoCtx.title.includes("public"), "no ctx.agent → fail-open allowed")

// ─── §3 migration: memory rename + merge-append (pin e) ──────────────

console.log("\n== migration memory move ==")
const mtmp = mkdtempSync(join(tmpdir(), "memory-mig-"))
setSharedProjectDir(mtmp)
mkdirSync(join(mtmp, ".opencode", "memory"), { recursive: true })
writeFileSync(join(mtmp, ".opencode", "memory", "public.md"), "# legacy\n\n- [2025-01-01] old\n", "utf-8")
const mig1 = migrateLegacyProjectArtifacts(mtmp)
assert(mig1.movedFiles.includes("memory/public.md"), "migration moves .opencode/memory/public.md")
assert(!existsSync(join(mtmp, ".opencode", "memory", "public.md")), "legacy source removed after rename")
assert(readFileSync(join(mtmp, ".ocp", "memory", "public.md"), "utf-8").includes("old"), "renamed content readable at new path")
// Target already exists → merge-append, source deleted, both lessons survive.
writeFileSync(join(mtmp, ".opencode", "memory", "public.md"), "- [2025-02-02] newer legacy\n", "utf-8")
const mig2 = migrateLegacyProjectArtifacts(mtmp)
assert(mig2.movedFiles.includes("memory/public.md"), "merge-append reported as moved")
const mergedPub = readFileSync(join(mtmp, ".ocp", "memory", "public.md"), "utf-8")
assert(mergedPub.includes("old") && mergedPub.includes("newer legacy"), "merge-append kept both lessons")
assert(!existsSync(join(mtmp, ".opencode", "memory", "public.md")), "source deleted after merge-append")
setSharedProjectDir(tmp)
rmSync(mtmp, { recursive: true, force: true })

// ─── Summary ─────────────────────────────────────────────────────────

rmSync(tmp, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)