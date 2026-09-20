/** Real process-death / restart / restore acceptance test. No paid calls.
 * A fixture-only plugin intercepts one fs rename and SIGKILLs the server AFTER
 * the accepted successor reaches disk. Production code has no test fault flag.
 */
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"
import { currentState } from "../plugins/adr/adr-context"

if (!Bun.which("opencode")) throw new Error("OpenCode >=1.18.15 is required")
const dir = mkdtempSync(join(tmpdir(), "adr-crash-runtime-"))
const state = join(dir, ".ocp/adr-compaction")
const marker = join(dir, ".ocp/fault-fired")
const password = randomUUID()
const record = (id: string, status: string) => `---\nstyle: nygard\nstatus: ${status}\ndate: 2026-09-20\nlayer: system\n---\n\n# ${id}. Boundaries\n\n## Context\n\nNeed isolation.\n\n## Decision\n\nUse explicit boundaries.\n\n## Consequences\n\nValidate calls.\n`
mkdirSync(join(dir, "docs/adr"), { recursive: true }); mkdirSync(join(dir, ".ocp"))
writeFileSync(join(dir, "docs/adr/0001-boundaries.md"), record("0001", "accepted"))
writeFileSync(join(dir, ".ocp/ocp.json"), JSON.stringify({ adr: { style: "nygard", numbering: "sequential", governance: "strict", layout: "flat" } }))
const wrapper = join(dir, "fault-plugin.ts")
writeFileSync(wrapper, `import * as fs from "node:fs"
import { mock } from "bun:test"
const rename = fs.renameSync
mock.module("node:fs", () => ({ ...fs, renameSync(from, to) {
  rename(from, to)
  if (String(to) === ${JSON.stringify(join(dir, "docs/adr/0002-consolidated-boundaries.md"))} && !fs.existsSync(${JSON.stringify(marker)})) {
    fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid))
    process.kill(process.pid, "SIGKILL")
  }
}}))
const { AdrPlugin } = await import(${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "../plugins/adr/adr.ts")).href)})
export default AdrPlugin
`)
let phase: "consolidate" | "restore" = "consolidate", step = 0, calls = 0
const readPlans = () => readdirSync(state).filter(n => /^cp-[a-f0-9]{16}\.json$/.test(n)).map(n => JSON.parse(readFileSync(join(state, n), "utf8")))
const model = Bun.serve({ hostname: "0.0.0.0", port: 0, async fetch(request) {
  calls++
  const body = await request.json() as any
  // Native title generation is a separate utility request, not a workflow turn.
  if (!body.tools?.length) return new Response(`data: ${JSON.stringify({ id: `title-${calls}`, object: "chat.completion.chunk", created: 123, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "ADR recovery fixture" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  const p = readPlans().find(p => p.kind === phase)!
  const last = body.messages.filter((m: any) => m.role === "tool").at(-1)
  let name: string | undefined, args: unknown
  if (step === 0) { name = "adr_compaction"; args = { plan: p.id, action: "ask" } }
  else if (step === 1 || (phase === "consolidate" && step === 4)) { name = "question"; args = { questions: JSON.parse(last.content).questions } }
  else if (phase === "consolidate" && step === 2) { name = "adr_compaction"; args = { plan: p.id, action: "evidence" } }
  else if (phase === "consolidate" && step === 3) {
    name = "adr_compaction"; args = { plan: p.id, action: "submit", candidate: {
      summary: [{ text: "Use explicit boundaries. Validate calls.", sources: [p.slots[0].id] }],
      replacements: [{ id: p.slots[0].id, title: "Consolidated boundaries", content: record(p.slots[0].id, "proposed") }],
      coverage: [{ source: "ADR-0001", disposition: "replace", targets: [p.slots[0].id], note: "Preserve meaning." }],
    } }
  } else if (step > 5) throw new Error("Unexpected model loop")
  step++
  const base = { id: `fixture-${calls}`, object: "chat.completion.chunk", created: 123, model: "fixture" }
  const delta = name ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${calls}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } : { role: "assistant", content: "Use the verified maintenance receipt." }
  return new Response([
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: name ? "tool_calls" : "stop" }] },
  ].map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
} })
writeFileSync(join(dir, "opencode.json"), JSON.stringify({
  plugin: [pathToFileURL(wrapper).href], model: "adr-fixture/fixture",
  provider: { "adr-fixture": { npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "test-only-not-a-credential" }, models: { fixture: { name: "fixture", limit: { context: 128000, output: 8192 }, cost: { input: 0, output: 0 } } } } },
}))

async function launch() {
  const proc = Bun.spawn(["opencode", "serve", "--hostname", "0.0.0.0", "--port", "0"], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_DISABLE_MODELS_FETCH: "true" } })
  const abort = new AbortController()
  let stderr = "", startup = ""
  const drain = (async () => { for await (const bytes of proc.stderr) stderr += new TextDecoder().decode(bytes) })()
  const timer = setTimeout(() => { abort.abort(); proc.kill() }, 90_000)
  let port: string | undefined
  for await (const bytes of proc.stdout) {
    startup += new TextDecoder().decode(bytes)
    port = /listening on http:\/\/[^:]+:(\d+)/.exec(startup)?.[1]
    if (port) break
  }
  if (!port) { clearTimeout(timer); proc.kill(); await drain; throw new Error(`Runtime startup failed: ${stderr}`) }
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" }
  return {
    proc,
    request: (path: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, { headers, method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: abort.signal }),
    async close() { clearTimeout(timer); abort.abort(); proc.kill(); await proc.exited; await drain },
    diagnostics: () => stderr,
  }
}
type Runtime = Awaited<ReturnType<typeof launch>>
async function* questions(runtime: Runtime) {
  const response = await runtime.request("/event")
  let buffer = ""
  const decoder = new TextDecoder()
  for await (const bytes of response.body!) {
    buffer += decoder.decode(bytes, { stream: true })
    const frames = buffer.split("\n\n"); buffer = frames.pop()!
    for (const frame of frames) for (const line of frame.split("\n")) {
      if (!line.startsWith("data: ")) continue
      const value = JSON.parse(line.slice(6)), event = value.payload ?? value
      if (event.type === "question.asked") yield event.properties ?? event.data
    }
  }
}
let runtime: Runtime | undefined
try {
  runtime = await launch()
  const session = await (await runtime.request("/session", {})).json() as { id: string }
  const stream = questions(runtime)
  const costEvent = stream.next() // subscribe before starting the command
  const running = runtime.request(`/session/${session.id}/command`, { command: "adr", arguments: "compaction --mode consolidate --archive", model: "adr-fixture/fixture" }).catch(() => null)
  const cost = (await costEvent).value
  assert.equal(cost.questions[0].options.length, 2)
  await runtime.request(`/question/${cost.id}/reply`, { answers: [[cost.questions[0].options[0].label]] })
  const review = (await stream.next()).value
  assert.equal(review.questions[0].options.length, 4)
  await runtime.request(`/question/${review.id}/reply`, { answers: [[review.questions[0].options[0].label]] }).catch(() => null)
  await runtime.proc.exited; await running
  assert.ok(existsSync(marker), runtime.diagnostics())
  const interrupted = readPlans()[0]
  assert.equal(interrupted.state, "applying")
  assert.match(interrupted.approval.actor, /^question:/)
  assert.equal(JSON.parse(readFileSync(join(state, `${interrupted.id}.lifecycle.json`), "utf8")).complete, false)
  assert.match(readFileSync(join(dir, "docs/adr/0002-consolidated-boundaries.md"), "utf8"), /status: Accepted/)
  assert.match(readFileSync(join(dir, "docs/adr/0001-boundaries.md"), "utf8"), /status: accepted/)
  assert.ok(!existsSync(join(dir, "docs/adr/CURRENT.md")))
  assert.equal(JSON.parse(readFileSync(join(state, "lock"), "utf8")).pid, runtime.proc.pid)
  await runtime.close()
  // Explicit test-operator cleanup, only AFTER the recorded owner exited.
  unlinkSync(join(state, "lock"))
  runtime = await launch()
  const beforeResumeCalls = calls
  const ledger = readFileSync(join(dir, ".ocp/adr-decisions.log"), "utf8")
  writeFileSync(join(dir, "docs/adr/9999-unrelated.md"), record("9999", "proposed"))
  const confirm = () => runtime!.request(`/session/${session.id}/command`, { command: "adr", arguments: `compaction --confirm ${interrupted.id}` })
  assert.equal((await confirm()).status, 204)
  assert.equal(readPlans()[0].state, "applying", "Unrelated new ADR must block recovery")
  assert.equal(readFileSync(join(dir, ".ocp/adr-decisions.log"), "utf8"), ledger)
  unlinkSync(join(dir, "docs/adr/9999-unrelated.md"))
  assert.equal((await confirm()).status, 204)
  const complete = readPlans()[0]
  assert.equal(complete.state, "complete", runtime.diagnostics())
  assert.deepEqual(complete.approval, interrupted.approval)
  assert.equal(readFileSync(join(dir, ".ocp/adr-decisions.log"), "utf8"), ledger)
  assert.equal(currentState(dir).status, "fresh")
  assert.equal((await confirm()).status, 204)
  assert.equal(readFileSync(join(dir, ".ocp/adr-decisions.log"), "utf8"), ledger)
  assert.equal(calls, beforeResumeCalls, "Manual recovery/replay must not invoke the model")
  console.log("PASS native restart: SIGKILL after successor acceptance, stale lock inspection, unrelated-edit refusal, exact idempotent recovery, original actor/ledger preserved")

  phase = "restore"; step = 0
  const restores = questions(runtime), asked = restores.next()
  const restoring = runtime.request(`/session/${session.id}/command`, { command: "adr", arguments: `compaction archive restore ${complete.id}`, model: "adr-fixture/fixture" })
  const question = (await asked).value
  assert.equal(question.questions[0].options.length, 3)
  assert.equal((await runtime.request(`/question/${question.id}/reply`, { answers: [[question.questions[0].options[0].label]] })).status, 200)
  assert.equal((await restoring).status, 200)
  assert.equal(readPlans().find(p => p.kind === "restore").state, "complete")
  assert.match(readFileSync(join(dir, "docs/adr/0001-boundaries.md"), "utf8"), /status: superseded/)
  assert.ok(!existsSync(join(dir, "docs/adr/archive/0001-boundaries.md")))
  assert.equal(currentState(dir).status, "fresh")
  assert.equal(readFileSync(join(dir, ".ocp/adr-decisions.log"), "utf8"), ledger)
  await restores.return(undefined)
  console.log("PASS native restore: separate Ask restores location/provenance without undoing acceptance")
} finally {
  await runtime?.close(); model.stop(true)
  rmSync(dir, { recursive: true, force: true })
}
