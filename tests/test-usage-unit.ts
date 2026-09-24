/**
 * Usage plugin — unit tests (v2 TUI plugin API).
 *
 * Covers:
 *   - plugin shape: setup(ctx) registers the slash/palette command + the
 *     modal dialog keymap layer (dimension/scroll/close commands)
 *   - the aggregation core (formatByDimension over a UsageSource fake):
 *     token totals, steps (assistant-message proxy), credits, models.dev
 *     simulated pricing, per-dimension tables
 *   - view composition (renderDimensionView / renderScrollView / fitDialogSize)
 *   - dialog lifecycle through a fake ctx (show once, repaint on tab
 *     switch instead of reopen, close via Enter/clear)
 *
 * v1's keypress-interceptor and dialog.replace re-render-count assertions
 * are replaced: the v2 dialog repaints reactively (no reopen per key), so
 * the observable surface is dialog.show / dialog.set calls and toasts.
 *
 * Run: bun tests/test-usage-unit.ts
 */
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeFileSync, rmSync } from "node:fs"

// Isolate the shared ocp.json user config for this run — set BEFORE the
// dynamic plugin import below (i18n now persists language there).
process.env.OCP_CONFIG_PATH = join(tmpdir(), `ocp-usage-test-${process.pid}.json`)

type UsageSessionRow = { id: string; parentID?: string; agent?: string }
type UsageMessageRow =
  | { type: "assistant"; agent?: string; providerID?: string; modelID?: string; cost?: number; tokens?: Record<string, never> | { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } }
  | { type: "compaction" }
  | { type: "other" }

const sessions: Record<string, UsageSessionRow> = {}
const messages: Record<string, UsageMessageRow[]> = {}
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

// ─── Fake v2 plugin context ──────────────────────────────────────────────

const toasts: Array<{ message: string; variant?: string; title?: string }> = []
const dialogShows: number[] = [] // one entry per ctx.ui.dialog.show
const dialogSizes: string[] = []
const dialogEvents: string[] = [] // ordered "show" / "set:<tier>" log
/** Host size slot. show() → replace() RESETS it to medium (opencode
 *  dialog.tsx), so only a set() landing after show() survives. */
let hostSize = "medium"
let closeCallbacks: Array<() => void> = []
let routeSessionID = "s1"

type Layer = { mode?: string; enabled?: () => boolean; commands?: Array<{ id?: string; bind?: string; run: (input?: string) => unknown }> }
const layers: Layer[] = []

const fakeCtx = {
  keymap: {
    layer: (input: () => Layer) => {
      layers.push(input())
    },
  },
  ui: {
    // Keymap layers register from a slot render (plugins/tui/_keymap-app.ts,
    // append:"app") — mimic the host by invoking the contribution once.
    slot: (claim: { render: (input: unknown) => unknown }) => { claim.render({}); return () => {} },
    toast: { show: (t: { message: string; variant?: string }) => toasts.push(t) },
    dialog: {
      set: (o: { size?: string }) => {
        if (!o.size) return
        dialogSizes.push(o.size)
        hostSize = o.size
        dialogEvents.push(`set:${o.size}`)
      },
      show: (render: () => unknown, onClose?: () => void) => {
        dialogShows.push(dialogShows.length)
        hostSize = "medium" // host replace() drops any size set beforehand
        dialogEvents.push("show")
        void render
        if (onClose) closeCallbacks.push(onClose)
      },
      clear: () => {
        const cbs = closeCallbacks
        closeCallbacks = []
        for (const cb of cbs) cb?.()
      },
    },
    router: {
      current: () => ({ type: "session", sessionID: routeSessionID }),
    },
  },
  client: {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => sessions[sessionID],
      list: async ({ parentID }: { parentID?: string } = {}) => ({
        data: (parentID ? children[parentID] ?? [] : []).map((id) => sessions[id]),
      }),
    },
  },
  data: {
    session: {
      message: {
        sync: async () => {},
        list: (sessionID: string) => messages[sessionID] ?? [],
      },
    },
  },
  renderer: { height: 30 },
} as never

// ─── Fixtures: mirror the reference screenshot ─────────────────────────────
// s1 = lite@main (4 steps), s2 = explore@sub (3 steps), c0 = child for climb test.
// Totals (incl. c0: 100 in / $0.0001): 22,853 in / 1,970 out / 27,008 cr / $0.0031 / 8 steps | hit 54.2%
//
// v2 steps semantics: one assistant message = one step (v1 counted
// step-finish parts inside a message). The `steps` fixture arg emits that
// many assistant messages: the first carries the tokens/cost, the rest are
// zero-token continuations — same totals, same step counts as v1.

