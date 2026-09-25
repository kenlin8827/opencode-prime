/**
 * Lite-Mode Plugin — Unit Tests (no opencode runtime dependency)
 *
 * Covers:
 *   - stripLiteOverhead: instruction-block removal, sentinel KEPT as the
 *     cross-plugin lite signal, non-instruction content preserved, idempotency
 *   - LiteModePlugin hook: strips only when the sentinel is present,
 *     leaves other agents' system prompts untouched
 *   - shared/plugin-scope: policy-driven agent identification (identifiers)
 *     and the two-step agent-scope gate (scopedForAgent)
 *
 * Run: npx tsx tests/test-lite-mode-unit.ts
 */

import { LiteModePlugin, stripLiteOverhead, isInstructionPath } from "../plugins/lite-mode/lite-mode"
import { detectAgent, detectAgentByName } from "../plugins/shared/plugin-scope"
import { scopedForAgent } from "../plugins/shared/agent-scope"
import scopeFile from "../plugin-scope.json"
import { readFileSync } from "node:fs"

// The lite identifier match text is policy data — fixtures read it directly.
const SENTINEL = (scopeFile as any).identifiers.lite.contains as string

// ─── Test framework ───────────────────────────────────────────────────────

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

// ─── Fixtures ─────────────────────────────────────────────────────────────
// Mirrors opencode v1.18.25 assembly: [agentPrompt, ...env, ...instructions,
// mcpInstructions?, skills?].join("\n"); each instruction segment is
// `Instructions from: <path>\n<file content>` and files end with a newline.

const ENV_BLOCK = "You are powered by the model named flash.\nWorking directory: /repo"

const INSTRUCTIONS = [
  "Instructions from: /home/u/.config/opencode/instructions/rfc-keywords.md\nThe keywords MUST, SHALL, SHOULD carry RFC 2119 semantics.\n",
  "Instructions from: /home/u/.config/opencode/instructions/routing-index.md\n# On-demand rule routing\n\n- SQL migrations → @dba\n- Lightweight lookups → @lite\n",
  "Instructions from: /repo/AGENTS.md\nProject-specific rules live here.\nSecond line of project rules.\n",
]

const SKILLS_BLOCK = "<available_skills>\n- sdd-workflow: ...\n</available_skills>"

function joinSystem(agentPrompt: string): string {
  return [agentPrompt, ENV_BLOCK, ...INSTRUCTIONS, SKILLS_BLOCK].join("\n")
}

const LITE_PROMPT = `${SENTINEL}\nYou are lite, a minimal-overhead assistant.`
const SHIPPED_LITE_PROMPT = readFileSync(new URL("../prompts/lite.md", import.meta.url), "utf8")

// ─── stripLiteOverhead ────────────────────────────────────────────────────

section("stripLiteOverhead")

const stripped = stripLiteOverhead(joinSystem(LITE_PROMPT))

assert(!stripped.includes("Instructions from:"), "all instruction blocks removed")
assert(!stripped.includes("RFC 2119"), "L0 iron-rule content gone")
assert(!stripped.includes("@dba"), "content after internal blank line removed too")
assert(!stripped.includes("Project-specific rules"), "project AGENTS.md block gone")
assert(stripped.includes(SENTINEL), "sentinel kept as cross-plugin lite signal")
assert(stripped.includes("You are lite"), "agent prompt preserved")
assert(stripped.includes("Working directory"), "env block preserved")
assert(stripped.includes("<available_skills>"), "skills block preserved")
assert(!/\n{3,}/.test(stripped), "no triple blank lines left behind")
assert(!stripped.startsWith("\n"), "no leading blank lines")

const strippedShippedPrompt = stripLiteOverhead(joinSystem(SHIPPED_LITE_PROMPT))
assert(
  strippedShippedPrompt.includes("follow `output-protocol.md` §Session language"),
  "shipped lite prompt keeps the session-language cross-reference after stripping",
)

const strippedTwice = stripLiteOverhead(stripped)
assert(strippedTwice === stripped, "idempotent on already-stripped text")

// File without trailing newline glued straight to the skills tag.
const glued = `${LITE_PROMPT}\n${ENV_BLOCK}\nInstructions from: /a/b.md\nno trailing newline\n${SKILLS_BLOCK}`
const gluedOut = stripLiteOverhead(glued)
assert(!gluedOut.includes("no trailing newline"), "glued block stripped")
assert(gluedOut.includes("<available_skills>"), "tag terminator rescues glued skills")

// Non-path-like marker argument is prose, not an instruction block.
const prose = `head line\nInstructions from: the docs\ntail line`
const proseOut = stripLiteOverhead(prose)
assert(proseOut === prose.replace(/\s+$/, "").trim(), "non-path marker kept verbatim")

// ─── isInstructionPath ────────────────────────────────────────────────────

section("isInstructionPath")

