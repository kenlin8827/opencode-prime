import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MARKER,
  buildProfile,
  mcpEnabledFrom,
  profileKey,
  renderProfileBlock,
  type ProjectProfile,
} from "../plugins/project-profiler/project-profiler"
import { appendBlock, escapeRegExp, stripBlockByLine } from "../plugins/shared/system-block"

let failures = 0

function assert(condition: boolean, message: string): void {
  if (condition) return
  failures++
  console.error(`FAIL: ${message}`)
}

const profile: ProjectProfile = {
  codegraph: "ready",
  gitnexus: "unavailable",
  serena: "unavailable",
  tgrep: "ready",
}

const block = renderProfileBlock(profile)
assert(block.includes("CodeGraph=ready"), "indexed CodeGraph is a compact ready capability")
assert(block.includes("GitNexus=unavailable"), "absent GitNexus is an explicit unavailable capability")
assert(block.includes("tgrep=ready"), "ready tgrep is exposed separately as a text index")
assert(block.includes(MARKER), "renderProfileBlock emits the [PROJECT CAPABILITIES] marker")
// V2 enablement shape: servers live under `mcp.servers`, the flag is
// `disabled`, and only an explicit `disabled: true` turns a backend off.
// (The plugin-side `ctx.mcp.list()` cannot be the source: measured on
// v2.0.15 it returns `{ data: [] }` for every call shape a plugin can make.)
assert(mcpEnabledFrom('{"mcp":{"servers":{"codegraph":{"disabled":true}}}}', "codegraph") === false, "explicit disabled:true is unavailable")
assert(mcpEnabledFrom('{"mcp":{"servers":{"codegraph":{"disabled":false}}}}', "codegraph") === true, "explicit disabled:false is available")
assert(mcpEnabledFrom('{"mcp":{"servers":{"codegraph":{"type":"local"}}}}', "codegraph") === true, "configured without `disabled` is available (v2 default false)")
assert(mcpEnabledFrom('{"mcp":{}}', "codegraph") === false, "unconfigured MCP is unavailable")
assert(mcpEnabledFrom('{"mcp":{"codegraph":{"enabled":true}}}', "codegraph") === false, "a v1-shaped document is not read as enabled")

