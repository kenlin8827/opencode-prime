/**
 * Lite-Mode Plugin — Unit Tests (no opencode runtime dependency)
 *
 * Covers:
 *   - stripLiteOverhead: instruction-block removal, sentinel KEPT as the
 *     cross-plugin lite signal, non-instruction content preserved, idempotency
 *   - LiteModePlugin hook: strips only when the sentinel is present,
 *     leaves other agents' system prompts untouched
 *   - shared/plugin-scope: policy-driven agent identification (identifiers)
 *     and the two-step scoped() gate
 *
 * Run: npx tsx tests/test-lite-mode-unit.ts
 */

import { LiteModePlugin, stripLiteOverhead, isInstructionPath } from "../plugins/lite-mode/lite-mode"
import { detectAgent, scoped } from "../plugins/shared/plugin-scope"
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
  strippedShippedPrompt.includes("explicit output-language instructions win")
    && strippedShippedPrompt.includes("first user instructional prose")
    && strippedShippedPrompt.includes("LC_ALL` → `LANGUAGE` → `LANG")
    && strippedShippedPrompt.includes("translation targets do not persist")
    && strippedShippedPrompt.includes("explicit persistent switch changes it"),
  "shipped lite prompt retains the compact session-language protocol after stripping",
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

// ─── Hook ─────────────────────────────────────────────────────────────────

section("LiteModePlugin hook")

const plugin = await LiteModePlugin({} as any)
const hook = plugin["experimental.chat.system.transform"]!

{
  const output = { system: [joinSystem(LITE_PROMPT)] }
  await hook({ sessionID: "s1", model: {} as any }, output)
  assert(!output.system[0].includes("Instructions from:"), "strips when sentinel present")
  assert(output.system[0].includes(SENTINEL), "sentinel survives the hook (injectors still need it)")
}

{
  const original = joinSystem("{file:prompts/build.md} expanded build prompt")
  const output = { system: [original] }
  await hook({ sessionID: "s2", model: {} as any }, output)
  assert(output.system[0] === original, "untouched without sentinel (other agents)")
}

{
  const output = { system: [joinSystem(LITE_PROMPT), joinSystem("other prompt")] }
  await hook({ sessionID: "s3", model: {} as any }, output)
  assert(!output.system[0].includes("Instructions from:"), "multi-element: sentinel entry stripped")
  assert(output.system[1].includes("Instructions from:"), "multi-element: other entry intact")
}

// ─── Policy-driven agent identification ─────────────────────────────────

section("shared/plugin-scope identification")

assert(detectAgent([SENTINEL]) === "lite", "lite sentinel identifies lite via plugin-scope.json")
assert(!(await scoped(undefined, ["env", `${SENTINEL}\nYou are lite`], "sdd")), "sentinel in any entry blocks injection")
assert(await scoped(undefined, ["env", "plain build prompt"], "sdd"), "no sentinel → injection allowed")
assert(await scoped(undefined, [], "sdd"), "empty array → injection allowed")
assert(await scoped(undefined, undefined, "sdd"), "undefined → injection allowed")
assert(await scoped(undefined, [42, null] as any, "sdd"), "non-string entries ignored")

// ─── Utility-call gate ─────────────────────────────────────────────

section("shared/plugin-scope utility calls")

const TITLE_SYSTEM = ["You are a title generator. You output ONLY a thread title. Nothing else.", "env info"]
assert(!(await scoped(undefined, TITLE_SYSTEM, "sdd")), "gate blocks title calls (default policy denies utility)")
assert(!(await scoped(undefined, [`${SENTINEL}\nlite prompt`], "sdd")), "gate blocks lite sessions (default policy denies lite)")
assert(await scoped(undefined, ["normal build prompt"], "sdd"), "normal chat passes")

// ─── Summary ──────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
