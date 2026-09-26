/** Real process-death / restart / restore acceptance test on OpenCode v2.
 * No paid calls. The fault is a filesystem trap, not production code: with
 * the source ADR marked read-only (Windows EPERM on replace), the journal
 * apply dies AFTER publishing the ledger + accepted successor and BEFORE
 * finishing the lifecycle; the test then hard-kills the idle server so a
 * restart must recover the half-applied transaction exactly.
 *
 * Why not v1's renameSync monkey-patch: the v2 plugin host evaluates plugin
 * module graphs so that builtin-exports patches from a fixture wrapper are
 * NOT visible to plugin named imports (probe-verified — zero rename events
 * seen through the patch). The trap keeps the same crash artifact class
 * (state applying + lifecycle journal incomplete + successor durable). The
 * companion stale-lock/dead-owner takeover stays covered by
 * tests/test-adr-compaction-faults.ts at the engine level.
 * Windows-only fault seam (POSIX rename ignores file read-only); other
 * platforms SKIP explicitly. Ask drive = native question tool → session
 * form; fixture model is content-driven (helpers/v2-fixture-model.ts).
 */
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"
import { currentState } from "../plugins/adr/adr-context"
import { locateV2Runtime, startV2Server, type V2Server } from "./helpers/v2-runtime"
import { adrFixtureNextTurn } from "./helpers/v2-fixture-model"

