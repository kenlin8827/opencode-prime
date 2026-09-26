/** Real OpenCode 2.x integration with a local deterministic model fixture.
 * No provider credentials or paid model calls. Runtime discovery + isolation
 * live in tests/helpers/v2-runtime.ts; without a v2 runtime this prints an
 * explicit [SKIP] and exits 0 (CI-friendly).
 * Run separately: bun tests/test-adr-compaction-runtime.ts
 *
 * V2 Ask surface (N3 re-architecture, plugins/adr/adr-compaction-runtime.ts):
 * the model calls the native `question` tool with the EXACT questions handed
 * back by adr_compaction ask/submit; the tool blocks on a server-side session
 * FORM which this test settles over POST /api/session/:id/form/:formID/reply.
 * Authorization is the tool's completed, server-produced answer consumed by
 * the plugin's execute.after hook — the trust property under test is that the
 * plan only advances when a real form answer lands (plan.approval.actor is
 * `question:<callID>;session:<id>`, and a model-forged argument can never
 * reach applyPlan), plus "approval injects no extra model turn".
 * The fixture model is CONTENT-DRIVEN (tests/helpers/v2-fixture-model.ts):
 * handled ADR commands inject replies via session.synthetic, which wakes the
 * model on the v2 host, so a positional step machine would desync.
 */
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { locateV2Runtime, startV2Server, type FormInfo, type V2Server } from "./helpers/v2-runtime"
import { adrFixtureNextTurn, isMainFlowConversation } from "./helpers/v2-fixture-model"

