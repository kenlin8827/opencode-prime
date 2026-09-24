/** Shared harness for runtime-integration tests that boot a REAL OpenCode v2
 * server. Everything the v2 migration keeps re-discovering lives here:
 *
 *  - runtime discovery  OCP_TEST_OPENCODE_BIN → sandbox source-run
 *    (.ocp/sandbox/bun-windows-x64/bun.exe + v2src) → PATH `opencode`.
 *    Anything below the 2.0.0 floor is rejected; nothing found = null so the
 *    CALLER prints an explicit [SKIP] line and exits 0 (CI-friendly — never a
 *    silent pass, never a hard error on machines without a v2 runtime).
 *  - isolation          fresh XDG dirs + fakehome per server; the host env
 *    traps (ORCA_/OPENCODE_ config vars) are unset or the spawned process
 *    reads the live session config (.ocp/sandbox/WORKING-EXAMPLE/README.md #1).
 *  - auth               HTTP Basic, username `opencode`, password pinned via
 *    OPENCODE_SERVER_PASSWORD (line 2 of stdout only applies to the compiled
 *    binary's random password; pinning keeps the harness deterministic).
 *  - location bootstrap every request carries x-opencode-directory in
 *    Windows form; plugin activation happens on the first location-scoped
 *    request (README #2), so `waitForPlugin` polls /api/plugin.
 *  - Ask surface        v1 `question.asked` SSE + /question/:id/reply are
 *    gone; the native question tool blocks on a session FORM — poll
 *    `waitForForm` (GET /api/session/:id/form) and settle it with
 *    `replyForm` (POST .../form/:formID/reply {answer}). Pending permission
 *    requests are auto-approved as a side-channel guard (action `question`
 *    may hit Permission.assert depending on the agent policy).
 */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const RUNTIME_FLOOR_MAJOR = 2

/** Host-env variables that hijack config resolution in a spawned server. */
const TRAP_ENV = [
  "ORCA_OPENCODE_CONFIG_DIR", "ORCA_AGENT_HOOK_ENDPOINT", "ORCA_AGENT_HOOK_TOKEN",
  "OPENCODE", "OPENCODE_PID", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_PASSWORD",
]

export interface V2Runtime {
  /** Human-readable provenance for logs and skip messages. */
  label: string
  command: string
  /** Args preceding the `serve` subcommand (source-run carries the bun loader). */
  prefix: string[]
  cwd: string
  /** Compiled binary only — source-run needs the isolation env (project
   * `.opencode/plugins` auto-discovery works on both; README FORM C). */
  kind: "source-run" | "binary"
}

function versionMajor(output: string): number | null {
  const match = /(\d+)\.\d+/.exec(output)
  return match ? Number(match[1]) : null
}

function checkVersion(command: string, args: string[]): "ok" | `below:${string}` | "unparseable" {
  const probe = Bun.spawnSync([command, ...args, "--version"], { stdout: "pipe", stderr: "pipe" })
  if (probe.exitCode !== 0) return "unparseable"
  const decode = (value: Uint8Array | ReadableStream) => typeof (value as ReadableStream).getReader === "function" ? "" : new TextDecoder().decode(value as Uint8Array)
  const output = `${decode(probe.stdout as Uint8Array)}${decode(probe.stderr as Uint8Array)}`.trim()
  const major = versionMajor(output)
  if (major === null) return "unparseable"
  if (major < RUNTIME_FLOOR_MAJOR) return `below:${output.split("\n")[0]}`
  return "ok"
}

function sandboxRuntime(repoRoot: string): V2Runtime | null {
  const sandbox = join(repoRoot, ".ocp", "sandbox")
  const bun = join(sandbox, "bun-windows-x64", "bun.exe")
  const cli = join(sandbox, "v2src", "packages", "cli")
  if (!existsSync(bun) || !existsSync(join(cli, "src", "index.ts"))) return null
  return { label: `sandbox source-run (${resolve(bun, "../..").replaceAll("\\", "/")} + v2src)`, kind: "source-run", command: bun, prefix: ["run", "--cwd", cli, "src/index.ts"], cwd: cli }
}