if (process.platform !== "win32") {
  console.log("[SKIP] test-adr-compaction-recovery-runtime: the read-only-rename fault trap is Windows-specific (POSIX rename replaces read-only files)")
  process.exit(0)
}
const runtime = locateV2Runtime({ repoRoot: resolve(import.meta.dir, "..") })
if (!runtime) {
  console.log("[SKIP] test-adr-compaction-recovery-runtime: no OpenCode v2 runtime discoverable — set OCP_TEST_OPENCODE_BIN (>=2.0.0) or provide .ocp/sandbox/v2src (see .ocp/sandbox/WORKING-EXAMPLE/README.md)")
  process.exit(0)
}
const root = mkdtempSync(join(tmpdir(), "adr-crash-runtime-"))
const dir = join(root, "proj")
const state = join(dir, ".ocp/adr-compaction")
const source0001 = join(dir, "docs/adr/0001-boundaries.md")
const successor = join(dir, "docs/adr/0002-consolidated-boundaries.md")
const password = randomUUID()
const record = (id: string, status: string) => `---\nstyle: nygard\nstatus: ${status}\ndate: 2026-09-20\nlayer: system\n---\n\n# ${id}. Boundaries\n\n## Context\n\nNeed isolation.\n\n## Decision\n\nUse explicit boundaries.\n\n## Consequences\n\nValidate calls.\n`
mkdirSync(join(dir, "docs/adr"), { recursive: true }); mkdirSync(join(dir, ".ocp"))
writeFileSync(source0001, record("0001", "accepted"))
writeFileSync(join(dir, ".ocp/ocp.json"), JSON.stringify({ adr: { style: "nygard", numbering: "sequential", layout: "flat", governance: "strict" } }))
mkdirSync(join(dir, ".opencode/plugins"), { recursive: true })
writeFileSync(join(dir, ".opencode/plugins/adr-runtime.ts"), `const { AdrPlugin } = await import(${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "../plugins/adr.ts")).href)})\nexport default AdrPlugin\n`)
let calls = 0
const readPlans = () => readdirSync(state).filter(n => /^cp-[a-f0-9]{16}\.json$/.test(n)).map(n => JSON.parse(readFileSync(join(state, n), "utf8")))
const sse = (chunks: unknown[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  calls++
  const body = await request.json() as any
  // Native title generation is a separate utility request, not a workflow turn.
  if (!body.tools?.length) return sse([{ id: `title-${calls}`, object: "chat.completion.chunk", created: 123, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "ADR recovery fixture" }, finish_reason: "stop" }] }])
  const action = adrFixtureNextTurn(body.messages, {
    record,
    plan: (id) => JSON.parse(readFileSync(join(state, `${id}.json`), "utf8")),
    archivedPath: join(dir, "docs/adr/archive/0001-boundaries.md"),
  })
  const base = { id: `fixture-${calls}`, object: "chat.completion.chunk", created: 123, model: "fixture" }
  if (action.kind === "final") return sse([
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: action.text }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ])
  return sse([
    { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${calls}`, type: "function", function: { name: action.name, arguments: JSON.stringify(action.args) } }] }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ])
} })
writeFileSync(join(dir, "opencode.json"), JSON.stringify({
  model: "adr-fixture/fixture",
  providers: { "adr-fixture": { name: "Local deterministic fixture", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "test-only-not-a-credential" }, models: { fixture: { name: "fixture", limit: { context: 128000, output: 8192 }, cost: { input: 0, output: 0 } } } } },
}))
let server: V2Server | undefined
const timer = setTimeout(async () => { await server?.close(); throw new Error("adr-compaction recovery runtime test exceeded 480s") }, 480_000)
try {
  // Durable XDG tree: the session row + storage must survive the process
  // death/restart cycle, so both launches share one data root.
  const xdgRoot = join(root, "shared-state")
  server = await startV2Server(runtime, { project: dir, password, xdgRoot, listenTimeoutMs: 240_000 })
  await server.waitForPlugin("opencode-prime.adr")
  const session = await server.createSession("adr recovery native ask", { providerID: "adr-fixture", id: "fixture" })
  // Arm the trap: the journal retires 0001 AFTER publishing the successor,
  // so its replace fails mid-lifecycle exactly at v1's crash point.
  chmodSync(source0001, 0o444)
  const running = server.command(session.id, "adr", "compaction --mode consolidate --archive")
  console.log("… launched; awaiting cost Ask form")
  const cost = await server.waitForForm(session.id, "ADR drafting cost")
  const costField = cost.fields.find(f => f.title === "ADR drafting cost")!
  assert.equal(costField.options!.length, 2)
  await server.replyForm(session.id, cost.id, { [costField.key]: costField.options![0].value })
  console.log("… cost settled; awaiting review Ask form")
  const review = await server.waitForForm(session.id, "ADR review")
  const reviewField = review.fields.find(f => f.title === "ADR review")!
  assert.equal(reviewField.options!.length, 4)
  assert.equal((await running).status, 204)
  console.log("… review Ask settled with accept; expecting mid-journal apply failure")
  await server.replyForm(session.id, review.id, { [reviewField.key]: reviewField.options![0].value })
  // The after hook converts the EPERM into a stop receipt; the turn settles
  // and the session goes idle WITHOUT the transaction completing.
  await server.waitIdle(session.id)
  const interrupted = readPlans()[0]
  assert.equal(interrupted.state, "applying", server.stderr())
  assert.match(interrupted.approval.actor, /^question:/, "approval must be minted from the server-produced question answer")
  assert.equal(JSON.parse(readFileSync(join(state, `${interrupted.id}.lifecycle.json`), "utf8")).complete, false, "lifecycle journal must be incomplete")
  assert.match(readFileSync(successor, "utf8"), /status: Accepted/, "accepted successor must be durable before any retirement")
  assert.match(readFileSync(source0001, "utf8"), /status: accepted/)
  assert.ok(!existsSync(join(dir, "docs/adr/CURRENT.md")))
  // Hard process death AFTER the fault settled (server idle; the durable
  // half-applied transaction, not the crash mechanics, is the recovery input).
  const deadPid = server.proc.pid
  server.proc.kill()
  await server.proc.exited
  await server.close()
  console.log(`… server (pid ${deadPid}) killed with an unfinished transaction on disk; relaunching`)
  server = await startV2Server(runtime, { project: dir, password, xdgRoot })
  await server.waitForPlugin("opencode-prime.adr")
  // A resumed durable turn could re-present the settled Ask defensively;
  // dismissing authorizes nothing (execute.after cancels the armed review).
  const dismissDeadline = Date.now() + 30_000
  for (;;) {
    const strays = await server.listForms(session.id)
    if (!strays.length || Date.now() > dismissDeadline) break
    for (const stray of strays) await server.cancelForm(session.id, stray.id)
    await Bun.sleep(500)
  }
  await server.waitIdle(session.id, 90_000)
  const ledger = readFileSync(join(dir, ".ocp/adr-decisions.log"), "utf8")
  chmodSync(source0001, 0o666)
  writeFileSync(join(dir, "docs/adr/9999-unrelated.md"), record("9999", "proposed"))
  const confirm = () => server!.command(session.id, "adr", `compaction --confirm ${interrupted.id}`)
  assert.equal((await confirm()).status, 204)
  assert.equal(readPlans()[0].state, "applying", "Unrelated new ADR must block recovery")
  assert.equal(readFileSync(join(dir, ".ocp/adr-decisions.log"), "utf8"), ledger)
  unlinkSync(join(dir, "docs/adr/9999-unrelated.md"))
  assert.equal((await confirm()).status, 204)
  const complete = readPlans()[0]
  assert.equal(complete.state, "complete", server.stderr())
  assert.deepEqual(complete.approval, interrupted.approval)
  assert.equal(readFileSync(join(dir, ".ocp/adr-decisions.log"), "utf8"), ledger)
  assert.equal(currentState(dir).status, "fresh")
  assert.equal((await confirm()).status, 204)
  assert.equal(readFileSync(join(dir, ".ocp/adr-decisions.log"), "utf8"), ledger)
  // Manual recovery mints no new Ask: the plan completed from the durable
  // journal + the original question answer alone. (v1's call-count assertion
  // cannot carry over: every handled command's synthetic reply wakes the v2
  // runner — see helpers/v2-fixture-model.ts header.)
  assert.deepEqual(await server.listForms(session.id), [], "manual recovery must not open a new Ask form")
  console.log("PASS v2 restart: mid-journal apply failure, successor durability, unrelated-edit refusal, exact idempotent recovery, original actor/ledger preserved")

  const restore = server.command(session.id, "adr", `compaction archive restore ${complete.id}`)
  const question = await server.waitForForm(session.id, "ADR review")
  const questionField = question.fields.find(f => f.title === "ADR review")!
  assert.equal(questionField.options!.length, 3)
  await server.replyForm(session.id, question.id, { [questionField.key]: questionField.options![0].value })
  assert.equal((await restore).status, 204)
  await server.waitIdle(session.id)
  assert.equal(readPlans().find(p => p.kind === "restore")?.state, "complete", server.stderr())
  assert.match(readFileSync(source0001, "utf8"), /status: superseded/)
  assert.ok(!existsSync(join(dir, "docs/adr/archive/0001-boundaries.md")))
  assert.equal(currentState(dir).status, "fresh")
  assert.equal(readFileSync(join(dir, ".ocp/adr-decisions.log"), "utf8"), ledger)
  console.log("PASS v2 restore: separate Ask restores location/provenance without undoing acceptance")
} catch (error) {
  console.error(`FAILED v2 recovery runtime: ${String(error)}`)
  console.error(server?.stderr().slice(-8000) ?? "server never started")
  throw error
} finally {
  clearTimeout(timer)
  await server?.close()
  rmSync(root, { recursive: true, force: true })
  model.stop(true)
}
