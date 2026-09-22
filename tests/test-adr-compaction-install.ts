/** End-to-end delivery: the production installer places the ADR maintenance
 * toolchain into a disposable OPENCODE_CONFIG_DIR, the installed copy performs
 * read-only analysis in-process, and a real OpenCode server boots from that
 * same installed tree with the tools auto-discovered (no fixture plugin path).
 *
 * Requires: `opencode` on PATH, registry access for OpenCode's own
 * `@opencode-ai/plugin` dependency install, and a current-version manifest.
 * Never bumps the version, writes historical manifests, or touches the real
 * user config dir (HOME is redirected to a temporary directory).
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
if (!Bun.which("opencode")) throw new Error("OpenCode >=1.18.15 is required")

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
    "tui.jsonc",
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

  // Real server boot from the installed tree: no fixture plugin path, auto-discovery only.
  proc = Bun.spawn(["opencode", "serve", "--hostname", "0.0.0.0", "--port", "0"], {
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv,
  })
  const stderrDrain = drain(proc.stderr as ReadableStream<Uint8Array>)
  const timer = setTimeout(() => { abort.abort(); proc?.kill() }, 240_000)
  try {
    let startup = "", port: string | undefined
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      startup += new TextDecoder().decode(chunk)
      port = /listening on http:\/\/[^:]+:(\d+)/.exec(startup)?.[1]
      if (port) break
    }
    assert.ok(port, `Installed runtime did not start: ${stderr}`)
    const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" }
    const get = (path: string) => fetch(`http://127.0.0.1:${port}${path}`, { headers, signal: abort.signal })
    let tools: string[] = []
    let attempts = 0
    // The first request also waits for OpenCode's own dependency install into
    // the config dir; that is the real delivery path, not a test shortcut.
    while (attempts++ < 60) {
      try {
        const response = await get("/experimental/tool/ids")
        if (response.ok) {
          tools = await response.json() as string[]
          if (tools.includes("adr_context") && tools.includes("adr_compaction")) break
        }
      } catch (error) {
        if (abort.signal.aborted) throw error
      }
      await Bun.sleep(2500)
    }
    assert.ok(tools.includes("adr_context") && tools.includes("adr_compaction"), `Installed plugins did not register the ADR maintenance tools: ${tools.join(", ")}`)
    const config = await get("/config")
    assert.ok(config.ok, `Resolved config endpoint failed: ${config.status}`)
    const resolved = JSON.stringify(await config.json())
    assert.ok(resolved.includes("plugins/adr.ts") || resolved.includes("plugins%2Fadr.ts"), "Auto-discovered ADR plugin is missing from the resolved config origins")
    const commands = await get("/command")
    assert.ok(commands.ok, `Command listing failed: ${commands.status}`)
    const commandNames = (await commands.json() as { name?: string }[]).map(entry => entry.name)
    assert.ok(commandNames.includes("adr-guard"), `Installed ADR command is missing from the native command list: ${commandNames.join(", ")}`)
    const skillFiles = readdirSync(installed("skills"))
    assert.ok(skillFiles.includes("adr-compaction") && skillFiles.includes("adr-context"), `Installed skill directories changed: ${skillFiles.join(", ")}`)
    assert.ok(!existsSync(join(project, ".ocp/adr-compaction")), "Server startup created maintenance state")
    console.log("PASS installed tree boots a real OpenCode server with auto-discovered ADR tools and command")
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
