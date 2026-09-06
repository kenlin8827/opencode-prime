/**
 * Usage TUI Plugin — Unit Tests (no host dependency)
 *
 * The plugin is a pure view over opencode server data: /usage queries the
 * conversation via api.client and formats token/cost economics. No local
 * collection or persistence.
 *
 * Coverage:
 *   - keymap registration (slash name)
 *   - default single-session view: tokens (in/out/reasoning), cost, steps,
 *     compactions via parts, cache hit rate, always-on model breakdown
 *   - /usage all tree view: root session, parentID climbing, children
 *     (subagents), per-session aggregation, totals line, share bars
 *   - /usage model → tree view with per-session model breakdown
 *   - subcommand parsing (name-token skipping, args sources)
 *   - empty tree / server failure → graceful toasts
 *
 * Run: bun run tests/test-usage-unit.ts
 */

import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeFileSync, rmSync } from "node:fs"

type SessionInfo = { id: string; parentID?: string; agent?: string }
type FakeMessage = { info: any; parts?: any[] }

// Isolate the shared ocp.jsonc user config for this run — set BEFORE the
// dynamic plugin import below (i18n now persists language there).
process.env.OCP_CONFIG_PATH = join(tmpdir(), `ocp-usage-test-${process.pid}.jsonc`)

const sessions: Record<string, SessionInfo> = {}
const messages: Record<string, FakeMessage[]> = {}
const children: Record<string, string[]> = {}

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

// ─── Mock TUI host ──────────────────────────────────────────────────────────

const toasts: any[] = []
const registeredCommands: any[] = []
const registeredBindings: any[] = []
const dialogRenders: Array<() => unknown> = []
const dialogSizes: string[] = []
const dialogCloseCallbacks: Array<() => void> = []

// Keypress listener tracking for global keyInput interceptor
const keypressListeners: Array<(e: any) => void> = []
const keypressEmitter = {
  on: (_event: string, handler: (e: any) => void) => { keypressListeners.push(handler) },
  off: (_event: string, handler: (e: any) => void) => {
    const idx = keypressListeners.indexOf(handler)
    if (idx >= 0) keypressListeners.splice(idx, 1)
  },
}
function fireKeypress(name: string) {
  let stopped = false
  for (const h of [...keypressListeners]) h({ name, stopPropagation: () => { stopped = true } })
  return stopped
}

let routeSessionID = "s1"

const fakeApi = {
  keymap: {
    registerLayer: (layer: any) => {
      registeredCommands.push(...(layer.commands || []))
      registeredBindings.push(...(layer.bindings || []))
    },
  },
  ui: {
    toast: (t: any) => {
      toasts.push(t)
    },
    dialog: {
      replace: (render: () => unknown, onClose?: () => void) => {
        dialogRenders.push(render)
        if (onClose) dialogCloseCallbacks.push(onClose)
      },
      clear: () => {},
      setSize: (s: string) => { dialogSizes.push(s) },
    },
  },
  kv: (() => {
    const store = new Map<string, unknown>()
    return {
      get: (k: string) => store.get(k),
      set: (k: string, v: unknown) => store.set(k, v),
    }
  })(),
  route: {
    get current() {
      return { name: "session", params: { sessionID: routeSessionID } }
    },
  },
  client: {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ data: sessions[sessionID] }),
      children: async ({ sessionID }: { sessionID: string }) => ({
        data: (children[sessionID] || []).map((id) => sessions[id]),
      }),
      messages: async ({ sessionID }: { sessionID: string }) => ({ data: messages[sessionID] || [] }),
    },
  },
  renderer: { keyInput: keypressEmitter, height: 30 },
} as any

// ─── Fixtures: mirror the reference screenshot ──────────────────────────────
// s1 = lite@main (4 steps), s2 = explore@sub (3 steps), c0 = child for climb test.
// Totals (incl. c0: 100 in / $0.0001): 22,853 in / 1,970 out / 27,008 cr / $0.0031 / 8 steps | hit 54.2%