/** Locate a v2 runtime; null = none discoverable (caller must SKIP). */
export function locateV2Runtime(options: { repoRoot: string; note?: (message: string) => void } = { repoRoot: process.cwd() }): V2Runtime | null {
  const note = options.note ?? ((message: string) => console.log(`[v2-runtime] ${message}`))
  const pinned = process.env.OCP_TEST_OPENCODE_BIN
  if (pinned) {
    const verdict = checkVersion(pinned, [])
    if (verdict === "ok") return { label: `OCP_TEST_OPENCODE_BIN (${pinned})`, kind: "binary", command: pinned, prefix: [], cwd: process.cwd() }
    note(`OCP_TEST_OPENCODE_BIN ${pinned} rejected: ${verdict} (floor ${RUNTIME_FLOOR_MAJOR}.0.0)`)
    return null
  }
  // Prefer the sandbox source-run: local plugin loading is PROVEN there
  // (WORKING-EXAMPLE); the compiled-binary loading path is not (N2 counter note).
  const sandbox = sandboxRuntime(options.repoRoot)
  if (sandbox) return sandbox
  const onPath = Bun.which("opencode")
  if (onPath) {
    const verdict = checkVersion(onPath, [])
    if (verdict === "ok") return { label: `PATH opencode (${onPath})`, kind: "binary", command: onPath, prefix: [], cwd: process.cwd() }
    note(`PATH opencode rejected: ${verdict} (floor ${RUNTIME_FLOOR_MAJOR}.0.0; prefer OCP_TEST_OPENCODE_BIN or .ocp/sandbox/v2src)`)
  }
  return null
}

export interface FormFieldInfo { key: string; title?: string; type: string; options?: Array<{ value: string; label: string; description?: string }> }
export interface FormInfo { id: string; sessionID: string; title: string; metadata?: Record<string, unknown>; fields: FormFieldInfo[] }

export interface V2Server {
  readonly port: number
  readonly project: string
  readonly proc: Bun.Subprocess
  /** Raw combined stderr so far — diagnostics on assertion failures. */
  stderr(): string
  request(path: string, body?: unknown): Promise<Response>
  post(path: string, body: unknown): Promise<Response>
  createSession(title: string, model?: { providerID: string; id: string }): Promise<{ id: string }>
  command(sessionID: string, name: string, text: string): Promise<Response>
  prompt(sessionID: string, text: string): Promise<Response>
  messages(sessionID: string): Promise<any[]>
  /** Poll until the named plugin reports `active` (throws on `failed`). */
  waitForPlugin(id: string, timeoutMs?: number): Promise<void>
  /** Poll until the location's skill list carries the named skill. Skill
   * sources load asynchronously after the instance build. */
  waitForSkill(name: string, timeoutMs?: number): Promise<void>
  listForms(sessionID: string): Promise<FormInfo[]>
  /** Dismiss a pending form (the question tool's error path). */
  cancelForm(sessionID: string, formID: string): Promise<void>
  /** Poll until a pending form carries a field titled `header` (also
   * auto-approves pending permission requests each round). */
  waitForForm(sessionID: string, header: string, timeoutMs?: number): Promise<FormInfo>
  replyForm(sessionID: string, formID: string, answer: Record<string, string | string[]>): Promise<void>
  /** Poll /api/session/active until this process no longer owns a drain. */
  waitIdle(sessionID: string, timeoutMs?: number): Promise<void>
  close(): Promise<void>
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

export async function startV2Server(runtime: V2Runtime, options: {
  project: string
  password?: string
  env?: Record<string, string>
  listenTimeoutMs?: number
  /** Reuse a durable XDG/home tree across restarts (process-death tests need
   * the session row + storage to survive); omitted = fresh throwaway dirs. */
  xdgRoot?: string
}): Promise<V2Server> {
  const ephemeral = options.xdgRoot === undefined
  const xdg = options.xdgRoot ?? mkdtempSync(join(tmpdir(), "ocp-v2-harness-"))
  const root = xdg
  const fakehome = join(xdg, "home")
  for (const dir of ["xdg-config", "xdg-data", "xdg-state", "xdg-cache", fakehome]) mkdirSync(dir, { recursive: true })
  const password = options.password ?? randomUUID()
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...options.env,
    XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_STATE_HOME: join(root, "xdg-state"), XDG_CACHE_HOME: join(root, "xdg-cache"),
    HOME: fakehome, USERPROFILE: fakehome,
    APPDATA: join(fakehome, "AppData", "Roaming"), LOCALAPPDATA: join(fakehome, "AppData", "Local"),
    OPENCODE_SERVER_PASSWORD: password, OPENCODE_DISABLE_MODELS_FETCH: "true",
  }
  for (const trap of TRAP_ENV) delete env[trap]
  // Port 0 would be friendlier, but v2 `serve` pins the announce line to the
  // requested port; the probe-and-immediately-release dance is what the
  // proven install-test recipe uses.
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
  const port = probe.port
  probe.stop(true)
  if (port === undefined) { rmSync(root, { recursive: true, force: true }); throw new Error("free-port probe returned no port") }
  const proc = Bun.spawn([runtime.command, ...runtime.prefix, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: runtime.cwd, stdout: "pipe", stderr: "pipe", env,
  })
  let stderr = ""
  const drain = (async () => { for await (const bytes of proc.stderr as ReadableStream<Uint8Array>) stderr += new TextDecoder().decode(bytes) })().catch(() => {})
  const abort = new AbortController()
  const close = async () => {
    abort.abort()
    try { proc.kill() } catch { /* already dead — the fault-plugin phase SIGKILLs itself */ }
    await Promise.allSettled([proc.exited, drain])
    if (ephemeral) rmSync(root, { recursive: true, force: true })
  }
  const failStartup = async (why: string): Promise<never> => { await close(); throw new Error(why) }

