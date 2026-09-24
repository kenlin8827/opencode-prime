/**
 * Unit smoke test for the sidebar-status project badges — focused on the
 * memory row (the projectMemory switch + entry count display).
 * Memory lives in the "OCP project" group (per-project capability, not a
 * cross-project behavior switch like adr).
 * Run: bun tests/test-sidebar-status-unit.ts
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildGuardBadges, buildProjectBadges } from "../plugins/tui/sidebar-status"
import { setProjectDir } from "../plugins/project-memory/project-memory-config"

let pass = 0
let fail = 0
function check(name: string, ok: boolean) {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}`) }
}

// Sandbox project dir so the real project config is never read.
// MCP disabled across the board (v2 shape: `mcp.servers.<name>.disabled`)
// so badges not under test stay filtered.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sidebar-status-"))
fs.mkdirSync(path.join(tmp, ".ocp"), { recursive: true })
// The memory badge counts via readPublic(), which resolves through the
// module-global projectDir (set by each plugin entry in production). Point
// it at the sandbox so a real .ocp/memory/public.md on this machine can't
// leak into the "ON · empty" assertions.
setProjectDir(tmp)

const noMcp = {
  mcp: {
    servers: {
      codegraph: { disabled: true },
      gitnexus: { disabled: true },
      serena: { disabled: true },
    },
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
//    taking sidebar space, unlike adr OFF which stays
//    visible in the OCP group because it's a behavior switch).
fs.writeFileSync(path.join(tmp, ".ocp", "ocp.json"), JSON.stringify({ projectMemory: "off" }))
check("explicit off: memory row hidden by OFF filter", row("memory") === undefined)

// 3. Explicit "on" + no memory.md on disk → still "ON · empty" (the file
//    lives under OCP config root, outside the sandbox; count is 0 here).
fs.writeFileSync(path.join(tmp, ".ocp", "ocp.json"), JSON.stringify({ projectMemory: "on" }))
const r3 = row("memory")
check("explicit on, no memory file: ON · empty", r3?.state === "ON · empty")

// 4. Boolean alias normalizes too.
fs.writeFileSync(path.join(tmp, ".ocp", "ocp.json"), JSON.stringify({ projectMemory: true }))
check("boolean true normalizes to on (ON · empty here)", row("memory")?.state === "ON · empty")

// 5. The memory row must NOT appear in the OCP group (buildGuardBadges):
//    a regression here means the row migrated back to the wrong section.
fs.writeFileSync(path.join(tmp, ".ocp", "ocp.json"), JSON.stringify({ projectMemory: "on" }))
check(
  "memory row is NOT in the OCP (guard) group",
  buildGuardBadges(tmp).find((b: { label: string }) => b.label === "memory") === undefined,
)

// ─── MCP enablement: v2 `mcp.servers.<name>` shape ───────────────────
//
// Regression guard for the v1 → v2 field miss: mcpEnabledIn() used to read
// v1's `mcp.<name>.enabled === true`, which can never match a v2 document
// (servers live under `mcp.servers`, the flag is `disabled`, and its
// default is false = connect). Every capability badge therefore stuck at
// OFF, and the model-facing [PROJECT CAPABILITIES] block lied the same way.
// Capability rows only render for an INIT scaffold — which is why the
// memory-only assertions above never exercised this path.

const caps = fs.mkdtempSync(path.join(os.tmpdir(), "sidebar-caps-"))
for (const rel of [path.join(".ocp", "ocp.json"), path.join("docs", "git-commits.md"), "AGENTS.md"]) {
  const p = path.join(caps, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, "{}")
}
setProjectDir(caps)
const badge = (label: string, cfg: unknown) =>
  buildProjectBadges(caps, cfg as Record<string, unknown>).find((b: { label: string }) => b.label === label)?.state
const servers = (extra: Record<string, unknown>) => ({
  mcp: { servers: { gitnexus: { disabled: true }, serena: { disabled: true }, ...extra } },
})

check("fixture is an INIT scaffold (so capability rows render)", badge("scaffold", null) === "INIT")
check("v2 disabled:true → row hidden (OFF is filtered as non-actionable)", badge("codegraph", servers({ codegraph: { disabled: true } })) === undefined)
check("v2 configured, no `disabled`, no index dir → NO INDEX", badge("codegraph", servers({ codegraph: { type: "local" } })) === "NO INDEX")
fs.mkdirSync(path.join(caps, ".codegraph"))
check("v2 configured without `disabled` + index dir → READY (v2 default false)", badge("codegraph", servers({ codegraph: { type: "local" } })) === "READY")
check("v2 disabled:false + index dir → READY", badge("codegraph", servers({ codegraph: { disabled: false } })) === "READY")
check("serena v2 enabled → READY (live LSP, no index step)", badge("serena", servers({ serena: { type: "local" }, codegraph: { disabled: true } })) === "READY")
check("v1-shaped `enabled:true` is NOT read as enabled → row stays hidden", badge("codegraph", { mcp: { codegraph: { enabled: true } } }) === undefined)
check("absent server entry → row hidden", badge("codegraph", { mcp: { servers: {} } }) === undefined)

fs.rmSync(caps, { recursive: true, force: true })
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
