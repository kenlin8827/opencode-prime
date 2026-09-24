/**
 * SDD (Specification-Driven Development) Unit Tests
 *
 * Tests:
 *   1. Phase definition and metadata
 *   2. Phase transition options (recommended + skips + backtrack + finish)
 *   3. Slugification
 *   4. Scaffolding (PRD & Plan) and idempotency
 *   5. Artifact discovery (listSddArtifacts)
 *   6. L2 disclosure: protocol lives in the sdd-workflow skill; /sdd /prd
 *      /plan /impl are thin command launchers (no system-prompt injection)
 *   7. Plugin shape (engine-only: command hook, no config/system hooks)
 *   8. Command hook execution (/sdd help, /sdd status, /prd, /plan)
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  getPhaseTransitionOptions,
  listSddArtifacts,
  scaffoldPlan,
  scaffoldPrd,
  SDD_PHASES,
  slugify,
  type SddPhase,
} from "../plugins/sdd/sdd-engine"
import { makeSddCommandHook } from "../plugins/sdd/sdd-command"
import SddPlugin, { parseSddCommand } from "../plugins/sdd/sdd"

let passed = 0
let failed = 0

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✅ ${msg}`)
    passed++
  } else {
    console.error(`  ❌ ${msg}`)
    failed++
  }
}

function header(title: string) {
  console.log(`\n════════════════════════════════════════════════════════════`)
  console.log(`  ${title}`)
  console.log(`════════════════════════════════════════════════════════════`)
}

// -------------------------------------------------------------
// 01: Phase definition & metadata
// -------------------------------------------------------------
header("01: Phase definition & metadata")
assert(Boolean(SDD_PHASES.prd), "PRD phase exists")
assert(Boolean(SDD_PHASES.adr), "ADR phase exists")
assert(Boolean(SDD_PHASES.plan), "PLAN phase exists")
assert(Boolean(SDD_PHASES.impl), "IMPL phase exists")
assert(SDD_PHASES.prd.recommendedNext === "adr", "PRD -> ADR")
assert(SDD_PHASES.adr.recommendedNext === "plan", "ADR -> PLAN")
assert(SDD_PHASES.plan.recommendedNext === "impl", "PLAN -> IMPL")

// -------------------------------------------------------------
// 02: Phase transition options & flexible skips
// -------------------------------------------------------------
header("02: Phase transition options & flexible skips")

const prdOptions = getPhaseTransitionOptions("prd")
assert(prdOptions.some((o) => o.isRecommended && o.targetPhase === "adr"), "PRD recommends /adr")
assert(prdOptions.some((o) => o.targetPhase === "plan"), "PRD allows jump to /plan")
assert(prdOptions.some((o) => o.targetPhase === "impl"), "PRD allows jump directly to /impl")
assert(prdOptions.some((o) => o.id === "finish"), "PRD allows finish/stay")

const adrOptions = getPhaseTransitionOptions("adr")
assert(adrOptions.some((o) => o.isRecommended && o.targetPhase === "plan"), "ADR recommends /plan")
assert(adrOptions.some((o) => o.targetPhase === "impl"), "ADR allows jump directly to /impl")
assert(adrOptions.some((o) => o.targetPhase === "prd"), "ADR allows back to /prd")

const planOptions = getPhaseTransitionOptions("plan")
assert(planOptions.some((o) => o.isRecommended && o.targetPhase === "impl"), "PLAN recommends /impl")
assert(planOptions.some((o) => o.targetPhase === "adr"), "PLAN allows back to /adr")
assert(planOptions.some((o) => o.targetPhase === "prd"), "PLAN allows back to /prd")

const implOptions = getPhaseTransitionOptions("impl")
assert(implOptions.some((o) => o.isRecommended && o.id === "qa"), "IMPL recommends /qa")
assert(implOptions.some((o) => o.id === "review"), "IMPL allows /code-review")
assert(implOptions.some((o) => o.id === "handoff"), "IMPL allows /handoff")

// -------------------------------------------------------------
// 03: Slugification
// -------------------------------------------------------------
header("03: Slugification")
assert(slugify("User Authentication") === "user-authentication", "Simple phrase slugified")
assert(slugify("用户认证") === "用户认证", "Unicode Chinese slugified cleanly")
assert(slugify("Payment_Gateway v2.0") === "payment-gateway-v20", "Special characters stripped")
assert(slugify("   multiple   spaces  ") === "multiple-spaces", "Whitespace normalized")
assert(slugify("---dashes---") === "dashes", "Leading/trailing dashes stripped")
assert(slugify("") === "feature", "Empty input fallbacks to 'feature'")

// -------------------------------------------------------------
// 04: Scaffolding (PRD & Plan)
// -------------------------------------------------------------
header("04: Scaffolding (PRD & Plan)")
const testTmpDir = join(process.cwd(), "scratch_test_sdd")
if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true })
mkdirSync(testTmpDir, { recursive: true })

try {
  // PRD scaffold
  const prd1 = scaffoldPrd(testTmpDir, "Shopping Cart")
  assert(prd1.created, "PRD scaffold created new file")
  assert(existsSync(prd1.path), "PRD file exists on disk")
  assert(prd1.relPath.includes("shopping-cart.md") && !prd1.relPath.includes("PRD-"), "PRD file has correct relative path without prefix")

  const prd2 = scaffoldPrd(testTmpDir, "Shopping Cart")
  assert(!prd2.created, "Second call does not overwrite existing PRD (idempotent)")

  // Plan scaffold
  const plan1 = scaffoldPlan(testTmpDir, "Shopping Cart")
  assert(plan1.created, "Plan scaffold created new file")
  assert(existsSync(plan1.path), "Plan file exists on disk")
  assert(plan1.relPath.includes("shopping-cart.md") && !plan1.relPath.includes("PLAN-"), "Plan file has correct relative path without prefix")

  const plan2 = scaffoldPlan(testTmpDir, "Shopping Cart")
  assert(!plan2.created, "Second call does not overwrite existing Plan (idempotent)")

  // Artifact discovery
  const artifacts = listSddArtifacts(testTmpDir)
  assert(artifacts.prds.length === 1, "Discovered 1 PRD")
  assert(artifacts.plans.length === 1, "Discovered 1 Plan")
} finally {
  if (existsSync(testTmpDir)) rmSync(testTmpDir, { recursive: true, force: true })
}

// -------------------------------------------------------------
// 05: L2 disclosure — skill body + thin command launchers
// -------------------------------------------------------------
header("05: L2 disclosure — skill body + command launchers")

const repoRoot = join(process.cwd())
const skillBody = readFileSync(join(repoRoot, "skills/sdd-workflow/SKILL.md"), "utf-8")
assert(skillBody.includes("name: sdd-workflow"), "sdd-workflow skill carries its frontmatter name")
assert(skillBody.includes("SDD Protocol"), "protocol body lives in the skill (on-demand L2)")
assert(skillBody.includes("/sdd handoff"), "merged protocol keeps the handoff section")

for (const cmd of ["sdd", "prd", "plan", "impl"]) {
  const launcher = readFileSync(join(repoRoot, `commands/${cmd}.md`), "utf-8")
  assert(launcher.includes("Load the sdd-workflow skill"), `/${cmd} launcher loads the sdd-workflow skill`)
  assert(launcher.includes("$ARGUMENTS"), `/${cmd} launcher forwards $ARGUMENTS`)
}
const planLauncher = readFileSync(join(repoRoot, "commands/plan.md"), "utf-8")
const implLauncher = readFileSync(join(repoRoot, "commands/impl.md"), "utf-8")
assert(planLauncher.includes("agent: plan"), "/plan routes to @plan")
assert(implLauncher.includes("agent: code"), "/impl routes to @code")

// -------------------------------------------------------------
// 06: Plugin shape — engine-only (no config / system hooks)
// -------------------------------------------------------------
header("06: Plugin shape — engine-only (v2)")

assert(SddPlugin.id === "sdd", "stable plugin id kept from v1 name")
assert(typeof SddPlugin.setup === "function", "setup() present (Plugin.define shape)")

{
  const hooks = new Map<string, (e: any) => Promise<void>>()
  const transforms: string[] = []
  const ctx: any = {
    session: { hook: async (name: string, cb: (e: any) => Promise<void>) => { hooks.set(name, cb); return { dispose: async () => {} } } },
    command: { transform: async () => { transforms.push("command"); return { dispose: async () => {} } } },
    tool: { transform: async () => { transforms.push("tool"); return { dispose: async () => {} } } },
  }
  await SddPlugin.setup(ctx)
  assert(hooks.has("prompt"), 'registers the "prompt" hook (v2 replacement for command.execute.before)')
  assert(!hooks.has("context"), "no context (system.transform) hook — protocol lives at L2")
  assert(transforms.length === 0, "no command/tool transform — commands come from commands/*.md")
}

// parseSddCommand: matches the template-defined commands, ignores others
assert(parseSddCommand("/sdd status")?.command === "sdd", "parseSddCommand recognizes /sdd")
assert(parseSddCommand("/sdd status")?.arguments === "status", "parseSddCommand extracts arguments")
assert(parseSddCommand("/prd build a cart")?.command === "prd", "parseSddCommand recognizes /prd")
assert(parseSddCommand("/plan x")?.command === "plan", "parseSddCommand recognizes /plan")
assert(parseSddCommand("/impl y")?.command === "impl", "parseSddCommand recognizes /impl")
assert(parseSddCommand("/usage") === null, "parseSddCommand ignores non-sdd commands")
assert(parseSddCommand("hello") === null, "parseSddCommand ignores plain prose")

// -------------------------------------------------------------
// 07: Command hook execution
// -------------------------------------------------------------
header("07: Command hook execution")

let promptedText = ""
// V2 session view: injectReply calls session.synthetic({ sessionID, text }).
const capturingSession: any = {
  synthetic: async ({ text }: { sessionID: string; text: string }) => {
    promptedText = text || ""
  },
}

const commandHook = makeSddCommandHook(capturingSession)

// /sdd help
await commandHook({ command: "sdd", arguments: "help", sessionID: "s1" })
assert(promptedText.includes("Specification-Driven Development"), "/sdd help outputs help text")

// /sdd status
await commandHook({ command: "sdd", arguments: "status", sessionID: "s1" })
assert(promptedText.includes("[SDD Status]"), "/sdd status outputs status text")

// /sdd handoff
await commandHook({ command: "sdd", arguments: "handoff", sessionID: "s1" })
assert(promptedText.includes("Generating SDD Handoff Package"), "/sdd handoff announces handoff generation")

// =============================================================
// Summary
// =============================================================
console.log(`\n════════════════════════════════════════════════════════════`)
console.log(`  Result: ${passed} passed / ${failed} failed`)
console.log(`════════════════════════════════════════════════════════════\n`)

if (failed > 0) process.exit(1)
