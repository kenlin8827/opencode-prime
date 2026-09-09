/**
 * Backend bootstrap for `/project init` and `/project index`.
 *
 * Semantics — first-time initialization vs index rebuild:
 *   /project init  → scaffold files + every FIRST-TIME init step, but only
 *                    when the backend's CLI is installed:
 *                      `codegraph init`    (one-time; watcher keeps it fresh)
 *                      `gitnexus analyze`  (initial build when the index is
 *                                          missing entirely)
 *                      dbhub.toml          scaffolded per project (never
 *                                          overwritten) when the dbhub MCP
 *                                          is enabled AND its CLI is on PATH
 *   /project index → manual rebuild/refresh, only for indexes that already
 *                    exist (a first index is init's job):
 *                      `codegraph sync`    incremental catch-up for changes
 *                                          made while the watcher wasn't
 *                                          running (full `codegraph index`
 *                                          rebuild stays a manual escape hatch)
 *                      `gitnexus analyze`  only when the index is STALE
 *
 * Gate (same AND-rule as project-profiler): a backend is touched only when
 * mcp.<name>.enabled in the installed opencode.jsonc is not false AND its
 * CLI is on PATH. A CLI present but disabled in config is never run; a
 * missing CLI is reported as skipped — never invoked, never errors.
 *
 * Serena needs no index step (live LSP) and is not handled here.
 *
 * Backend commands and lifecycle conditions are driven by `project-hooks.jsonc`
 * instead of hardcoded strings.
 */

import { execSync, spawn } from "node:child_process"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { DBHUB_TOML_REL, scaffoldFile, writeDbhubToml } from "./project-manager-scaffold"
import { loadProjectHooks, type BackendAction, type ProjectHooks } from "./project-hooks-loader"
import { getProjectDir } from "./project-manager-config"
import { tgrepOptionsFrom, type TgrepOptions } from "../tgrep/tgrep-config"
import { hasTgrepIndex, probeTgrepStatus, recordSuccessfulIndex, tgrepNeedsRebuild, type TgrepReadiness } from "../tgrep/tgrep-service"

// ─── Probes ──────────────────────────────────────────────────────────

/** Parse mcp.<name>.enabled out of opencode.jsonc text — same JSONC subset
 * rule as project-profiler: strip whole-line // comments, then read the real
 * object (a regex can't cross nested braces like gitnexus's `env` block).
 * Missing entry or unparseable text → true (assume enabled). */
export function mcpEnabledFrom(text: string, name: string): boolean {
  try {
    const json = text.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")
    const obj = JSON.parse(json) as { mcp?: Record<string, { enabled?: boolean }> }
    const flag = obj.mcp?.[name]?.enabled
    return flag !== false
  } catch { /* unparseable — assume enabled */ return true }
}

/** mcp.<name>.enabled from the installed opencode.jsonc. Degrades to true
 * when the config is missing/unreadable. */
function mcpEnabled(name: string): boolean {
  try {
    const cfg = join(homedir(), ".config", "opencode", "opencode.jsonc")
    return mcpEnabledFrom(readFileSync(cfg, "utf8"), name)
  } catch { /* no config — assume enabled */ return true }
}

function codegraphCliInstalled(): boolean {
  try {
    // `--version` — the CLI has no `version` subcommand (commander rejects it).
    execSync("codegraph --version", { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] })
    return true
  } catch { /* not installed or not on PATH */ }
  return false
}

function gitnexusCliInstalled(): boolean {
  try {
    execSync("gitnexus --version", { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] })
    return true
  } catch { /* not installed or not on PATH */ }
  return false
}

/** dbhub has no `--version`/`--help` (every invocation demands a database
 * config), so probe PATH presence instead — `where.exe` finds npm-global
 * .cmd shims on Windows, `command -v` elsewhere. */
function dbhubCliInstalled(): boolean {
  const probe = process.platform === "win32" ? "where.exe dbhub" : "command -v dbhub"
  try {
    execSync(probe, { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] })
    return true
  } catch { /* not installed or not on PATH */ }
  return false
}

