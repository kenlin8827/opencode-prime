/**
 * Unit smoke test for the sidebar-status project badges — focused on the
 * memory row (the projectMemory switch + entry count display).
 * Memory lives in the "OCP project" group (per-project capability, not a
 * cross-project behavior switch like adr-guard/e2e-guard).
 * Run: bun tests/test-sidebar-status-unit.ts
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildGuardBadges, buildProjectBadges } from "../plugins/tui/sidebar-status"

let pass = 0
let fail = 0
function check(name: string, ok: boolean) {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}`) }
}

// Sandbox project dir so the real project config is never read.
// MCP disabled across the board so badges not under test stay filtered.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sidebar-status-"))
fs.mkdirSync(path.join(tmp, ".opencode"), { recursive: true })

const noMcp = {
  mcp: {
    codegraph: { enabled: false },
    gitnexus: { enabled: false },
    serena: { enabled: false },
  },
}
const row = (label: string) =>
  buildProjectBadges(tmp, noMcp).find((b: { label: string }) => b.label === label)

// 1. Default (no projectMemory field, NOT INIT project): resolves to "on" →
//    empty memory.md → state "ON · empty", variant "info" (nudge to /memory
//    capture). Memory row renders even pre-init — the row is lifecycle-
//    independent (data lives under OCP config root).
const r1 = row("memory")
check("default (NOT INIT): memory row renders as ON · empty", r1?.state === "ON · empty" && r1?.variant === "info")

// 2. Explicit "off" → row is hidden by the OFF filter (mirrors commit-
//    discipline OFF: "the project doesn't use this capability" — not worth
//    taking sidebar space, unlike adr-guard/e2e-guard OFF which stay
//    visible in the OCP group because they're behavior switches).
fs.writeFileSync(path.join(tmp, ".opencode", "opencode.jsonc"), JSON.stringify({ projectMemory: "off" }))
check("explicit off: memory row hidden by OFF filter", row("memory") === undefined)

// 3. Explicit "on" + no memory.md on disk → still "ON · empty" (the file
//    lives under OCP config root, outside the sandbox; count is 0 here).
fs.writeFileSync(path.join(tmp, ".opencode", "opencode.jsonc"), JSON.stringify({ projectMemory: "on" }))
const r3 = row("memory")
check("explicit on, no memory file: ON · empty", r3?.state === "ON · empty")

// 4. Boolean alias normalizes too.
fs.writeFileSync(path.join(tmp, ".opencode", "opencode.jsonc"), JSON.stringify({ projectMemory: true }))
check("boolean true normalizes to on (ON · empty here)", row("memory")?.state === "ON · empty")

// 5. The memory row must NOT appear in the OCP group (buildGuardBadges):
//    a regression here means the row migrated back to the wrong section.
fs.writeFileSync(path.join(tmp, ".opencode", "opencode.jsonc"), JSON.stringify({ projectMemory: "on" }))
check(
  "memory row is NOT in the OCP (guard) group",
  buildGuardBadges(tmp).find((b: { label: string }) => b.label === "memory") === undefined,
)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
