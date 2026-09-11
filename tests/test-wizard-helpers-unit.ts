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
  formatAdrModeBadge,
  backendLine,
  hookLine,
  scaffoldLine,
  initReport,
  breadcrumbHeader,
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
check("guardBadge on → ON", formatGuardBadge("on") === "🟢 ON")
check("guardBadge off → OFF", formatGuardBadge("off") === "🔴 OFF")
check("guardBadge default → default", formatGuardBadge("default") === "⚪ default")
check("guardBadge undefined → default", formatGuardBadge(undefined) === "⚪ default")

// formatAdvisorBadge
check("advisorBadge lite → lite", formatAdvisorBadge("lite") === "🟢 lite")
check("advisorBadge full → full", formatAdvisorBadge("full") === "🔵 full")
check("advisorBadge off → off", formatAdvisorBadge("off") === "🔴 off")
check("advisorBadge default → default", formatAdvisorBadge("default") === "⚪ default")
check("advisorBadge undefined → default", formatAdvisorBadge(undefined) === "⚪ default")

// formatAdrModeBadge
check("adrModeBadge auto → auto", formatAdrModeBadge("auto") === "🟢 auto")
check("adrModeBadge flat → flat", formatAdrModeBadge("flat") === "📄 flat")
check("adrModeBadge hierarchical → hierarchy", formatAdrModeBadge("hierarchical") === "📦 hierarchy")
check("adrModeBadge default → default", formatAdrModeBadge("default") === "⚪ default")
check("adrModeBadge undefined → default", formatAdrModeBadge(undefined) === "⚪ default")

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
  scaffoldLine(mkScaffold(".opencode/opencode.jsonc", "created")) ===
    "  ✅ created .opencode/opencode.jsonc",
)
check(
  "scaffoldLine updated",
  scaffoldLine(mkScaffold(".opencode/opencode.jsonc", "updated")) ===
    "  ♻️ updated .opencode/opencode.jsonc",
)
check(
  "scaffoldLine invalid",
  scaffoldLine(mkScaffold(".opencode/opencode.jsonc", "invalid")) ===
    "  ⚠️ malformed .opencode/opencode.jsonc",
)
check(
  "scaffoldLine skipped",
  scaffoldLine(mkScaffold(".opencode/opencode.jsonc", "skipped")) ===
    "  ⏭️ kept .opencode/opencode.jsonc",
)

// initReport — composes sections
const report = initReport(
  [mkScaffold(".opencode/opencode.jsonc", "created")],
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
check("initReport shows scaffold line", report.includes("created .opencode/opencode.jsonc"))
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

console.log(`\n${"─".repeat(40)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