function assistant(over: Record<string, unknown>, steps = 1): UsageMessageRow[] {
  const first: UsageMessageRow = { type: "assistant", ...over }
  const rest: UsageMessageRow[] = Array.from({ length: Math.max(0, steps - 1) }, () => ({
    type: "assistant",
    ...over,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }))
  return [first, ...rest]
}

// lite@main: 11,702 in / 984 out / 7,232 cr / $0.001 / 4 steps → hit 38.2%
sessions.s1 = { id: "s1", agent: "build" }
messages.s1 = [
  ...assistant({ agent: "lite", providerID: "anthropic", modelID: "claude-pro", cost: 0.0006, tokens: { input: 5851, output: 492, reasoning: 0, cache: { read: 3616, write: 0 } } }, 2),
  ...assistant({ agent: "lite", providerID: "anthropic", modelID: "claude-pro", cost: 0.0004, tokens: { input: 5851, output: 492, reasoning: 0, cache: { read: 3616, write: 0 } } }, 2),
]

// explore@sub: 11,051 in / 976 out / 19,776 cr / $0.002 / 3 steps → hit 64.2%
sessions.s2 = { id: "s2", parentID: "s1", agent: "task" }
messages.s2 = [
  ...assistant({ agent: "explore", providerID: "google", modelID: "gemini", cost: 0.0015, tokens: { input: 6000, output: 500, reasoning: 10, cache: { read: 10000, write: 0 } } }, 2),
  ...assistant({ agent: "explore", providerID: "google", modelID: "gemini-flash", cost: 0.0005, tokens: { input: 5051, output: 476, reasoning: 0, cache: { read: 9776, write: 0 } } }, 1),
  { type: "compaction" },
  { type: "compaction" },
] as UsageMessageRow[]
// 2 compaction messages → exercise the compactions counter in the single view

// child session of s1 (exercises parentID climbing when it is the route target)
sessions.c0 = { id: "c0", parentID: "s1", agent: "code" }
messages.c0 = assistant({ agent: "code", providerID: "anthropic", modelID: "claude-pro", cost: 0.0001, tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } }, 1)

children.s1 = ["s2", "c0"]

const plugin = (await import("../plugins/tui/usage/tui")).default

await plugin.setup(fakeCtx)

// Force "en" after initI18n's env detection so string assertions are
// deterministic regardless of the host LANG/LC_ALL.
const { setLocale } = await import("../plugins/tui/i18n")
setLocale("en")

const allCommands = layers.flatMap((layer) => layer.commands ?? [])
const command = (id: string) => allCommands.find((c) => c.id === id)
const runUsage = (args?: string) => command("usage.show")!.run(args)
const lastToast = () => toasts[toasts.length - 1]
// openDimension is fire-and-forget; let its promise chain settle before asserting.
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)) }
// Simulate the host tearing down dialogs: fire every registered onClose
// (this flips the plugin's dialogOpen flag; dispatching modal commands
// directly without closing first would leave it stuck open).
const closeAll = () => {
  ;(fakeCtx as { ui: { dialog: { clear: () => void } } }).ui.dialog.clear()
}

// --- plugin shape checks ---
assertEq(plugin.id, "usage", "plugin id")
assertEq(typeof plugin.setup, "function", "setup entry exported")
assertEq(layers.length, 2, "two keymap layers (global commands + dialog modal layer)")
for (const id of ["usage.show", "usage.dim.session", "usage.dim.agent", "usage.dim.model"]) {
  assert(allCommands.some((c) => c.id === id), `command "${id}" registered`)
}
for (const id of ["usage.key.session", "usage.key.agent", "usage.key.model", "usage.dim.prev", "usage.dim.next", "usage.scroll.up", "usage.scroll.down", "usage.scroll.j", "usage.scroll.k", "usage.close"]) {
  assert(allCommands.some((c) => c.id === id), `dialog command "${id}" registered`)
}
const modalLayer = layers.find((layer) => layer.mode === "modal")
assert(modalLayer !== undefined, "dialog commands live in a modal-mode layer")
const showCmd = command("usage.show")!
assertEq(showCmd.slash?.name, "usage", "slash name registered (bare, TUI prepends /)")
assertEq(showCmd.slash?.arguments, undefined, "slash has NO arguments — menu Enter executes immediately (UX contract 2026-09-24); subcommands live in-menu / in-dialog keys")
assertEq(command("usage.key.agent")!.bind, "2", "tab hotkey bound to 2")

