/**
 * Wizard helpers — pure-function unit tests.
 *
 * These tests cover the badge formatters and report line formatters that
 * project-wizard (and, in the future, provider/profile wizards) share.
 * No TUI runtime dependency.
 *
 * Run: npx tsx tests/test-wizard-helpers-unit.ts
 */

import { strict as assert } from "node:assert"
import {
  formatGuardBadge,
  formatAdvisorBadge,
  formatAdrLayoutBadge,
  backendLine,
  hookLine,
  scaffoldLine,
  initReport,
  breadcrumbHeader,
  showBusyModal,
  WIZARD_GROUPS,
} from "../plugins/tui/_wizard-helpers"
import { initI18nHeadless } from "../plugins/tui/i18n"

let passed = 0
let failed = 0

function check(name: string, condition: boolean): void {
  if (condition) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`)
  }
}

console.log("\n=== Badge formatters ===")

// formatGuardBadge
check("guardBadge on → On", formatGuardBadge("on") === "🟢 On")
check("guardBadge off → Off", formatGuardBadge("off") === "🔴 Off")
check("guardBadge undefined → empty", formatGuardBadge(undefined) === "")

// formatAdvisorBadge
check("advisorBadge lite → Lite", formatAdvisorBadge("lite") === "🟢 Lite")
check("advisorBadge full → Full", formatAdvisorBadge("full") === "🔵 Full")
check("advisorBadge off → Off", formatAdvisorBadge("off") === "🔴 Off")
check("advisorBadge undefined → empty", formatAdvisorBadge(undefined) === "")

// formatAdrLayoutBadge
check("adrLayoutBadge auto → Auto", formatAdrLayoutBadge("auto") === "🟢 Auto")
check("adrLayoutBadge flat → Flat", formatAdrLayoutBadge("flat") === "📄 Flat")
check("adrLayoutBadge hierarchical → Hierarchy", formatAdrLayoutBadge("hierarchical") === "📦 Hierarchy")
check("adrLayoutBadge undefined → empty", formatAdrLayoutBadge(undefined) === "")

console.log("\n=== Report line formatters ===")

// backendLine
check(
  "backendLine ran",
  backendLine({ backend: "codegraph", status: "ran", detail: "ok" }) === "  ✅ codegraph: ok",
)
check(
  "backendLine failed",
  backendLine({ backend: "codegraph", status: "failed", detail: "missing" }) ===
    "  ❌ codegraph: missing",
)
check(
  "backendLine skipped",
  backendLine({ backend: "codegraph", status: "skipped", detail: "no CLI" }) ===
    "  ⏭️ codegraph: skipped (no CLI)",
)

// hookLine
check(
  "hookLine registered",
  hookLine({ hook: "post-commit", status: "registered", detail: "added" }) ===
    "  ✅ post-commit: added",
)
check(
  "hookLine updated",
  hookLine({ hook: "post-commit", status: "updated", detail: "refreshed" }) ===
    "  ♻️ post-commit: refreshed",
)
check(
  "hookLine failed",
  hookLine({ hook: "post-commit", status: "failed", detail: "EPERM" }) ===
    "  ❌ post-commit: EPERM",
)
check(
  "hookLine skipped",
  hookLine({ hook: "post-commit", status: "skipped", detail: "no active" }) ===
    "  ⏭️ post-commit: skipped (no active)",
)

// scaffoldLine — uses ScaffoldResult
const mkScaffold = (relPath: string, status: "created" | "updated" | "invalid" | "skipped") =>
  ({ relPath, status } as const)

check(
  "scaffoldLine created",
  scaffoldLine(mkScaffold(".ocp/ocp.json", "created")) ===
    "  ✅ created .ocp/ocp.json",
)
check(
  "scaffoldLine updated",
  scaffoldLine(mkScaffold(".ocp/ocp.json", "updated")) ===
    "  ♻️ updated .ocp/ocp.json",
)
check(
  "scaffoldLine invalid",
  scaffoldLine(mkScaffold(".ocp/ocp.json", "invalid")) ===
    "  ⚠️ malformed .ocp/ocp.json",
)
check(
  "scaffoldLine skipped",
  scaffoldLine(mkScaffold(".ocp/ocp.json", "skipped")) ===
    "  ⏭️ kept .ocp/ocp.json",
)

// initReport — composes sections
const report = initReport(
  [mkScaffold(".ocp/ocp.json", "created")],
  [{ backend: "codegraph", status: "ran", detail: "ok" }],
  [{ hook: "post-commit", status: "registered", detail: "added" }],
  "/tmp/project",
)
check(
  "initReport contains target",
  report.includes("Target: /tmp/project"),
)
check("initReport contains files section", report.includes("Files:"))
check("initReport contains backends section", report.includes("Backends:"))
check("initReport contains hooks section", report.includes("Hooks:"))
check("initReport shows scaffold line", report.includes("created .ocp/ocp.json"))
check("initReport shows backend line", report.includes("codegraph: ok"))
check("initReport shows hook line", report.includes("post-commit: added"))

// initReport with empty arrays — should still produce sections with no lines
const emptyReport = initReport([], [], [], "/tmp/empty")
check("initReport empty has Target", emptyReport.startsWith("Target: /tmp/empty"))
check("initReport empty has Files section", emptyReport.includes("Files:"))
check("initReport empty has no scaffold lines", !emptyReport.includes("created "))

// ─── breadcrumbHeader ────────────────────────────────────────────────

console.log("\n=== breadcrumbHeader ===")

// i18n must be initialized before tr() resolves keys.
// Use the headless variant — initI18n() requires TuiPluginApi.
initI18nHeadless()

const SEP = " │ "
const ACTIVE_MARKER = "●"

check(
  "WIZARD_GROUPS canonical order is projectGuards → adr → tooling",
  JSON.stringify(WIZARD_GROUPS) ===
    JSON.stringify(["projectGuards", "adr", "tooling"]),
)

// Locale-agnostic structural assertions: each header has (n-1) separators,
// exactly 1 active marker, and the marker is glued to a non-empty token.
for (const g of WIZARD_GROUPS) {
  const header = breadcrumbHeader(g)
  const sepCount = (header.match(/│/g) ?? []).length
  check(`breadcrumbHeader(${g}) has exactly ${WIZARD_GROUPS.length - 1} separator(s)`, sepCount === WIZARD_GROUPS.length - 1)
  const markerCount = (header.match(/●/g) ?? []).length
  check(`breadcrumbHeader(${g}) has exactly 1 active marker`, markerCount === 1)
  // The active marker must be followed by some non-empty label
  const markerIdx = header.indexOf(ACTIVE_MARKER)
  const afterMarker = header.slice(markerIdx + 1).split(SEP)[0]
  check(
    `breadcrumbHeader(${g}) marker is followed by a non-empty label`,
    afterMarker.length > 0,
  )
}

// Active group's position matches its index in WIZARD_GROUPS.
const guardsHeader = breadcrumbHeader("projectGuards")
check(
  "projectGuards: marker in first segment",
  guardsHeader.split(SEP)[0].startsWith(ACTIVE_MARKER),
)
const toolingHeader = breadcrumbHeader("tooling")
check(
  "tooling: marker in last segment",
  toolingHeader.split(SEP).pop()!.startsWith(ACTIVE_MARKER),
)

// Locale-agnostic spot-check: rendered segments must all be non-empty.
const anyHeader = breadcrumbHeader("adr")
const segments = anyHeader.split(SEP)
check(
  `all ${WIZARD_GROUPS.length} segments are non-empty`,
  segments.length === WIZARD_GROUPS.length && segments.every((s) => s.length > 0),
)

// ─── showBusyModal: dual-@opentui/solid-instance regression guard ─────
//
// When opencode loads our plugin files from `~/.config/opencode/plugins/
// tui/*.ts`, every `import { jsx } from "@opentui/solid/jsx-runtime"`
// resolves to a separate physical module from the host's bundled copy.
// Solid resolves contexts by Symbol identity, so `useContext(RendererContext)`
// inside the plugin's `createElement` looks up the wrong symbol and throws
// `Error: No renderer found` on the host's render loop, killing the TUI
// (opencode issues #27447 and #33884).
//
// `showBusyModal` used to draw a JSX panel via `dialog.show(() => jsx(...))`
// and crashed. The fix routes the indicator through `ctx.ui.toast.show`,
// which is plain options (no plugin JSX). This test asserts showBusyModal
// never invokes `ctx.ui.dialog.show` — and routes the message through toast.
console.log("\n=== showBusyModal dual-instance guard ===")

let dialogShowCalls = 0
let toastCalls: { title?: string; message: string; variant?: string }[] = []
const stubCtx = {
  ui: {
    dialog: {
      show: () => {
        dialogShowCalls++
        throw new Error("showBusyModal must not touch dialog.show — would crash on dual-instance hosts")
      },
      set: () => undefined,
      clear: () => undefined,
    },
    toast: {
      show: (options: { title?: string; message: string; variant?: string }) => {
        toastCalls.push(options)
      },
    },
  },
  theme: { text: { base: "#fff", muted: "#888", feedback: { info: { base: "#5cf" } } } },
} as never

showBusyModal(stubCtx, {
  title: "Initializing",
  message: "Scaffolding files…",
  busyText: "Working",
})
check("showBusyModal does NOT call ctx.ui.dialog.show", dialogShowCalls === 0)
check("showBusyModal routes through ctx.ui.toast.show", toastCalls.length === 1)
check("showBusyModal toast carries the title", toastCalls[0]?.message.includes("Initializing"))
check("showBusyModal toast carries the message", toastCalls[0]?.message.includes("Scaffolding files…"))
check("showBusyModal toast carries the busyText", toastCalls[0]?.message.includes("Working"))
check("showBusyModal toast contains a spinner glyph", toastCalls[0]?.message.includes("⏳"))

// showBusyModal must not throw if the host lacks `dialog` (only `toast`).
const minimalCtx = {
  ui: {
    toast: { show: () => undefined },
  },
} as never
let minimalThrew = false
try {
  showBusyModal(minimalCtx, { title: "x", message: "y" })
} catch {
  minimalThrew = true
}
check("showBusyModal tolerates a ctx without dialog (toast-only fallback)", !minimalThrew)

console.log(`\n${"─".repeat(40)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