const assistant = (over: Record<string, unknown>, steps = 1): FakeMessage => ({
  info: { role: "assistant", ...over },
  parts: Array.from({ length: steps }, () => ({ type: "step-finish" })),
})

// lite@main: 11,702 in / 984 out / 7,232 cr / $0.001 / 4 steps → hit 38.2%
sessions.s1 = { id: "s1", agent: "build" }
messages.s1 = [
  assistant({ mode: "lite", agent: "lite", providerID: "anthropic", modelID: "claude-pro", cost: 0.0006, tokens: { input: 5851, output: 492, reasoning: 0, cache: { read: 3616, write: 0 } } }, 2),
  assistant({ mode: "lite", agent: "lite", providerID: "anthropic", modelID: "claude-pro", cost: 0.0004, tokens: { input: 5851, output: 492, reasoning: 0, cache: { read: 3616, write: 0 } } }, 2),
]

// explore@sub: 11,051 in / 976 out / 19,776 cr / $0.002 / 3 steps → hit 64.2%
sessions.s2 = { id: "s2", parentID: "s1", agent: "task" }
messages.s2 = [
  assistant({ mode: "explore", agent: "explore", providerID: "google", modelID: "gemini", cost: 0.0015, tokens: { input: 6000, output: 500, reasoning: 10, cache: { read: 10000, write: 0 } } }, 2),
  assistant({ mode: "explore", agent: "explore", providerID: "google", modelID: "gemini-flash", cost: 0.0005, tokens: { input: 5051, output: 476, reasoning: 0, cache: { read: 9776, write: 0 } } }, 1),
]
// 2 compaction parts → exercise the compactions counter in the single view
messages.s2[0].parts.push({ type: "compaction" })
messages.s2[1].parts.push({ type: "compaction" })

// child session of s1 (exercises parentID climbing when it is the route target)
sessions.c0 = { id: "c0", parentID: "s1", agent: "code" }
messages.c0 = [assistant({ mode: "code", agent: "code", providerID: "anthropic", modelID: "claude-pro", cost: 0.0001, tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } }, 1)]

children.s1 = ["s2", "c0"]

const plugin = (await import("../plugins/tui/usage")).default

await plugin.tui!(fakeApi, undefined, {} as any)

// Force "en" after initI18n's env detection so string assertions are
// deterministic regardless of the host LANG/LC_ALL.
const { setLocale } = await import("../plugins/tui/i18n")
setLocale(fakeApi, "en")

const runUsage = (args?: string) => registeredCommands[0].run({ input: args } as any)
const lastToast = () => toasts[toasts.length - 1]
// openTable is fire-and-forget; let its promise chain settle before asserting.
const tick = () => new Promise((r) => setTimeout(r, 0))

// --- plugin shape checks ---
assertEq(plugin.id, "usage", "plugin id")
assert(typeof plugin.tui === "function", "tui entry exported")
assertEq(registeredCommands.length, 6, "usage.show + 3 dimensions + prev/next registered")
assertEq(registeredCommands[0].slashName, "usage", "slash name registered (bare, TUI prepends /)")

// --- /usage: shows the session view in a dialog ---
toasts.length = 0
dialogRenders.length = 0
dialogCloseCallbacks.length = 0
await runUsage("usage.show")
await tick()
assertEq(toasts.length, 0, "/usage with data shows no toast")
assertEq(dialogRenders.length, 1, "usage dialog opened")

// --- dimension commands are no-ops when dialog is closed (dialogOpen guard) ---
for (const cb of dialogCloseCallbacks) cb()
dialogCloseCallbacks.length = 0
const dimCmd = registeredCommands.find((c: any) => c.name === "usage.dim.agent")
const prevCmd = registeredCommands.find((c: any) => c.name === "usage.dim.prev")
dialogRenders.length = 0
dimCmd!.run()
await tick()
assertEq(dialogRenders.length, 0, "dimension command is no-op when dialog is closed")
prevCmd!.run()
await tick()
assertEq(dialogRenders.length, 0, "cycle command is no-op when dialog is closed")

