/**
 * Unit smoke test for the sidebar-status guard badges — focused on the
 * project-memory row (added 2026-09-11 after the switch existed in config
 * but was invisible in the right panel).
 * Run: bun tests/test-sidebar-status-unit.ts
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildGuardBadges } from "../plugins/tui/sidebar-status"

let pass = 0
let fail = 0
function check(name: string, ok: boolean) {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}`) }
}

// Sandbox project dir so the real project config is never read.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sidebar-status-"))
fs.mkdirSync(path.join(tmp, ".opencode"), { recursive: true })

// Profile row depends on the real user config — ignore it, find by label.
const row = (dir: string, label: string) =>
  buildGuardBadges(dir).find((b: { label: string }) => b.label === label)

// Default: no projectMemory field → OFF row, info variant.
const off = row(tmp, "project-memory")
check("project-memory badge renders OFF by default", off?.state === "OFF" && off?.variant === "info")

// projectMemory: "on" → ON row, warning variant (mirrors other guards).
fs.writeFileSync(
  path.join(tmp, ".opencode", "opencode.jsonc"),
  JSON.stringify({ projectMemory: "on" }),
)
const on = row(tmp, "project-memory")
check("project-memory badge renders ON when switch is on", on?.state === "ON" && on?.variant === "warning")

// Boolean alias normalizes too.
fs.writeFileSync(
  path.join(tmp, ".opencode", "opencode.jsonc"),
  JSON.stringify({ projectMemory: true }),
)
check("project-memory badge normalizes boolean true", row(tmp, "project-memory")?.state === "ON")

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