  const deadline = Date.now() + (options.listenTimeoutMs ?? 180_000)
  let startup = ""
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  // One carried read promise per iteration: racing a FRESH read() against a
  // timeout each round would orphan the previous read and DISCARD its chunk
  // (the listen announce lost in the race). The pending promise is reused
  // until it resolves. ReadResult shape duck-typed across DOM/Bun lib drift.
  type ReadResult = { done: boolean; value?: Uint8Array }
  let readPromise: Promise<ReadResult> | undefined
  try {
    for (;;) {
      if (/server listening on http:\/\/127\.0\.0\.1/.test(startup)) break
      if (proc.exitCode !== null) return await failStartup(`v2 server exited (${proc.exitCode}) before listen: stdout=${startup}\nstderr=${stderr}`)
      if (Date.now() > deadline) return await failStartup(`v2 server (${runtime.label}) did not listen within budget: stdout=${startup}\nstderr=${stderr}`)
      readPromise ??= reader.read() as Promise<ReadResult>
      const raced = await Promise.race([readPromise, sleep(250).then(() => null)])
      if (raced === null) continue
      readPromise = undefined
      if (raced.done) return await failStartup(`v2 server exited before listen: stdout=${startup}\nstderr=${stderr}`)
      startup += new TextDecoder().decode(raced.value ?? new Uint8Array())
    }
  } catch (error) {
    return await failStartup(`v2 server startup read failed: ${String(error)}; stderr=${stderr}`)
  }