// --- dimension commands work when dialog is open ---
await runUsage("usage.show")
await tick()
dialogRenders.length = 0
dimCmd!.run()
await tick()
assertEq(dialogRenders.length, 1, "dimension command works when dialog is open")
// close dialog for subsequent tests
for (const cb of dialogCloseCallbacks) cb()
dialogCloseCallbacks.length = 0

// --- keymap: bindings registered (guarded by dialogOpen) ---
// Bindings are empty: key interception is via global keypress handler,
// not keymap bindings. Verify no bindings registered.
assertEq(registeredBindings.length, 0, "no keymap bindings (intercepted via keyInput)")
// dimension commands registered for command palette / slash subcommands
for (const name of ["usage.dim.session", "usage.dim.agent", "usage.dim.model", "usage.dim.prev", "usage.dim.next"]) {
  assert(registeredCommands.some((c) => c.name === name), `command "${name}" registered`)
}

// --- keypress interception: dimension keys switch via stopPropagation ---
// Open dialog first — keypress handler is only active while dialog is open
await runUsage("usage.show")
await tick()
dialogRenders.length = 0
// "2" → agent dimension: should stopPropagation + open new dialog
const stopped2 = fireKeypress("2")
await tick()
assert(stopped2, "keypress '2' stopPropagation returned true")
assertEq(dialogRenders.length, 1, "keypress '2' triggered agent dimension switch")

// "3" → model dimension
fireKeypress("3")
await tick()
assertEq(dialogRenders.length, 2, "keypress '3' triggered model dimension switch")

// left → prev dimension (model→agent)
fireKeypress("left")
await tick()
assertEq(dialogRenders.length, 3, "keypress 'left' cycled to prev dimension")

// right → next dimension (agent→model)
fireKeypress("right")
await tick()
assertEq(dialogRenders.length, 4, "keypress 'right' cycled to next dimension")

// Unhandled key: Enter should NOT be stopped
const stoppedEnter = fireKeypress("return")
assert(!stoppedEnter, "Enter key not stopped (dialog handles it for close)")
// Scroll keys pass through when the table fits (no overflow → no interception).
// Switch back to the session dim first: the model dim's id-mapping footer
// makes even 3 rows overflow a 30-row terminal.
fireKeypress("1")
await tick()
const stoppedUp = fireKeypress("up")
assert(!stoppedUp, "'up' not stopped when the table fits the terminal")

// Close dialog → keypress handler removed
for (const cb of dialogCloseCallbacks) cb()
dialogCloseCallbacks.length = 0
assertEq(keypressListeners.length, 0, "keypress handler removed after dialog close")

// After close, keypresses are NOT intercepted
dialogRenders.length = 0
const stoppedAfterClose = fireKeypress("2")
assert(!stoppedAfterClose, "keypress not intercepted after dialog close")
await tick()
assertEq(dialogRenders.length, 0, "no dialog opened from keypress after close")

// --- generation counter: stale onClose doesn't break keypress handler ---
await runUsage("usage.show")
await tick()
const staleListeners = [...keypressListeners]
const staleCbs = [...dialogCloseCallbacks]
keypressListeners.length = 0
dialogCloseCallbacks.length = 0
// fireKeypress iterates keypressListeners which we just cleared.
// The handler was saved in staleListeners, so call it directly.
staleListeners[0]({ name: "3", stopPropagation: () => {} })
// Now the handler's openDimension("model") has started its async chain.
// Wait for it to complete and install the new handler.
await new Promise((r) => setTimeout(r, 100))
assertEq(keypressListeners.length, 1, "new keypress handler after dimension switch")
// Fire stale onClose from old dialog — should be a no-op
for (const cb of staleCbs) cb()
assertEq(keypressListeners.length, 1, "stale onClose didn't remove new handler (generation guard)")
// New handler still works
fireKeypress("2")
await tick()
assertEq(dialogRenders.length >= 1, true, "dimension switch still works after stale onClose")
// Cleanup
for (const cb of dialogCloseCallbacks) cb()
dialogCloseCallbacks.length = 0

