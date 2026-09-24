/**
 * tool-compress Plugin — Unit Tests (v2, no opencode runtime dependency)
 *
 * V2 model: one "context" hook reads the agent straight off the event and
 * rewrites `e.tools[...].description` per request — there is no cross-hook
 * state (v1's chat.message/chat.params agent tracking is gone), so gating
 * is a pure function of e.agent.
 *
 * Covers:
 *   - description-only rewrites for @lite and @build (input/jsonSchema untouched)
 *   - gating: rewrite applies only when the event agent is a COMPRESS agent
 *   - task/skill prose is per-agent (lite five-assist vs build full roster)
 *   - v1 id aliases onto v2 tool ids (bash→shell/execute, task→subagent)
 *   - unknown/MCP tools are left intact (not in OVERRIDES)
 *   - tgrep_search description is owned by the tgrep plugin, not this one
 *   - plugin entry registers the "context" hook via setup()
 *
 * Run: bun test ./tests/test-tool-compress-unit.ts
 */

import ToolCompressPlugin, { toolCompressContextHook, compressedDescription } from "../plugins/tool-compress"

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

type Tools = Record<string, { description?: string; input?: unknown }>

function eventWith(agent: string | undefined, tools: Tools): { agent?: string; tools: Tools } {
  return { agent, tools }
}

// ─── Plugin entry shape ────────────────────────────────────────────────────

section("plugin entry (Plugin.define shape)")

assert(ToolCompressPlugin.id === "tool-compress", "stable id kept from v1 name")
assert(typeof ToolCompressPlugin.setup === "function", "setup() present")

{
  const hooks = new Map<string, (e: never) => Promise<void>>()
  const ctx = { session: { hook: async (n: string, cb: (e: never) => Promise<void>) => { hooks.set(n, cb); return { dispose: async () => {} } } } }
  const cleanup = await ToolCompressPlugin.setup(ctx as never)
  assert(hooks.has("context"), 'setup registers the "context" hook')
  assert(typeof cleanup === "function", "setup returns a cleanup")
  await cleanup()
}

// ─── Gate closed for unknown/absent agent ──────────────────────────────────

section("gate: no rewrite when agent is absent or not a compress agent")

{
  const e = eventWith(undefined, { bash: { description: "Execute a shell command " + "x".repeat(4000) } })
  await toolCompressContextHook(e)
  assert((e.tools.bash?.description?.length ?? 0) > 4000, "no rewrite when agent unknown")
}

{
  const e = eventWith("code", { bash: { description: "x".repeat(4655) } })
  await toolCompressContextHook(e)
  assert(e.tools.bash!.description!.length === 4655, "non-compressed agent keeps stock description")
}

// ─── Lite ──────────────────────────────────────────────────────────────────

section("gate: rewrites only descriptions for @lite")

{
  const e = eventWith("lite", {
    bash: { description: "x".repeat(4655) },
    task: { description: "x".repeat(1800) },
    read: { description: "x".repeat(1158) },
    skill: { description: "x".repeat(900) },
    // a tool with a schema — must NOT be altered, only description is touched
    write: { description: "x".repeat(1000), input: { type: "object", properties: { filePath: { type: "string" } } } },
  })
  await toolCompressContextHook(e)
  assert((e.tools.bash?.description?.length ?? 0) < 300, "bash description compressed for lite")
  assert((e.tools.bash?.description ?? "").includes("workdir"), "compressed bash keeps the workdir rule")

  const taskDesc = e.tools.task?.description ?? ""
  assert(taskDesc.includes("explore") && taskDesc.includes("code-review-fast") && taskDesc.includes("code-review") && taskDesc.includes("advisor") && taskDesc.includes("vision"),
    "task compressed to the five-assist roster for lite")
  assert(!taskDesc.includes("researcher"), "task roster hides subagents lite cannot dispatch")

  assert((e.tools.read?.description?.length ?? 999) < 200, "read description compressed for lite")
  assert((e.tools.read?.description ?? "").includes("offset"), "compressed read keeps offset mention")

  const skillDesc = e.tools.skill?.description ?? ""
  assert(skillDesc.includes("memory-summarize") && skillDesc.includes("handoff") && skillDesc.includes("git-merge"),
    "lite skill prose names git + handoff + memory-summarize")
  assert(!skillDesc.includes("sdd-workflow"), "lite skill prose is not build's full roster")

  // description-only contract: the input schema survives untouched
  assert(e.tools.write?.input !== undefined, "write tool input schema preserved (description-only rewrite)")
}

// ─── Unknown/MCP tools left intact ─────────────────────────────────────────

section("unknown/MCP tools: left intact (not in OVERRIDES)")

{
  const e = eventWith("lite", { md_to_pdf: { description: "Convert markdown to PDF" } })
  await toolCompressContextHook(e)
  assert(e.tools.md_to_pdf?.description === "Convert markdown to PDF", "unknown/MCP tools left intact")
}

{
  const e = eventWith("lite", { tgrep_search: { description: "Built-in OpenCode tool for codebase-wide text/regex search..." } })
  await toolCompressContextHook(e)
  assert((e.tools.tgrep_search?.description ?? "").startsWith("Built-in OpenCode tool"),
    "tgrep_search description untouched (owned by tgrep plugin)")
}

// ─── Build ─────────────────────────────────────────────────────────────────

section("gate: @build compresses shared tools + build rosters")

{
  const e = eventWith("build", {
    bash: { description: "x".repeat(4655) },
    task: { description: "x".repeat(1800) },
    skill: { description: "x".repeat(900) },
  })
  await toolCompressContextHook(e)
  assert((e.tools.bash?.description?.length ?? 0) < 300, "bash description compressed for build")
  assert((e.tools.bash?.description ?? "").includes("workdir"), "compressed bash keeps the workdir rule for build")

  const taskDesc = e.tools.task?.description ?? ""
  assert(taskDesc.includes("architect") && taskDesc.includes("code-review"), "build task roster names the full team")
  assert(!taskDesc.includes("five-assist"), "build task roster is not lite's five-assist list")

  const skillDesc = e.tools.skill?.description ?? ""
  assert(skillDesc.includes("sdd-workflow") && skillDesc.includes("git-merge") && skillDesc.includes("handoff"),
    "build skill prose names full roster (sdd + git + handoff)")
  assert(!skillDesc.includes("five-assist"), "build skill prose is not lite's five-assist list")
}

// ─── v1→v2 tool id aliases ─────────────────────────────────────────────────

section("aliases: v2 tool ids (shell/execute/subagent) get compressed")

assert(compressedDescription("shell", "lite") !== null, "shell aliases to bash override for lite")
assert(compressedDescription("execute", "lite") !== null, "execute aliases to bash override for lite")
assert(compressedDescription("subagent", "lite") !== null, "subagent aliases to task override for lite")
assert((compressedDescription("subagent", "lite") ?? "").includes("explore"), "subagent gets the lite five-assist roster")
assert(compressedDescription("subagent", "code") === null, "alias still gated by agent")
assert(compressedDescription("write", "code") === null, "non-compress agent → null")

// A real v2-shaped event using v2 tool ids.
{
  const e = eventWith("lite", { shell: { description: "x".repeat(4000) }, subagent: { description: "x".repeat(2000) } })
  await toolCompressContextHook(e)
  assert((e.tools.shell?.description?.length ?? 0) < 300, "shell tool compressed in a live event for lite")
  assert((e.tools.subagent?.description ?? "").includes("explore"), "subagent tool gets lite roster in a live event")
}

console.log(`\n${"─".repeat(60)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
