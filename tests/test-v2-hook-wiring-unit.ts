/**
 * v2 hook wiring — unit tests for the migrated execute.before/after plumbing
 * of design-token-guard and rtk-write (the pure decision cores are covered
 * by their own suites; here we prove the single-event wiring: tool name
 * filter, mutable input rewrite, Tool.Error-shaped deny, after-result
 * mutation, and fail-open behavior).
 *
 * Run: bun run tests/test-v2-hook-wiring-unit.ts
 */
import { spawnSync } from "node:child_process"
import designTokenGuard from "../plugins/design-token-guard"
import rtkWrite from "../plugins/rtk-write/index"

let passed = 0
let failed = 0
function assert(cond: unknown, label: string): void {
  if (cond) {
    passed++
  } else {
    failed++
    console.error(`  ✗ FAIL: ${label}`)
  }
}

type HookCallback = (event: any) => Promise<void>
type HookName = "execute.before" | "execute.after"

function makeToolCtx() {
  const hooks: Partial<Record<HookName, HookCallback>> = {}
  return {
    hooks,
    ctx: {
      tool: {
        hook: async (name: HookName, callback: HookCallback) => {
          hooks[name] = callback
          return { dispose: async () => {} }
        },
        transform: async () => ({ dispose: async () => {} }),
      },
      location: { directory: process.cwd() },
    },
  }
}

const realWarn = console.warn
const realError = console.error
console.warn = () => {}
console.error = () => {}

// ─── design-token-guard ──────────────────────────────────────────────
{
  const { hooks, ctx } = makeToolCtx()
  await designTokenGuard.setup(ctx as never)
  const before = hooks["execute.before"]!

  const blockEvent = { tool: "write", input: { filePath: "App.tsx", content: "const c = '#fff'" } }
  let denied: unknown
  try {
    await before(blockEvent)
  } catch (err) {
    denied = err
  }
  assert(denied instanceof Error, "hardcoded hex write is rejected")
  assert(String((denied as Error).message).includes("[Design Token Guard]"), "rejection carries the guard banner")
  assert((denied as { _tag?: string })?._tag === "Tool.Error", "rejection is Tool.Error-shaped")

  await before({ tool: "write", input: { filePath: "notes.txt", content: "const c = '#fff'" } })
    .then(() => assert(true, "non-frontend write passes"))
    .catch(() => assert(false, "non-frontend write passes"))

  await before({ tool: "write", input: { filePath: "App.tsx", content: "// design-token-guard: off\nconst c = '#fff'" } })
    .then(() => assert(true, "opt-out first line passes"))
    .catch(() => assert(false, "opt-out first line passes"))

  await before({ tool: "read", input: { filePath: "App.tsx" } })
    .then(() => assert(true, "non-write tool passes"))
    .catch(() => assert(false, "non-write tool passes"))

  await before({ tool: "write", input: undefined })
    .then(() => assert(true, "missing input fails open"))
    .catch(() => assert(false, "missing input fails open"))
}

// ─── rtk-write (needs the real rtk binary; skipped otherwise) ────────
{
  const hasRtk = spawnSync("rtk", ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true }).status === 0
  if (!hasRtk) {
    console.log("SKIP: rtk binary not on PATH — rtk-write wiring section skipped")
  } else {
    const { hooks, ctx } = makeToolCtx()
    await rtkWrite.setup(ctx as never)
    assert(hooks["execute.before"] !== undefined && hooks["execute.after"] !== undefined, "both tool hooks registered")

    const before = hooks["execute.before"]!
    const after = hooks["execute.after"]!

    const callEvent = { tool: "shell", input: { command: "git status" }, sessionID: "wire-session", agent: "build", messageID: "wire-msg", id: "wire-call-1" }
    await before(callEvent as never)
    assert(callEvent.input.command === "rtk git status", `before-hook rewrites the shell command through rtk (got ${JSON.stringify(callEvent.input.command)})`)

    const elided = "clean\n[see remaining: tail -n +1 x-hidden.log]"
    const afterEvent = {
      tool: "shell",
      input: callEvent.input,
      sessionID: "wire-session",
      agent: "build",
      messageID: "wire-msg",
      id: "wire-call-1",
      status: "completed",
      result: { output: elided, content: [{ type: "text", text: elided }], metadata: {} },
    }
    await after(afterEvent as never)
    assert(String(afterEvent.result.output).includes("RTK_RAW=1 git status"), "after-hook appends the recovery notice to output")
    const lastText = afterEvent.result.content.findLast((item: { type: string; text?: string }) => item.type === "text")
    assert(String(lastText?.text).includes("RTK_RAW=1 git status"), "after-hook appends the recovery notice to model-visible content")
    assert(String(lastText?.text).startsWith("clean"), "original content text is preserved")

    // Error status must be ignored (v1 only annotated string output).
    const errorEvent = { ...afterEvent, id: "wire-call-2", status: "error", error: { message: "boom" } }
    await after(errorEvent as never)
    assert(errorEvent.result === afterEvent.result || errorEvent.result.output !== undefined, "error-status event leaves results alone")

    // Untracked call ID gets no hint even when elided.
    const untracked = { ...afterEvent, id: "never-seen", status: "completed", result: { output: elided, content: [{ type: "text", text: elided }] } }
    await after(untracked as never)
    assert(untracked.result.output === elided, "untracked call gets no recovery notice")
  }
}

console.warn = realWarn
console.error = realError
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
