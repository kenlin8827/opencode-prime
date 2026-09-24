/** Echo fixture model server for tests/test-advisor-e2e.ps1 — a deterministic
 * OpenAI-compatible chat-completions endpoint that answers every turn with a
 * short text completion and NO tool calls. The advisor e2e verifies command
 * handling, `.ocp/ocp.json` persistence, and the v2 `context`-hook injection
 * log — none of which need a real model; the WORKING-EXAMPLE proves the
 * context hook fires at assembly, before any provider transport.
 *
 * It also OWNS the fixture project's opencode.json: the port is only known
 * after bind, and a fixed default port (fallback +1 on EADDRINUSE) removes
 * any file/port write race between the harness and this server.
 *
 * Protocol: argv[2] = fixture project dir (required), argv[3] = preferred
 * port (default 4677). Prints `echo-model-port=<n>` and
 * `echo-model-ready` on stdout so the harness can wait for readiness.
 */
const projectDir = process.argv[2]
if (!projectDir) {
  console.error("usage: bun tests/helpers/echo-model-server.ts <fixture-project-dir> [port]")
  process.exit(2)
}
const preferred = Number(process.argv[3] ?? 4677)
const turn = (base: Record<string, unknown>, text: string, finish: string | null) =>
  `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: text || finish ? { ...(text ? { role: "assistant", content: text } : {}), ...(finish ? { finish_reason: finish } : {}) } : {} }] })}\n\n`

let port = preferred
for (;;) {
  try {
    Bun.serve({ hostname: "127.0.0.1", port, async fetch(request) {
      const url = new URL(request.url)
      if (!url.pathname.endsWith("/chat/completions")) return Response.json({ object: "list", data: [] })
      const body = await request.json().catch(() => ({}) as Record<string, unknown>)
      const base = { id: `chatcmpl-echo-${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: (body.model as string) ?? "echo" }
      const sse = new Response(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant" } }] })}\n\n` +
        turn(base, "echo: ok", "stop") +
        `data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
      return sse
    } })
    break
  } catch {
    port++
    if (port > preferred + 20) { console.error("no free port in range"); process.exit(2) }
  }
}
const { mkdirSync, writeFileSync } = await import("node:fs")
const { join } = await import("node:path")
mkdirSync(projectDir, { recursive: true })
writeFileSync(join(projectDir, "opencode.json"), JSON.stringify({
  model: "echo/echo",
  providers: { echo: { name: "Local echo fixture", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "test-only-not-a-credential" }, models: { echo: { name: "echo", limit: { context: 128000, output: 2048 }, cost: { input: 0, output: 0 } } } } },
}, null, 2))
console.log(`echo-model-port=${port}`)
console.log("echo-model-ready")