// An indexed backend is ready only when the index exists AND the server is
// enabled; Serena is live LSP, so enablement alone is enough. The enablement
// reader is injected so this stays deterministic (no home-config dependency).
const sandbox = mkdtempSync(join(tmpdir(), "prof-cap-"))
const on = (name: string) => name === "codegraph" || name === "serena"
try {
  assert(buildProfile(sandbox, on).codegraph === "unavailable", "enabled but no index dir is not ready")
  mkdirSync(join(sandbox, ".codegraph"))
  assert(buildProfile(sandbox, on).codegraph === "ready", "enabled + index dir is ready")
  assert(buildProfile(sandbox, () => false).codegraph === "unavailable", "index dir without enablement is not ready")
  assert(buildProfile(sandbox, on).serena === "ready", "serena needs only enablement (live LSP)")
  assert(buildProfile(sandbox, on).gitnexus === "unavailable", "unenabled gitnexus stays unavailable")
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

// ── profileKey: stable hash for equal profiles, distinct for different ──
//
// The cache correctness invariant for project-profiler. The hook compares
// the freshly-computed profile key against the last-injected one; if
// this helper produces equal keys for structurally equal profiles, the
// hook's idempotency check holds. If it ever produces equal keys for
// structurally different profiles (a collision), the hook would silently
// skip a real profile change.
{
  const a: ProjectProfile = { codegraph: "ready", gitnexus: "unavailable", serena: "unavailable", tgrep: "ready" }
  const b: ProjectProfile = { codegraph: "ready", gitnexus: "unavailable", serena: "unavailable", tgrep: "ready" }
  const c: ProjectProfile = { codegraph: "ready", gitnexus: "unavailable", serena: "unavailable", tgrep: "building" }
  const d: ProjectProfile = { codegraph: "unavailable", gitnexus: "unavailable", serena: "unavailable", tgrep: "ready" }

  assert(profileKey(a) === profileKey(b), "profileKey: equal profiles produce equal keys (idempotency)")
  assert(profileKey(a) !== profileKey(c), "profileKey: tgrep state change produces a different key (invalidation)")
  assert(profileKey(a) !== profileKey(d), "profileKey: codegraph state change produces a different key (invalidation)")
  assert(profileKey(a).length === 64, "profileKey: returns SHA-256 hex (64 chars)")
}

// ── escapeRegExp: keeps stripBlockByLine's regex in sync with MARKER ───
//
// `stripBlockByLine(system, MARKER)` constructs its pattern via
// `new RegExp(`\\n${escapeRegExp(MARKER)}`)`. If this helper breaks, the
// regex silently keeps matching the OLD marker text after a rename —
// regression would be invisible until a runtime actually preserves
// output.system across turns.
{
  assert(escapeRegExp("[PROJECT CAPABILITIES]") === "\\[PROJECT CAPABILITIES\\]",
    "escapeRegExp: escapes square brackets")
  assert(escapeRegExp("(a)+b") === "\\(a\\)\\+b",
    "escapeRegExp: escapes parentheses and plus")
  assert(escapeRegExp("a.b*c?") === "a\\.b\\*c\\?",
    "escapeRegExp: escapes dot, star, question mark")
  assert(escapeRegExp("plain") === "plain",
    "escapeRegExp: passes plain text through unchanged")
}

// ── renderProfileBlock ↔ profileKey round-trip ─────────────────────────
//
// The hook uses `profileKey(profile)` to decide whether to skip. When
// the profile changes, the hook re-renders via `renderProfileBlock` and
// re-injects. This case locks that the rendered block for a given
// profile is byte-identical across calls (so the strip-and-replace
// path always sees the same source string) AND that two profiles
// produce distinguishable blocks.
{
  const a: ProjectProfile = { codegraph: "ready", gitnexus: "unavailable", serena: "unavailable", tgrep: "ready" }
  const b: ProjectProfile = { codegraph: "ready", gitnexus: "unavailable", serena: "unavailable", tgrep: "ready" }
  const c: ProjectProfile = { codegraph: "ready", gitnexus: "unavailable", serena: "unavailable", tgrep: "building" }

  assert(renderProfileBlock(a) === renderProfileBlock(b),
    "renderProfileBlock: byte-identical for equal profiles (cache-stable)")
  assert(renderProfileBlock(a) !== renderProfileBlock(c),
    "renderProfileBlock: distinct for distinct profiles (cache-invalidation visible)")
}

// ── appendBlock: defensive coverage for the hook helper ────────────────
// SDK types `output.system` as string[] but observed opencode runtimes
// have passed empty arrays and all-object arrays; the helper must
// surface the block SOMEWHERE in every case so the model sees the
// capability state. Comprehensive coverage lives in
// tests/test-system-block-unit.ts; these cases are the ones the
// project-profiler hook exercises directly.

// Happy path: appends to last string entry.
{
  const sys: unknown[] = ["ROOT", "<!-- lite-mode -->\nLite content"]
  appendBlock(sys, block)
  assert(sys[sys.length - 1] === "<!-- lite-mode -->\nLite content" + block, "appendBlock: appends to last string entry")
}

// Empty array: pushes block as sole entry.
{
  const sys: unknown[] = []
  appendBlock(sys, block)
  assert(sys.length === 1 && sys[0] === block, "appendBlock: empty array pushes block as sole entry")
}

// Mixed array: appends to the LAST string entry, not to objects.
{
  const sys: unknown[] = ["ROOT", { type: "text", text: "extra" }, "<!-- lite-mode -->\nLite"]
  appendBlock(sys, block)
  assert(sys[2] === "<!-- lite-mode -->\nLite" + block, "appendBlock: mixed array appends to last string entry, not objects")
}

// ── stripBlockByLine + appendBlock: round-trip ──────────────────────────
//
// The hook's profile-change path runs `stripBlockByLine(system, MARKER)`
// then `appendBlock(system, renderProfileBlock(profile))`. The
// round-trip must:
//   - remove the stale block entirely (no marker text remains)
//   - leave the system with exactly one fresh block (no stacking)
//   - preserve everything before the marker line
// This is the actual bug-fix invariant from ADR 0002: a mid-session
// profile change must refresh the prompt, not stack on top of stale
// data.
{
  const staleProfile: ProjectProfile = { codegraph: "ready", gitnexus: "unavailable", serena: "unavailable", tgrep: "ready" }
  const freshProfile: ProjectProfile = { codegraph: "ready", gitnexus: "unavailable", serena: "unavailable", tgrep: "building" }
  const staleBlock = renderProfileBlock(staleProfile)
  const freshBlock = renderProfileBlock(freshProfile)
  const sys: unknown[] = ["ROOT\n<!-- lite-mode -->\nLite content" + staleBlock]

  stripBlockByLine(sys, MARKER)
  appendBlock(sys, freshBlock)

  assert(!(sys[0] as string).includes("tgrep=ready,") && !(sys[0] as string).includes("tgrep=ready\n"),
    "round-trip: stale 'tgrep=ready' is gone after strip+append")
  assert((sys[0] as string).includes("tgrep=building"),
    "round-trip: fresh 'tgrep=building' is present after strip+append")
  assert((sys[0] as string).split(MARKER).length === 2,
    "round-trip: exactly one marker remains (no stacking)")
  assert((sys[0] as string).startsWith("ROOT\n<!-- lite-mode -->\nLite content"),
    "round-trip: prefix before the marker line is preserved")
}

if (failures > 0) process.exit(1)
console.log("Project profiler capability contract: PASS")