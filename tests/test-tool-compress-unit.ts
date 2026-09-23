/**
 * tool-compress Plugin — Unit Tests (no opencode runtime dependency)
 *
 * Covers:
 *   - tool.definition rewrites descriptions for @lite and @build (description
 *     only, parameters and jsonSchema stay untouched)
 *   - gating: rewrite applies only after chat.message reports a COMPRESS agent
 *   - task/skill prose is per-agent (lite five-assist vs build full roster)
 *   - chat.params provides redundant agent signal
 *   - unknown/MCP tools are left intact (not in OVERRIDES)
 *   - tgrep_search description is owned by the tgrep plugin, not this one
 *
 * Run: bun tests/test-tool-compress-unit.ts
 */

import { ToolCompressPlugin } from "../plugins/tool-compress"

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✅ ${msg}`)
    passed++
  } else {
    console.error(`  ❌ ${msg}`)
    failed++
  }
}

function section(title: string): void {
  console.log(`\n${"═".repeat(60)}`)
  console.log(`  ${title}`)
  console.log(`${"═".repeat(60)}`)
}

const plugin = await ToolCompressPlugin()
const onMessage = plugin["chat.message"]!
const onParams = plugin["chat.params"]!
const onToolDef = plugin["tool.definition"]!

// ─── Gate closed before any chat.message ─────────────────────────────────

section("gate: closed before chat.message")

{
  const output = { description: "Execute a shell command " + "x".repeat(4000) }
  await onToolDef({ toolID: "bash" } as any, output)
  assert(output.description.length > 4000, "no rewrite before an agent is known")
}

// ─── Gate opens for lite ─────────────────────────────────────────────────

section("gate: rewrites only descriptions for @lite")

await onMessage({ sessionID: "s1", agent: "lite" } as any, {} as any)

{
  const output = { description: "x".repeat(4655) }
  await onToolDef({ toolID: "bash" } as any, output)
  assert(output.description.length < 300, "bash description compressed for lite")
  assert(output.description.includes("workdir"), "compressed bash keeps the workdir rule")
}

{
  const output = { description: "x".repeat(1800) }
  await onToolDef({ toolID: "task" } as any, output)
  assert(output.description.includes("explore") && output.description.includes("code-review-fast") && output.description.includes("code-review") && output.description.includes("advisor") && output.description.includes("vision"), "task compressed to the five-assist roster for lite")
  assert(!output.description.includes("researcher"), "task roster hides subagents lite cannot dispatch")
}

{
  const output = { description: "x".repeat(1158) }
  await onToolDef({ toolID: "read" } as any, output)
  assert(output.description.length < 200, "read description compressed for lite")
  assert(output.description.includes("offset"), "compressed read keeps offset mention")
}

{
  const output = { description: "x".repeat(900) }
  await onToolDef({ toolID: "skill" } as any, output)
  // Lite roster: five git ops + handoff + memory-summarize (agent: lite).
  assert(output.description.includes("memory-summarize") && output.description.includes("handoff") && output.description.includes("git-merge"), "lite skill prose names git + handoff + memory-summarize")
  assert(!output.description.includes("sdd-workflow"), "lite skill prose is not build's full roster")
}

// ─── Unknown/MCP tools left intact ───────────────────────────────────────

section("unknown/MCP tools: left intact (not in OVERRIDES)")

{
  const output = { description: "Convert markdown to PDF" }
  await onToolDef({ toolID: "md_to_pdf" } as any, output)
  assert(output.description === "Convert markdown to PDF", "unknown/MCP tools left intact")
}

// ─── Gate: build compresses shared tools with build-specific rosters ─────

section("gate: @build compresses shared tools + build rosters")

await onMessage({ sessionID: "s2", agent: "build" } as any, {} as any)

{
  const output = { description: "x".repeat(4655) }
  await onToolDef({ toolID: "bash" } as any, output)
  assert(output.description.length < 300, "bash description compressed for build")
  assert(output.description.includes("workdir"), "compressed bash keeps the workdir rule for build")
}

{
  const output = { description: "x".repeat(1800) }
  await onToolDef({ toolID: "task" } as any, output)
  assert(output.description.includes("architect") && output.description.includes("code-review"), "build task roster names the full team")
  assert(!output.description.includes("five-assist"), "build task roster is not lite's five-assist list")
}

{
  const output = { description: "x".repeat(900) }
  await onToolDef({ toolID: "skill" } as any, output)
  assert(output.description.includes("sdd-workflow") && output.description.includes("git-merge") && output.description.includes("handoff"), "build skill prose names full roster (sdd + git + handoff)")
  assert(!output.description.includes("five-assist"), "build skill prose is not lite's five-assist list")
}

// ─── Gate closes again for other agents ──────────────────────────────────

section("gate: other agents keep stock descriptions")

await onMessage({ sessionID: "s4", agent: "code" } as any, {} as any)

{
  const output = { description: "x".repeat(4655) }
  await onToolDef({ toolID: "bash" } as any, output)
  assert(output.description.length === 4655, "no rewrite for non-compressed agents (bash stock for code)")
}

// ─── tgrep_search description is owned by the tgrep plugin, not tool-compress ─

section("ownership: tgrep_search description is NOT modified by tool-compress")

// tgrep_search now sets its own description via `plugins/tgrep.ts` (loaded
// from `plugins/tgrep/tgrep-tool-description.md`). tool-compress only
// short-circuits tools it knows about; an unknown tool ID leaves the
// output untouched, so the plugin's description survives.
await onMessage({ sessionID: "s3", agent: "code" } as any, {} as any)

{
  const output = { description: "Built-in OpenCode tool for codebase-wide text/regex search..." }
  await onToolDef({ toolID: "tgrep_search" } as any, output)
  assert(output.description.startsWith("Built-in OpenCode tool"), "tgrep_search description untouched by tool-compress (owned by tgrep plugin)")
}

// ─── chat.params provides redundant agent signal ─────────────────────────

section("signal: chat.params alone opens the gate")

await onParams({ sessionID: "sp", agent: "lite", model: {}, provider: {}, message: {} } as any, {} as any)

{
  const output = { description: "x".repeat(4655) }
  await onToolDef({ toolID: "bash" } as any, output)
  assert(output.description.length < 300, "chat.params alone activates compression")
}

// ─── Missing agent field keeps last known agent ──────────────────────────

section("gate: agent-less messages do not reset state")

await onMessage({ sessionID: "s3", agent: "lite" } as any, {} as any)
await onMessage({ sessionID: "s3" } as any, {} as any)

{
  const output = { description: "x".repeat(2305) }
  await onToolDef({ toolID: "bash" } as any, output)
  assert(output.description.length < 300, "lite state persists across agent-less messages")
}

console.log(`\n${"─".repeat(60)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
