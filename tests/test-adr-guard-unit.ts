/**
 * ADR Iron Law Plugin — Unit Tests (no API dependency)
 *
 * Coverage:
 *   - tokenizer: quote-aware splitting of shell commands
 *   - git commit detection & amend flag (incl. chained commits)
 *   - commit message extraction (-m, --message=, -am, glued forms)
 *   - conventional-commit type gate (feat/refactor only)
 *   - stripJsonc: comment/trailing-comma stripping without corrupting strings
 *   - state normalize & arg parsing (on/off aliases)
 *   - system hook: inject when on, idempotent, strip when off
 *   - tool guard: blocks feat commit without ADR change, allows fix/amend/off
 *     (incl. per-invocation gating of chained commits)
 *   - strict governance (Phase 6, §11/§13): /adr decide flow (madr + nygard +
 *     dotted iteration IDs), status-line-only byte-stable flip, append-only
 *     ledger, refusal outside strict, strict commit gate pass/fail, legacy
 *     gate independence, governance invariance over parsing/index,
 *     `git commit -a` / named-path unstaged-flip audit (F13), CRLF
 *     byte-stability (F14),
 *     adrDir-override decide/gate resolution (I)
 *
 * Run: bun run tests/test-adr-guard-unit.ts   (or: npx tsx tests/test-adr-guard-unit.ts)
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, dirname, basename } from "node:path"
import { fileURLToPath } from "node:url"

import {
  normalizeState,
  parseStateArg,
  getState,
  setState,
  setProjectDir,
  getProjectDir,
  getAdrConfig,
  getAdrDir,
  setAdrConfigFields,
  stripJsonc,
  COMMAND_NAME,
} from "../plugins/adr/adr-config"
import { createAdr, getNormalizedAdrs, supersedeAdr } from "../plugins/adr/adr-engine"
import { decideAdr, DECISIONS_LEDGER_REL, readDecidedIds, stagedAcceptFlips, acceptFlipsFromDiff } from "../plugins/adr/adr-governance"
import { setConfigField, clearConfigField } from "../plugins/shared/opencode-prime"
import {
  tokenize,
  isGitCommit,
  hasAmendFlag,
  extractCommitMessage,
  requiresAdr,
  segmentCommitsAll,
  segmentCommitsNamedPaths,
} from "../plugins/adr/adr-runtime"
import { makeSystemHook } from "../plugins/adr/adr-system-inject"
import { makeToolGuardHook } from "../plugins/adr/adr-tool-guard"
import { AdrPlugin } from "../plugins/adr/adr"

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, "..")

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

// Fake client — only the log surface is exercised in unit tests.
// ─── V2 test harness ──────────────────────────────────────────────────
// loadAdrPlugin runs AdrPlugin.setup() against a fake ctx and returns a
// v1-shaped plugin facade so the historical call sites keep working:
//   * plugin["command.execute.before"](input)  -> the registered command
//     execute(); a "handled" result re-throws Error("handled") to mirror
//     v1's empty-204 throw convention the assertions check.
//   * toasts -> shared/notify writes "[ocp:notify][variant] message" lines
//     to console (v2 has no toast surface); the spy below routes them into
//     the active per-test toasts array instead of stdout.
//   * session.prompt -> v1-shaped args ({ body: { parts: [{ text }] } })
//     so prompt-fall-through capture keeps its old shape.
const fakeSession: any = { synthetic: async () => {}, prompt: async () => {}, get: async () => ({}) }

type Toast = { message: string; level: string }
let activeToasts: Toast[] = []
const origLog = console.log
const origWarn = console.warn
function notifySpy(orig: (...a: unknown[]) => void, args: unknown[]): void {
  const line = String(args[0] ?? "")
  const m = /\[ocp:notify\]\[(\w+)\]\s*([\s\S]*)/.exec(line)
  if (m) { activeToasts.push({ message: m[2], level: m[1] }); return }
  orig(...args)
}
console.log = (...args: unknown[]) => notifySpy(origLog, args)
console.warn = (...args: unknown[]) => notifySpy(origWarn, args)

async function loadAdrPlugin(directory: string, toasts: Toast[] = [], promptedCalls: any[] = []) {
  activeToasts = toasts
  const commands = new Map<string, (inv: any) => Promise<"handled" | "dispatched" | void>>()
  const added: Array<{ name: string; description?: string }> = []
  const hookNames = new Set<string>()
  const ctx: any = {
    location: { directory },
    session: {
      hook: async (name: string) => { hookNames.add("session:" + name); return { dispose: async () => {} } },
      synthetic: async () => {},
      get: async () => ({}),
      // v1-shaped capture of template fall-through / continue dispatches.
      prompt: async ({ text }: any) => { promptedCalls.push({ body: { parts: [{ text }] } }) },
    },
    tool: {
      hook: async (name: string) => { hookNames.add("tool:" + name); return { dispose: async () => {} } },
      transform: async () => { hookNames.add("tool:transform"); return { dispose: async () => {} } },
    },
    command: {
      transform: async (cb: any) => {
        cb({ add: (d: any) => { commands.set(d.name, d.execute); added.push(d) } })
        return { dispose: async () => {} }
      },
    },
    event: { subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }) },
  }
  const cleanup = await AdrPlugin.setup(ctx)
  return {
    "command.execute.before": async (input: { command?: string; arguments?: string; sessionID?: string }) => {
      const exec = commands.get(input.command ?? "")
      if (!exec) return
      const invocation = { sessionID: input.sessionID ?? "t", prompt: { text: input.arguments ?? "" } }
      await exec(invocation)
      if ((invocation as { __status?: string }).__status === "handled") throw new Error("handled")
    },
    "tool.execute.before": true,
    "experimental.chat.system.transform": true,
    commands,
    added,
    hookNames,
    cleanup,
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  1. Tokenizer
// ═════════════════════════════════════════════════════════════════════════

function test01_Tokenizer() {
  section("01: Quote-aware tokenizer")
  assert(
    JSON.stringify(tokenize(`git commit -m "feat: add api"`)) ===
      JSON.stringify(["git", "commit", "-m", "feat: add api"]),
    "double-quoted message kept as one token",
  )
  assert(
    JSON.stringify(tokenize(`git commit -m 'refactor: split; parse'`)) ===
      JSON.stringify(["git", "commit", "-m", "refactor: split; parse"]),
    "single-quoted message with semicolon survives",
  )
  assert(
    JSON.stringify(tokenize(`git add -A && git commit -m "feat: x"`)) ===
      JSON.stringify(["git", "add", "-A", "&&", "git", "commit", "-m", "feat: x"]),
    "chained commands split on &&",
  )
  assert(
    JSON.stringify(tokenize(`git commit -m "say \\"hi\\""`)) ===
      JSON.stringify(["git", "commit", "-m", 'say "hi"']),
    "escaped quotes inside double quotes preserved",
  )
}

// ═════════════════════════════════════════════════════════════════════════
//  2. git commit detection & amend
// ═════════════════════════════════════════════════════════════════════════

function test02_GitCommitDetection() {
  section("02: git commit detection & amend flag")
  assert(isGitCommit(`git commit -m "feat: x"`), "plain git commit detected")
  assert(isGitCommit(`git add . && git commit -m "feat: x"`), "chained git commit detected")
  assert(!isGitCommit(`git commit-tree abc`), "git commit-tree NOT a commit")
  assert(!isGitCommit(`git status`), "unrelated git command ignored")
  assert(hasAmendFlag(`git commit --amend -m "feat: x"`), "--amend detected")
  assert(!hasAmendFlag(`git commit -m "feat: x"`), "no amend on plain commit")
  assert(
    hasAmendFlag(`git commit --amend && git commit -m "feat: x"`),
    "amend detected in chained command",
  )
  assert(
    isGitCommit(`git commit -m "fix: a" && git commit -m "feat: b"`),
    "second chained commit detected",
  )
}

// ═════════════════════════════════════════════════════════════════════════
//  3. Commit message extraction
// ═════════════════════════════════════════════════════════════════════════

function test03_MessageExtraction() {
  section("03: Commit message extraction")
  assert(extractCommitMessage(`git commit -m "feat: add api"`) === "feat: add api", "-m double-quoted")
  assert(extractCommitMessage(`git commit -m 'feat: add api'`) === "feat: add api", "-m single-quoted")
  assert(extractCommitMessage(`git commit -m feat-word`) === "feat-word", "-m unquoted single word")
  assert(extractCommitMessage(`git commit -m="feat: x"`) === "feat: x", "-m= form")
  assert(extractCommitMessage(`git commit --message "feat: x"`) === "feat: x", "--message form")
  assert(extractCommitMessage(`git commit --message="feat: x"`) === "feat: x", "--message= form")
  assert(extractCommitMessage(`git commit -am "feat: x"`) === "feat: x", "combined -am form")
  assert(
    extractCommitMessage(`git add -A && git commit -m "feat: x; done" && git push`) === "feat: x; done",
    "message in chained command",
  )
  assert(extractCommitMessage(`git commit`) === null, "no inline message → null (fail open)")
  assert(
    extractCommitMessage(`git commit -m "fix: a" && git commit -m "feat: b"`) === "fix: a",
    "multi-commit: first invocation's message returned",
  )
}

// ═════════════════════════════════════════════════════════════════════════
//  4. Conventional-commit type gate
// ═════════════════════════════════════════════════════════════════════════

function test04_TypeGate() {
  section("04: feat/refactor type gate")
  assert(requiresAdr("feat: add login"), "feat: triggers")
  assert(requiresAdr("feat(api): add login"), "feat(scope): triggers")
  assert(requiresAdr("refactor!: drop v1 path"), "refactor!: triggers")
  assert(requiresAdr("REFACTOR(core): x"), "case-insensitive")
  assert(requiresAdr("feat: x\n\nbody with refactor: notes"), "only first line counts")
  assert(!requiresAdr("fix: bug"), "fix: does not trigger")
  assert(!requiresAdr("docs: update readme"), "docs: does not trigger")
  assert(!requiresAdr("chore: bump deps"), "chore: does not trigger")
  assert(!requiresAdr("feature: not a conventional type"), "feature: is not feat:")
}

// ═════════════════════════════════════════════════════════════════════════
//  4b. stripJsonc — comments & trailing commas, string-safe
// ═════════════════════════════════════════════════════════════════════════

function test04b_StripJsonc() {
  section("04b: stripJsonc — comments & trailing commas (string-safe)")
  assert(JSON.parse(stripJsonc('{"a": 1, /* c */ "b": 2,}')).b === 2, "trailing comma in object removed")
  assert(JSON.parse(stripJsonc('{"a": [1, 2,],}')).a.length === 2, "trailing comma in array removed")
  assert(JSON.parse(stripJsonc('{"a": "x,}"}')).a === "x,}", "comma inside string preserved (,})")
  assert(JSON.parse(stripJsonc('{"url": "see a,] b"}')).url === "see a,] b", "comma inside string preserved (,])")
  assert(
    JSON.parse(stripJsonc('{"u": "http://x", // note\n"b": 1}')).u === "http://x",
    "// inside string is not a comment",
  )
  assert(JSON.parse(stripJsonc('{"s": "say \\"hi\\"",}')).s === 'say "hi"', "escaped quote + trailing comma")
}

