/** End-to-end delivery: the production installer places the ADR maintenance
 * toolchain into a disposable OPENCODE_CONFIG_DIR, the installed copy performs
 * read-only analysis in-process, and a real OpenCode server boots from that
 * same installed tree with the tools auto-discovered (no fixture plugin path).
 *
 * Requires: the sandboxed v2 runtime (.ocp/sandbox/bun-windows-x64/bun.exe +
 * .ocp/sandbox/v2src — see .ocp/sandbox/WORKING-EXAMPLE/README.md), registry
 * access for OpenCode's own dependency install, and a current-version
 * manifest. Never bumps the version, writes historical manifests, or touches
 * the real user config dir (HOME is redirected to a temporary directory).
 * Run: bun tests/test-adr-compaction-install.ts
 */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { executeInstall } from "../install/src/installer"

const repo = resolve(import.meta.dir, "..")
// v2 seam: the boot assertions below drive the SANDBOXED v2 runtime (see
// .ocp/sandbox/WORKING-EXAMPLE) instead of a v1 `opencode` binary on PATH —
// the host PATH may carry an unrelated v1 install and MUST NOT be spawned.
const sandbox = resolve(repo, ".ocp/sandbox")
const sandboxBun = join(sandbox, "bun-windows-x64", "bun.exe")
const v2Cli = join(sandbox, "v2src", "packages", "cli")
if (!existsSync(sandboxBun) || !existsSync(join(v2Cli, "src", "index.ts"))) {
  console.warn("[SKIP] test-adr-compaction-install: sandbox v2 runtime missing (.ocp/sandbox/bun-windows-x64/bun.exe + v2src)")
  process.exit(0)
}

const versionsDir = join(repo, "install/versions")
const versionJsonPath = join(repo, "install/version.json")
const versionJson = readFileSync(versionJsonPath, "utf8")
const releaseVersion = JSON.parse(versionJson).version as string
const snapshotVersions = () => Object.fromEntries(readdirSync(versionsDir).map(name => [name, createHash("sha256").update(readFileSync(join(versionsDir, name))).digest("hex")]))
const beforeVersions = snapshotVersions()
assert.ok(existsSync(join(versionsDir, `${releaseVersion}.manifest.txt`)), "Current-version manifest must exist; the delivery test never generates or rewrites one")

const root = mkdtempSync(join(tmpdir(), "adr-install-e2e-"))
// The shipped template references prompts/instructions as ~/.config/opencode/…
// (templated into the agent prompt block), so the only faithful end-to-end
// layout is a canonical config dir under a sandboxed HOME. Redirecting only
// XDG_CONFIG_HOME would leave those ~ paths pointing at the real user config.
const home = join(root, "home")
const target = join(home, ".config/opencode")
const project = join(root, "project")
const previousHome = process.env.HOME
const previousXdg = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"].map(key => [key, process.env[key]] as const)
process.env.HOME = home
// During install, pin XDG so installer-side writes (bundled models/cost.jsonc)
// land in the sandbox too; the server child gets the canonical HOME-derived
// layout instead (template prompts resolve through ~).
process.env.XDG_CONFIG_HOME = join(root, "xdg-installer")
const record = `---\nstyle: nygard\nstatus: accepted\ndate: 2026-09-20\nlayer: system\n---\n\n# 0001. Boundaries\n\n## Context\n\nNeed isolation.\n\n## Decision\n\nUse explicit boundaries.\n\n## Consequences\n\nValidate calls.\n`
mkdirSync(join(project, "docs/adr"), { recursive: true })
mkdirSync(join(project, ".ocp"), { recursive: true })
writeFileSync(join(project, ".ocp/ocp.json"), JSON.stringify({ adr: { style: "nygard", numbering: "sequential", layout: "flat", governance: "strict" } }))
writeFileSync(join(project, "docs/adr/0001-boundaries.md"), record)