// --- numbered tab strip + composed view (official TabSelect style underline) ---
const { formatByDimension, renderDimensionView, fitDialogSize } = await import("../plugins/tui/usage")
const sessionRender = await formatByDimension(fakeApi.client, "s1", "session")
const view = renderDimensionView(sessionRender, "agent")
const viewLines = view.split("\n")
assertEq(viewLines[0], "(1)By session   (2)By agent   (3)By model", "tab strip labels carry hotkey numbers (no space after number)")
// "(2)By agent" sits at offset width("(1)By session") + 3; the bar covers exactly its width
assertEq(viewLines[1], " ".repeat(16) + "▬".repeat(11), "underline bar under the active tab")
assertEq(viewLines[2], "", "blank line between strip and table")
assert(!view.includes("1/2/3 or"), "hint line removed (numbers are self-documenting)")

// --- OCP points fallback: cost 0 + plan provider → credits column (积分) ---
// Point the loader at an isolated fixture file so tests don't touch real config.
const pointsPath = join(tmpdir(), `ocp-points-test-${process.pid}.jsonc`)
writeFileSync(pointsPath, `{
  "providers": {
    "zhipuai-coding-plan": {
      "credits": true,
      "divisor": 10000,
      "rates": { "glm-5.3-flash": { "input": 2.3, "cached": 0.56, "output": 8 } }
    }
  }
}`)
process.env.OCP_POINTS_PATH = pointsPath
// Force the points loader to re-read under the new OCP_POINTS_PATH.
const { resetCostsCache } = await import("../plugins/tui/usage")
resetCostsCache()

sessions.z1 = { id: "z1", agent: "build" }
// 10000×2.3 + 20000×0.56 + 5000×8 / 10000 = (23000 + 11200 + 40000) / 10000 = 7.42 积分
messages.z1 = [assistant({ mode: "build", agent: "build", providerID: "zhipuai-coding-plan", modelID: "glm-5.3-flash", cost: 0, tokens: { input: 10000, output: 5000, cache: { read: 20000, write: 0 } } }, 1)]
const ptsText = (await formatByDimension(fakeApi.client, "z1", "session")).table
assert(ptsText.includes("credits") && ptsText.includes("7.42"), "credits column present for plan sessions")
  assert(ptsText.includes("7.42"), `points computed via OCP dataset (got: ${ptsText.split("\n").join(" | ")})`)
  // On coding plans the server-side cost is $0, but credits are the actual
  // billing mechanism so costKnown should be true and no simulated-price icon appears.
  assert(!ptsText.includes("🏷️"), "coding-plan sessions don't get a simulated-price icon (credits are the real bill)")
delete sessions.z1
delete messages.z1
rmSync(pointsPath, { force: true })
delete process.env.OCP_POINTS_PATH
resetCostsCache()

// --- non-plan provider with cost 0 → models.dev simulated price + pricing link ---
const modelsDevPath = join(tmpdir(), `ocp-modelsdev-test-${process.pid}.json`)
writeFileSync(modelsDevPath, JSON.stringify({
  ts: Date.now(),
  prices: { "anthropic/claude-pro": { input: 3, cached: 0.3, output: 15 } },
  pageIds: { "claude-pro": "anthropic/claude-pro" },
}))
process.env.OCP_MODELSDEV_PATH = modelsDevPath
resetCostsCache()
sessions.z2 = { id: "z2", agent: "build" }
messages.z2 = [assistant({ mode: "build", agent: "build", providerID: "anthropic", modelID: "claude-pro", cost: 0, tokens: { input: 1000, output: 100, cache: { read: 10000, write: 0 } } }, 1)]
const nonPlanText = (await formatByDimension(fakeApi.client, "z2", "session")).table
assert(nonPlanText.includes("🏷️ $0.0075") && !nonPlanText.includes("积分"), "non-plan cost 0 shows models.dev simulated estimate prefixed with price-tag icon")
assert(nonPlanText.includes("https://models.dev/models/anthropic/claude-pro"), "simulated pricing footer links to models.dev model page")
delete sessions.z2
delete messages.z2
rmSync(modelsDevPath, { force: true })
delete process.env.OCP_MODELSDEV_PATH
resetCostsCache()