const runtime = locateV2Runtime({ repoRoot: resolve(import.meta.dir, "..") })
if (!runtime) {
  console.log("[SKIP] test-adr-compaction-runtime: no OpenCode v2 runtime discoverable — set OCP_TEST_OPENCODE_BIN (>=2.0.0) or provide .ocp/sandbox/v2src (see .ocp/sandbox/WORKING-EXAMPLE/README.md)")
  process.exit(0)
}
if (!process.env.ADR_TEST_CHOICE) {
  for (const choice of ["accept", "drafts", "modify", "cancel"]) {
    const child = Bun.spawnSync([process.execPath, import.meta.path], { env: { ...process.env, ADR_TEST_CHOICE: choice }, stdout: "inherit", stderr: "inherit" })
    assert.equal(child.exitCode, 0, `Native Ask ${choice} failed`)
  }
  process.exit(0)
}
const choice = process.env.ADR_TEST_CHOICE!
const root = mkdtempSync(join(tmpdir(), "adr-runtime-"))
const dir = join(root, "proj")
const record = (id: string, status: string) => `---\nstyle: nygard\nstatus: ${status}\ndate: 2026-09-19\nlayer: system\n---\n\n# ${id.slice(4)}. Boundaries\n\n## Context\n\nNeed isolation.\n\n## Decision\n\nUse explicit boundaries.\n\n## Consequences\n\nValidate calls.\n`
mkdirSync(join(dir, "docs/adr"), { recursive: true }); mkdirSync(join(dir, ".ocp"))
mkdirSync(join(dir, ".opencode/skills/adr-compaction"), { recursive: true })
writeFileSync(join(dir, ".opencode/skills/adr-compaction/SKILL.md"), readFileSync(resolve(import.meta.dir, "../skills/adr-compaction/SKILL.md"), "utf8"))
writeFileSync(join(dir, "docs/adr/0001-boundaries.md"), record("ADR-0001", "accepted"))
writeFileSync(join(dir, ".ocp/ocp.json"), JSON.stringify({ adr: { style: "nygard", numbering: "sequential", governance: "strict", layout: "flat" } }))
// v2 auto-discovery loads plugin FILES only from a plugins/ directory; the
// wrapper re-exports the repository plugin verbatim (no fixture copy drift).
mkdirSync(join(dir, ".opencode/plugins"), { recursive: true })
writeFileSync(join(dir, ".opencode/plugins/adr-runtime.ts"), `const { AdrPlugin } = await import(${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "../plugins/adr.ts")).href)})\nexport default AdrPlugin\n`)
let mainTurns = 0
const sse = (chunks: unknown[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
const textTurn = (id: string, text: string) => {
  const base = { id, object: "chat.completion.chunk", created: 123, model: "fixture" }
  return sse([
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
  ])
}
let utilityCalls = 0
const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const body = await request.json() as any
  // Requests without tool definitions are utility calls (native title
  // generation and friends) — answer inertly, never count as a turn.
  if (!body.tools?.length) { utilityCalls++; return textTurn(`util-${utilityCalls}`, "ADR runtime fixture") }
  const action = adrFixtureNextTurn(body.messages, {
    record,
    plan: (id) => JSON.parse(readFileSync(join(dir, ".ocp/adr-compaction", `${id}.json`), "utf8")),
    archivedPath: join(dir, "docs/adr/archive/0001-boundaries.md"),
  })
  if (isMainFlowConversation(body.messages)) mainTurns++
  const base = { id: `fixture-${utilityCalls + mainTurns}`, object: "chat.completion.chunk", created: 123, model: "fixture" }
  if (action.kind === "final") return textTurn(base.id, action.text)
  const delta = { role: "assistant", tool_calls: [{ index: 0, id: `call_${base.id}`, type: "function", function: { name: action.name, arguments: JSON.stringify(action.args) } }] }
  return sse([
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
  ])
} })
writeFileSync(join(dir, "opencode.json"), JSON.stringify({
  model: "adr-fixture/fixture",
  skills: ["./.opencode/skills"],
  providers: { "adr-fixture": { name: "Local deterministic fixture", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "test-only-not-a-credential" }, models: { fixture: { name: "fixture", limit: { context: 128000, output: 8192 }, cost: { input: 0, output: 0 } } } } },
}))
let server: V2Server | undefined
const timer = setTimeout(async () => { await server?.close(); throw new Error("adr-compaction runtime test exceeded 420s") }, 420_000)
try {
  server = await startV2Server(runtime, { project: dir, listenTimeoutMs: 240_000 })
  // v2 replaced v1's /experimental/tool/ids listing: plugin activation is the
  // server-visible proof that setup() registered the ADR tools/commands.
  await server.waitForPlugin("opencode-prime.adr")
  await server.waitForSkill("adr-compaction")
  const readPlan = (id: string) => JSON.parse(readFileSync(join(dir, ".ocp/adr-compaction", `${id}.json`), "utf8"))
  const answer = async (sessionID: string, form: FormInfo, header: string, optionIndex: number) => {
    const field = form.fields.find(f => f.title === header)!
    assert.ok(field.options, `form '${header}' carries no options`)
    await server!.replyForm(sessionID, form.id, { [field.key]: field.options![optionIndex].value })
  }
  // Read-only command on a DISPOSABLE session: it injects its analysis via
  // session.synthetic, which wakes the model on the v2 host (see
  // v2-fixture-model header) — kept out of the measured main session.
  const drySession = await server.createSession("adr dry run", { providerID: "adr-fixture", id: "fixture" })
  const dry = await server.command(drySession.id, "adr", "compaction --dry-run")
  assert.equal(dry.status, 204)
  assert.equal(mainTurns, 0, "a read-only command must not drive the drafting flow")
  const session = await server.createSession("adr runtime native ask", { providerID: "adr-fixture", id: "fixture" })
  const running = server.command(session.id, "adr", "compaction --mode consolidate --archive")
  const cost = await server.waitForForm(session.id, "ADR drafting cost")
  const costField = cost.fields.find(f => f.title === "ADR drafting cost")!
  assert.equal(costField.options!.length, 2)
  await answer(session.id, cost, "ADR drafting cost", 0)
  const review = await server.waitForForm(session.id, "ADR review")
  const reviewField = review.fields.find(f => f.title === "ADR review")!
  assert.equal(reviewField.options!.length, 4)
  assert.equal((await running).status, 204)
  const choiceIndex = ["accept", "drafts", "modify", "cancel"].indexOf(choice)
  await answer(session.id, review, "ADR review", choiceIndex)
  await server.waitIdle(session.id)
  const planId = readdirSync(join(dir, ".ocp/adr-compaction")).find(n => /^cp-[a-f0-9]{16}\.json$/.test(n))!.slice(0, -5)
  const result = readPlan(planId)
  assert.equal(mainTurns, 9, `Approval must not inject another model turn (turns=${mainTurns})`)
  // Trust property: every persisted actor is minted by the plugin from the
  // question tool's SERVER-produced result, never from a model argument.
  // 'modify' requests changes and 'cancel' dismisses — both authorize nothing
  // and must leave no approval actor (engine applies cancel before writing
  // any approval record).
  assert.match(result.costApproval.actor, /^question:/)
  if (choice === "modify" || choice === "cancel") assert.equal(result.approval?.actor, undefined, `'${choice}' must not authorize execution`)
  else assert.match(result.approval.actor, /^question:/)
  if (choice !== "accept") {
    assert.equal(result.state, { drafts: "drafts", modify: "review", cancel: "cancelled" }[choice as "drafts" | "modify" | "cancel"])
    assert.match(readFileSync(join(dir, "docs/adr/0001-boundaries.md"), "utf8"), /status: accepted/)
    assert.ok(!existsSync(join(dir, "docs/adr/CURRENT.md")))
    assert.ok(!existsSync(join(dir, ".ocp/adr-decisions.log")))
    const draft = join(dir, "docs/adr/0002-consolidated-boundaries.md")
    assert.equal(existsSync(draft), choice === "drafts")
    if (choice === "drafts") assert.match(readFileSync(draft, "utf8"), /status: proposed/)
    console.log(`PASS real v2 runtime: native Ask ${choice} via server form; no acceptance, retirement, publication or archive`)
  } else {
    assert.equal(result.state, "complete", JSON.stringify(result))
    const transcript = await server.messages(session.id)
    const tools = transcript.filter(m => m.type === "assistant").flatMap(m => m.content ?? [])
    const skill = tools.find((c: any) => c.type === "tool" && c.name === "skill")
    assert.equal(skill?.state?.status, "completed", "Native skill discovery/loading must work")
    assert.match(readFileSync(join(dir, ".ocp/adr-decisions.log"), "utf8"), /ADR-0002/)
    assert.match(readFileSync(join(dir, "docs/adr/archive/0001-boundaries.md"), "utf8"), /superseded/)
    assert.match(readFileSync(join(dir, "docs/adr/CURRENT.md"), "utf8"), /ADR-0002/)
    const guardConfig = await server.command(session.id, "adr", "config readGuard guard")
    assert.equal(guardConfig.status, 204)
    const guardRun = await server.prompt(session.id, "Read the archived original directly to validate the read guard.")
    assert.equal(guardRun.status, 200, await guardRun.text())
    await server.waitIdle(session.id)
    const guarded = (await server.messages(session.id)).filter(m => m.type === "assistant").flatMap(m => m.content ?? [])
      .find((c: any) => c.type === "tool" && c.name === "read" && c.state?.status === "error")
    assert.match(JSON.stringify(guarded?.state?.error ?? guarded?.state ?? ""), /ADR-READ-GUARD/)
    console.log("PASS real v2 runtime: supported archive read blocked before body output")
    console.log("PASS real v2 runtime: registration, read-only command, bounded drafting, native Ask via session form, strict acceptance ledger, CURRENT/index publication, archive")
  }
} catch (error) {
  console.error(`FAILED real v2 runtime (${choice}): ${String(error)}`)
  console.error(server?.stderr().slice(-8000) ?? "server never started")
  throw error
} finally {
  clearTimeout(timer)
  await server?.close()
  rmSync(root, { recursive: true, force: true })
  model.stop(true)
}
