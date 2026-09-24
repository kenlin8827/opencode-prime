/**
 * Loader for `project-hooks.jsonc` — the project-level MCP lifecycle registry.
 *
 * The registry declares, per backend:
 *   - mcp / cli names used for enabled / PATH probes
 *   - init / index / teardown actions with `when` condition lists
 *   - git_hooks: hook-name → command to run inside the managed block
 *
 * Resolution: the registry ships NEXT TO THIS MODULE only (repo
 * `plugins/project-manager/`, installed `~/.config/opencode/project-
 * manager/`) — no per-project or user-level override is looked up.
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export interface BackendAction {
  /** Shell command to run; null or omitted for non-CLI actions. */
  command?: string | null
  /** Named non-CLI action. Currently only "scaffold" is supported. */
  action?: "scaffold"
  /** Action-specific arguments (e.g. { template, target } for scaffold). */
  args?: Record<string, unknown>
  /** Conditions that must all pass for the action to run. */
  when: string[]
  /** Optional user-visible note when the action runs or skips. */
  note?: string
}

export interface BackendEntry {
  /** MCP name used to read `mcp.servers.<name>.disabled` from opencode.jsonc. */
  mcp: string
  /** CLI name used for PATH probes. */
  cli: string
  init: BackendAction | null
  index: BackendAction | null
  teardown: BackendAction | null
  /** Hook name → command to run inside the managed block. */
  git_hooks: Record<string, string> | null
}

export interface ProjectHooks {
  backends: Record<string, BackendEntry>
}

const PROJECT_HOOKS_NAME = "project-hooks.jsonc"

/** Strip whole-line // comments — same JSONC subset rule used elsewhere. */
function stripLineComments(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function validateAction(raw: unknown, ctx: string): BackendAction {
  if (!isPlainObject(raw)) throw new Error(`${ctx} must be an object`)
  const when = (raw as { when?: unknown }).when
  if (!Array.isArray(when) || when.some((c) => typeof c !== "string")) {
    throw new Error(`${ctx}.when must be an array of strings`)
  }
  const command = (raw as { command?: unknown }).command
  if (command !== undefined && command !== null && typeof command !== "string") {
    throw new Error(`${ctx}.command must be a string, null, or omitted`)
  }
  const action = (raw as { action?: unknown }).action
  if (action !== undefined && action !== null && action !== "scaffold") {
    throw new Error(`${ctx}.action must be "scaffold", null, or omitted`)
  }
  const args = (raw as { args?: unknown }).args
  if (args !== undefined && args !== null) {
    if (!isPlainObject(args)) throw new Error(`${ctx}.args must be an object`)
    if (action === "scaffold") {
      const a = args as Record<string, unknown>
      if (typeof a.template !== "string") throw new Error(`${ctx}.args.template must be a string`)
      if (typeof a.target !== "string") throw new Error(`${ctx}.args.target must be a string`)
    }
  } else if (action === "scaffold") {
    throw new Error(`${ctx}.args is required when action is "scaffold"`)
  }
  const note = (raw as { note?: unknown }).note
  if (note !== undefined && typeof note !== "string") {
    throw new Error(`${ctx}.note must be a string or omitted`)
  }
  return { command, action: action === null ? undefined : action, args: args as Record<string, unknown> | undefined, when: when as string[], note }
}

function validateBackendEntry(raw: unknown, name: string): BackendEntry {
  if (!isPlainObject(raw)) throw new Error(`backends.${name} must be an object`)
  const mcp = (raw as { mcp?: unknown }).mcp
  const cli = (raw as { cli?: unknown }).cli
  if (typeof mcp !== "string") throw new Error(`backends.${name}.mcp must be a string`)
  if (typeof cli !== "string") throw new Error(`backends.${name}.cli must be a string`)

  const parseAction = (key: "init" | "index" | "teardown") => {
    const v = (raw as Record<string, unknown>)[key]
    if (v === null || v === undefined) return null
    return validateAction(v, `backends.${name}.${key}`)
  }

  const gitHooksRaw = (raw as { git_hooks?: unknown }).git_hooks
  let git_hooks: Record<string, string> | null = null
  if (gitHooksRaw !== null && gitHooksRaw !== undefined) {
    if (!isPlainObject(gitHooksRaw)) throw new Error(`backends.${name}.git_hooks must be an object or null`)
    for (const [k, v] of Object.entries(gitHooksRaw)) {
      if (typeof v !== "string") throw new Error(`backends.${name}.git_hooks.${k} must be a string command`)
    }
    git_hooks = gitHooksRaw as Record<string, string>
  }

  return {
    mcp,
    cli,
    init: parseAction("init"),
    index: parseAction("index"),
    teardown: parseAction("teardown"),
    git_hooks,
  }
}

export function validateProjectHooks(raw: unknown): ProjectHooks {
  if (!isPlainObject(raw)) throw new Error("project-hooks.jsonc must be an object")
  const backendsRaw = (raw as { backends?: unknown }).backends
  if (!isPlainObject(backendsRaw)) throw new Error("project-hooks.jsonc must have a 'backends' object")

  const backends: Record<string, BackendEntry> = {}
  for (const [name, entry] of Object.entries(backendsRaw)) {
    backends[name] = validateBackendEntry(entry, name)
  }
  return { backends }
}

/** Resolve the registry file next to this module. */
export function resolveProjectHooksPath(): string | null {
  const p = join(dirname(fileURLToPath(import.meta.url)), PROJECT_HOOKS_NAME)
  return existsSync(p) ? p : null
}

/**
 * Read and validate `project-hooks.jsonc`.
 * Returns null when the file is missing; throws when it is malformed.
 */
export function loadProjectHooks(path?: string): ProjectHooks | null {
  const target = path ?? resolveProjectHooksPath()
  if (!target) return null
  const text = readFileSync(target, "utf-8")
  const json = stripLineComments(text)
  const parsed = JSON.parse(json)
  return validateProjectHooks(parsed)
}