// --- auto-fit dialog width ---
assertEq(fitDialogSize("a".repeat(10)), "medium", "narrow content → medium")
assertEq(fitDialogSize("a".repeat(70)), "large", "medium-wide content → large")
assertEq(fitDialogSize("a".repeat(100)), "xlarge", "wide content → xlarge")

// --- dimension tables via formatByDimension (host renders the dialog) ---

// session dimension: one row per session + total row
const sessionText = (await formatByDimension(fakeApi.client, "s1", "session")).table
for (const header of ["session", "in", "out", "cached", "steps", "cost", "share"]) {
  assert(sessionText.includes(header), `session table has "${header}" column`)
}
assert(sessionText.includes("🧠 lite"), "main session row (emoji icon)")
assert(sessionText.includes("🦾 explore"), "subagent session row (emoji icon)")
assert(!sessionText.includes("@"), "no @ concatenation in session names")
assert(!sessionText.includes("main agent") && !sessionText.includes("主 agent"), "legend line removed")
assert(sessionText.includes("11,702") && sessionText.includes("100"), "per-session in values")
  assert(sessionText.includes("22,853") && sessionText.includes("1,970") && sessionText.includes("27,008"), "total row sums")
assert(sessionText.includes("$0.0031"), "total row cost")
assert(sessionText.includes("hit 54.2%") && sessionText.includes("total"), "total row with hit rate")
assert(sessionText.includes("51.2%"), "s1 share pct")
assert(sessionText.includes("\u2588"), "bar characters present")
assert(!sessionText.includes("cache-write") && !sessionText.includes("reasoning"), "display limited to 3 numbers: in / out / cached")

// agent dimension: sessions grouped by agent attribution
const agentText = (await formatByDimension(fakeApi.client, "s1", "agent")).table
for (const header of ["agent", "sess", "in", "out", "cached", "cost", "share"]) {
  assert(agentText.includes(header), `agent table has "${header}" column`)
}
assert(agentText.includes("lite") && agentText.includes("explore"), "agent rows present")
assert(agentText.includes("11,702"), "per-agent input sums")
  assert(agentText.includes("19,776"), "explore cached-in sum")
assert(!agentText.includes("build") || agentText.indexOf("explore") < agentText.indexOf("build"), "fixture agent 'build' never used by messages")

// model dimension: tokens/cost summed across the whole tree (same columns as sessions)
const modelText = (await formatByDimension(fakeApi.client, "s1", "model")).table
for (const header of ["model", "sess", "in", "out", "cached", "cost", "share"]) {
  assert(modelText.includes(header), `model table has "${header}" column`)
}
assert(modelText.includes("anthropic/claude-pro"), "model row: claude-pro")
assert(modelText.includes("🆔 ") && modelText.includes("\n• claude-pro ← anthropic/claude-pro"), "full model-id label has model icon")
assert(modelText.includes("11,802"), "claude-pro input summed across s1+c0 (11702+100)")
assert(modelText.includes("994") && modelText.includes("7,232"), "claude-pro output/cache summed (984+10, 7232+0)")
assert(modelText.includes("google/gemini-flash"), "model row: gemini-flash")