// --- /usage: shows the session view in a dialog ---
toasts.length = 0
dialogShows.length = 0
dialogSizes.length = 0
dialogEvents.length = 0
closeCallbacks = []
await runUsage(undefined)
await tick()
assertEq(toasts.length, 0, "/usage with data shows no toast")
assertEq(dialogShows.length, 1, "usage dialog opened")
assertEq(dialogSizes.length, 1, "dialog size set once on open")
assertEq(dialogEvents[dialogEvents.length - 1]?.startsWith("set:"), true, "size applied AFTER show() — set-before-show is wiped by the host's replace() reset to medium")
assertEq(hostSize, dialogSizes[dialogSizes.length - 1], "host size slot holds the fitted tier, not the medium reset")

// --- dimension commands are no-ops when dialog is closed ---
closeAll()
assertEq(modalLayer!.enabled!(), false, "modal layer disabled after host close")
dialogShows.length = 0
dialogSizes.length = 0
command("usage.dim.agent")!.run()
await tick()
assertEq(dialogShows.length, 0, "dimension command is no-op when dialog is closed")
// modal-layer commands are only ever dispatched by the host while the
// layer is enabled (dialog open) — emulate that gate in the harness.
if (modalLayer!.enabled!()) command("usage.dim.prev")!.run()
await tick()
assertEq(dialogShows.length, 0, "cycle command is no-op when dialog is closed")

// --- dimension commands work when dialog is open ---
await runUsage(undefined)
await tick()
dialogShows.length = 0
dialogSizes.length = 0
command("usage.dim.agent")!.run()
await tick()
assertEq(dialogShows.length, 0, "tab switch does NOT reopen the dialog (v2 repaints in place)")
assertEq(dialogSizes.length, 1, "tab switch re-fits the dialog size")
assertEq(dialogEvents[dialogEvents.length - 1]?.startsWith("set:"), true, "tab switch applies size to the live dialog (no replace in between)")

// --- modal layer enabledness is guarded by dialogOpen ---
assertEq(typeof modalLayer!.enabled, "function", "modal layer is enable-guarded")
assertEq(modalLayer!.enabled!(), true, "modal layer enabled while dialog open")
closeAll()
assertEq(modalLayer!.enabled!(), false, "modal layer disabled after close")
await runUsage(undefined)
await tick()
assertEq(modalLayer!.enabled!(), true, "modal layer enabled while dialog open")

// --- tab hotkeys switch dimensions ---
dialogSizes.length = 0
command("usage.key.agent")!.run()
await tick()
assertEq(dialogSizes.length, 1, "hotkey '2' switched to agent dimension")
command("usage.key.model")!.run()
await tick()
assertEq(dialogSizes.length, 2, "hotkey '3' switched to model dimension")
command("usage.dim.prev")!.run()
await tick()
assertEq(dialogSizes.length, 3, "'left' cycled to prev dimension")
command("usage.dim.next")!.run()
await tick()
assertEq(dialogSizes.length, 4, "'right' cycled to next dimension")

// --- scroll keys repaint without reopening ---
dialogShows.length = 0
dialogSizes.length = 0
command("usage.scroll.down")!.run()
command("usage.scroll.j")!.run()
command("usage.scroll.k")!.run()
await tick()
assertEq(dialogShows.length, 0, "scroll keys never reopen the dialog")
assertEq(dialogSizes.length, 0, "scroll keys never resize (tier fixed to full table)")

// --- Enter closes (v1's DialogAlert ok button) ---
assertEq(modalLayer!.enabled!(), true, "dialog open before Enter test")
command("usage.close")!.run() // dialog.clear → host fires onClose
assertEq(modalLayer!.enabled!(), false, "Enter-close resets the open flag")
dialogShows.length = 0
command("usage.dim.agent")!.run()
await tick()
assertEq(dialogShows.length, 0, "commands stay no-op after close")

// --- numbered tab strip + composed view (official TabSelect style underline) ---
const { formatByDimension, renderDimensionView, fitDialogSize } = await import("../plugins/tui/usage/tui")
// Aggregation assertions build a UsageSource over the same fixtures the
// fake ctx feeds the plugin (the dialog path above exercised it end-to-end).
const usageSource = {
  getSession: async (id: string) => sessions[id],
  listChildren: async (parentID: string) => (children[parentID] ?? []).map((id) => sessions[id]).filter(Boolean),
  messages: async (id: string) => messages[id] ?? [],
}

const view = renderDimensionView(await formatByDimension(usageSource, "s1", "session"), "agent")
const viewLines = view.split("\n")
assertEq(viewLines[0], "(1) By session   (2) By agent   (3) By model", "tab strip labels carry '(n) ' hotkey prefixes")
// "(2) By agent" sits at offset width("(1) By session") + 3; the bar covers exactly its width
assertEq(viewLines[1], " ".repeat(17) + "▬".repeat(12), "underline bar under the active tab")
assertEq(viewLines[2], "", "blank line between strip and table")
assert(!view.includes("1/2/3 or"), "hint line removed (numbers are self-documenting)")