// ═════════════════════════════════════════════════════════════════════════
//  5. State normalize & arg parsing
// ═════════════════════════════════════════════════════════════════════════

function test05_StateParsing() {
  section("05: State normalize & arg parsing")
  // Default-off must not depend on this repo's committed config — resolve
  // against an empty temp directory instead.
  const tmp = mkdtempSync(join(tmpdir(), "adr-guard-"))
  try {
    setProjectDir(tmp)
    assert(getState() === "off", "default state is OFF (no config field)")
  } finally {
    setProjectDir(REPO_ROOT)
    rmSync(tmp, { recursive: true, force: true })
  }
  assert(normalizeState("on") === "on", "on")
  assert(normalizeState("OFF") === "off", "OFF (case-insensitive)")
  assert(normalizeState("enabled") === "on", "enabled → on alias")
  assert(normalizeState("disabled") === "off", "disabled → off alias")
  assert(normalizeState("true") === "on", "true → on alias")
  assert(normalizeState("maybe") === null, "unknown → null")
  assert(parseStateArg("on") === "on", "/adr-guard on")
  assert(parseStateArg("  off  ") === "off", "whitespace trimmed")
  assert(parseStateArg("status") === null, "status → null (caller reports)")
  assert(parseStateArg(undefined) === null, "no args → null (caller reports)")
  assert(COMMAND_NAME === "adr-guard", "command name stable")
}

// ═════════════════════════════════════════════════════════════════════════
//  5b. /adr guard routing + /adr-guard alias equivalence
// ═════════════════════════════════════════════════════════════════════════