// --- scrollable viewport: short terminals slice data rows, pin header + total ---
const { renderScrollView } = await import("../plugins/tui/usage")
// Pre-growth snapshot (few data rows): a table within MAX_VISIBLE_ROWS rows
// fits any terminal without scrolling — used by the no-overflow assertions.
const smallRender = await formatByDimension(fakeApi.client, "s1", "session")
const smallFlat = renderDimensionView(smallRender, "session")
// Grow the tree to 12 sessions so the session table overflows a 30-row
// terminal. x0 carries 14 steps → totalSteps crosses the soft tier (30),
// so the context warning is part of the pinned top region too.
for (let i = 0; i < 9; i++) {
  const id = `x${i}`
  sessions[id] = { id, parentID: "s1", agent: "task" }
  messages[id] = [assistant({ mode: "explore", agent: "explore", providerID: "google", modelID: "gemini", cost: 0.0001, tokens: { input: 100 + i, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } }, i === 0 ? 14 : 1)]
  children.s1.push(id)
}
const bigRender = await formatByDimension(fakeApi.client, "s1", "session")
const bigFlat = renderDimensionView(bigRender, "session")
assertEq(bigRender.view.dataRows.length, 12, "grown tree has 12 data rows")
assert(bigFlat.includes("turns"), "context warning present in the flat view")

// Short terminal (30 rows → 15 message lines): overflow, pinned chrome, indicator
const svTop = renderScrollView(bigRender, "session", 30, 0)
assert(svTop.maxOffset > 0, "overflow detected on a short terminal")
assertEq(svTop.offset, 0, "offset 0 at the top")
assertEq(svTop.view.split("\n").slice(0, 8).join("\n"), bigFlat.split("\n").slice(0, 8).join("\n"), "tab strip + warning + column header pinned at top")
assert(svTop.view.includes("11,702"), "first data row visible at offset 0")
assert(!svTop.view.includes("108"), "last data row not visible at offset 0")
assert(svTop.view.includes(bigRender.view.totalRow), "total row pinned (always visible)")
assert(svTop.view.includes("↑/↓") && svTop.view.includes("of 12"), "scroll indicator present with row count")
assert(svTop.view.split("\n").length < bigFlat.split("\n").length, "sliced view shorter than the flat view")

// Scroll to the bottom: clamped, last row visible, line count stable
const svEnd = renderScrollView(bigRender, "session", 30, 9999)
assertEq(svEnd.offset, svEnd.maxOffset, "offset clamped to maxOffset")
assert(svEnd.view.includes("108"), "last data row visible at the bottom")
assert(!svEnd.view.includes("11,702"), "first data row scrolled out at the bottom")
assertEq(svEnd.view.split("\n").length, svTop.view.split("\n").length, "line count stable while scrolling")

// Mid-offset window
const svMid = renderScrollView(bigRender, "session", 30, 3)
assertEq(svMid.offset, 3, "explicit mid offset honored")
assert(svMid.view.includes("101"), "row 5 visible at offset 3")
assert(!svMid.view.includes("11,702"), "row 1 scrolled out at offset 3")

// Tall terminal: viewport capped at MAX_VISIBLE_ROWS (8) rows regardless of
// terminal height — 12 data rows → 8 visible, 4-row scroll range.
const svTall = renderScrollView(bigRender, "session", 100, 5)
assertEq(svTall.maxOffset, 4, "tall terminal → viewport capped at 8 rows (12 − 8)")
assertEq(svTall.offset, 4, "offset clamped to maxOffset")
assert(svTall.view.includes("108"), "last data row visible at the capped bottom")
assert(!svTall.view.includes("11,702"), "first data row outside the 8-row window")
assert(svTall.view.includes("↑/↓"), "scroll indicator present when capped")
// Table within 8 rows → fits, byte-identical to the flat render, no indicator
const svFit = renderScrollView(smallRender, "session", 100, 5)
assertEq(svFit.maxOffset, 0, "table that fits → no scrolling")
assertEq(svFit.offset, 0, "offset forced to 0 when nothing overflows")
assertEq(svFit.view, smallFlat, "no-overflow view identical to the flat render")
assert(!svFit.view.includes("↑/↓"), "no scroll indicator when the table fits")

