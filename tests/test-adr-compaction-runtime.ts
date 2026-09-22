/** Real OpenCode 1.18.15+ integration with a local deterministic model fixture.
 * No provider credentials or paid model calls. Requires `opencode` on PATH.
 * Run separately: bun tests/test-adr-compaction-runtime.ts
 */
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"

if (!Bun.which("opencode")) throw new Error("Install OpenCode >=1.18.15 to run the native runtime integration test")
if (!process.env.ADR_TEST_CHOICE) {
  for (const choice of ["accept", "drafts", "modify", "cancel"]) {
    const child = Bun.spawnSync([process.execPath, import.meta.path], { env: { ...process.env, ADR_TEST_CHOICE: choice }, stdout: "inherit", stderr: "inherit" })
    assert.equal(child.exitCode, 0, `Native Ask ${choice} failed`)
  }
  process.exit(0)
}
const choice = process.env.ADR_TEST_CHOICE!
const dir = mkdtempSync(join(tmpdir(), "adr-runtime-"))
const password = randomUUID()
let step = 0
const record = (id: string, status: string) => `---\nstyle: nygard\nstatus: ${status}\ndate: 2026-09-19\nlayer: system\n---\n\n# ${id.slice(4)}. Boundaries\n\n## Context\n\nNeed isolation.\n\n## Decision\n\nUse explicit boundaries.\n\n## Consequences\n\nValidate calls.\n`
mkdirSync(join(dir, "docs/adr"), { recursive: true }); mkdirSync(join(dir, ".ocp"))
mkdirSync(join(dir, ".opencode/skills/adr-compaction"), { recursive: true })
writeFileSync(join(dir, ".opencode/skills/adr-compaction/SKILL.md"), readFileSync(resolve(import.meta.dir, "../skills/adr-compaction/SKILL.md"), "utf8"))
writeFileSync(join(dir, "docs/adr/0001-boundaries.md"), record("ADR-0001", "accepted"))
writeFileSync(join(dir, ".ocp/ocp.json"), JSON.stringify({ adr: { style: "nygard", numbering: "sequential", governance: "strict", layout: "flat" } }))
const model = Bun.serve({ hostname: "0.0.0.0", port: 0, async fetch(request) {
  const body = await request.json() as any
  const names = readdirSync(join(dir, ".ocp/adr-compaction")).filter(n => /^cp-[a-f0-9]{16}\.json$/.test(n))
  const p = JSON.parse(readFileSync(join(dir, ".ocp/adr-compaction", names[0]), "utf8"))
  const last = body.messages.filter((m: any) => m.role === "tool").at(-1)
  let name: string | undefined, args: unknown
  if (step === 0) { name = "skill"; args = { name: "adr-compaction" } }
  else if (step === 1) { name = "adr_compaction"; args = { plan: p.id, action: "ask" } }
  else if (step === 2) { name = "question"; args = { questions: JSON.parse(last.content).questions } }
  else if (step === 3) { name = "adr_compaction"; args = { plan: p.id, action: "evidence" } }
  else if (step === 4) {
    name = "adr_compaction"; args = { plan: p.id, action: "stage", batch: "decisions", candidate: {
      summary: [{ text: "Use explicit boundaries. Validate calls.", sources: [p.slots[0].id] }],
      replacements: [{ id: p.slots[0].id, title: "Consolidated boundaries", content: record(p.slots[0].id, "proposed") }],
      coverage: [],
    } }
  } else if (step === 5) {
    name = "adr_compaction"; args = { plan: p.id, action: "stage", batch: "coverage", candidate: { summary: [], replacements: [], coverage: [{ source: "ADR-0001", disposition: "replace", targets: [p.slots[0].id], note: "Preserved constraint without semantic change." }] } }
  } else if (step === 6) { name = "adr_compaction"; args = { plan: p.id, action: "submit" } }
  else if (step === 7) { name = "question"; args = { questions: JSON.parse(last.content).questions } }
  else if (step === 9) { name = "read"; args = { filePath: join(dir, "docs/adr/archive/0001-boundaries.md") } }
  else if (step > 11) throw new Error("Unexpected repeated model loop")
  step++
  const base = { id: `fixture-${step}`, object: "chat.completion.chunk", created: 123, model: "fixture" }
  const delta = name ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${step}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } : { role: "assistant", content: "Read the actual maintenance receipt for results." }
  const chunks = [
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: name ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
  ]
  return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
} })
writeFileSync(join(dir, "opencode.json"), JSON.stringify({
  plugin: [pathToFileURL(resolve(import.meta.dir, "../plugins/adr.ts")).href], model: "adr-fixture/fixture",
  provider: { "adr-fixture": { npm: "@ai-sdk/openai-compatible", name: "Local deterministic fixture", options: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "test-only-not-a-credential" }, models: { fixture: { name: "fixture", limit: { context: 128000, output: 8192 }, cost: { input: 0, output: 0 } } } } },
}))
const proc = Bun.spawn(["opencode", "serve", "--hostname", "0.0.0.0", "--port", "0"], {
  cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_DISABLE_MODELS_FETCH: "true" },
})
const abort = new AbortController()
let stderr = ""
const drain = (async () => { for await (const chunk of proc.stderr) stderr += new TextDecoder().decode(chunk) })()
const timer = setTimeout(() => { abort.abort(); proc.kill() }, 120_000)
try {
  let startup = "", port: string | undefined
  for await (const chunk of proc.stdout) {
    startup += new TextDecoder().decode(chunk)
    port = /listening on http:\/\/[^:]+:(\d+)/.exec(startup)?.[1]
    if (port) break
  }
  assert.ok(port, `Runtime did not start: ${stderr}`)
  const base = `http://127.0.0.1:${port}`
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" }
  const api = (path: string, body?: unknown) => fetch(base + path, { headers, method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: abort.signal })
  const tools = await (await api("/experimental/tool/ids")).json() as string[]
  assert.ok(tools.includes("adr_context") && tools.includes("adr_compaction"))
  const session = await (await api("/session", {})).json() as { id: string }
  const dry = await api(`/session/${session.id}/command`, { command: "adr", arguments: "compaction --dry-run" })
  assert.equal(dry.status, 204); assert.equal(step, 0)
  const events = await api("/event")
  let asks = 0
  const question = (async () => {
    let buffer = ""
    const decoder = new TextDecoder()
    for await (const bytes of events.body!) {
      buffer += decoder.decode(bytes, { stream: true })
      const frames = buffer.split("\n\n"); buffer = frames.pop()!
      for (const frame of frames) for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue
        const value = JSON.parse(line.slice(6)), e = value.payload ?? value
        if (e.type === "question.asked") {
          const asked = e.properties ?? e.data
          asks++
          if (asks === 1) {
            assert.equal(asked.questions[0].header, "ADR drafting cost")
            assert.equal(asked.questions[0].options.length, 2)
            assert.equal((await api(`/question/${asked.id}/reply`, { answers: [[asked.questions[0].options[0].label]] })).status, 200)
          } else return asked
        }
      }
    }
    throw new Error("Question event stream ended")
  })()
  const running = api(`/session/${session.id}/command`, { command: "adr", arguments: "compaction --mode consolidate --archive", model: "adr-fixture/fixture" })
  const asked = await question
  assert.equal(asked.sessionID, session.id)
  assert.equal(asked.questions[0].options.length, 4)
  const choiceIndex = ["accept", "drafts", "modify", "cancel"].indexOf(choice)
  const accepted = await api(`/question/${asked.id}/reply`, { answers: [[asked.questions[0].options[choiceIndex].label]] })
  assert.equal(accepted.status, 200)
  const response = await running
  assert.equal(response.status, 200, await response.text())
  const name = readdirSync(join(dir, ".ocp/adr-compaction")).find(n => /^cp-[a-f0-9]{16}\.json$/.test(n))!
  const result = JSON.parse(readFileSync(join(dir, ".ocp/adr-compaction", name), "utf8"))
  const transcript = await (await api(`/session/${session.id}/message`)).json() as any[]
  const skill = transcript.flatMap(m => m.parts ?? []).find(p => p.type === "tool" && p.tool === "skill")
  assert.equal(skill?.state?.status, "completed", "Native skill discovery/loading must work")
  assert.equal(asks, 2)
  assert.equal(step, 9, "Approval must not inject another model turn")
  if (choice !== "accept") {
    assert.equal(result.state, { drafts: "drafts", modify: "review", cancel: "cancelled" }[choice as "drafts" | "modify" | "cancel"])
    assert.match(readFileSync(join(dir, "docs/adr/0001-boundaries.md"), "utf8"), /status: accepted/)
    assert.ok(!existsSync(join(dir, "docs/adr/CURRENT.md")))
    assert.ok(!existsSync(join(dir, ".ocp/adr-decisions.log")))
    const draft = join(dir, "docs/adr/0002-consolidated-boundaries.md")
    assert.equal(existsSync(draft), choice === "drafts")
    if (choice === "drafts") assert.match(readFileSync(draft, "utf8"), /status: proposed/)
    console.log(`PASS real runtime: native Ask ${choice}; no acceptance, retirement, publication or archive`)
  } else {
  assert.equal(result.state, "complete", JSON.stringify(result))
  assert.match(result.approval.actor, /^question:/)
  assert.match(result.costApproval.actor, /^question:/)
  assert.equal(asks, 2)
  assert.match(readFileSync(join(dir, ".ocp/adr-decisions.log"), "utf8"), /ADR-0002/)
  assert.match(readFileSync(join(dir, "docs/adr/archive/0001-boundaries.md"), "utf8"), /superseded/)
  assert.match(readFileSync(join(dir, "docs/adr/CURRENT.md"), "utf8"), /ADR-0002/)
  assert.equal(step, 9, "Approval must not inject another model turn")
  const guardConfig = await api(`/session/${session.id}/command`, { command: "adr", arguments: "config readGuard guard" })
  assert.equal(guardConfig.status, 204)
  const guardRun = await api(`/session/${session.id}/message`, { parts: [{ type: "text", text: "Read the archived original directly to validate the read guard." }], model: { providerID: "adr-fixture", modelID: "fixture" } })
  assert.equal(guardRun.status, 200)
  const messages = await (await api(`/session/${session.id}/message`)).json() as any[]
  const blocked = messages.flatMap(m => m.parts ?? []).find(p => p.type === "tool" && p.tool === "read" && p.state?.status === "error")
  assert.match(blocked?.state?.error ?? "", /ADR-READ-GUARD/)
  console.log("PASS real runtime: supported archive read blocked before body output")
  console.log("PASS real runtime: registration, read-only command, bounded drafting, native Ask, strict acceptance ledger, CURRENT/index publication, archive")
  }
} finally {
  clearTimeout(timer); abort.abort(); proc.kill(); model.stop(true)
  await proc.exited; await drain
  rmSync(dir, { recursive: true, force: true })
}
