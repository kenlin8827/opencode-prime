/**
 * Project Manager Plugin — Unit Tests (no API dependency)
 *
 * Coverage:
 *   - validateMessage: structural Conventional-Commits subset
 *     (types, scope, breaking `!`, 72-char cap, git-generated exemptions)
 *   - file-as-switch: gate inactive without docs/git-commits.md, active with
 *   - tool guard: blocks violating messages, allows compliant/amend/editor
 *     commits, judges chained commits per invocation
 *   - scaffold: creates missing files only (never overwrites)
 *   - injection: progressive-disclosure pointer only (file content never
 *     injected), byte-identical repeat, strip on file deletion
 *   - index bootstrap: first-time init (codegraph init, gitnexus analyze
 *     when the index is missing) in `/project init` vs manual refresh of
 *     EXISTING indexes in `/project index` (codegraph sync, gitnexus analyze
 *     only when stale), enabled+CLI AND-gate, mcp.enabled JSONC parsing;
 *     dbhub.toml scaffold gated on the dbhub MCP enabled flag AND the
 *     installed CLI (never overwrites, env-var DSN only)
 *   - gitnexus hooks: register post-commit/post-merge/post-checkout when
 *     gitnexus is enabled + CLI installed + inside a git repo; remove managed
 *     block when gitnexus is disabled or CLI missing; preserve user content
 *   - announce: session-created suggestion of `/project init` on
 *     uninitialized projects — subagent silence, once-per-run, initialized
 *     projects stay silent
 *
 * Run: bun run tests/test-project-manager-unit.ts   (or: npx tsx tests/test-project-manager-unit.ts)
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  COMMAND_NAME,
  CONFIG_REL,
  GIT_COMMITS_REL,
  hasConventionFile,
  parseSubcommand,
  setProjectDir,
} from "../plugins/project-manager/project-manager-config"
import {
  applySwitchesToConfigContent,
  generateConfigContent,
  runInit,
  runInitWithSwitches,
  runSync,
  updateSwitchesOnly,
  writeDbhubToml,
  ensureTgrepGitignore,
} from "../plugins/project-manager/project-manager-scaffold"
import { removeConfigField, migrateLegacyProjectArtifacts } from "../plugins/shared/opencode-prime"
import { detectProjectSwitches } from "../plugins/project-manager/project-manager-options"
import {
  mcpEnabledFrom,
  planIndexBackends,
  planInitBackends,
  probeBackends,
  shellwords,
  type BackendProbe,
} from "../plugins/project-manager/project-manager-index"
import { registerProjectHooks } from "../plugins/project-manager/project-manager-hooks"
import { makeSystemHook, MARKER } from "../plugins/project-manager/project-manager-system-inject"
import { makeAnnounceHook, suggestInitMessage } from "../plugins/project-manager/project-manager-announce"
import { makeCommandHook } from "../plugins/project-manager/project-manager-command"
import { makeToolGuardHook, validateMessage } from "../plugins/project-manager/project-manager-tool-guard"

// ─── Test framework ───────────────────────────────────────────────────────

// Pin language=en via a sandboxed ocp config — guard command reports are
// localized and this machine's real ~/.config/opencode/ocp.json may say
// zh-CN, which would break the English-phrase assertions below. ADR 0004 v2:
// the runtime reads `ocp.json` ONLY, so the fixture must use that name.
process.env.OCP_CONFIG_PATH = join(tmpdir(), "pm-unit-ocp.json")
writeFileSync(process.env.OCP_CONFIG_PATH, `{ "language": "en" }`)

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

// Temp project dir shared by the stateful tests.
const projectDir = mkdtempSync(join(tmpdir(), "pm-unit-"))
setProjectDir(projectDir)
const conventionFile = join(projectDir, ...GIT_COMMITS_REL.split("/"))

function createConventionFile(): void {
  mkdirSync(join(projectDir, "docs"), { recursive: true })
  writeFileSync(conventionFile, "# convention\n", "utf-8")
}

/** Run the guard hook on a bash command; true when the commit was blocked. */
async function guardBlocks(command: string): Promise<boolean> {
  const hook = makeToolGuardHook(fakeClient)
  try {
    await hook({ tool: "bash" }, { args: { command } })
    return false
  } catch (err) {
    return String(err).includes("project-manager")
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  1. validateMessage — structural subset
// ═════════════════════════════════════════════════════════════════════════

function test01_ValidateMessage() {
  section("01: validateMessage — structural rules")

  // Compliant forms.
  assert(validateMessage("feat: add api") === null, "plain type passes")
  assert(validateMessage("fix(auth): guard nil session") === null, "scoped type passes")
  assert(validateMessage("refactor!: drop v1 endpoints") === null, "breaking `!` passes")
  assert(validateMessage("feat(x): y\n\nLong body that can be anything at all.") === null, "only first line is judged")
  assert(validateMessage(`feat: ${"y".repeat(66)}`) === null, "exactly 72 chars passes")

  // Type violations.
  assert(validateMessage("update stuff") !== null, "no type prefix blocked")
  assert(validateMessage("feature: add api") !== null, "unknown type blocked")
  assert(validateMessage("feat add api") !== null, "missing colon blocked")
  assert(validateMessage("feat: ") !== null, "empty summary blocked")
  assert(validateMessage("Feat: add api") !== null, "uppercase type blocked")

  // Length violations.
  assert(validateMessage(`feat: ${"x".repeat(70)}`) !== null, ">72-char first line blocked")

  // Git-generated exemptions.
  assert(validateMessage("Merge branch 'feature/x' into main") === null, "merge message exempt")
  assert(validateMessage('Revert "feat: add api"') === null, "revert message exempt")
  assert(validateMessage("fixup! feat: add api") === null, "fixup! exempt")
  assert(validateMessage("squash! feat: add api") === null, "squash! exempt")
}

// ═════════════════════════════════════════════════════════════════════════
//  2. File-as-switch
// ═════════════════════════════════════════════════════════════════════════

async function test02_FileAsSwitch() {
  section("02: file-as-switch semantics")

  assert(hasConventionFile() === false, "no file → switch off")
  assert(
    (await guardBlocks(`git commit -m "update stuff"`)) === false,
    "no file → violating commit NOT blocked (gate inactive)",
  )

  createConventionFile()
  assert(hasConventionFile() === true, "file present → switch on")
}

// ═════════════════════════════════════════════════════════════════════════
//  3. Tool guard behavior (file present)
// ═════════════════════════════════════════════════════════════════════════

async function test03_ToolGuard() {
  section("03: tool guard — blocking behavior")

  assert(await guardBlocks(`git commit -m "update stuff"`), "violating message blocked")
  assert(await guardBlocks(`git commit -m "feat add api"`), "missing colon blocked")
  assert(await guardBlocks(`git commit -m "feat: ${"x".repeat(70)}"`), "too-long first line blocked")
  assert((await guardBlocks(`git commit -m "feat: add api"`)) === false, "compliant message passes")
  assert((await guardBlocks(`git commit -m "fix(auth): guard nil"`)) === false, "scoped message passes")
  assert((await guardBlocks(`git commit -m "Merge branch 'x'"`)) === false, "merge message passes")
  assert((await guardBlocks(`git commit --amend -m "update stuff"`)) === false, "--amend exempt")
  assert((await guardBlocks(`git commit`)) === false, "editor commit (no -m) fail-open")
  assert((await guardBlocks(`git add . && git commit -m "feat: x"`)) === false, "chained non-commit prefix passes")
  assert(await guardBlocks(`git commit --amend && git commit -m "update stuff"`), "chained: amend exempts only itself")
  assert((await guardBlocks(`git push`)) === false, "non-commit command passes")

  // Non-bash tools are never gated.
  const hook = makeToolGuardHook(fakeClient)
  let blocked = false
  try {
    await hook({ tool: "edit" }, { args: { command: `git commit -m "update stuff"` } })
  } catch {
    blocked = true
  }
  assert(blocked === false, "non-bash tool passes")
}

// ═════════════════════════════════════════════════════════════════════════
//  4. Switch off again (file deleted mid-session)
// ═════════════════════════════════════════════════════════════════════════

async function test04_SwitchOff() {
  section("04: file deleted → gate deactivates")
  rmSync(conventionFile)
  assert(hasConventionFile() === false, "deleted file → switch off")
  assert(
    (await guardBlocks(`git commit -m "update stuff"`)) === false,
    "violating commit passes again after deletion",
  )
}

// ═════════════════════════════════════════════════════════════════════════
//  5. Scaffold idempotency (creates only missing files)
// ═════════════════════════════════════════════════════════════════════════

function test05_Scaffold() {
  section("05: scaffold — never overwrites")

  // Pre-existing AGENTS.md with custom content must survive init.
  writeFileSync(join(projectDir, "AGENTS.md"), "CUSTOM", "utf-8")

  const r1 = runInit()
  assert(r1.files.every((r) => r.status !== undefined), "every target reported")
  assert(
    r1.files.find((r) => r.relPath === "AGENTS.md")?.status === "skipped",
    "existing AGENTS.md skipped",
  )
  assert(
    r1.files.find((r) => r.relPath === GIT_COMMITS_REL)?.status === "created",
    "missing git-commits.md created",
  )
  assert(
    r1.migration.switchedKeys.length === 0 && r1.migration.warnings.length === 0,
    "clean project → empty migration report",
  )

  const r2 = runInit()
  assert(r2.files.every((r) => r.status === "skipped"), "second run skips everything")
  assert(
    !readFileSync(join(projectDir, "AGENTS.md"), "utf-8").includes("Generated"),
    "custom AGENTS.md content untouched",
  )
}

// ═════════════════════════════════════════════════════════════════════════
//  5b. updateSwitchesOnly — config-only write, never touches other files
// ═════════════════════════════════════════════════════════════════════════

function test05b_UpdateSwitchesOnly() {
  section("05b: updateSwitchesOnly — config-only, no AGENTS.md / git-commits.md scaffold")

  // (1) Empty project → only the config is created; other baseline files
  //     MUST remain absent. Phase 1C sub-dialog Save path for first-time
  //     projects (responsibility separation from the main-menu skeleton).
  const dirSync = mkdtempSync(join(tmpdir(), "pm-switches-only-"))
  setProjectDir(dirSync)

  const switches = { envGuard: "on", projectMemory: "on" } as const
  const result = updateSwitchesOnly(switches).file
  assert(result.relPath === CONFIG_REL, "result targets the config file")
  assert(result.status === "created", "first call creates the config")

  const cfgPath = join(dirSync, ".ocp", "ocp.json")
  assert(existsSync(cfgPath), "config file written")
  assert(
    !existsSync(join(dirSync, "AGENTS.md")),
    "AGENTS.md NOT scaffolded — that's the main-menu skeleton's job",
  )
  assert(
    !existsSync(join(dirSync, "docs", "git-commits.md")),
    "git-commits.md NOT scaffolded — that's the main-menu skeleton's job",
  )

  // (2) Idempotent when values unchanged.
  const r2 = updateSwitchesOnly(switches).file
  assert(r2.status === "skipped", "idempotent when values unchanged")

  // (3) Different values → updated.
  const r3 = updateSwitchesOnly({ envGuard: "off", projectMemory: "on" } as const).file
  assert(r3.status === "updated", "different switch value triggers an update")
  const after = readFileSync(cfgPath, "utf-8")
  assert(after.includes('"envGuard": "off"'), "updated config carries the new value")
  assert(after.includes('"projectMemory": "on"'), "untouched switches remain in place")
  // ADR §6 pin: the saved `.ocp/ocp.json` is STRICT JSON (wizard-append +
  // {} bootstrap + remove-last-key path) — JSON.parse, no comment stripping.
  try { JSON.parse(after); assert(true, "wizard-saved config is strict-JSON-valid") } catch { assert(false, "wizard-saved config is strict-JSON-valid") }

  rmSync(dirSync, { recursive: true, force: true })

  // (4) INVERTED pin (ADR 0004 §6): a legacy project with only a root
  //     `opencode.jsonc` does NOT get updated in place anymore — the save
  //     CREATES `.ocp/ocp.json` (write-new; §3 migration runs first and
  //     only moves ACTIVE switch keys; a commented line stays put). The
  //     old "no second config spawned" expectation belonged to the
  //     pre-migration era.
  const dirLegacy = mkdtempSync(join(tmpdir(), "pm-switches-legacy-"))
  setProjectDir(dirLegacy)
  const rootCfg = join(dirLegacy, "opencode.jsonc")
  writeFileSync(
    rootCfg,
    '{\n  // "autoAdvisorMode": "lite",\n}\n',
    "utf-8",
  )
  const rLegacy = updateSwitchesOnly({ envGuard: "off" } as const).file
  assert(
    rLegacy.relPath === CONFIG_REL && rLegacy.status === "created",
    "legacy root-only project: save CREATES .ocp/ocp.json (write-new)",
  )
  assert(
    readFileSync(rootCfg, "utf-8").includes('// "autoAdvisorMode"'),
    "legacy root config untouched by the save",
  )
  assert(existsSync(join(dirLegacy, ".ocp", "ocp.json")), ".ocp/ocp.json is the new canonical location")
  rmSync(dirLegacy, { recursive: true, force: true })

  // (5) Contrast: runInitWithSwitches (the skeleton path) still
  //     scaffolds AGENTS.md + git-commits.md. Proves responsibility
  //     separation from both sides.
  const dirInit = mkdtempSync(join(tmpdir(), "pm-switches-init-"))
  setProjectDir(dirInit)
  const ri = runInitWithSwitches({ envGuard: "on" } as const)
  assert(
    ri.files.find((r) => r.relPath === "AGENTS.md")?.status === "created",
    "runInitWithSwitches (skeleton path) still scaffolds AGENTS.md",
  )
  assert(
    existsSync(join(dirInit, "docs", "git-commits.md")),
    "runInitWithSwitches (skeleton path) still scaffolds git-commits.md",
  )
  assert(
    existsSync(join(dirInit, ".ocp", ".gitignore")),
    "skeleton init bootstraps .ocp/.gitignore",
  )
  rmSync(dirInit, { recursive: true, force: true })

  setProjectDir(projectDir)
}

// ═════════════════════════════════════════════════════════════════════════
//  6. Command parsing
// ═════════════════════════════════════════════════════════════════════════

async function test06_Command() {
  section("06: command parsing and /project init handling")
  assert(COMMAND_NAME === "project", "command name is /project")
  assert(parseSubcommand("init") === "init", "'init' parsed")
  assert(parseSubcommand("  INIT  extra") === "init", "case-insensitive, first token only")
  assert(parseSubcommand(undefined) === null, "missing args → null (help)")
  assert(parseSubcommand("   ") === null, "blank args → null (help)")

  // Command hook handles /project init
  const dirCmd = mkdtempSync(join(tmpdir(), "pm-cmd-"))
  setProjectDir(dirCmd)
  let promptText = ""
  const mockClient: any = {
    session: {
      prompt: async ({ body }: any) => {
        promptText = body.parts?.[0]?.text ?? ""
      },
    },
  }
  let handledCalled = false
  const hook = makeCommandHook(mockClient, () => {
    handledCalled = true
    throw new Error("handled")
  })

  try {
    await hook({ command: "project", arguments: "init", sessionID: "s-test" })
  } catch (e: any) {
    if (e.message !== "handled") throw e
  }
  assert(handledCalled === true, "hook handles /project init")
  assert(promptText.includes("[project-manager] init done"), "/project init executes init report")

  rmSync(dirCmd, { recursive: true, force: true })
  setProjectDir(projectDir)
}

// ─── Run ──────────────────────────────────────────────────────────────────

// ═════════════════════════════════════════════════════════════════════
//  7. System injection — progressive-disclosure pointer (not full content)
// ═════════════════════════════════════════════════════════════════════

async function test07_Injection() {
  section("07: injection — pointer only, never file content")

  const hook = makeSystemHook(fakeClient)

  // No file → complete no-op.
  rmSync(conventionFile, { force: true })
  const empty = { system: ["base prompt"] }
  await hook({}, empty)
  assert(empty.system[0] === "base prompt", "no file → prompt untouched")

  // File present → pointer injected, file CONTENT stays out of context.
  createConventionFile()
  const out = { system: ["entry A", "entry B"] }
  await hook({}, out)
  assert(out.system[0] === "entry A", "multi-entry: first entry untouched")
  assert(out.system[1].includes(MARKER), "marker present in last entry")
  assert(out.system[1].includes(GIT_COMMITS_REL), "pointer names the file")
  assert(out.system[1].includes("progressive"), "pointer declares progressive disclosure")
  assert(!out.system[1].includes("# convention"), "file content NOT injected")
  assert(out.system[1].length < 600, "pointer is compact (<600 chars)")

  // Repeat on the same built prompt → byte-identical no-op.
  const before = out.system[1]
  await hook({}, out)
  assert(out.system[1] === before, "repeat call is byte-identical (cache-friendly)")

  // File deleted mid-session → stale pointer stripped, prompt restored.
  rmSync(conventionFile)
  await hook({}, out)
  assert(out.system[1] === "entry B", "deletion strips the pointer and restores the prompt")
}

// ═══════════════════════════════════════════════════════════════════
//  8. Index bootstrap — first-time init vs manual refresh (pure planner)
// ═══════════════════════════════════════════════════════════════════

function probe(overrides: Partial<BackendProbe>): BackendProbe {
  return {
    codegraphEnabled: true,
    codegraphCli: true,
    codegraphIndexed: false,
    gitnexusEnabled: true,
    gitnexusCli: true,
    gitnexusIndex: "missing",
    dbhubEnabled: true,
    dbhubCli: true,
    dbhubToml: false,
    tgrepEnabled: false, tgrepCli: false, tgrepIndexed: false, tgrepReadiness: "unavailable", tgrepPolicyCurrent: false, tgrepOptions: { enabled: false },
    ...overrides,
  }
}

function planFor(plans: ReturnType<typeof planInitBackends>, backend: "codegraph" | "gitnexus" | "dbhub" | "tgrep") {
  return plans.find((p) => p.backend === backend)!
}

function test08_IndexPlanning() {
  section("08: index bootstrap — first-time init vs manual refresh")

  // `/project init` runs every FIRST-TIME step, only when CLI installed.
  assert(planFor(planInitBackends(probe({})), "codegraph").command === "codegraph init", "init plans codegraph init when CLI + enabled + not indexed")
  assert(planFor(planInitBackends(probe({})), "gitnexus").command === "gitnexus analyze", "init plans gitnexus initial build when index missing")
  assert(planFor(planInitBackends(probe({ codegraphIndexed: true })), "codegraph").command === null, "codegraph already indexed → no run")
  assert(planFor(planInitBackends(probe({ gitnexusIndex: "ready" })), "gitnexus").command === null, "gitnexus already indexed → no run")
  assert(planFor(planInitBackends(probe({ gitnexusIndex: "stale" })), "gitnexus").command === null, "gitnexus stale is a rebuild → deferred to /project index")
  assert(planFor(planInitBackends(probe({ codegraphCli: false })), "codegraph").command === null, "codegraph CLI missing → skipped, never invoked")
  assert(planFor(planInitBackends(probe({ gitnexusCli: false })), "gitnexus").command === null, "gitnexus CLI missing → skipped, never invoked")
  assert(planFor(planInitBackends(probe({ codegraphEnabled: false })), "codegraph").command === null, "codegraph disabled → no run even with CLI")
  assert(planFor(planInitBackends(probe({ gitnexusEnabled: false })), "gitnexus").command === null, "gitnexus disabled → no run even with CLI")

  // dbhub.toml scaffold — gated on enabled flag + installed CLI, never overwrites.
  assert(planFor(planInitBackends(probe({})), "dbhub").note.includes("dbhub.toml"), "init plans dbhub.toml scaffold when enabled + CLI + missing")
  assert(planFor(planInitBackends(probe({ dbhubEnabled: false })), "dbhub").note.includes("disabled"), "dbhub disabled → no scaffold")
  assert(planFor(planInitBackends(probe({ dbhubCli: false })), "dbhub").note.includes("CLI not installed"), "dbhub CLI missing → skipped silently")
  assert(!planFor(planInitBackends(probe({ dbhubCli: false })), "dbhub").note.startsWith("scaffold"), "dbhub CLI missing → never scaffolds")
  assert(planFor(planInitBackends(probe({ dbhubToml: true })), "dbhub").note.includes("already present"), "dbhub.toml exists → no scaffold")
  assert(!planIndexBackends(probe({})).some((p) => p.backend === "dbhub"), "dbhub has no index phase — never listed by /project index")

  // writeDbhubToml — creates with env-var DSN, preserves existing content.
  const dirDb = mkdtempSync(join(tmpdir(), "pm-dbh-"))
  assert(writeDbhubToml(dirDb) === "created", "first call creates dbhub.toml")
  const toml = readFileSync(join(dirDb, "dbhub.toml"), "utf-8")
  assert(toml.includes("${DBHUB_DSN}"), "template uses env-var DSN (no credentials)")
  assert(toml.includes("readonly = true"), "execute_sql stays read-only")
  assert(writeDbhubToml(dirDb) === "skipped", "second call never overwrites")
  writeFileSync(join(dirDb, "dbhub.toml"), "CUSTOM", "utf-8")
  assert(writeDbhubToml(dirDb) === "skipped", "custom dbhub.toml preserved")
  assert(readFileSync(join(dirDb, "dbhub.toml"), "utf-8") === "CUSTOM", "custom content untouched")
  rmSync(dirDb, { recursive: true, force: true })

  // probeBackends reports the dbhub fields (enabled from config, CLI on PATH, toml presence).
  const pb = probeBackends(projectDir)
  assert(typeof pb.dbhubEnabled === "boolean", "probe reports dbhubEnabled")
  assert(typeof pb.dbhubCli === "boolean", "probe reports dbhubCli")
  assert(pb.dbhubToml === false, "probe reports missing dbhub.toml")

  // `/project index` is manual refresh of EXISTING indexes only.
  assert(planFor(planIndexBackends(probe({ codegraphIndexed: true })), "codegraph").command === "codegraph sync", "codegraph indexed → incremental sync")
  assert(planFor(planIndexBackends(probe({})), "codegraph").command === null, "codegraph no index → init step, not a refresh")
  assert(planFor(planIndexBackends(probe({ codegraphCli: false, codegraphIndexed: true })), "codegraph").command === null, "codegraph CLI missing → skipped, never invoked")
  assert(planFor(planIndexBackends(probe({ codegraphEnabled: false, codegraphIndexed: true })), "codegraph").command === null, "codegraph disabled → no run even with CLI")
  assert(planFor(planIndexBackends(probe({ gitnexusIndex: "stale" })), "gitnexus").command === "gitnexus analyze", "stale index → rebuild")
  assert(planFor(planIndexBackends(probe({ gitnexusIndex: "ready" })), "gitnexus").command === null, "ready index → no run")
  assert(planFor(planIndexBackends(probe({ gitnexusIndex: "missing" })), "gitnexus").command === null, "missing index → init step, not a rebuild")
  assert(planFor(planIndexBackends(probe({ gitnexusCli: false })), "gitnexus").command === null, "CLI missing → skipped, never invoked")
  assert(planFor(planIndexBackends(probe({ gitnexusEnabled: false })), "gitnexus").command === null, "disabled → no run even with CLI")
  assert(planFor(planInitBackends(probe({ tgrepEnabled: true, tgrepCli: true })), "tgrep").command === "tgrep index .", "tgrep init builds missing local index")
  assert(planFor(planIndexBackends(probe({ tgrepEnabled: true, tgrepCli: true })), "tgrep").command === null, "tgrep index command never creates first index")
  assert(planFor(planIndexBackends(probe({ tgrepEnabled: true, tgrepCli: true, tgrepIndexed: true, tgrepReadiness: "server", tgrepPolicyCurrent: true })), "tgrep").command === null, "healthy tgrep server skips rebuild")
  assert(planFor(planIndexBackends(probe({ tgrepEnabled: true, tgrepCli: true, tgrepIndexed: true, tgrepReadiness: "disk-index" })), "tgrep").command === "tgrep index .", "unhealthy tgrep index rebuilds")

  // mcp.<name>.enabled parsing (same JSONC subset rule as the profiler).
  assert(mcpEnabledFrom('{"mcp":{"gitnexus":{"enabled":false}}}', "gitnexus") === false, "explicit false honored")
  assert(mcpEnabledFrom('{"mcp":{"gitnexus":{"enabled":true}}}', "gitnexus") === true, "explicit true honored")
  assert(mcpEnabledFrom('{"mcp":{}}', "gitnexus") === true, "missing entry → assume enabled")
  const commented = '// "mcp":{"gitnexus":{"enabled":false}}\n{"mcp":{"gitnexus":{"enabled":true}}}'
  assert(mcpEnabledFrom(commented, "gitnexus") === true, "whole-line // comments stripped")
}

// ═══════════════════════════════════════════════════════════════════
//  9. Announce — suggest /project init on uninitialized projects
// ═══════════════════════════════════════════════════════════════════

async function test09_Announce() {
  section("09: announce — /project init suggestion")

  // Pure message builder.
  const probeFull: BackendProbe = {
    codegraphEnabled: true, codegraphCli: true, codegraphIndexed: false,
    gitnexusEnabled: true, gitnexusCli: true, gitnexusIndex: "missing",
    dbhubEnabled: true, dbhubCli: true, dbhubToml: false,
    tgrepEnabled: false, tgrepCli: false, tgrepIndexed: false, tgrepReadiness: "unavailable", tgrepPolicyCurrent: false, tgrepOptions: { enabled: false },
  }
  const msg = suggestInitMessage(["AGENTS.md"], probeFull)
  assert(msg.includes("/project init"), "message names the command")
  assert(msg.includes("AGENTS.md"), "message lists missing files")
  assert(msg.includes("codegraph"), "message hints unindexed installed backend")
  const probeNoCli = { ...probeFull, codegraphCli: false, gitnexusCli: false }
  assert(!suggestInitMessage(["AGENTS.md"], probeNoCli).includes("Also:"), "no backend hint when CLIs absent")

  // Hook behavior with a capturing fake client.
  const dir2 = mkdtempSync(join(tmpdir(), "pm-announce-"))
  setProjectDir(dir2)
  let prompts = 0
  const hookClient: any = {
    tui: { showToast: async () => { prompts++ } },
  }
  const hook = makeAnnounceHook(hookClient)
  await hook({ event: { type: "session.created", properties: { info: { id: "sub", parentID: "main" } } } })
  assert(prompts === 0, "subagent session → no suggestion")
  await hook({ event: { type: "session.created", properties: { info: { id: "s1" } } } })
  assert(prompts === 1, "uninitialized project → suggestion shown")
  await hook({ event: { type: "session.created", properties: { info: { id: "s2" } } } })
  assert(prompts === 1, "once per server run — no nag")

  // Fully initialized project → silent.
  const dir3 = mkdtempSync(join(tmpdir(), "pm-init-"))
  setProjectDir(dir3)
  mkdirSync(join(dir3, "docs"), { recursive: true })
  mkdirSync(join(dir3, ".ocp"), { recursive: true })
  writeFileSync(join(dir3, "AGENTS.md"), "x", "utf-8")
  writeFileSync(join(dir3, "docs", "git-commits.md"), "x", "utf-8")
  writeFileSync(join(dir3, ".ocp", "ocp.json"), "{}", "utf-8")
  const hook2 = makeAnnounceHook(hookClient)
  await hook2({ event: { type: "session.created", properties: { info: { id: "s3" } } } })
  assert(prompts === 1, "initialized project → no suggestion")

  rmSync(dir2, { recursive: true, force: true })
  rmSync(dir3, { recursive: true, force: true })
  setProjectDir(projectDir)
}

// ═════════════════════════════════════════════════════════════════════
// 10. Sync — on-demand §3 legacy migration (ADR 0004 v2)
// ═════════════════════════════════════════════════════════════════════

function test10_Sync() {
  section("10: sync — on-demand legacy migration, durable-gated deactivation")

  const dirSync = mkdtempSync(join(tmpdir(), "pm-sync-"))
  setProjectDir(dirSync)
  assert(runSync().status === "missing", "no legacy state and no config → missing (init's job)")

  // Legacy project: switch keys + platform keys + comments in .opencode jsonc.
  mkdirSync(join(dirSync, ".opencode"), { recursive: true })
  const legacyPath = join(dirSync, ".opencode", "opencode.jsonc")
  writeFileSync(
    legacyPath,
    '{\n  "$schema": "https://opencode.ai/config.json", // team note\n  "e2eGuard": "on",\n  "agent": { "build": { "model": "x/y" } }\n}\n',
    "utf-8",
  )
  const s1 = runSync()
  assert(s1.status === "added", "legacy switch keys → migrated")
  assert(s1.added.includes("e2eGuard"), "e2eGuard among migrated items")
  const ocpPath = join(dirSync, ".ocp", "ocp.json")
  assert(existsSync(ocpPath), "migration created .ocp/ocp.json")
  let ocpParsed: Record<string, unknown>
  try {
    ocpParsed = JSON.parse(readFileSync(ocpPath, "utf-8")) as Record<string, unknown>
    assert(ocpParsed.e2eGuard === "on", "PIN (a): migrated .ocp/ocp.json is STRICT JSON with the value")
  } catch {
    assert(false, "PIN (a): migrated .ocp/ocp.json is STRICT JSON with the value")
    ocpParsed = {}
  }
  const legacyAfter = readFileSync(legacyPath, "utf-8")
  assert(/\/\/\s*"e2eGuard"/.test(legacyAfter), "legacy switch re-commented after durable copy")
  assert(legacyAfter.includes('"$schema": "https://opencode.ai/config.json"') && legacyAfter.includes('"agent"'), "platform keys untouched")

  // PIN (d): idempotent — second run reports nothing.
  const s2 = runSync()
  assert(s2.status === "up-to-date", "second migration is a no-op")
  assert(s2.migration.switchedKeys.length === 0 && s2.migration.movedFiles.length === 0 && s2.migration.skipped.length === 0 && s2.migration.warnings.length === 0, "PIN (d): empty report on re-run")

  // Legacy plain .json: deactivation uses strict LINE DELETE (never //).
  const rootJson = join(dirSync, "opencode.json")
  writeFileSync(rootJson, '{\n  "adrGuard": "on",\n  "mcp": { "a": 1 }\n}\n', "utf-8")
  const s3 = runSync()
  assert(s3.migration.switchedKeys.includes("adrGuard"), "root .json key migrated")
  const jsonAfter = readFileSync(rootJson, "utf-8")
  try {
    const parsedRoot = JSON.parse(jsonAfter) as Record<string, unknown>
    assert(!("adrGuard" in parsedRoot) && parsedRoot.mcp !== undefined && !jsonAfter.includes("//"), "PIN (h): legacy .json deactivated by line deletion, strict-valid, no //")
  } catch {
    assert(false, "PIN (h): legacy .json deactivated by line deletion, strict-valid, no //")
  }

  rmSync(dirSync, { recursive: true, force: true })

  // PIN (b): unwritable .ocp target (dir sits at the file path) → nothing
  // switched, legacy NOT deactivated, warning surfaced.
  const dirBlock = mkdtempSync(join(tmpdir(), "pm-sync-blocked-"))
  setProjectDir(dirBlock)
  mkdirSync(join(dirBlock, ".opencode"), { recursive: true })
  mkdirSync(join(dirBlock, ".ocp"), { recursive: true })
  mkdirSync(join(dirBlock, ".ocp", "ocp.json"), { recursive: true })
  const blockedLegacy = join(dirBlock, ".opencode", "opencode.jsonc")
  writeFileSync(blockedLegacy, '{\n  "envGuard": "on"\n}\n', "utf-8")
  const sBlocked = runSync()
  assert(sBlocked.migration.switchedKeys.length === 0, "PIN (b): failed copy reports zero switched keys")
  assert(sBlocked.migration.warnings.length > 0, "PIN (b): copy failure surfaces a warning")
  assert(readFileSync(blockedLegacy, "utf-8").includes('"envGuard": "on"'), "PIN (b): legacy key survives — no deactivation without a durable copy")
  rmSync(dirBlock, { recursive: true, force: true })

  setProjectDir(projectDir)
}

// ═════════════════════════════════════════════════════════════════════════
//  11. GitNexus git hooks — register when active, cleanup when not
// ═════════════════════════════════════════════════════════════════════════

const MARKER_START = "# >>> OCP-project-hook:gitnexus (managed by /project init; do not edit this block) >>>"
const MARKER_END = "# <<< OCP-project-hook:gitnexus <<<"

function hookProbe(overrides: Partial<BackendProbe>): BackendProbe {
  return {
    codegraphEnabled: true, codegraphCli: true, codegraphIndexed: false,
    gitnexusEnabled: true, gitnexusCli: true, gitnexusIndex: "missing",
    dbhubEnabled: true, dbhubCli: true, dbhubToml: false,
    tgrepEnabled: false, tgrepCli: false, tgrepIndexed: false, tgrepReadiness: "unavailable", tgrepPolicyCurrent: false, tgrepOptions: { enabled: false },
    ...overrides,
  }
}

function test11_Hooks() {
  section("11: gitnexus git hooks — register/cleanup")

  const dir = mkdtempSync(join(tmpdir(), "pm-hooks-"))

  // No .git directory → skipped.
  const noGit = registerProjectHooks(dir, hookProbe({}))
  assert(noGit.length === 1, "non-git repo reports one summary result")
  assert(noGit[0].status === "skipped", "non-git repo skips hooks")
  assert(noGit[0].detail.includes("not a git repository"), "non-git repo states reason")

  mkdirSync(join(dir, ".git"), { recursive: true })

  // gitnexus disabled → skipped and cleans up any old managed block.
  mkdirSync(join(dir, ".git", "hooks"), { recursive: true })
  const oldPath = join(dir, ".git", "hooks", "post-commit")
  writeFileSync(oldPath, `#!/bin/sh\n\n${MARKER_START}\n# old block\n${MARKER_END}\n`, "utf-8")
  const disabled = registerProjectHooks(dir, hookProbe({ gitnexusEnabled: false }))
  const disabledCommit = disabled.find((h) => h.hook === "post-commit")!
  assert(disabledCommit.status === "updated", "disabled gitnexus removes existing managed block")
  assert(!existsSync(oldPath), "managed block removed when disabled")

  // gitnexus CLI missing → skipped.
  const missingCli = registerProjectHooks(dir, hookProbe({ gitnexusCli: false }))
  assert(missingCli[0].status === "skipped", "missing CLI skips hooks")
  assert(missingCli[0].detail.includes("CLI not installed"), "missing CLI states reason")

  // Active: creates all three hooks.
  const active = registerProjectHooks(dir, hookProbe({}))
  assert(active.length === 3, "active gitnexus registers 3 hooks")
  assert(active.every((h) => h.status === "registered"), "active gitnexus creates hooks")
  for (const name of ["post-commit", "post-merge", "post-checkout"]) {
    const p = join(dir, ".git", "hooks", name)
    assert(existsSync(p), `${name} hook file exists`)
    const content = readFileSync(p, "utf-8")
    assert(content.includes("#!/bin/sh"), `${name} has shebang`)
    assert(content.includes(MARKER_START), `${name} has start marker`)
    assert(content.includes(MARKER_END), `${name} has end marker`)
    assert(content.includes("gitnexus analyze"), `${name} runs gitnexus analyze`)
  }

  // Idempotent re-run: up to date.
  const rerun = registerProjectHooks(dir, hookProbe({}))
  assert(rerun.every((h) => h.status === "skipped"), "second run skips unchanged hooks")

  // Existing user hook content is preserved.
  const userPath = join(dir, ".git", "hooks", "post-checkout")
  writeFileSync(userPath, "#!/bin/sh\necho 'user script'\n", "utf-8")
  const appended = registerProjectHooks(dir, hookProbe({}))
  const appendedHook = appended.find((h) => h.hook === "post-checkout")!
  assert(appendedHook.status === "updated", "user hook gets managed block appended")
  const userContent = readFileSync(userPath, "utf-8")
  assert(userContent.includes("echo 'user script'"), "user content preserved")
  assert(userContent.includes(MARKER_START), "managed block appended after user content")

  // Managed block can be refreshed in place.
  const before = readFileSync(userPath, "utf-8")
  writeFileSync(userPath, before.replace("gitnexus analyze", "gitnexus --old analyze"), "utf-8")
  const refreshed = registerProjectHooks(dir, hookProbe({}))
  const refreshedHook = refreshed.find((h) => h.hook === "post-checkout")!
  assert(refreshedHook.status === "updated", "stale managed block is refreshed")
  assert(readFileSync(userPath, "utf-8").includes("gitnexus analyze"), "managed block refreshed to current content")

  // Cleanup when disabled: removes managed block, keeps user content.
  const cleanup = registerProjectHooks(dir, hookProbe({ gitnexusEnabled: false }))
  const cleanupHook = cleanup.find((h) => h.hook === "post-checkout")!
  assert(cleanupHook.status === "updated", "cleanup updates hook")
  const afterCleanup = readFileSync(userPath, "utf-8")
  assert(afterCleanup.includes("echo 'user script'"), "user content survives cleanup")
  assert(!afterCleanup.includes(MARKER_START), "managed block removed in cleanup")

  rmSync(dir, { recursive: true, force: true })
}

function test12_TgrepGitignore() {
  section("12: tgrep .gitignore is append-only")
  const dir = mkdtempSync(join(tmpdir(), "pm-tgrep-"))
  assert(ensureTgrepGitignore(dir) === "not-git", "non-Git directory stays untouched")
  assert(!existsSync(join(dir, ".gitignore")), "non-Git directory does not gain .gitignore")
  mkdirSync(join(dir, ".git"))
  writeFileSync(join(dir, ".gitignore"), "custom\n", "utf8")
  assert(ensureTgrepGitignore(dir) === "added", "appends tgrep rule once")
  const first = readFileSync(join(dir, ".gitignore"), "utf8")
  assert(first === "custom\n.tgrep/\n", "custom content is preserved")
  assert(ensureTgrepGitignore(dir) === "present", "second run is idempotent")
  assert(readFileSync(join(dir, ".gitignore"), "utf8") === first, "second run is byte stable")
  rmSync(dir, { recursive: true, force: true })
}

test01_ValidateMessage()
await test02_FileAsSwitch()
await test03_ToolGuard()
await test04_SwitchOff()
test05_Scaffold()
test05b_UpdateSwitchesOnly()
await test06_Command()
await test07_Injection()
test08_IndexPlanning()
await test09_Announce()
test10_Sync()
test11_Hooks()
function test13_Shellwords() {
  section("13: shellwords — POSIX argv tokenizer for registry commands")
  // Bug guarded (P2 #1 in the audit): naive `split(" ")` would silently
  // mangle a command like `tgrep index --filter "*.ts"` into 4 tokens at
  // the wrong boundaries. shellwords honors quotes + backslash escapes.
  assertEq(shellwords("a b c").length, 3, "plain split stays split")
  assertEq(shellwords("a \"b c\" d").length, 3, "double-quoted space stays inside the token")
  assertEq(shellwords("a 'b c' d").length, 3, "single-quoted space stays inside the token")
  assertEq(shellwords("a b\\ c d").length, 3, "backslash-escaped space outside quotes stays inside the token (POSIX)")
  assertEq(shellwords("  a   b  ").length, 2, "runs of whitespace collapse")
  assertEq(shellwords("").length, 0, "empty string → empty argv")
  // The actual motivating case from the audit.
  const argv = shellwords(`tgrep index --filter "*.ts"`)
  assertEq(argv.length, 4, "realistic quoted-filter argv stays 4 tokens")
  assertEq(argv[3], "*.ts", "quoted filter value preserved verbatim")
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
  assert(actual === expected, `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
}

// ═════════════════════════════════════════════════════════════════════
// 14. Strict-JSON text surgery pins (ADR 0004 round-3/4 review)
// ═════════════════════════════════════════════════════════════════════

function test14_StrictJsonSurgery() {
  section("14: strict-JSON text surgery — pins a/c/g/h")
  const parses = (s: string): boolean => { try { JSON.parse(s); return true } catch { return false } }

  // (a) wizard-append into a populated object + {} bootstrap + sole member.
  const appended = applySwitchesToConfigContent('{\n  "a": "x"\n}', { adrGuard: "on" })
  assert(parses(appended) && JSON.parse(appended).adrGuard === "on" && JSON.parse(appended).a === "x",
    "(a) append keeps strict JSON, existing member untouched, NO trailing comma")
  assert(parses(generateConfigContent({ envGuard: "on", e2eGuard: "off" })), "(a) {}-bootstrap full template is strict JSON")

  // (h) delete-mode span excision on compact single-line JSON.
  assert(removeConfigField('{"a":"1","k":"v"}', "k", "delete") === '{"a":"1"}', "(h) minus last member consumes preceding comma")
  assert(removeConfigField('{"a":"1","k":"v"}', "a", "delete") === '{"k":"v"}', "(h) minus first member consumes trailing comma")
  assert(removeConfigField('{"k":"v"}', "k", "delete") === "{}", "(h) sole member → {} (no annihilation)")
  assert(!removeConfigField('{"a":"1"}', "a", "delete").includes("//"), "(h) delete mode never emits //")

  // (g) separator before a trailing comment; `//` inside string values ignored.
  const trailingNote = applySwitchesToConfigContent('{\n  "a": "x" // why\n}', { adrGuard: "on" })
  assert(trailingNote.includes('"a": "x", // why'), "(g) separator comma lands BEFORE the trailing comment")
  const urlCase = applySwitchesToConfigContent('{\n  "url": "https://x.com"\n}', { adrGuard: "on" })
  assert(parses(urlCase) && JSON.parse(urlCase).url === "https://x.com" && JSON.parse(urlCase).adrGuard === "on",
    "(g) https:// last member not mistaken for a comment; append strict-valid")

  // (c) values with " and \ round-trip through every upsert path.
  const escInsert = applySwitchesToConfigContent("{\n}\n", { adrDir: 'a"b\\c' })
  assert(parses(escInsert) && JSON.parse(escInsert).adrDir === 'a"b\\c', "(c) escaped-quote value survives {} bootstrap + reparse")
  const escReupsert = applySwitchesToConfigContent(escInsert, { adrDir: "second" })
  assert(parses(escReupsert) && JSON.parse(escReupsert).adrDir === "second", "(c) re-upsert over escaped value leaves no residue")
}

// ═════════════════════════════════════════════════════════════════════
// 15. OCP_PROJECT_DIR env override — central ocpDir() resolution (phase 4b)
// ═════════════════════════════════════════════════════════════════════

function test15_OcpProjectDirEnv() {
  section("15: OCP_PROJECT_DIR override resolves centrally")
  const origEnv = process.env.OCP_PROJECT_DIR
  try {
    // (a) unset → default .ocp (regression)
    delete process.env.OCP_PROJECT_DIR
    const da = mkdtempSync(join(tmpdir(), "pm-env-a-"))
    setProjectDir(da)
    updateSwitchesOnly({ envGuard: "on" } as const)
    assert(existsSync(join(da, ".ocp", "ocp.json")), "(a) unset env → .ocp/ocp.json")
    rmSync(da, { recursive: true, force: true })

    // (b) RELATIVE override → project-scoped rename, gitignore lands inside
    const db = mkdtempSync(join(tmpdir(), "pm-env-b-"))
    setProjectDir(db)
    process.env.OCP_PROJECT_DIR = ".foo"
    updateSwitchesOnly({ envGuard: "on" } as const)
    assert(existsSync(join(db, ".foo", "ocp.json")), "(b) relative → <root>/.foo/ocp.json")
    assert(existsSync(join(db, ".foo", ".gitignore")), "(b) gitignore bootstrapped inside the override dir")
    assert(!existsSync(join(db, ".ocp")), "(b) default dir NOT created while overridden")
    rmSync(db, { recursive: true, force: true })

    // (c) ABSOLUTE override is INVALID (4c contract: project-relative only)
    //     → silently ignored, resolution falls back to <root>/.ocp and
    //     nothing is ever written out-of-root.
    const abs = mkdtempSync(join(tmpdir(), "pm-env-abs-"))
    const dc = mkdtempSync(join(tmpdir(), "pm-env-c-"))
    setProjectDir(dc)
    process.env.OCP_PROJECT_DIR = abs
    updateSwitchesOnly({ envGuard: "on" } as const)
    assert(existsSync(join(dc, ".ocp", "ocp.json")), "(c) absolute env ignored → default <root>/.ocp")
    assert(!existsSync(join(abs, "ocp.json")) && !existsSync(join(abs, ".gitignore")), "(c) zero writes at the absolute location")
    assert(updateSwitchesOnly({ envGuard: "on" } as const).file.status === "skipped", "(c) read path falls back to the same default")
    rmSync(dc, { recursive: true, force: true })
    rmSync(abs, { recursive: true, force: true })

    // (c2) `..`-traversing override is INVALID like absolute → default (m2).
    // Run-unique escape name so parallel CI runs can't alias each other.
    const escapeName = `../escape-c2-${process.pid}`
    process.env.OCP_PROJECT_DIR = escapeName
    const dc2 = mkdtempSync(join(tmpdir(), "pm-env-c2-"))
    setProjectDir(dc2)
    updateSwitchesOnly({ envGuard: "on" } as const)
    assert(existsSync(join(dc2, ".ocp", "ocp.json")), "(c2) ..-traversing env ignored → default <root>/.ocp")
    assert(!existsSync(join(dc2, "..", `escape-c2-${process.pid}`, "ocp.json")), "(c2) nothing escaped the project root")
    rmSync(dc2, { recursive: true, force: true })

    // (d) blank env behaves as unset
    process.env.OCP_PROJECT_DIR = "   "
    const dd = mkdtempSync(join(tmpdir(), "pm-env-d-"))
    setProjectDir(dd)
    updateSwitchesOnly({ envGuard: "on" } as const)
    assert(existsSync(join(dd, ".ocp", "ocp.json")), "(d) whitespace-only env = unset")
    rmSync(dd, { recursive: true, force: true })
  } finally {
    if (origEnv === undefined) delete process.env.OCP_PROJECT_DIR
    else process.env.OCP_PROJECT_DIR = origEnv
    setProjectDir(projectDir)
  }
}

// ═════════════════════════════════════════════════════════════════════
// 16. B1 — wizard-open order: migrate BEFORE detect; saves never clobber
// ═════════════════════════════════════════════════════════════════════

function test16_OpenMigrateThenDetect() {
  section("16: B1 open-migration defeats the default-clobber chain")
  const dir = mkdtempSync(join(tmpdir(), "pm-clobber-"))
  setProjectDir(dir)
  mkdirSync(join(dir, ".opencode"), { recursive: true })
  writeFileSync(
    join(dir, ".opencode", "opencode.jsonc"),
    '{\n  "$schema": "https://opencode.ai/config.json",\n  "autoAdvisorMode": "off",\n  "adrDir": "docs/decisions"\n}\n',
    "utf-8",
  )
  // startProjectWizard order: migration → detect → (later) save with detected.
  const open1 = migrateLegacyProjectArtifacts(dir)
  assert(open1.switchedKeys.length === 2 && open1.warnings.length === 0, "first open migrates and the report is non-empty (visible)")
  const detected = detectProjectSwitches(dir)
  assert(
    detected.exists && detected.switches.autoAdvisorMode === "off" && detected.switches.adrDir === "docs/decisions",
    "detect reads migrated truth — defaults no longer mask explicit values",
  )
  const ri = runInitWithSwitches(detected.switches)
  const saved = JSON.parse(readFileSync(join(dir, ".ocp", "ocp.json"), "utf-8")) as Record<string, unknown>
  assert(saved.autoAdvisorMode === "off" && saved.adrDir === "docs/decisions", "B1: save with detected switches does NOT clobber migrated values")
  assert(
    ri.migration.switchedKeys.length === 0 && ri.migration.movedFiles.length === 0 && ri.migration.warnings.length === 0,
    "second-run (save-time) migration report is empty — idempotent",
  )
  rmSync(dir, { recursive: true, force: true })
  setProjectDir(projectDir)
}

test12_TgrepGitignore()
test13_Shellwords()
test14_StrictJsonSurgery()
test15_OcpProjectDirEnv()
test16_OpenMigrateThenDetect()

rmSync(projectDir, { recursive: true, force: true })

console.log(`\n${"═".repeat(60)}`)
console.log(`  RESULT: ${passed} passed, ${failed} failed`)
console.log(`${"═".repeat(60)}`)
if (failed > 0) process.exit(1)