  const headers = {
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    "content-type": "application/json",
    // Windows-style absolute path — a git-bash /c/ form silently misses the
    // location and every request 404s (WORKING-EXAMPLE §3).
    "x-opencode-directory": options.project,
  }
  const base = `http://127.0.0.1:${port}`
  const request = (path: string, init?: RequestInit) => fetch(base + path, { ...init, headers: { ...headers, ...(init?.headers ?? {}) }, signal: abort.signal })
  const json = async <T>(path: string): Promise<T> => {
    const response = await request(path)
    if (!response.ok) throw new Error(`GET ${path} -> ${response.status}: ${(await response.text()).slice(0, 400)}`)
    return await response.json() as T
  }
  const api: Omit<V2Server, "waitForPlugin" | "waitForSkill" | "listForms" | "cancelForm" | "waitForForm" | "replyForm" | "waitIdle" | "close"> = {
    port, project: options.project, proc, stderr: () => stderr,
    request: (path, body) => request(path, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) }),
    post: (path, body) => request(path, { method: "POST", body: JSON.stringify(body) }),
    createSession: async (title, model) => {
      // Placement follows the create PAYLOAD's location, not the directory
      // header — omitting it lands the session on the server's own cwd.
      const response = await request("/api/session", { method: "POST", body: JSON.stringify({ title, location: { directory: options.project }, ...(model ? { model } : {}) }) })
      if (!response.ok) throw new Error(`session create -> ${response.status}: ${(await response.text()).slice(0, 400)}`)
      return (await response.json() as { data: { id: string } }).data
    },
    command: (sessionID, name, text) => request(`/api/session/${sessionID}/command`, { method: "POST", body: JSON.stringify({ name, text }) }),
    prompt: (sessionID, text) => request(`/api/session/${sessionID}/prompt`, { method: "POST", body: JSON.stringify({ text }) }),
    messages: async (sessionID) => {
      const all: any[] = []
      let cursor: string | undefined
      do {
        // The endpoint rejects order alongside a cursor; the first page's asc
        // order carries through the whole chain.
        const page = await json<{ data: any[]; cursor?: { next?: string } }>(`/api/session/${sessionID}/message${cursor ? `?cursor=${encodeURIComponent(cursor)}` : "?order=asc"}`)
        all.push(...page.data); cursor = page.cursor?.next
      } while (cursor)
      return all
    },
  }
  const server: V2Server = {
    ...api,
    async waitForPlugin(id, timeoutMs = 180_000) {
      const until = Date.now() + timeoutMs
      for (;;) {
        try {
          const response = await request("/api/location")
          if (response.ok) {
            const list = ((await json<{ data?: Array<{ id?: string; state?: { status?: string } }> }>("/api/plugin")).data ?? [])
            const entry = list.find((p) => p.id === id)
            if (entry?.state?.status === "active") return
            if (entry?.state?.status === "failed") throw new Error(`plugin '${id}' failed to load: ${JSON.stringify(entry)}`)
          }
        } catch (error) {
          if (abort.signal.aborted) throw error
          if (error instanceof Error && error.message.includes("failed to load")) throw error
        }
        if (Date.now() > until) throw new Error(`plugin '${id}' not active within ${timeoutMs}ms; stderr=${stderr.slice(-4000)}`)
        await sleep(2000)
      }
    },
    async waitForSkill(name, timeoutMs = 90_000) {
      const until = Date.now() + timeoutMs
      for (;;) {
        try {
          const skills = await json<{ data?: Array<{ id?: string; name?: string }> }>("/api/skill")
          if ((skills.data ?? []).some((s) => s.name === name || s.id === name)) return
        } catch (error) { if (abort.signal.aborted) throw error }
        if (Date.now() > until) throw new Error(`skill '${name}' never appeared within ${timeoutMs}ms; stderr=${stderr.slice(-4000)}`)
        await sleep(500)
      }
    },
    async listForms(sessionID) {
      return (await json<{ data?: FormInfo[] }>(`/api/session/${sessionID}/form`).catch(() => ({ data: [] as FormInfo[] }))).data ?? []
    },
    async cancelForm(sessionID, formID) {
      await request(`/api/session/${sessionID}/form/${formID}`, { method: "DELETE" })
    },
    async waitForForm(sessionID, header, timeoutMs = 120_000) {
      const until = Date.now() + timeoutMs
      for (;;) {
        // The native question tool calls Permission.assert first; a pending
        // request there would keep the form from ever appearing.
        try {
          const permissions = await json<{ data?: Array<{ id: string }> }>(`/api/session/${sessionID}/permission`)
          for (const pending of permissions.data ?? []) await request(`/api/session/${sessionID}/permission/${pending.id}/reply`, { method: "POST", body: JSON.stringify({ decision: "once" }) })
        } catch { /* listing not available on this placement — forms alone */ }
        const forms = await json<{ data?: FormInfo[] }>(`/api/session/${sessionID}/form`).catch((error) => { if (abort.signal.aborted) throw error; return { data: [] as FormInfo[] } })
        const form = (forms.data ?? []).find((f) => f.fields.some((field) => field.title === header))
        if (form) return form
        if (Date.now() > until) throw new Error(`form '${header}' never appeared for ${sessionID} within ${timeoutMs}ms; stderr=${stderr.slice(-4000)}`)
        await sleep(400)
      }
    },
    async replyForm(sessionID, formID, answer) {
      const response = await request(`/api/session/${sessionID}/form/${formID}/reply`, { method: "POST", body: JSON.stringify({ answer }) })
      assert.equal(response.status, 204, `form reply failed: ${response.status} ${await response.text()}`)
    },
    async waitIdle(sessionID, timeoutMs = 120_000) {
      const until = Date.now() + timeoutMs
      for (;;) {
        try {
          const active = await json<{ data: Record<string, unknown> }>("/api/session/active")
          if (!(sessionID in active.data)) { await sleep(300); if (!(sessionID in (await json<{ data: Record<string, unknown> }>("/api/session/active")).data)) return }
        } catch (error) { if (abort.signal.aborted) throw error }
        if (Date.now() > until) throw new Error(`session ${sessionID} still active after ${timeoutMs}ms; stderr=${stderr.slice(-4000)}`)
        await sleep(500)
      }
    },
    close,
  }
  return server
}