function cliInstalled(name: string): boolean {
  if (name === "codegraph") return codegraphCliInstalled()
  if (name === "gitnexus") return gitnexusCliInstalled()
  if (name === "dbhub") return dbhubCliInstalled()
  if (name === "tgrep") {
    const probe = process.platform === "win32" ? "where.exe tgrep" : "command -v tgrep"
    try {
      execSync(probe, { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] })
      execSync("tgrep --version", { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] })
      return true
    } catch { return false }
  }
  return false
}

/** Index state of .gitnexus/ vs HEAD — same staleness rule as the profiler:
 * any HEAD commit newer than the newest index file marks the index stale. */
function gitnexusIndexState(root: string): "ready" | "stale" | "missing" {
  const idx = join(root, ".gitnexus")
  if (!existsSync(idx)) return "missing"
  try {
    let indexMtime = 0
    for (const e of readdirSync(idx)) {
      try {
        const m = statSync(join(idx, e)).mtimeMs
        if (m > indexMtime) indexMtime = m
      } catch { /* entry vanished — ignore */ }
    }
    const head = execSync("git log -1 --format=%ct", {
      cwd: root, encoding: "utf8", timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    const headSec = parseInt(head, 10)
    if (!Number.isNaN(headSec) && headSec * 1000 > indexMtime) return "stale"
  } catch { /* not a git repo or git unavailable — treat index as ready */ }
  return "ready"
}

export interface BackendProbe {
  codegraphEnabled: boolean
  codegraphCli: boolean
  codegraphIndexed: boolean
  gitnexusEnabled: boolean
  gitnexusCli: boolean
  gitnexusIndex: "ready" | "stale" | "missing"
  dbhubEnabled: boolean
  dbhubCli: boolean
  dbhubToml: boolean
  tgrepEnabled: boolean
  tgrepCli: boolean
  tgrepIndexed: boolean
  tgrepReadiness: TgrepReadiness
  tgrepPolicyCurrent: boolean
  tgrepOptions: TgrepOptions
}

/** Probe both backends for the given project root (sync, cheap). */
export function probeBackends(root: string): BackendProbe {
  const cgEnabled = mcpEnabled("codegraph")
  const gnEnabled = mcpEnabled("gitnexus")
  const dhEnabled = mcpEnabled("dbhub")
  let tgrepOptions: TgrepOptions = { enabled: false }
  try { tgrepOptions = tgrepOptionsFrom(root, readFileSync(join(homedir(), ".config", "opencode", "options.jsonc"), "utf8")) } catch { /* invalid setting disables safely */ }
  const tgEnabled = tgrepOptions.enabled
  const tgCli = tgEnabled && cliInstalled("tgrep")
  return {
    codegraphEnabled: cgEnabled,
    codegraphCli: cgEnabled && codegraphCliInstalled(),
    codegraphIndexed: cgEnabled && existsSync(join(root, ".codegraph")),
    gitnexusEnabled: gnEnabled,
    gitnexusCli: gnEnabled && gitnexusCliInstalled(),
    gitnexusIndex: gnEnabled ? gitnexusIndexState(root) : "missing",
    dbhubEnabled: dhEnabled,
    dbhubCli: dhEnabled && dbhubCliInstalled(),
    dbhubToml: existsSync(join(root, DBHUB_TOML_REL)),
    tgrepEnabled: tgEnabled,
    tgrepCli: tgCli,
    tgrepIndexed: tgEnabled && hasTgrepIndex(root, tgrepOptions),
    tgrepReadiness: tgCli ? probeTgrepStatus(root, tgrepOptions) : "unavailable",
    tgrepPolicyCurrent: tgCli && hasTgrepIndex(root, tgrepOptions) ? !tgrepNeedsRebuild(root, tgrepOptions) : false,
    tgrepOptions,
  }
}

// ─── Registry-driven planner ─────────────────────────────────────────

export type BackendKind = "codegraph" | "gitnexus" | "dbhub" | "tgrep"

export interface BackendPlan {
  backend: BackendKind
  /** Command to run in the project root; null → nothing to run. */
  command: string | null
  /** Non-CLI action to perform instead of spawning a command. */
  action?: "scaffold"
  /** Action-specific arguments. */
  args?: Record<string, unknown>
  /** User-visible explanation of the decision. */
  note: string
}

function evaluateCondition(cond: string, root: string, probe: BackendProbe): boolean {
  const negated = cond.startsWith("!")
  const c = negated ? cond.slice(1) : cond
  let result = false

  if (c === "always") {
    result = true
  } else if (c.startsWith("mcp_enabled:")) {
    const name = c.slice("mcp_enabled:".length)
    result = name === "codegraph" ? probe.codegraphEnabled
      : name === "gitnexus" ? probe.gitnexusEnabled
        : name === "dbhub" ? probe.dbhubEnabled
           : false
  } else if (c.startsWith("tool_enabled:")) {
    result = c.slice("tool_enabled:".length) === "tgrep" && probe.tgrepEnabled
  } else if (c.startsWith("cli_installed:")) {
    const name = c.slice("cli_installed:".length)
    result = name === "codegraph" ? probe.codegraphCli
      : name === "gitnexus" ? probe.gitnexusCli
         : name === "dbhub" ? probe.dbhubCli
         : name === "tgrep" ? probe.tgrepCli
           : false
  } else if (c.startsWith("indexed:")) {
    const name = c.slice("indexed:".length)
    result = name === "codegraph" ? probe.codegraphIndexed : name === "tgrep" ? probe.tgrepIndexed : false
  } else if (c.startsWith("server_healthy:")) {
    result = c.slice("server_healthy:".length) === "tgrep" && probe.tgrepReadiness === "server"
  } else if (c.startsWith("index_missing:")) {
    result = c.slice("index_missing:".length) === "tgrep" && !probe.tgrepIndexed
  } else if (c.startsWith("policy_current:")) {
    result = c.slice("policy_current:".length) === "tgrep" && probe.tgrepPolicyCurrent
  } else if (c === "tgrep_rebuild_needed") {
    result = probe.tgrepIndexed && (probe.tgrepReadiness !== "server" || !probe.tgrepPolicyCurrent)
  } else if (c.startsWith("toml_present:")) {
    const name = c.slice("toml_present:".length)
    result = name === "dbhub" ? probe.dbhubToml : false
  } else if (c === "index_missing") {
    result = probe.gitnexusIndex === "missing"
  } else if (c === "index_stale") {
    result = probe.gitnexusIndex === "stale"
  } else if (c === "index_ready") {
    result = probe.gitnexusIndex === "ready"
  } else {
    throw new Error(`Unknown project-hooks condition: ${c}`)
  }

  return negated ? !result : result
}

function conditionSkipNote(cond: string, probe: BackendProbe): string {
  if (cond.startsWith("tool_enabled:")) return `${cond.slice("tool_enabled:".length)} disabled in options.jsonc`
  if (cond.startsWith("mcp_enabled:")) return `${cond.slice("mcp_enabled:".length)} disabled in options.jsonc`
  if (cond.startsWith("cli_installed:")) return `${cond.slice("cli_installed:".length)} CLI not installed`
  if (cond === "indexed:codegraph") return "no index yet — that's an init step, run /project init"
  if (cond === "!indexed:codegraph") return "already indexed"
  if (cond === "toml_present:dbhub") return "no dbhub.toml — that's an init step"
  if (cond === "!toml_present:dbhub") return "dbhub.toml already present"
  if (cond === "index_missing") {
    return probe.gitnexusIndex === "ready" ? "already indexed" : "stale — rebuild via /project index"
  }
  if (cond === "index_stale") return "index up to date"
  if (cond === "index_ready") return "no index yet — that's an init step, run /project init"
  if (cond === "index_missing:tgrep") return "local tgrep index already exists"
  if (cond === "!server_healthy:tgrep") return "healthy tgrep server keeps the index current"
  if (cond === "policy_current:tgrep") return "tgrep index policy/version changed — rebuild via /project index"
  if (cond === "tgrep_rebuild_needed") return probe.tgrepReadiness === "server" ? "healthy tgrep server and current policy" : "no healthy tgrep server"
  return `skipped (${cond})`
}

function planBackendAction(
  backend: BackendKind,
  action: BackendAction | null,
  root: string,
  probe: BackendProbe,
): BackendPlan {
  if (!action) {
    return { backend, command: null, note: "no action configured" }
  }
  for (const cond of action.when) {
    if (!evaluateCondition(cond, root, probe)) {
      return { backend, command: null, note: conditionSkipNote(cond, probe) }
    }
  }
  if (action.action === "scaffold") {
    return { backend, command: null, action: "scaffold", args: action.args, note: action.note ?? "scaffold file" }
  }
  return { backend, command: action.command ?? null, args: backend === "tgrep" ? { options: probe.tgrepOptions } : undefined, note: action.note ?? `${action.command} planned` }
}

function planBackends(
  registry: ProjectHooks | null,
  phase: "init" | "index" | "teardown",
  root: string,
  probe: BackendProbe,
): BackendPlan[] {
  const names: BackendKind[] = ["codegraph", "gitnexus", "dbhub", "tgrep"]
  if (!registry) {
    // Registry missing — every backend is skipped with a safe fallback note.
    return names.map((backend) => ({ backend, command: null, note: "project-hooks.jsonc not found" }))
  }
  return names.map((backend) => {
    const entry = registry.backends[backend]
    if (!entry) {
      return { backend, command: null, note: "not configured in project-hooks.jsonc" }
    }
    return planBackendAction(backend, entry[phase], root, probe)
  })
}

/** First-time init steps for `/project init` — one plan per backend.
 * Driven by `project-hooks.jsonc`. */
export function planInitBackends(p: BackendProbe, root = getProjectDir()): BackendPlan[] {
  return planBackends(loadProjectHooks(), "init", root, p)
}

/** Rebuild/refresh for `/project index` — only EXISTING indexes are touched
 * here; creating a first index is an init step, not a rebuild.
 * Driven by `project-hooks.jsonc`. */
export function planIndexBackends(p: BackendProbe, root = getProjectDir()): BackendPlan[] {
  return planBackends(loadProjectHooks(), "index", root, p)
}

// ─── Executor ────────────────────────────────────────────────────────

export type BackendStatus = "ran" | "skipped" | "failed"

export interface BackendResult {
  backend: BackendKind
  status: BackendStatus
  detail: string
}

/** Run the planned backend commands in the project root (async, sequential,
 * never throws). shell:true so npm-global .cmd shims resolve on Windows. */
export function runBackends(plans: BackendPlan[], root: string): Promise<BackendResult[]> {
  return plans.reduce(
    (chain, plan) => chain.then((acc) => runBackend(plan, root).then((r) => [...acc, r])),
    Promise.resolve([] as BackendResult[]),
  )
}

/** Run one planned backend command (async, never throws). Non-CLI actions
 * such as "scaffold" are handled here as well. */
function runBackend(plan: BackendPlan, root: string): Promise<BackendResult> {
  if (plan.action === "scaffold") {
    const template = String(plan.args?.template ?? "")
    const target = String(plan.args?.target ?? "")
    if (!template || !target) {
      return Promise.resolve({
        backend: plan.backend,
        status: "failed",
        detail: "scaffold action missing template or target",
      })
    }
    try {
      const status = scaffoldFile(root, template, target)
      return Promise.resolve({
        backend: plan.backend,
        status: status === "created" ? "ran" : "skipped",
        detail: status === "created" ? (plan.note ?? `${target} created`) : `${target} already present`,
      })
    } catch (e) {
      return Promise.resolve({ backend: plan.backend, status: "failed", detail: String(e) })
    }
  }
  if (!plan.command) {
    return Promise.resolve({ backend: plan.backend, status: "skipped", detail: plan.note })
  }
  const [cmd, ...args] = plan.command.split(" ")
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: root, shell: true, stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr.on("data", (d) => (stderr += String(d)))
    child.on("error", (e) => resolve({ backend: plan.backend, status: "failed", detail: String(e) }))
    child.on("close", (code) => {
      if (code === 0) {
        if (plan.backend === "tgrep") {
          try { recordSuccessfulIndex(root, plan.args?.options as TgrepOptions) } catch { /* metadata failure must not invalidate a successful CLI index */ }
        }
        resolve({ backend: plan.backend, status: "ran", detail: `${plan.command} done` })
      } else {
        const firstErr = stderr.trim().split("\n")[0]
        resolve({
          backend: plan.backend,
          status: "failed",
          detail: `${plan.command} exited ${code}${firstErr ? ` — ${firstErr}` : ""}`,
        })
      }
    })
  })
}