const childEnv: Record<string, string | undefined> = { ...process.env, HOME: home, OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_SERVER_PASSWORD: randomUUID() }
for (const [key] of previousXdg) delete childEnv[key]
const password = childEnv.OPENCODE_SERVER_PASSWORD!
const abort = new AbortController()
let proc: ReturnType<typeof Bun.spawn> | undefined
let stderr = ""
const drain = (stream: ReadableStream<Uint8Array>) => (async () => { for await (const bytes of stream) stderr += new TextDecoder().decode(bytes) })()
try {
  const install = executeInstall(repo, { action: "install", target, force: true, noBackup: true, yes: true, isInteractive: false, projectMode: "headless" }, {
    global_commands: false,
    tui_mode: "direct",
    tools: { rtk: false, ripgrep: false, tgrep: { enabled: false }, herdr: false, luvus: false, openchamber_web: false, openchamber_desktop: false, openchamber_vscode: false },
    mcp: { serena: false, codegraph: false, gitnexus: false, dbhub: false, headroom: false, idea: false },
  })
  assert.ok(install.success && install.filesInstalled > 0, "Installer did not report a successful install")
  assert.equal(install.version, releaseVersion)

  const installed = (rel: string) => join(target, rel)
  const required = [
    "plugins/adr.ts",
    "plugins/adr/adr-compaction.ts",
    "plugins/adr/adr-compaction-runtime.ts",
    "plugins/adr/adr-context.ts",
    "plugins/adr/adr-publication.ts",
    "plugins/adr/adr-archive.ts",
    "plugins/adr/adr-read-guard.ts",
    "plugins/adr/adr-storage.ts",
    "skills/adr-compaction/SKILL.md",
    "skills/adr-context/SKILL.md",
    "plugin-scope.json",
    "opencode.jsonc",
    // v2 seam: the terminal-client config renders to `cli.json` (mergeTuiConfig
    // in install/src/merger.ts), replacing v1's `tui.jsonc` artifact.
    "cli.json",
    "installed.version",
  ]
  for (const rel of required) assert.ok(existsSync(installed(rel)), `Installer did not deliver ${rel}`)
  assert.ok(existsSync(join(root, "xdg-installer/opencode/models/cost.jsonc")), "Installer-side models cost file did not land in the sandbox")
  assert.equal(readFileSync(installed("plugin-scope.json"), "utf8"), readFileSync(join(repo, "plugin-scope.json"), "utf8"), "Installed scope policy drifted from the repository policy")
  assert.equal(readFileSync(installed("plugins/adr/adr-compaction.ts"), "utf8"), readFileSync(join(repo, "plugins/adr/adr-compaction.ts"), "utf8"), "Installed plugin drifted from the repository source")
  for (const name of readdirSync(join(repo, "instructions"))) assert.ok(existsSync(installed(`instructions/${name}`)), `Installer did not deliver instructions/${name}`)
  const installedConfig = JSON.parse(readFileSync(installed("opencode.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"))
  assert.equal(installedConfig.instructions.length, 5, "Installed L0 instruction list changed")

  // The installed copy must work on its own: analyze without writes.
  const installedConfigModule = await import(pathToFileURL(installed("plugins/adr/adr-config.ts")).href)
  const installedCompaction = await import(pathToFileURL(installed("plugins/adr/adr-compaction.ts")).href)
  installedConfigModule.setProjectDir(project)
  const analysis = installedCompaction.analyzeCompaction(project)
  assert.match(analysis, /selected: 1/, `Installed analysis did not report the fixture record: ${analysis.slice(0, 200)}`)
  assert.ok(!existsSync(join(project, ".ocp/adr-compaction")), "Read-only analysis wrote maintenance state")
  assert.equal(readFileSync(join(project, "docs/adr/0001-boundaries.md"), "utf8"), record, "Read-only analysis modified the ADR source")
  console.log("PASS installed toolchain analyzes a real project without writes")

  // Real server boot from the installed tree against the SANDBOXED v2 runtime
  // (no fixture plugin path, config-dir auto-discovery only). Spawn recipe:
  // .ocp/sandbox/WORKING-EXAMPLE — the v2 global config resolves through
  // HOME/.config/opencode (== the installed target), plugins load per
  // location after the first directory-scoped request. The host PATH v1
  // binary MUST NOT be used: the migrated plugin exports the v2
  // `{ id, setup }` shape and cannot register on a v1 server.
  const childEnvPinned: Record<string, string | undefined> = { ...childEnv }
  for (const key of ["OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_PASSWORD", "ORCA_OPENCODE_CONFIG_DIR", "ORCA_AGENT_HOOK_ENDPOINT", "ORCA_AGENT_HOOK_TOKEN"]) delete childEnvPinned[key]
  const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("") } })
  const bootPort = portProbe.port
  portProbe.stop(true)
  proc = Bun.spawn([sandboxBun, "run", "--cwd", v2Cli, "src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", String(bootPort)], {
    cwd: v2Cli,
    stdout: "pipe",
    stderr: "pipe",
    env: childEnvPinned,
  })
  const stderrDrain = drain(proc.stderr as ReadableStream<Uint8Array>)
  const timer = setTimeout(() => { abort.abort(); proc?.kill() }, 240_000)
  try {
    let startup = ""
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      startup += new TextDecoder().decode(chunk)
      if (/server listening on http:\/\/\S+/.test(startup)) break
    }
    assert.ok(/server listening on http:\/\/127\.0\.0\.1/.test(startup), `Installed v2 runtime did not boot: stdout=${startup}\nstderr=${stderr}`)
    const headers = {
      authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      "content-type": "application/json",
      // v2 location bootstrap: the per-location instance graph (where plugin
      // setup() runs) is built on the first directory-scoped request. The
      // header value must be a Windows-style path, not a git-bash /d/ path.
      "x-opencode-directory": project,
    }
    const get = (path: string) => fetch(`http://127.0.0.1:${bootPort}${path}`, { headers, signal: abort.signal })
    type PluginEntry = { id?: string; state?: { status?: string } }
    let plugins: PluginEntry[] = []
    let attempts = 0
    // The bootstrap also pays for the v2 runtime's cold start from source and
    // its dependency install into the config dir; that is the real delivery
    // path, not a test shortcut.
    while (attempts++ < 90) {
      try {
        const location = await get("/api/location")
        if (location.ok) {
          const response = await get("/api/plugin")
          if (response.ok) {
            plugins = ((await response.json() as { data?: PluginEntry[] }).data ?? [])
            if (plugins.some(p => p.id === "adr" && p.state?.status === "active")) break
          }
        }
      } catch (error) {
        if (abort.signal.aborted) throw error
      }
      await Bun.sleep(2000)
    }
    // v2 has no v1-style `/experimental/tool/ids` listing; tool payloads are
    // added inside `ctx.tool.transform` during setup() — plugin `active`
    // status is the server-visible proof that setup (and the ADR tool/command
    // transforms) completed without throwing. Tool payload unit coverage
    // lives in tests/test-v2-hook-wiring-unit.ts and the compaction unit tests.
    const adr = plugins.find(p => p.id === "adr")
    assert.equal(adr?.state?.status, "active", `Installed ADR plugin did not activate in the v2 runtime: ${JSON.stringify(plugins.filter(p => String(p.id ?? "").includes("adr") || String(p.id ?? "").includes(".opencode") === false))}`)
    const commands = await get("/api/command")
    assert.ok(commands.ok, `Command listing failed: ${commands.status}`)
    const commandNames = ((await commands.json() as { data?: { name?: string }[] }).data ?? []).map(entry => entry.name)
    assert.ok(commandNames.includes("adr-guard"), `Installed ADR command is missing from the native command list: ${commandNames.join(", ")}`)
    const skillFiles = readdirSync(installed("skills"))
    assert.ok(skillFiles.includes("adr-compaction") && skillFiles.includes("adr-context"), `Installed skill directories changed: ${skillFiles.join(", ")}`)
    assert.ok(!existsSync(join(project, ".ocp/adr-compaction")), "Server startup created maintenance state")
    console.log("PASS installed tree boots the sandbox v2 runtime with auto-discovered active ADR plugin and command")
  } finally {
    clearTimeout(timer)
  }
} finally {
  abort.abort()
  proc?.kill()
  await proc?.exited
  await drain(proc?.stderr as ReadableStream<Uint8Array>).catch(() => {})
  rmSync(root, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  for (const [key, value] of previousXdg) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  assert.equal(readFileSync(versionJsonPath, "utf8"), versionJson, "Delivery test modified install/version.json")
  assert.deepEqual(snapshotVersions(), beforeVersions, "Delivery test modified install/versions")
}
console.log("PASS production install delivers the ADR toolchain to a real OpenCode config dir")
