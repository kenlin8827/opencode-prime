/**
 * Render test for the sidebar-status collapsible section headers
 * (plugins/tui/sidebar-status — MCP-style ▼/▶ disclosure).
 *
 * renderStatusPanel builds the real production tree; this test mounts it
 * via @opentui/solid's testRender harness (the slot has no standalone
 * renderer of its own) and drives the actual mouse pipeline —
 * hitTest → dispatch → Renderable "up" listener → signal → re-render —
 * to prove a header click collapses exactly its own section and rows
 * never toggle.
 *
 * The signal wiring here mirrors SidebarPanel's (signal read inside a
 * createMemo; onToggle flips the signal) — the component itself needs a
 * full plugin Context, which the standalone harness cannot provide.
 *
 * Run: bun tests/test-sidebar-collapse-render.ts
 */
import assert from "node:assert/strict"

// Solid must resolve to the CLIENT build under Bun (the SSR build's no-op
// effects would freeze the memo) — register the redirect BEFORE any import
// that pulls in solid-js. Same pattern as test-ocp-ui-render.tsx.
const { ensureSolidTransformPlugin } = await import("../node_modules/@opentui/solid/scripts/solid-plugin.js")
ensureSolidTransformPlugin()

const { createMemo, createSignal } = await import("solid-js")
const { renderStatusPanel } = await import("../plugins/tui/sidebar-status/tui")
const { testRender } = await import("../node_modules/@opentui/solid/index.bun.js")

// Keep a failing assert from stranding an open opentui renderer (hangs the run).
process.on("uncaughtException", (error) => {
  console.error(String((error as { message?: string })?.message ?? error))
  process.exit(1)
})
process.on("unhandledRejection", (error) => {
  console.error(String((error as { message?: string })?.message ?? error))
  process.exit(1)
})

// Minimal deterministic inputs — renderStatusPanel is pure beyond its args
// (the badge builders have their own suites; this path never touches fs).
const theme = {
  error: "#ff5555",
  warning: "#f0c674",
  info: "#8abeb7",
  success: "#b5bd68",
  textMuted: "#969896",
  borderSubtle: "#373b41",
  text: "#c5c8c6",
  backgroundPanel: "#1d2021",
  border: "#373b41",
}
type Badge = { label: string; state: string; variant: "error" | "warning" | "info" | "success" }
const guards: Badge[] = [
  { label: "adr", state: "OFF", variant: "info" },
  { label: "auto-advisor", state: "OFF", variant: "info" },
]
const project: Badge[] = [
  { label: "scaffold", state: "INIT", variant: "success" },
  { label: "git-commits", state: "ON", variant: "success" },
]

const [collapse, setCollapse] = createSignal({ guards: false, project: false })
const toggle = (section: "guards" | "project") => setCollapse((c) => ({ ...c, [section]: !c[section] }))

const ui = await testRender(
  () => createMemo(() => renderStatusPanel(guards, project, theme, "2.0.0", "", collapse(), toggle)),
  { width: 60, height: 20 },
)
await ui.flush()

const lineOf = (needle: string): number => {
  const y = ui.captureCharFrame().split(/\r?\n/).findIndex((line) => line.includes(needle))
  assert.ok(y >= 0, `frame should contain "${needle}"`)
  return y
}

// 1. Expanded by default: ▼ markers + all rows visible.
let frame = ui.captureCharFrame()
assert.match(frame, /▼ OCP v2\.0\.0/, "expanded guards header shows ▼")
assert.match(frame, /▼ OCP project/, "expanded project header shows ▼")
assert.match(frame, /adr/, "guards rows visible when expanded")
assert.match(frame, /scaffold/, "project rows visible when expanded")

// 2. Clicking a ROW never toggles — only the header row is bound.
await ui.mockMouse.click(3, lineOf("OCP v2.0.0") + 1)
await ui.flush()
assert.match(ui.captureCharFrame(), /▼ OCP v2\.0\.0/, "row click does not collapse the section")

// 3. Clicking the guards header collapses exactly the guards section.
await ui.mockMouse.click(3, lineOf("OCP v2.0.0"))
await ui.flush()
frame = ui.captureCharFrame()
assert.match(frame, /▶ OCP v2\.0\.0/, "clicked header flips to ▶")
assert.ok(!frame.includes("adr"), "guards rows hidden after collapse")
assert.match(frame, /▼ OCP project/, "project section unaffected")
assert.match(frame, /scaffold/, "project rows still visible")

// 4. Clicking the project header collapses it too.
await ui.mockMouse.click(3, lineOf("OCP project"))
await ui.flush()
frame = ui.captureCharFrame()
assert.match(frame, /▶ OCP project/, "project header flips to ▶")
assert.ok(!frame.includes("scaffold"), "project rows hidden after collapse")

// 5. Re-expanding restores the rows (and leaves the other section alone).
await ui.mockMouse.click(3, lineOf("OCP v2.0.0"))
await ui.flush()
frame = ui.captureCharFrame()
assert.match(frame, /▼ OCP v2\.0\.0/, "re-click expands again")
assert.match(frame, /adr/, "guards rows restored")
assert.ok(!frame.includes("scaffold"), "project section stays collapsed")

ui.renderer.destroy()
console.log("sidebar collapse render: PASS")