// --- OCP points fallback: cost 0 + plan provider → credits column (积分) ---
// Point the loader at an isolated fixture file so tests don't touch real config.
const pointsPath = join(tmpdir(), `ocp-points-test-${process.pid}.json`)
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
const { resetCostsCache } = await import("../plugins/tui/usage/tui")
resetCostsCache()

sessions.z1 = { id: "z1", agent: "build" }
// 10000×2.3 + 20000×0.56 + 5000×8 / 10000 = (23000 + 11200 + 40000) / 10000 = 7.42 积分
messages.z1 = assistant({ agent: "build", providerID: "zhipuai-coding-plan", modelID: "glm-5.3-flash", cost: 0, tokens: { input: 10000, output: 5000, cache: { read: 20000, write: 0 } } }, 1)
const ptsText = (await formatByDimension(usageSource, "z1", "session")).table
assert(ptsText.includes("credits") && ptsText.includes("7.42"), "credits column present for plan sessions")
assert(ptsText.includes("7.42"), `points computed via OCP dataset (got: ${ptsText.split("\n").join(" | ")})`)
// On coding plans the server-side cost is $0, but credits are the actual
// billing mechanism so costKnown should be true and no simulated-price icon appears.
assert(!ptsText.includes("🪙"), "coding-plan sessions don't get a simulated-price icon (credits are the real bill)")
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
messages.z2 = assistant({ agent: "build", providerID: "anthropic", modelID: "claude-pro", cost: 0, tokens: { input: 1000, output: 100, cache: { read: 10000, write: 0 } } }, 1)
const nonPlanText = (await formatByDimension(usageSource, "z2", "session")).table
assert(nonPlanText.includes("🪙 $0.0075") && !nonPlanText.includes("积分"), "non-plan cost 0 shows models.dev simulated estimate prefixed with coin icon")
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
const sessionText = (await formatByDimension(usageSource, "s1", "session")).table
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
const shareRows = sessionText.split("\n").filter((line) => /\d+\.\d% [█░]/.test(line))
const barStarts = shareRows.map((line) => line.indexOf("█") >= 0 ? line.indexOf("█") : line.indexOf("░"))
assert(shareRows.length > 1 && barStarts.every((start) => start === barStarts[0]), "share bars start at a fixed column regardless of percentage digits")
assert(!sessionText.includes("cache-write") && !sessionText.includes("reasoning"), "display limited to 3 numbers: in / out / cached")
// Table stretched to fill the dialog tier: the header rule spans the tier's
// full text width (fixture fits the large tier → 83 cols), so the dialog
// border hugs the content with no dead space on the right.
const ruleLine = sessionText.split("\n").find((l) => l.includes("─"))!
assertEq(ruleLine.length, 83, "header rule spans the dialog tier text width (stretched gaps)")

// agent dimension: sessions grouped by agent attribution
const agentText = (await formatByDimension(usageSource, "s1", "agent")).table
for (const header of ["agent", "sess", "in", "out", "cached", "cost", "share"]) {
  assert(agentText.includes(header), `agent table has "${header}" column`)
}
assert(agentText.includes("lite") && agentText.includes("explore"), "agent rows present")
assert(agentText.includes("11,702"), "per-agent input sums")
assert(agentText.includes("19,776"), "explore cached-in sum")
assert(!agentText.includes("build") || agentText.indexOf("explore") < agentText.indexOf("build"), "fixture agent 'build' never used by messages")

// model dimension: tokens/cost summed across the whole tree (same columns as sessions)
const modelText = (await formatByDimension(usageSource, "s1", "model")).table
for (const header of ["model", "sess", "in", "out", "cached", "cost", "share"]) {
  assert(modelText.includes(header), `model table has "${header}" column`)
}
assert(modelText.includes("claude-pro"), "model row: claude-pro (short name)")
assert(modelText.includes("🆔 ") && modelText.includes("\n• claude-pro ← anthropic/claude-pro"), "full model-id label has model icon")
assert(modelText.includes("11,802"), "claude-pro input summed across s1+c0 (11702+100)")
assert(modelText.includes("994") && modelText.includes("7,232"), "claude-pro output/cache summed (984+10, 7232+0)")
assert(modelText.includes("gemini-flash"), "model row: gemini-flash")

