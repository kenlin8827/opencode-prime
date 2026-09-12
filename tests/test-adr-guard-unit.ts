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
 *
 * Run: bun run tests/test-adr-guard-unit.ts   (or: npx tsx tests/test-adr-guard-unit.ts)
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import {
  normalizeState,
  parseStateArg,
  getState,
  setState,
  setProjectDir,
  getProjectDir,
  stripJsonc,
  COMMAND_NAME,
} from "../plugins/adr-guard/adr-guard-config"
import {
  tokenize,
  isGitCommit,
  hasAmendFlag,
  extractCommitMessage,
  requiresAdr,
} from "../plugins/adr-guard/adr-guard-runtime"
import { makeSystemHook } from "../plugins/adr-guard/adr-guard-system-inject"
import { makeToolGuardHook } from "../plugins/adr-guard/adr-guard-tool-guard"
import { AdrGuardPlugin } from "../plugins/adr-guard/adr-guard"

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
const fakeClient: any = { app: { log: async () => {} } }

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
//  6. System hook — inject when on, idempotent, strip when off
// ═════════════════════════════════════════════════════════════════════════

async function test06_SystemHook() {
  section("06: System hook inject / idempotency / strip")
  const hook = makeSystemHook(fakeClient)

  setState("on")
  const out1 = { system: ["base prompt"] }
  await hook({}, out1 as any)
  assert(out1.system[0].includes("[ADR-GUARD: ON]"), "marker injected when on")
  assert(out1.system[0].includes("ADR Iron Law"), "protocol body injected")
  assert(out1.system[0].includes("ADR directory"), "runtime ADR directory section present")

  const afterFirst = out1.system[0]
  await hook({}, out1 as any)
  assert(out1.system[0] === afterFirst, "second call is a no-op (cache-friendly)")

  setState("off")
  await hook({}, out1 as any)
  assert(!out1.system[0].includes("[ADR-GUARD"), "marker stripped when switched off")
  assert(out1.system[0] === "base prompt", "original prompt restored exactly")

  const out2 = { system: ["base prompt"] }
  await hook({}, out2 as any)
  assert(out2.system[0] === "base prompt", "off + no marker → complete no-op")

  // Multi-entry system prompt: the fragment must land in the LAST entry
  // only — the old loop duplicated it across every entry.
  setState("on")
  const out3 = { system: ["entry A", "entry B"] }
  await hook({}, out3 as any)
  assert(out3.system[0] === "entry A", "multi-entry: first entry untouched")
  assert(out3.system[1].includes("[ADR-GUARD: ON]"), "marker present in last entry only")
  assert(out3.system.filter((s) => s.includes("[ADR-GUARD: ON]")).length === 1, "marker appears exactly once across entries")
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
  const guard = makeToolGuardHook(fakeClient)

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
      await guard({ tool: "bash" } as any, { args: { command } } as any)
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
    (await guard({ tool: "edit" } as any, { args: {} } as any)) === undefined,
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
  section("08: Config hook — command registration")
  const plugin = (await AdrGuardPlugin({ client: fakeClient, directory: REPO_ROOT } as any)) as any
  const cfg: any = {}
  await plugin["config"](cfg)
  assert(!!cfg.command, "cfg.command created")
  assert(!!cfg.command[COMMAND_NAME], "command registered")
  assert(cfg.command[COMMAND_NAME].description.includes("ADR"), "description mentions ADR")
  assert(!!plugin["tool.execute.before"], "tool guard hook present")
  assert(!!plugin["experimental.chat.system.transform"], "system hook present")
  assert(!!plugin["command.execute.before"], "command hook present")
}

async function test09_AdrCommandAutoDraft() {
  section("09: /adr new auto-draft vs --empty flag")
  let promptedCalls: any[] = []
  const mockClient: any = {
    app: { log: async () => {} },
    tui: { showToast: async () => {} },
    session: {
      prompt: async (args: any) => {
        promptedCalls.push(args)
      },
    },
  }

  const tmpTestDir = mkdtempSync(join(tmpdir(), "adr-test-draft-"))
  try {
    const plugin = (await AdrGuardPlugin({ client: mockClient, directory: tmpTestDir } as any)) as any
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
  const mockClient: any = {
    app: { log: async () => {} },
    tui: { showToast: async () => {} },
    session: {
      prompt: async () => {},
    },
  }

  const tmpTestDir = mkdtempSync(join(tmpdir(), "adr-test-super-"))
  try {
    const plugin = (await AdrGuardPlugin({ client: mockClient, directory: tmpTestDir } as any)) as any
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
    assert(adr1Content.includes("status: superseded by 0002"), "ADR 0001 marked as superseded by 0002")
    assert(adr1Content.includes("superseded_by: docs/adr/0002-new-cloud-storage-standard.md"), "ADR 0001 contains superseded_by link")

    const adr2Content = readFileSync(adr2Path, "utf-8")
    assert(adr2Content.includes("parent: docs/adr/0001-initial-storage-decision.md"), "ADR 0002 references parent ADR 0001")

    const indexPath = join(tmpTestDir, "docs/adr/INDEX.md")
    assert(existsSync(indexPath), "INDEX.md exists")
    const indexContent = readFileSync(indexPath, "utf-8")
    assert(indexContent.includes("Superseded"), "INDEX.md contains Superseded status for 0001")
    assert(indexContent.includes("Accepted"), "INDEX.md contains Accepted status for 0002")

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

// ─── Main entry ───────────────────────────────────────────────────────────

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
    await test06_SystemHook()
    await test07_ToolGuard()
    await test08_ConfigHook()
    await test09_AdrCommandAutoDraft()
    await test10_AdrSupersede()
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