async function test05b_GuardCommandRouting() {
  section("05b: /adr guard routing + /adr-guard alias")
  const toasts: { message: string; level: string }[] = []
  const mockClient: any = {
    app: { log: async () => {} },
    tui: { showToast: async (args: any) => { toasts.push({ message: String(args?.body?.message ?? ""), level: String(args?.body?.variant ?? "") }) } },
    session: { prompt: async () => {} },
  }
  const tmp = mkdtempSync(join(tmpdir(), "adr-guard-route-"))
  try {
    const plugin = (await loadAdrPlugin(tmp, toasts)) as any
    const cmdHook = plugin["command.execute.before"]

    // `/adr guard on` — routed subcommand: handled (204) + switch flipped
    toasts.length = 0
    let threw: any = null
    try { await cmdHook({ command: "adr", arguments: "guard on", sessionID: "r-1" }) } catch (e) { threw = e }
    assert(threw !== null, "/adr guard on is handled (204)")
    assert(getState() === "on", "/adr guard on flips the switch")
    assert(toasts.some((t) => t.message.includes("ON")), "/adr guard on announces ON")

    // alias parity: /adr-guard off
    toasts.length = 0
    threw = null
    try { await cmdHook({ command: "adr-guard", arguments: "off", sessionID: "r-2" }) } catch (e) { threw = e }
    assert(threw !== null, "/adr-guard off alias still handled (204)")
    assert(getState() === "off", "/adr-guard off flips the switch back")
    assert(toasts.some((t) => t.message.includes("OFF")), "alias announces OFF")

    // status: /adr guard status → status report, switch untouched
    toasts.length = 0
    threw = null
    try { await cmdHook({ command: "adr", arguments: "guard status", sessionID: "r-3" }) } catch (e) { threw = e }
    assert(threw !== null, "/adr guard status is handled (204)")
    assert(toasts.some((t) => t.message.toUpperCase().includes("STATUS")), "/adr guard status announces state")

    // reset: removes the adrGuard field (back to default off)
    try { await cmdHook({ command: "adr", arguments: "guard on", sessionID: "r-4" }) } catch { /* 204 */ }
    assert(getState() === "on", "pre-reset state on")
    toasts.length = 0
    threw = null
    try { await cmdHook({ command: "adr", arguments: "guard reset", sessionID: "r-5" }) } catch (e) { threw = e }
    assert(threw !== null, "/adr guard reset is handled (204)")
    assert(getState() === "off", "/adr guard reset reverts to default off")

    // bare `/adr guard` must NOT fall through to the new-decision branch
    const adrDir = join(tmp, "docs", "adr")
    const before = existsSync(adrDir) ? readdirSync(adrDir).length : 0
    try { await cmdHook({ command: "adr", arguments: "guard", sessionID: "r-6" }) } catch { /* 204 */ }
    const after = existsSync(adrDir) ? readdirSync(adrDir).length : 0
    assert(before === after, "bare /adr guard creates NO ADR (no fall-through to new)")
  } finally {
    setProjectDir(REPO_ROOT)
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  6. System hook — inject when on, idempotent, strip when off
// ═════════════════════════════════════════════════════════════════════════

async function test06_SystemHook() {
  section("06: System hook inject / idempotency / strip (Phase 7.8)")
  const hookV2 = makeSystemHook(fakeSession)
  // v1 (input, output) call convention over the v2 single-event hook;
  // the SAME system array reference is shared so assertions see the flips.
  const hook = async (input: any, output: { system: string[] }) => {
    await hookV2({ sessionID: input?.sessionID, system: output.system })
  }

  // Phase 7.8: the hook injects hint + config on EVERY turn regardless
  // of the adrGuard switch (the switch now only gates the tool guard).
  // No protocol body is ever inlined — it lives in the adr-protocol skill.
  setState("on")
  const out1 = { system: ["base prompt"] }
  await hook({}, out1 as any)
  assert(out1.system[0].includes("[ADR]"), "hint marker injected (state=on)")
  assert(out1.system[0].includes("[ADR-CONFIG-RUNTIME]"), "config marker injected (state=on)")
  assert(!out1.system[0].includes("ADR Iron Law"), "protocol body NEVER inlined (skill-based, Phase 7.8)")
  assert(out1.system[0].includes("adrDir"), "runtime adrDir field present in config table")
  assert(out1.system[0].includes("filenamePattern"), "runtime filenamePattern field present in config table")
  assert(out1.system[0].includes("`docs/adr/`"), "adrDir default rendered with leading docs/adr/")

  // Idempotency: same config → byte-identical output (provider
  // prefix-cache contract; deterministic rendering, no volatile content).
  const afterFirst = out1.system[0]
  await hook({}, out1 as any)
  assert(out1.system[0] === afterFirst, "second call is byte-identical (cache-friendly)")

  // Switch off: hint + config STAY injected (Phase 7.8 — the switch no
  // longer toggles prompt content); no protocol body appears either way.
  setState("off")
  await hook({}, out1 as any)
  assert(out1.system[0].includes("[ADR]"), "hint marker still injected (state=off)")
  assert(out1.system[0].includes("[ADR-CONFIG-RUNTIME]"), "config marker still injected (state=off)")
  assert(!out1.system[0].includes("ADR Iron Law"), "no protocol body in off state either")

  const out2 = { system: ["base prompt"] }
  await hook({}, out2 as any)
  assert(out2.system[0].includes("[ADR]"), "fresh prompt → hint injected")
  assert(out2.system[0].includes("[ADR-CONFIG-RUNTIME]"), "fresh prompt → config injected")
  assert(out2.system[0].includes("/adr config"), "hint advertises /adr config")

  // Multi-entry system prompt: fragments land in the LAST entry only —
  // the old loop duplicated them across every entry.
  const out3 = { system: ["entry A", "entry B"] }
  await hook({}, out3 as any)
  assert(out3.system[0] === "entry A", "multi-entry: first entry untouched")
  assert(out3.system[1].includes("[ADR]"), "hint marker present in last entry only")
  assert(out3.system[1].includes("[ADR-CONFIG-RUNTIME]"), "config marker present in last entry only")
  assert(out3.system.filter((s) => s.includes("[ADR]")).length === 1, "hint marker appears exactly once across entries")
}

// ═════════════════════════════════════════════════════════════════════════
//  7. Tool guard — block / allow matrix
// ═════════════════════════════════════════════════════════════════════════
// Hermetic precondition: a THROWAWAY git repo (one committed file, clean
// status) so hasAdrChanges() is reliably false — the block path must not
// depend on the real repo's working-tree state (hasAdrChanges also matches
// any docs/adr path by design, so an uncommitted ADR edit in REPO_ROOT
// would silently open the gate and hollow out these assertions).

async function test07_ToolGuard() {
  section("07: Tool guard block/allow matrix")
  const guard = makeToolGuardHook()

  const rootT7 = mkdtempSync(join(tmpdir(), "adr-guard-t7-"))
  const git = (args: string[]) =>
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: rootT7,
      timeout: 10_000,
    })
  assert(git(["init", "-q"]).status === 0, "throwaway git repo init")
  writeFileSync(join(rootT7, "README.md"), "t\n")
  assert(git(["add", "README.md"]).status === 0, "throwaway repo seed staged")
  assert(git(["commit", "-qm", "chore: seed"]).status === 0, "throwaway repo seeded")
  setProjectDir(rootT7)
  try {

  async function call(command: string): Promise<string | null> {
    try {
      await guard({ tool: "bash", input: { command } } as any)
      return null
    } catch (err) {
      return String((err as Error).message)
    }
  }

  setState("on")
  const blocked = await call(`git commit -m "feat: add new api"`)
  assert(blocked !== null && blocked.includes("[ADR-GUARD]"), "feat commit blocked without ADR change")
  assert(blocked !== null && blocked.includes("NNNN-slug"), "block message names the MADR template")

  assert((await call(`git commit -m "fix: bug"`)) === null, "fix commit allowed")
  assert((await call(`git commit -m "chore: deps"`)) === null, "chore commit allowed")
  assert((await call(`git commit --amend -m "feat: x"`)) === null, "--amend allowed")
  assert(
    (await call(`git commit --amend && git commit -m "feat: x"`)) !== null,
    "amend does NOT exempt a later fresh feat commit",
  )
  assert(
    (await call(`git commit -m "fix: a" && git commit -m "feat: b"`)) !== null,
    "chained feat commit blocked even when first is fix",
  )
  assert(
    (await call(`git commit --amend && git commit -m "fix: x"`)) === null,
    "amend + fix chain allowed",
  )
  assert((await call(`git commit`)) === null, "no inline message → fail open")
  assert((await call(`git status`)) === null, "non-commit bash allowed")
  assert(
    (await guard({ tool: "edit", input: {} } as any)) === undefined,
    "non-bash tool untouched",
  )

  setState("off")
  assert((await call(`git commit -m "feat: x"`)) === null, "off → feat commit allowed")
  } finally {
    setProjectDir(REPO_ROOT)
    rmSync(rootT7, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  8. Config hook — command registration
// ═════════════════════════════════════════════════════════════════════════

async function test08_ConfigHook() {
  section("08: V2 registration — commands, hooks, tools")
  const plugin = await loadAdrPlugin(REPO_ROOT)
  assert(plugin.commands.has(COMMAND_NAME), "/adr-guard alias registered (editor.add)")
  assert(plugin.commands.has("adr"), "/adr command registered (editor.add)")
  const guardCmd = plugin.added.find((c) => c.name === COMMAND_NAME)
  assert((guardCmd?.description ?? "").includes("ADR"), "alias description mentions ADR")
  assert(plugin.hookNames.has("session:context"), "system injection -> v2 context hook present")
  assert(plugin.hookNames.has("tool:execute.before"), "tool guard hook present")
  assert(plugin.hookNames.has("tool:execute.after"), "question-authorization after-hook present")
  assert(plugin.hookNames.has("tool:transform"), "adr tools registered via tool transform")
  await plugin.cleanup()
}

async function test09_AdrCommandAutoDraft() {
  section("09: /adr new auto-draft vs --empty flag")
  let promptedCalls: any[] = []
  const tmpTestDir = mkdtempSync(join(tmpdir(), "adr-test-draft-"))
  try {
    const plugin = await loadAdrPlugin(tmpTestDir, [], promptedCalls)
    const cmdHook = plugin["command.execute.before"]

    // Test 1: /adr new with default auto-drafting
    let thrownError: any = null
    try {
      await cmdHook({ command: "adr", arguments: 'new "Test Auto Draft"', sessionID: "test-sess-1" })
    } catch (e) {
      thrownError = e
    }
    assert(thrownError === null, "default /adr new does NOT throw 204, allowing OpenCode to dispatch to LLM")
    const adr1 = join(tmpTestDir, "docs/adr/0001-test-auto-draft.md")
    assert(existsSync(adr1), "default /adr new scaffolds 0001 file")

    // Test 2: /adr new with --empty flag
    thrownError = null
    try {
      await cmdHook({ command: "adr", arguments: 'new "Test Empty Template" --empty', sessionID: "test-sess-2" })
    } catch (e) {
      thrownError = e
    }
    assert(!!thrownError, "command hook returns 204 handled for --empty")
    const adr2 = join(tmpTestDir, "docs/adr/0002-test-empty-template.md")
    assert(existsSync(adr2), "/adr new --empty scaffolds 0002 file")

    // Test 3: direct /adr <title> without 'new' keyword
    thrownError = null
    try {
      await cmdHook({ command: "adr", arguments: '"Test Direct Requirement Without New Keyword"', sessionID: "test-sess-3" })
    } catch (e) {
      thrownError = e
    }
    assert(thrownError === null, "direct /adr <title> does not throw 204, dispatching to LLM")
    const adr3 = join(tmpTestDir, "docs/adr/0003-test-direct-requirement-without-new-keyword.md")
    assert(existsSync(adr3), "direct /adr scaffolds 0003 file")

    // Test 4: unquoted title: /adr 采用 Redis 作为分布式锁
    thrownError = null
    try {
      await cmdHook({ command: "adr", arguments: "采用 Redis 作为分布式锁", sessionID: "test-sess-4" })
    } catch (e) {
      thrownError = e
    }
    assert(thrownError === null, "unquoted /adr command does not throw 204, dispatching to LLM")
    const adr4 = join(tmpTestDir, "docs/adr/0004-redis.md")
    assert(existsSync(adr4), "unquoted /adr scaffolds 0004-redis.md file")
  } finally {
    rmSync(tmpTestDir, { recursive: true, force: true })
  }
}

async function test10_AdrSupersede() {
  section("10: /adr supersede linking, index & auto-draft")
  const tmpTestDir = mkdtempSync(join(tmpdir(), "adr-test-super-"))
  try {
    const plugin = await loadAdrPlugin(tmpTestDir)
    const cmdHook = plugin["command.execute.before"]

    // Step 1: Create initial ADR 0001
    try {
      await cmdHook({ command: "adr", arguments: 'new "Initial Storage Decision" --empty', sessionID: "s-1" })
    } catch {}

    const adr1Path = join(tmpTestDir, "docs/adr/0001-initial-storage-decision.md")
    assert(existsSync(adr1Path), "ADR 0001 created")

    // Step 2: Supersede with unpadded numeric '1' and auto-draft
    let thrownError: any = null
    try {
      await cmdHook({ command: "adr", arguments: 'supersede 1 "New Cloud Storage Standard"', sessionID: "s-2" })
    } catch (e) {
      thrownError = e
    }
    assert(thrownError === null, "/adr supersede does not throw 204, dispatching to LLM")

    const adr2Path = join(tmpTestDir, "docs/adr/0002-new-cloud-storage-standard.md")
    assert(existsSync(adr2Path), "ADR 0002 created via unpadded numeric '1'")

    const adr1Content = readFileSync(adr1Path, "utf-8")
    assert(adr1Content.includes("status: Superseded by ADR-0002"), "ADR 0001 status line flipped to Superseded by ADR-0002")
    // §9.5: the flip touches ONLY the status line — the pre-refactor engine
    // injected a `superseded_by:` frontmatter key (wholesale frontmatter
    // rewrite); Phase 1 narrowed it, so the old body stays byte-stable.
    assert(!adr1Content.includes("superseded_by:"), "ADR 0001 gains NO superseded_by frontmatter (status-line-only flip)")
    assert(adr1Content.includes("## Decision Outcome"), "ADR 0001 body preserved (Decision Outcome intact)")

    const adr2Content = readFileSync(adr2Path, "utf-8")
    assert(adr2Content.includes("supersedes: ADR-0001"), "ADR 0002 references supersedes: ADR-0001 (ID form)")

    const indexPath = join(tmpTestDir, "docs/adr/INDEX.md")
    assert(existsSync(indexPath), "INDEX.md exists")
    const indexContent = readFileSync(indexPath, "utf-8")
    assert(indexContent.includes("Superseded"), "INDEX.md contains Superseded status for 0001")
    assert(indexContent.includes("Proposed"), "INDEX.md contains Proposed status for 0002 (§6.2: no code path writes accepted)")

    // Step 3: Supersede with --empty flag
    thrownError = null
    try {
      await cmdHook({ command: "adr", arguments: 'supersede 0002 "Third Storage Standard" --empty', sessionID: "s-3" })
    } catch (e) {
      thrownError = e
    }
    assert(!!thrownError, "/adr supersede --empty throws 204 handled")

    const adr3Path = join(tmpTestDir, "docs/adr/0003-third-storage-standard.md")
    assert(existsSync(adr3Path), "ADR 0003 created")
  } finally {
    rmSync(tmpTestDir, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  11. Strict governance (Phase 6, §11/§13)
// ═════════════════════════════════════════════════════════════════════════
// One throwaway project: git repo + adr.governance config, covering the
// decide flow on madr / nygard / dotted-iteration records, ledger
// append-only behavior, refusal outside strict, the strict commit gate
// pass/fail matrix, and governance invariance over parsing/index output.

async function test11_StrictGovernance() {
  section("11: Strict governance — decide flow, ledger, commit gate")
  const guard = makeToolGuardHook()
  const toasts: { message: string; level: string }[] = []
  const mockClient: any = {
    app: { log: async () => {} },
    tui: { showToast: async (args: any) => { toasts.push({ message: String(args?.body?.message ?? ""), level: String(args?.body?.variant ?? "") }) } },
    session: { prompt: async () => {} },
  }

  const root = mkdtempSync(join(tmpdir(), "adr-gov-"))
  const git = (args: string[]) =>
    spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: root,
      timeout: 10_000,
    })
  assert(git(["init", "-q"]).status === 0, "governance sandbox git repo init")
  writeFileSync(join(root, "README.md"), "t\n")
  assert(git(["add", "README.md"]).status === 0 && git(["commit", "-qm", "chore: seed"]).status === 0, "governance sandbox seeded")

  setProjectDir(root)
  try {
    assert(setAdrConfigFields({ governance: "strict", style: "madr" }), "adr.governance=strict written")
    assert(getAdrConfig().governance === "strict", "governance reads back strict")
    const ledgerPath = join(root, DECISIONS_LEDGER_REL)

    async function call(command: string): Promise<string | null> {
      try {
        await guard({ tool: "bash", input: { command } } as any)
        return null
      } catch (err) {
        return String((err as Error).message)
      }
    }

    // ── A. decide flow — madr record, status-line-only flip ──────────
    const a1 = createAdr({ projectDir: root, title: "Madr Decision" })
    const before1 = readFileSync(a1.fullPath, "utf-8")
    assert(before1.includes("status: Proposed"), "madr record scaffolded Proposed (§6.2)")
    const r1 = decideAdr(root, "ADR-0001", "ratified after review")
    assert(r1.id === "ADR-0001", "decide resolves canonical ADR-0001")
    const after1 = readFileSync(a1.fullPath, "utf-8")
    const beforeLines = before1.split(/\r?\n/)
    const afterLines = after1.split(/\r?\n/)
    assert(beforeLines.length === afterLines.length, "decide changes NO line count (§9.5 byte-stability)")
    const changed = afterLines.filter((l, i) => l !== beforeLines[i])
    assert(changed.length === 1 && /^status:\s*Accepted/.test(changed[0] ?? ""), "decide flips ONLY the status line")
    assert(existsSync(ledgerPath), "ledger created at .ocp/adr-decisions.log")
    const ledger1 = readFileSync(ledgerPath, "utf-8").trimEnd().split(/\r?\n/)
    assert(ledger1.length === 1, "ledger holds exactly one line after first decide")
    const cols1 = (ledger1[0] ?? "").split("\t")
    assert(cols1[1] === "ADR-0001" && cols1[2] === a1.relPath && cols1[3] === "ratified after review", "ledger line: canonical ID + relPath + note")
    const indexAfterDecide = readFileSync(join(root, "docs/adr/INDEX.md"), "utf-8")
    assert(indexAfterDecide.includes("Accepted"), "index regenerated with Accepted badge")
    let threw = false
    try { decideAdr(root, "ADR-0001") } catch { threw = true }
    assert(threw, "deciding an already-accepted ADR refuses")

    // ── B. nygard record via bare/unpadded ref, ledger stays append-only ──
    const a2 = createAdr({ projectDir: root, title: "Nygard Decision", style: "nygard" })
    const firstLedgerLine = readFileSync(ledgerPath, "utf-8").split(/\r?\n/)[0]
    const r2 = decideAdr(root, "2") // bare unpadded numeric — normalized to ADR-0002
    assert(r2.id === "ADR-0002", "decide normalizes bare '2' to ADR-0002 (nygard record)")
    const ledger2 = readFileSync(ledgerPath, "utf-8").split(/\r?\n/)
    assert(ledger2[0] === firstLedgerLine, "append-only: first ledger line byte-unchanged after second decide")

    // ── C. dotted iteration ID — no four-digit assumption anywhere ────
    const a3 = createAdr({ projectDir: root, title: "Iteration Decision", numbering: "iteration", baseline: "0.2", iteration: "54" })
    assert(a3.id === "0.2.54.01", "dotted record allocated 0.2.54.01")
    const r3 = decideAdr(root, "0.2.54.01")
    assert(r3.id === "ADR-0.2.54.01", "decide canonicalizes dotted ID to ADR-0.2.54.01")
    const decided = readDecidedIds(root)
    assert(decided.has("ADR-0001") && decided.has("ADR-0002") && decided.has("ADR-0.2.54.01"), "readDecidedIds holds all three canonical IDs")
    writeFileSync(ledgerPath, "garbage line\n", { flag: "a" })
    assert(readDecidedIds(root).size === 3, "malformed ledger lines skipped, never fatal")

    // ── D. superseded records are archive — decide refuses ────────────
    const a4 = createAdr({ projectDir: root, title: "To Be Superseded" })
    assert(a4.id === "0003", "sequential allocation reaches 0003 (dotted IDs never counted)")
    supersedeAdr(root, "3", "Replacement Decision")
    threw = false
    try { decideAdr(root, "ADR-0003") } catch (e) { threw = String(e).includes("only proposed") }
    assert(threw, "deciding a superseded record refuses (archive stays archive)")

    // ── E. /adr decide refuses outside strict; command surface ───────
    assert(setAdrConfigFields({ governance: "none" }), "governance flipped to none")
    const ledgerBeforeNoneRefuse = readFileSync(ledgerPath, "utf-8")
    const a5 = createAdr({ projectDir: root, title: "Convention Mode Decision" })
    threw = false
    try { decideAdr(root, "ADR-0005") } catch (e) { threw = String(e).includes("only available in strict") }
    assert(threw, "decideAdr refuses in none mode with a clear message")
    assert(readFileSync(ledgerPath, "utf-8") === ledgerBeforeNoneRefuse, "refused decide in none mode appends NO ledger line")
    assert(setAdrConfigFields({ governance: "review" }), "governance flipped to review")
    threw = false
    try { decideAdr(root, "ADR-0005") } catch (e) { threw = String(e).includes("only available in strict") }
    assert(threw, "decideAdr refuses in review mode (protocol-only)")
    assert(readFileSync(ledgerPath, "utf-8") === ledgerBeforeNoneRefuse, "refused decides append NO ledger lines")
    assert(setAdrConfigFields({ governance: "strict" }), "governance restored to strict")

    // Command surface: /adr decide via the plugin command hook
    const plugin = (await loadAdrPlugin(root, toasts)) as any
    const cmdHook = plugin["command.execute.before"]
    toasts.length = 0
    let handledThrown: any = null
    try {
      await cmdHook({ command: "adr", arguments: "decide ADR-0005 \"note via command\"", sessionID: "g-1" })
    } catch (e) { handledThrown = e }
    assert(handledThrown !== null, "/adr decide is handled (204)")
    assert(toasts.some((t) => t.message.includes("ADR-0005")), "/adr decide announces the decided ID (locale-independent)")
    assert(readFileSync(ledgerPath, "utf-8").includes("ADR-0005") && readFileSync(ledgerPath, "utf-8").includes("note via command"), "command-path decide appends ledger line with note")
    toasts.length = 0
    assert(setAdrConfigFields({ governance: "none" }), "governance flipped to none for command refusal")
    const a6 = createAdr({ projectDir: root, title: "Second Convention Decision" })
    void a6
    try { await cmdHook({ command: "adr", arguments: "decide ADR-0006", sessionID: "g-2" }) } catch { /* handled() throws 204 */ }
    assert(toasts.some((t) => t.message.includes("only available in strict")), "command /adr decide announces refusal outside strict")
    assert(setAdrConfigFields({ governance: "strict" }), "governance restored to strict for gate tests")

    // ── F. strict commit gate pass/fail matrix (staged diff based) ────
    // F1: feat commit with NO decided flip staged → blocked
    let blocked = await call(`git commit -m "feat: add new api"`)
    assert(blocked !== null && blocked.includes("[ADR-GOVERNANCE]"), "strict gate blocks feat commit without a decided flip")

    // F2: hand-edited accept flip (no ledger) staged → blocked on EVERY type
    const a7 = createAdr({ projectDir: root, title: "Hand Edited Decision" })
    const a7Content = readFileSync(a7.fullPath, "utf-8")
    writeFileSync(a7.fullPath, a7Content.replace(/^status:\s*[^\r\n]+/im, "status: accepted"), "utf-8")
    assert(git(["add", "docs/adr"]).status === 0, "hand-edited flip staged")
    blocked = await call(`git commit -m "fix: bug"`)
    assert(blocked !== null && blocked.includes("ADR-0007") && blocked.includes("decision record"), "undecided flip blocks even a fix commit")
    assert(stagedAcceptFlips(root, "docs/adr").some((f) => f.id === "ADR-0007"), "stagedAcceptFlips detects the normalized ID")
    // restore: back to proposed, unstage
    writeFileSync(a7.fullPath, a7Content, "utf-8")
    git(["reset", "-q"])

    // F3: proper flow — /adr decide then stage → feat commit passes
    decideAdr(root, "ADR-0007", "decided then shipped")
    assert(git(["add", "-A"]).status === 0, "decided flip + code staged")
    blocked = await call(`git commit -m "feat: add new api"`)
    assert(blocked === null, "feat commit ships when it carries a ledger-backed decided flip")
    assert(git(["commit", "-qm", "feat: add new api"]).status === 0, "feat commit EXECUTED after gate pass (guard only intercepts)")

    // F4: dotted iteration undecided flip → blocked, dotted ID named (no four-digit assumption)
    const a8 = createAdr({ projectDir: root, title: "Iteration Hand Edit", numbering: "iteration", baseline: "0.2", iteration: "54" })
    const a8Content = readFileSync(a8.fullPath, "utf-8")
    writeFileSync(a8.fullPath, a8Content.replace(/^status:\s*[^\r\n]+/im, "status: accepted"), "utf-8")
    git(["add", "docs/adr"])
    blocked = await call(`git commit -m "feat: dotted flip"`)
    assert(blocked !== null && blocked.includes("ADR-0.2.54.02"), "dotted iteration undecided flip blocked, dotted ID named")
    writeFileSync(a8.fullPath, a8Content, "utf-8")
    git(["reset", "-q"])

    // F5: review mode — no mechanical gate at all
    assert(setAdrConfigFields({ governance: "review" }), "governance flipped to review for gate check")
    let reviewBlocked: string | null = null
    try {
      await guard({ tool: "bash" } as any, { args: { command: `git commit -m "feat: free"` } } as any)
    } catch (e) { reviewBlocked = String((e as Error).message) }
    assert(reviewBlocked === null, "review mode: feat commit NOT mechanically gated (protocol-only, §11)")
    assert(setAdrConfigFields({ governance: "strict" }), "governance restored to strict")

    // F6: --amend stays exempt under strict
    let amendBlocked: string | null = null
    try {
      await guard({ tool: "bash" } as any, { args: { command: `git commit --amend -m "chore: seed v2"` } } as any)
    } catch (e) { amendBlocked = String((e as Error).message) }
    assert(amendBlocked === null, "--amend exempt from the strict gate")

    // ── F7. --amend never launders an undecided flip (MAJOR 1 + MINOR 4) ──
    // The amend exemption applies ONLY to the positive decision check; the
    // undecided-flip audit must run for EVERY commit invocation. The
    // hand-flip also uses the quoted YAML form to prove quoted detection.
    const a10 = createAdr({ projectDir: root, title: "Amend Launder Attempt" })
    const a10Content = readFileSync(a10.fullPath, "utf-8")
    writeFileSync(a10.fullPath, a10Content.replace(/^status:\s*[^\r\n]+/im, 'status: "accepted"'), "utf-8")
    git(["add", "docs/adr"])
    blocked = await call(`git commit --amend --no-edit`)
    assert(
      blocked !== null && blocked.includes(`ADR-${a10.id}`) && blocked.includes("decision record"),
      "--amend with a staged undecided flip is BLOCKED (amend exempts only the positive check)",
    )
    assert(
      stagedAcceptFlips(root, "docs/adr").some((f) => f.id === `ADR-${a10.id}`),
      'quoted status: "accepted" flip detected in the staged diff',
    )
    writeFileSync(a10.fullPath, a10Content, "utf-8")
    git(["reset", "-q"])

    // ── F8. user diff config (diff.noprefix) cannot blind the probe (MAJOR 3) ──
    assert(git(["config", "diff.noprefix", "true"]).status === 0, "sandbox repo sets diff.noprefix=true")
    const a11 = createAdr({ projectDir: root, title: "Noprefix Config Decision" })
    const a11Content = readFileSync(a11.fullPath, "utf-8")
    writeFileSync(a11.fullPath, a11Content.replace(/^status:\s*[^\r\n]+/im, "status: accepted"), "utf-8")
    git(["add", "docs/adr"])
    blocked = await call(`git commit -m "fix: noprefix probe"`)
    assert(
      blocked !== null && blocked.includes(`ADR-${a11.id}`),
      "flips still detected under diff.noprefix=true (forced a/ b/ prefixes)",
    )
    writeFileSync(a11.fullPath, a11Content, "utf-8")
    git(["reset", "-q"])
    assert(git(["config", "diff.noprefix", "false"]).status === 0, "diff.noprefix reset after probe")

    // ── F9. nested/hierarchical ADR dirs are inside the strict gate (MAJOR 2) ──
    mkdirSync(join(root, "docs/adr/domains/payments"), { recursive: true })
    mkdirSync(join(root, "docs/adr/domains/billing"), { recursive: true })
    const a12 = createAdr({ projectDir: root, title: "Nested Domain Decision" })
    renameSync(a12.fullPath, join(root, "docs/adr/domains/payments", basename(a12.fullPath)))
    const a13 = createAdr({ projectDir: root, title: "Nested Iteration Decision", numbering: "iteration", baseline: "0.3", iteration: "1" })
    renameSync(a13.fullPath, join(root, "docs/adr/domains/billing", basename(a13.fullPath)))
    const nested = [
      { adr: a12, dir: "payments" },
      { adr: a13, dir: "billing" },
    ].map(({ adr, dir }) => {
      const path = join(root, "docs/adr/domains", dir, basename(adr.fullPath))
      const original = readFileSync(path, "utf-8")
      writeFileSync(path, original.replace(/^status:\s*[^\r\n]+/im, "status: accepted"), "utf-8")
      return { adr, path, original }
    })
    git(["add", "docs/adr"])
    blocked = await call(`git commit -m "feat: nested flips"`)
    assert(
      blocked !== null && blocked.includes(`ADR-${a12.id}`),
      "nested sequential undecided flip is BLOCKED (nested dirs are gated)",
    )
    assert(
      blocked !== null && blocked.includes(`ADR-${a13.id}`),
      "nested dotted-iteration undecided flip is BLOCKED (dotted grammar, nested dir)",
    )
    for (const n of nested) writeFileSync(n.path, n.original, "utf-8")
    git(["reset", "-q"])
    // Decided path: /adr decide resolves nested records; the flips then pass.
    const d12 = decideAdr(root, `ADR-${a12.id}`)
    const d13 = decideAdr(root, a13.id)
    assert(d12.relPath.includes("domains/payments/"), "decide resolves the nested sequential record")
    assert(d13.id === "ADR-0.3.1.01" && d13.relPath.includes("domains/billing/"), "decide resolves the nested dotted record")
    assert(git(["add", "-A"]).status === 0, "decided nested flips staged")
    blocked = await call(`git commit -m "feat: nested decided"`)
    assert(blocked === null, "feat commit passes once the nested flips are decided (no false block)")
    assert(git(["commit", "-qm", "feat: nested decided"]).status === 0, "nested decided flips EXECUTED after gate pass")

    // ── F10. pathspec commits cannot satisfy the SAME-commit invariant (MINOR 8) ──
    const a14 = createAdr({ projectDir: root, title: "Pathspec Bypass Attempt" })
    decideAdr(root, `ADR-${a14.id}`)
    writeFileSync(join(root, "src.ts"), "export {}\n")
    assert(git(["add", "-A"]).status === 0, "decided flip staged alongside code")
    blocked = await call(`git commit -m "feat: partial" -- src.ts`)
    assert(
      blocked !== null && blocked.includes("git commit --"),
      "pathspec commit BLOCKED with the targeted message (decided flip would ship later)",
    )
    assert(git(["commit", "-qm", "feat: pathspec guard case"]).status === 0, "full-index commit ships the decided flip for real")

    // ── F11. decide flips ONLY the frontmatter status line (MINOR 5) ────
    const a15 = createAdr({ projectDir: root, title: "Fenced Body Status Decision" })
    const c15 = readFileSync(a15.fullPath, "utf-8")
      .replace(/^status:\s*[^\r\n]+/im, "status: proposed # awaiting review") +
      "\n## Appendix\n\n```yaml\n# pipeline example\nstatus: draft\n```\n"
    writeFileSync(a15.fullPath, c15, "utf-8")
    decideAdr(root, `ADR-${a15.id}`)
    const after15 = readFileSync(a15.fullPath, "utf-8")
    assert(after15.includes("status: Accepted # awaiting review"), "decide preserves the trailing # comment on the flipped line")
    assert(after15.includes("status: draft"), "fenced body status: line stays untouched")
    assert(
      after15.split(/\r?\n/).length === c15.split(/\r?\n/).length,
      "decide changes NO line count even with a fenced status: line in the body",
    )
    const a16 = createAdr({ projectDir: root, title: "Missing Status Frontmatter Decision" })
    const c16 = readFileSync(a16.fullPath, "utf-8").replace(/^status:\s*[^\r\n]+\r?\n/im, "")
    writeFileSync(a16.fullPath, c16, "utf-8")
    decideAdr(root, `ADR-${a16.id}`) // madr adapter defaults a missing status to proposed (§6.2)
    const fm16 = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(a16.fullPath, "utf-8"))?.[1] ?? ""
    assert(/^status:\s*accepted/im.test(fm16), "missing frontmatter status → accepted injected INSIDE the frontmatter block")
    assert(
      git(["add", "-A"]).status === 0 && git(["commit", "-qm", "docs: governance hardening cases"]).status === 0,
      "F11 records committed for real (no staged flips left for section H)",
    )

    // ── F12. /adr init --governance is validated like --style (MINOR 6) ──
    assert(setAdrConfigFields({ governance: "review" }), "governance set to review for the init guard test")
    toasts.length = 0
    try { await cmdHook({ command: "adr", arguments: "init custom --governance strick", sessionID: "g-3" }) } catch { /* handled() throws 204 */ }
    assert(toasts.some((t) => t.message.includes("strick")), "invalid --governance refused with a warning toast naming the value")
    assert(getAdrConfig().governance === "review", "refused init writes NOTHING to the config")
    toasts.length = 0
    try { await cmdHook({ command: "adr", arguments: "init custom --governance strict", sessionID: "g-4" }) } catch { /* handled() throws 204 */ }
    assert(getAdrConfig().governance === "strict", "valid --governance strict persists")

    // Equals form must parse identically (P3): --governance=strict /
    // --governance=<invalid> / --style=<value>.
    toasts.length = 0
    try { await cmdHook({ command: "adr", arguments: "init custom --governance=strick", sessionID: "g-5" }) } catch { /* handled() throws 204 */ }
    assert(toasts.some((t) => t.message.includes("strick")), "invalid --governance=<value> (equals form) refused with a warning toast naming the value")
    assert(getAdrConfig().governance === "strict", "refused equals-form init writes NOTHING to the config")
    try { await cmdHook({ command: "adr", arguments: "init custom --governance=review", sessionID: "g-6" }) } catch { /* handled() throws 204 */ }
    assert(getAdrConfig().governance === "review", "valid --governance=review (equals form) persists")
    try { await cmdHook({ command: "adr", arguments: "init custom --style=nygard --governance=none", sessionID: "g-7" }) } catch { /* handled() throws 204 */ }
    assert(getAdrConfig().style === "nygard" && getAdrConfig().governance === "none", "--style=<value> equals form parses alongside --governance=<value>")
    assert(setAdrConfigFields({ governance: "strict", style: "madr" }), "style + governance restored after equals-form tests")

    // ── F13. `git commit -a` cannot smuggle an UNSTAGED hand-flip (P1) ──
    // `-a`/`--all` commit tracked unstaged modifications the --cached probe
    // never sees. The gate must detect the flag token-level and add a
    // working-diff pass, or `git commit -am "fix: x"` ships an unledgered
    // flip.
    assert(segmentCommitsAll(["-am", "msg"]), "token level: cluster -am detected as -a")
    assert(segmentCommitsAll(["-qa", "msg"]), "token level: cluster -qa detected as -a")
    assert(segmentCommitsAll(["--all", "-m", "msg"]), "token level: --all detected")
    assert(segmentCommitsAll(["-a", "--amend", "--no-edit"]), "token level: -a --amend detected (amend stages working tree too)")
    assert(!segmentCommitsAll(["-m", "msg"]), "token level: plain -m is NOT -a")
    assert(!segmentCommitsAll(["--amend", "--no-edit"]), "token level: --amend is NOT --all")
    assert(!segmentCommitsAll(["-mfeat: api"]), "token level: glued -m message is NOT -a (m consumes the rest)")

    const a17 = createAdr({ projectDir: root, title: "Unstaged Launder Attempt" })
    assert(
      git(["add", "-A"]).status === 0 && git(["commit", "-qm", "docs: seed a17"]).status === 0,
      "a17 committed so the hand-flip is a TRACKED unstaged modification (-a territory)",
    )
    const a17Content = readFileSync(a17.fullPath, "utf-8")
    writeFileSync(a17.fullPath, a17Content.replace(/^status:\s*[^\r\n]+/im, "status: accepted"), "utf-8")
    assert(!stagedAcceptFlips(root, "docs/adr").some((f) => f.id === `ADR-${a17.id}`), "unstaged flip invisible to the cached-only probe (the hole)")
    blocked = await call(`git commit -am "fix: launder via -a"`)
    assert(
      blocked !== null && blocked.includes(`ADR-${a17.id}`) && blocked.includes("decision record"),
      "unstaged hand-flip + git commit -am is BLOCKED (working diff probed)",
    )
    blocked = await call(`git commit --all -m "fix: launder via --all"`)
    assert(
      blocked !== null && blocked.includes(`ADR-${a17.id}`),
      "unstaged hand-flip + git commit --all is BLOCKED too",
    )

    // Named-path commits ship working-tree content of NAMED paths WITHOUT
    // -a: bare positional pathspecs (git's implied --only when paths are
    // given), `--only`/`--include`, `-o`/`-i`, and `-- <paths>`. Same hole,
    // same fix — the audit must detect them token-level and probe the
    // working diff. Value tokens of value-taking options are never paths.
    assert(segmentCommitsNamedPaths(["docs/adr/0007.md", "-m", "chore: x"]), "token level: bare pathspec detected")
    assert(segmentCommitsNamedPaths(["-m", "chore: x", "docs/adr/0007.md"]), "token level: trailing pathspec after the message value detected")
    assert(segmentCommitsNamedPaths(["--only", "docs/adr", "-m", "chore: x"]), "token level: --only detected")
    assert(segmentCommitsNamedPaths(["--include", "docs/adr", "-m", "chore: x"]), "token level: --include detected")
    assert(segmentCommitsNamedPaths(["-o", "-m", "chore: x"]), "token level: -o detected")
    assert(segmentCommitsNamedPaths(["-io", "-m", "chore: x"]), "token level: cluster -io detected")
    assert(segmentCommitsNamedPaths(["--", "src.ts"]), "token level: -- separator detected")
    assert(!segmentCommitsNamedPaths(["-m", "chore: x"]), "token level: -m value is NOT a pathspec")
    assert(!segmentCommitsNamedPaths(["-am", "fix: x"]), "token level: cluster -am message value skipped")
    assert(!segmentCommitsNamedPaths(["-mfeat: api"]), "token level: glued -m message skipped")
    assert(!segmentCommitsNamedPaths(["-F", "msg.txt"]), "token level: -F value skipped")
    assert(!segmentCommitsNamedPaths(["--message=hi"]), "token level: --message= inline value skipped")
    assert(!segmentCommitsNamedPaths(["--amend", "--no-edit"]), "token level: --amend ships no named paths")
    blocked = await call(`git commit docs/adr/${basename(a17.fullPath)} -m "chore: named path"`)
    assert(
      blocked !== null && blocked.includes(`ADR-${a17.id}`) && blocked.includes("decision record"),
      "unstaged hand-flip + bare pathspec commit (no -a) is BLOCKED (working diff probed)",
    )
    blocked = await call(`git commit --only docs/adr -m "chore: only flag"`)
    assert(
      blocked !== null && blocked.includes(`ADR-${a17.id}`),
      "unstaged hand-flip + git commit --only docs/adr is BLOCKED too",
    )
    writeFileSync(a17.fullPath, a17Content, "utf-8")
    blocked = await call(`git commit -am "chore: tidy"`)
    assert(blocked === null, "git commit -am with NO flips passes the audit (chore escapes the positive gate)")

    // ── F14. decideAdr preserves CRLF on both flip paths (P4) ──────────
    const a18 = createAdr({ projectDir: root, title: "CRLF Inject Decision" })
    const crlfNoStatus = readFileSync(a18.fullPath, "utf-8")
      .replace(/^status:\s*[^\r\n]+\r?\n/im, "")
      .replace(/\n/g, "\r\n")
    writeFileSync(a18.fullPath, crlfNoStatus, "utf-8")
    decideAdr(root, `ADR-${a18.id}`)
    const after18 = readFileSync(a18.fullPath, "utf-8")
    assert(after18.includes("status: Accepted\r\n"), "injected status line carries CRLF on a CRLF record (inject path)")
    assert(
      (after18.match(/\n/g) ?? []).length === (after18.match(/\r\n/g) ?? []).length,
      "no lone-LF line introduced into the CRLF record (inject path)",
    )
    const a19 = createAdr({ projectDir: root, title: "CRLF Replace Decision" })
    writeFileSync(a19.fullPath, readFileSync(a19.fullPath, "utf-8").replace(/\n/g, "\r\n"), "utf-8")
    decideAdr(root, `ADR-${a19.id}`)
    const after19 = readFileSync(a19.fullPath, "utf-8")
    assert(/^status: Accepted\r$/m.test(after19), "replaced status line keeps CRLF (replace path)")
    assert(
      (after19.match(/\n/g) ?? []).length === (after19.match(/\r\n/g) ?? []).length,
      "no lone-LF line introduced into the CRLF record (replace path)",
    )
    assert(
      git(["add", "-A"]).status === 0 && git(["commit", "-qm", "docs: f13 f14 cases"]).status === 0,
      "F13/F14 records committed for real (no flips left for later sections)",
    )

    // ── G. governance invariance: parsing/index identical under all modes ──
    const snapshot = () => JSON.stringify(getNormalizedAdrs(root)) + "||" + readFileSync(join(root, "docs/adr/INDEX.md"), "utf-8")
    assert(setAdrConfigFields({ governance: "none" }), "governance none for invariance snapshot")
    const snapNone = snapshot()
    assert(setAdrConfigFields({ governance: "review" }), "governance review for invariance snapshot")
    const snapReview = snapshot()
    assert(setAdrConfigFields({ governance: "strict" }), "governance strict for invariance snapshot")
    const snapStrict = snapshot()
    assert(snapNone === snapReview && snapReview === snapStrict, "normalized records + index bytes IDENTICAL under none/review/strict")

    // ── H. legacy adrGuard independence (§6.4): unchanged behavior ────
    assert(getAdrConfig().governance === "strict", "sandbox still strict")
    assert(getState() === "off", "legacy adrGuard off in sandbox (untouched by adr.* writes)")
    const a9 = createAdr({ projectDir: root, title: "Legacy Independence Decision" })
    void a9
    git(["add", "-A"])
    // legacy off → presence gate does NOT fire even under strict; strict gate
    // blocks only because no decided flip ships. Turning legacy ON adds its
    // own block message — proving the two gates are independent layers.
    setState("on")
    blocked = await call(`git commit -m "feat: legacy check"`)
    assert(blocked !== null && blocked.includes("[ADR-GOVERNANCE]"), "strict gate still fires with legacy adrGuard on")
    assert(!(blocked ?? "").includes("[ADR-GUARD] Blocked: feat/refactor commit without an ADR change"), "legacy presence gate passes (ADR files staged) — layers independent")
    setState("off")

    // ── I. adrDir override: decide + gate resolve the configured root (P1) ──
    // Previously decideAdr hard-defaulted getAllAdrs to docs/adr while the
    // strict gate scanned the configured override dir — every flip there was
    // flagged undecidable and /adr decide threw "Cannot find existing ADR"
    // with no fix path. decideAdr must resolve via the same configured
    // root/layout as the gate.
    assert(setConfigField("adrDir", "docs/decisions").ok, "adrDir=docs/decisions written to project config")
    assert(getAdrDir() === "docs/decisions", "getAdrDir reads the override back")
    mkdirSync(join(root, "docs/decisions"), { recursive: true })
    // Unique stem (0099) — docs/adr already holds ADR-0001; a collision would
    // resolve by first sorted path and mask the override-dir resolution.
    writeFileSync(
      join(root, "docs/decisions/0099-override-dir-decision.md"),
      ["---", "status: proposed", "date: 2026-01-01", "---", "", "# Override Dir Decision", ""].join("\n"),
      "utf-8",
    )
    const dOverride = decideAdr(root, "ADR-0099", "override dir record")
    assert(dOverride.relPath === "docs/decisions/0099-override-dir-decision.md", "decideAdr resolves the record under the adrDir override")
    assert(readDecidedIds(root).has("ADR-0099"), "the override-dir decision lands in the ledger")
    assert(git(["add", "-A"]).status === 0, "decided override-dir flip staged")
    blocked = await call(`git commit -m "feat: override dir decided"`)
    assert(blocked === null, "strict gate counts the override-dir flip as decided (no false undecided block)")
    assert(git(["commit", "-qm", "feat: override dir decided"]).status === 0, "override-dir decided flip EXECUTED after gate pass")
    assert(clearConfigField("adrDir").ok, "adrDir override cleared (sandbox back to default)")
  } finally {
    setProjectDir(REPO_ROOT)
    rmSync(root, { recursive: true, force: true })
  }
}

// ─── Main entry ───────────────────────────────────────────────────────────

// Quoted +++ headers (core.quotePath=true, non-ASCII ADR filenames) must not
// blind flip detection — the staged probe fixture is parsed purely.
function test12_QuotedDiffHeaders() {
  section("Test 12: quoted +++ headers (core.quotePath, non-ASCII paths)")
  // Real git quotes non-ASCII bytes octally (`\303\263` = ó); the literal
  // accented form covers hosts where quoting only wraps without escaping.
  const fixture = [
    'diff --git "a/docs/adr/0001-decisi\\303\\263n.md" "b/docs/adr/0001-decisi\\303\\263n.md"',
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    '+++ "b/docs/adr/0001-decisi\\303\\263n.md"',
    "@@ -0,0 +1,3 @@",
    "+---",
    "+status: accepted",
    "+---",
    'diff --git a/docs/adr/0002-plain.md b/docs/adr/0002-plain.md',
    "--- a/docs/adr/0002-plain.md",
    "+++ b/docs/adr/0002-plain.md",
    "@@ -1 +1 @@",
    "-status: proposed",
    "+status: accepted",
  ].join("\n")
  const flips = acceptFlipsFromDiff(fixture)
  assert(
    flips.some((f) => f.id === "ADR-0001" && f.relPath === "docs/adr/0001-decisión.md"),
    "octal-quoted non-ASCII +++ header: flip detected with decoded path",
  )
  assert(
    flips.some((f) => f.id === "ADR-0002" && f.relPath === "docs/adr/0002-plain.md"),
    "plain ASCII +++ header behavior unchanged",
  )

  const literalQuoted = [
    '+++ "b/docs/adr/0001-decisión.md"',
    "+status: accepted",
  ].join("\n")
  const literalFlips = acceptFlipsFromDiff(literalQuoted)
  assert(
    literalFlips.length === 1 && literalFlips[0].relPath === "docs/adr/0001-decisión.md",
    'literal accented quoted header `+++ "b/docs/adr/0001-decisión.md"` detected',
  )
  assert(flips.length === 2, "no phantom flips from headers/dev-null noise")
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗")
  console.log("║  ADR Iron Law — Unit Tests (no API)                     ║")
  console.log("╚══════════════════════════════════════════════════════════╝")

  // Pin the project dir to the repo root so config writes + git queries run
  // against a real git repo. The switch lives in the project OCP config
  // `.ocp/ocp.json` (ADR 0004 v2 single source) — snapshot it up front and
  // restore it afterwards; the tests flip the guard on/off and must not
  // pollute the repo's real runtime config.
  const origDir = getProjectDir()
  setProjectDir(REPO_ROOT)
  const cfgFile = join(REPO_ROOT, ".ocp", "ocp.json")
  const cfgPreexisting = existsSync(cfgFile)
  const origCfg = cfgPreexisting ? readFileSync(cfgFile, "utf-8") : null

  try {
    test01_Tokenizer()
    test02_GitCommitDetection()
    test03_MessageExtraction()
    test04_TypeGate()
    test04b_StripJsonc()
    test05_StateParsing()
    await test05b_GuardCommandRouting()
    await test06_SystemHook()
    await test07_ToolGuard()
    await test08_ConfigHook()
    await test09_AdrCommandAutoDraft()
    await test10_AdrSupersede()
    await test11_StrictGovernance()
    test12_QuotedDiffHeaders()
  } finally {
    if (cfgPreexisting && origCfg !== null) {
      mkdirSync(dirname(cfgFile), { recursive: true })
      writeFileSync(cfgFile, origCfg, "utf-8")
    } else if (existsSync(cfgFile)) rmSync(cfgFile)
    setProjectDir(origDir)
  }

  console.log(`\n${"═".repeat(60)}`)
  console.log(`  Result: ${passed} passed / ${failed} failed`)
  console.log(`${"═".repeat(60)}`)
  if (failed > 0) process.exit(1)
}

main()