// --- scrollable viewport: short terminals slice data rows, pin header + total ---
const { renderScrollView } = await import("../plugins/tui/usage/tui")
// Pre-growth snapshot (few data rows): a table small enough to fit a tall
// terminal without scrolling — used by the no-overflow assertions.
const smallRender = await formatByDimension(usageSource, "s1", "session")
const smallFlat = renderDimensionView(smallRender, "session")
// Grow the tree to 12 sessions so the session table overflows a 30-row
// terminal. x0 carries 14 steps → totalSteps crosses the soft tier (30),
// so the context warning is part of the pinned top region too.
for (let i = 0; i < 9; i++) {
  const id = `x${i}`
  sessions[id] = { id, parentID: "s1", agent: "task" }
  messages[id] = assistant({ agent: "explore", providerID: "google", modelID: "gemini", cost: 0.0001, tokens: { input: 100 + i, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } }, i === 0 ? 14 : 1)
  children.s1.push(id)
}
const bigRender = await formatByDimension(usageSource, "s1", "session")
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

// Tall terminal: the viewport is budget-derived (no fixed row cap), so a
// table that fits the available rows shows EVERY row — no scroll, no clamp.
const svTall = renderScrollView(bigRender, "session", 100, 5)
assertEq(svTall.maxOffset, 0, "tall terminal fits all 12 rows → no scroll range")
assertEq(svTall.offset, 0, "offset forced to 0 when nothing overflows")
assert(svTall.view.includes("108"), "last data row visible on a tall terminal")
assert(svTall.view.includes("11,702"), "first data row visible on a tall terminal")
assert(!svTall.view.includes("↑/↓"), "no scroll indicator when the tall viewport fits everything")

// Height adapts to the terminal: the same 12-row table overflows a 40-row
// terminal but not a 100-row one — viewport grows with the budget.
const svShortTall = renderScrollView(bigRender, "session", 40, 0)
assert(svShortTall.maxOffset > svTall.maxOffset, "shorter terminal shows fewer rows (viewport scales with height)")

// Small table → fits, byte-identical to the flat render, no indicator
const svFit = renderScrollView(smallRender, "session", 100, 5)
assertEq(svFit.maxOffset, 0, "table that fits → no scrolling")
assertEq(svFit.offset, 0, "offset forced to 0 when nothing overflows")
assertEq(svFit.view, smallFlat, "no-overflow view identical to the flat render")
assert(!svFit.view.includes("↑/↓"), "no scroll indicator when the table fits")

// --- /usage all|agent|model → opens the corresponding table dialog ---
closeAll()
toasts.length = 0
dialogShows.length = 0
await runUsage("usage.show all")
await tick()
assertEq(toasts.length, 0, "/usage all shows no toast")
assertEq(dialogShows.length, 1, "session table dialog opened")

// --- parentID climbing: route on a child session still shows the whole tree ---
routeSessionID = "c0"
const climbText = (await formatByDimension(usageSource, "c0", "session")).table
assert(climbText.includes("🦾 lite") && climbText.includes("🦾 explore") && climbText.includes("🧠 code"), "route on child walks up to root and includes whole tree")
assert(climbText.includes("🧠 code"), "current session (even if child) gets the main icon")
routeSessionID = "s1"

// --- no data anywhere → graceful message ---
closeAll()
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
const realGet = (fakeCtx as { client: { session: { get: unknown } } }).client.session.get
;(fakeCtx as { client: { session: { get: unknown } } }).client.session.get = async () => {
  throw new Error("boom")
}
toasts.length = 0
await runUsage("usage.show all")
await tick()
assertEq(toasts.length, 1, "one toast on server error")
assert(toasts[0].message.includes("No token data") || toasts[0].message.includes("Failed"), "server error degrades gracefully")
;(fakeCtx as { client: { session: { get: unknown } } }).client.session.get = realGet

// --- unknown subcommand → usage hint ---
closeAll()
toasts.length = 0
await runUsage("usage.show bogus")
assertEq(toasts.length, 1, "one toast for unknown subcommand")
assert(toasts[0].message.includes("Unknown subcommand"), "unknown subcommand shows error")
assert(toasts[0].message.includes("Usage:"), "unknown subcommand shows usage hint")

// --- parseSubcommand unit coverage (v2: raw slash input) ---
const { parseSubcommand } = await import("../plugins/tui/usage/tui")
assertEq(parseSubcommand("usage.show"), null, "bare command name → no subcommand")
assertEq(parseSubcommand("usage.show model"), "model", "trailing arg extracted")
assertEq(parseSubcommand("/usage agent"), "agent", "leading /usage token skipped")
assertEq(parseSubcommand(undefined), null, "no input → null")
assertEq(parseSubcommand("   "), null, "blank input → null")

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
