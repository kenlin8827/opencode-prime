import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadTgrepOptions } from "../plugins/tgrep/tgrep-config"
import { buildProjectBadges } from "../plugins/tui/sidebar-status"

let failed = 0
function assert(ok: boolean, message: string): void {
  console.log(`${ok ? "✅" : "❌"} ${message}`)
  if (!ok) failed++
}

// Global MCP config with every backend disabled — keeps the assertion set
// focused on the project-state and tgrep-badge contracts instead of any
// one MCP's rendering. Tests are deterministic on this dimension.
const noMcp = { mcp: { codegraph: { enabled: false }, gitnexus: { enabled: false }, serena: { enabled: false } } }

// ─── 1. Not-init project: only the "scaffold" row renders, NOT INIT + error ───
// Label "scaffold" mirrors resolveProjectScaffold() and the INIT/PARTIAL/
// NOT INIT state machine; "project" was ambiguous (collides visually with
// the "memory" row in the OCP group).
const rootNotInit = mkdtempSync(join(tmpdir(), "sidebar-badge-notinit-"))
const badgesNotInit = buildProjectBadges(rootNotInit, noMcp)
const projectNotInit = badgesNotInit.find((b) => b.label === "scaffold")
assert(projectNotInit?.state === "NOT INIT", "not-init: scaffold badge = NOT INIT")
assert(projectNotInit?.variant === "error", "not-init: scaffold badge variant = error (red, distinct from warning)")
assert(
  badgesNotInit.filter((b) => b.label !== "scaffold" && b.label !== "memory").length === 0,
  "not-init: only scaffold + memory render (gating hides git-commits/codegraph/gitnexus/serena/tgrep/dprint before init; memory is lifecycle-independent and always renders when ON)",
)
rmSync(rootNotInit, { recursive: true, force: true })

// ─── 2. Partially-init project: PARTIAL + warning ───
const rootPartial = mkdtempSync(join(tmpdir(), "sidebar-badge-partial-"))
mkdirSync(join(rootPartial, ".opencode"))
writeFileSync(join(rootPartial, ".opencode", "opencode.jsonc"), "{}")
const badgesPartial = buildProjectBadges(rootPartial, noMcp)
const projectPartial = badgesPartial.find((b) => b.label === "scaffold")
assert(projectPartial?.state === "PARTIAL", "partial: scaffold badge = PARTIAL")
assert(projectPartial?.variant === "warning", "partial: scaffold badge variant = warning (yellow, less severe than error)")
rmSync(rootPartial, { recursive: true, force: true })

// ─── 3. Fully-init project: INIT + success; git-commits rendered; MCP rows hidden ───
const rootInit = mkdtempSync(join(tmpdir(), "sidebar-badge-init-"))
mkdirSync(join(rootInit, ".opencode"))
writeFileSync(join(rootInit, ".opencode", "opencode.jsonc"), "{}")
mkdirSync(join(rootInit, "docs"))
writeFileSync(join(rootInit, "docs", "git-commits.md"), "")
writeFileSync(join(rootInit, "AGENTS.md"), "")
const badgesInit = buildProjectBadges(rootInit, noMcp)
const projectInit = badgesInit.find((b) => b.label === "scaffold")
assert(projectInit?.state === "INIT", "init: scaffold badge = INIT")
assert(projectInit?.variant === "success", "init: scaffold badge variant = success (green)")
assert(badgesInit.some((b) => b.label === "git-commits"), "init: git-commits badge rendered")
assert(badgesInit.find((b) => b.label === "codegraph") === undefined, "init: codegraph hidden when MCP disabled")
assert(badgesInit.find((b) => b.label === "gitnexus") === undefined, "init: gitnexus hidden when MCP disabled")
assert(badgesInit.find((b) => b.label === "serena") === undefined, "init: serena hidden when MCP disabled")

// ─── 4. Tgrep badge contract: env-aware (tools.tgrep + CLI), but the 6-state label/variant table is fixed ───
// Tgrep readiness depends on the user's global config + CLI presence on PATH, so the
// test branches on the actual environment. When the badge renders, the contract
// (state in TGREP_STATE_LABEL, variant in {success,info,warning}) must hold regardless.
const cliOnPath = spawnSync("tgrep", ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true }).status === 0
const switchOn = loadTgrepOptions(rootInit).enabled
const tgrepBadge = badgesInit.find((b) => b.label === "tgrep")

if (switchOn && cliOnPath) {
  assert(tgrepBadge !== undefined, "init+tgrep+CLI: tgrep badge rendered")
} else {
  // tools.tgrep=false OR CLI missing -> resolveTgrep returns "off" -> filtered out by OFF filter
  assert(tgrepBadge === undefined, "init+tgrep off/missing: badge hidden by OFF filter")
}

if (tgrepBadge) {
  const KNOWN_STATES = ["READY", "NO WATCHER", "STALE", "BUILDING", "NO INDEX", "NO CLI"]
  assert(KNOWN_STATES.includes(tgrepBadge.state), `tgrep badge state "${tgrepBadge.state}" is one of ${KNOWN_STATES.join(", ")} (matches [PROJECT CAPABILITIES] block)`)
  assert(["success", "info", "warning"].includes(tgrepBadge.variant), `tgrep badge variant "${tgrepBadge.variant}" is success/info/warning (per state severity tier)`)
  // The variant contract is: ready → success, building → info, everything else (no-watcher/stale/no-index/no-cli) → warning
  const variantForState = (s: string): string =>
    s === "READY" ? "success" : s === "BUILDING" ? "info" : "warning"
  assert(tgrepBadge.variant === variantForState(tgrepBadge.state), `tgrep badge variant "${tgrepBadge.variant}" matches the state → variant contract for ${tgrepBadge.state}`)
}

rmSync(rootInit, { recursive: true, force: true })

if (failed > 0) process.exit(1)
console.log("Sidebar tgrep badge: PASS")