// --- plugin-level: scroll keys intercepted while the dialog overflows ---
toasts.length = 0
dialogRenders.length = 0
await runUsage("usage.show")
await tick()
assertEq(dialogRenders.length, 1, "dialog opened for the grown tree")
const rendersBefore = dialogRenders.length
assert(fireKeypress("down"), "'down' stopPropagation when the table overflows")
await tick()
assertEq(dialogRenders.length, rendersBefore + 1, "'down' re-rendered the dialog from cache")
assert(fireKeypress("j"), "'j' scroll alias intercepted")
assert(fireKeypress("k"), "'k' scroll alias intercepted")
// Clamping: hammering 'down' past the end stops re-rendering
for (let i = 0; i < 100; i++) fireKeypress("down")
assert(dialogRenders.length < rendersBefore + 100, "scroll re-renders stop at the clamp boundary")
assert(!fireKeypress("return"), "Enter not stopped while scrolling")
// Tab switch to a dimension that fits → scroll keys pass through again
fireKeypress("2")
await tick()
assert(!fireKeypress("down"), "'down' passes through after switching to a table that fits")
for (const cb of dialogCloseCallbacks) cb()
dialogCloseCallbacks.length = 0
assertEq(keypressListeners.length, 0, "keypress handler removed after close")

// --- /usage all|agent|model → opens the corresponding table dialog ---
toasts.length = 0
dialogRenders.length = 0
await runUsage("usage.show all")
await tick()
assertEq(toasts.length, 0, "/usage all shows no toast")
assertEq(dialogRenders.length, 1, "session table dialog opened")

// --- parentID climbing: route on a child session still shows the whole tree ---
routeSessionID = "c0"
const climbText = (await formatByDimension(fakeApi.client, "c0", "session")).table
assert(climbText.includes("🦾 lite") && climbText.includes("🦾 explore") && climbText.includes("🧠 code"), "route on child walks up to root and includes whole tree")
assert(climbText.includes("🧠 code"), "current session (even if child) gets the main icon")
routeSessionID = "s1"

// --- no data anywhere → graceful message ---
const keep = { ...messages }
for (const k of Object.keys(messages)) delete messages[k]
toasts.length = 0
await runUsage("usage.show all")
await tick()
assertEq(toasts.length, 1, "one toast when session has no data")
assert(toasts[0].message.includes("No token data"), "empty session shows no-data message")
Object.assign(messages, keep)

// --- server failure on root lookup → graceful message, not a crash ---
// (session.get is only on the tree path, so exercise /usage all)
const realGet = fakeApi.client.session.get
fakeApi.client.session.get = async () => {
  throw new Error("boom")
}
toasts.length = 0
await runUsage("usage.show all")
await tick()
assertEq(toasts.length, 1, "one toast on server error")
assert(toasts[0].message.includes("No token data") || toasts[0].message.includes("Failed"), "server error degrades gracefully")
fakeApi.client.session.get = realGet

// --- unknown subcommand → usage hint ---
toasts.length = 0
await runUsage("usage.show bogus")
assertEq(toasts.length, 1, "one toast for unknown subcommand")
assert(toasts[0].message.includes("Unknown subcommand"), "unknown subcommand shows error")
assert(toasts[0].message.includes("Usage:"), "unknown subcommand shows usage hint")

// --- parseSubcommand unit coverage ---
const { parseSubcommand } = await import("../plugins/tui/usage")
assertEq(parseSubcommand({ input: "usage.show" } as any), null, "bare command name → no subcommand")
assertEq(parseSubcommand({ input: "usage.show model" } as any), "model", "trailing arg extracted")
assertEq(parseSubcommand({ data: { args: ["agent"] } } as any), "agent", "data.args wins")
assertEq(parseSubcommand(null), null, "null ctx → null")

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