assert(isInstructionPath("/home/u/.config/opencode/instructions/a.md"), "unix absolute path")
assert(isInstructionPath("~/rules.md"), "home-relative path")
assert(isInstructionPath("C:\\repo\\AGENTS.md"), "windows path")
assert(isInstructionPath("https://example.com/rules"), "remote URL")
assert(isInstructionPath("./docs/rules.txt"), "relative path")
assert(!isInstructionPath("the docs"), "plain prose rejected")
assert(!isInstructionPath(""), "empty rejected")

// ─── V2 plugin entry + "context" hook ─────────────────────────────────────
// V2 contract: default export is { id, setup(ctx) }; setup registers hook
// callbacks on a fake ctx and we invoke the captured "context" callback with
// a v2 event ({ agent, system: SystemPart[] }).

section("LiteModePlugin v2 entry")

assert(LiteModePlugin.id === "lite-mode", "plugin id kept from v1 name")
assert(typeof LiteModePlugin.setup === "function", "setup() present (Plugin.define shape)")

type Hook = (e: { agent?: string; system?: Array<{ type: string; text: string }> }) => Promise<void>
function fakeCtx() {
  const hooks = new Map<string, Hook>()
  const ctx = {
    session: {
      hook: async (name: string, cb: Hook) => {
        hooks.set(name, cb)
        return { dispose: async () => {} }
      },
    },
  }
  return { ctx: ctx as never, hooks }
}

const { ctx, hooks } = fakeCtx()
const cleanup = await LiteModePlugin.setup(ctx)
const hook = hooks.get("context")
assert(hook !== undefined, '"context" hook registered by setup()')
assert(typeof cleanup === "function", "setup() returns a cleanup")

{
  const e = { agent: "lite", system: [{ type: "text", text: joinSystem(LITE_PROMPT) }] }
  await hook!(e)
  assert(!e.system[0].text.includes("Instructions from:"), "strips when agent=lite (v2 primary channel)")
  assert(e.system[0].text.includes(SENTINEL), "sentinel survives the hook (injectors still need it)")
}

{
  // v1 parity: system-text sentinel identifies lite even when agent id differs.
  const e = { agent: "build", system: [{ type: "text", text: joinSystem(LITE_PROMPT) }] }
  await hook!(e)
  assert(!e.system[0].text.includes("Instructions from:"), "strips via text fallback when agent id is generic")
}

{
  const original = joinSystem("{file:prompts/build.md} expanded build prompt")
  const e = { agent: "build", system: [{ type: "text", text: original }] }
  await hook!(e)
  assert(e.system[0].text === original, "untouched without sentinel (other agents)")
}

{
  const e = {
    agent: "lite",
    system: [
      { type: "text", text: joinSystem(LITE_PROMPT) },
      { type: "text", text: joinSystem("other prompt") },
    ],
  }
  await hook!(e)
  assert(!e.system[0].text.includes("Instructions from:"), "multi-part: sentinel part stripped")
  assert(e.system[1].text.includes("Instructions from:"), "multi-part: other part intact")
}

{
  // Part object identity + non-text fields survive the rewrite.
  const part = { type: "text" as const, text: joinSystem(LITE_PROMPT) }
  const e = { agent: "lite", system: [part] }
  await hook!(e)
  assert(e.system[0] === part, "SystemPart object mutated in place (identity preserved)")
}

await cleanup!()

// ─── Policy-driven agent identification ─────────────────────────────────

section("shared/plugin-scope identification")

assert(detectAgent([SENTINEL]) === "lite", "lite sentinel identifies lite via plugin-scope.json")
assert(detectAgentByName("lite") === "lite", "v2 agent-id identifies lite (primary channel)")
assert(detectAgent([{ type: "text", text: SENTINEL }]) === "lite", "v2 SystemPart entries accepted by text detection")
assert(!(await scopedForAgent({ system: ["env", `${SENTINEL}\nYou are lite`] }, "sdd")), "sentinel in any entry blocks injection")
assert(await scopedForAgent({ system: ["env", "plain build prompt"] }, "sdd"), "no sentinel → injection allowed")
assert(await scopedForAgent({ system: [] }, "sdd"), "empty array → injection allowed")
assert(await scopedForAgent({ system: undefined }, "sdd"), "undefined → injection allowed")
assert(await scopedForAgent({ system: [42, null] as any }, "sdd"), "non-string entries ignored")

// ─── Utility-call gate ─────────────────────────────────────────────

section("shared/plugin-scope utility calls")

const TITLE_SYSTEM = ["You are a title generator. You output ONLY a thread title. Nothing else.", "env info"]
assert(!(await scopedForAgent({ system: TITLE_SYSTEM }, "sdd")), "gate blocks title calls (default policy denies utility)")
assert(!(await scopedForAgent({ system: [`${SENTINEL}\nlite prompt`] }, "sdd")), "gate blocks lite sessions (default policy denies lite)")
assert(await scopedForAgent({ system: ["normal build prompt"] }, "sdd"), "normal chat passes")

// ─── Summary ──────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
