import { spawnSync } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { relative, resolve, sep } from "node:path"
import type { TgrepReadiness } from "./tgrep-service"

export interface TgrepSearchInput { pattern: string; path?: string; flags?: string[]; freshness?: "indexed" | "current" }
export type TgrepSearchStatus = "matches" | "no-matches" | "error"
export interface TgrepSearchResult { backend: "tgrep" | "fallback"; code: number; status: TgrepSearchStatus; stdout: string; stderr: string }
const ALLOWED_FLAGS = new Set(["-i", "--ignore-case", "-F", "--fixed-strings", "-g", "--glob"])

export function resolveSearchPath(root: string, path = "."): string {
  const base = realpathSync(root)
  const unresolved = resolve(base, path)
  const target = existsSync(unresolved) ? realpathSync(unresolved) : unresolved
  const rel = relative(base, target)
  if (rel === ".." || rel.startsWith(`..${sep}`) || /^[A-Za-z]:/.test(rel)) throw new Error("search path escapes workspace root")
  return target
}

export function buildTgrepSearchArgs(root: string, input: TgrepSearchInput): string[] {
  if (!input.pattern) throw new Error("search pattern must not be empty")
  const flags = input.flags ?? []
  if (flags.some((flag) => !ALLOWED_FLAGS.has(flag))) throw new Error("unsupported tgrep search flag; use current/full scan fallback")
  const target = resolveSearchPath(root, input.path)
  return [...(input.freshness === "current" ? ["--no-index"] : []), ...flags, "--", input.pattern, target]
}

function resultFrom(backend: "tgrep" | "fallback", result: ReturnType<typeof spawnSync>): TgrepSearchResult {
  const code = result.status ?? 2
  return {
    backend, code, status: code === 0 ? "matches" : code === 1 ? "no-matches" : "error",
    stdout: result.stdout ?? "", stderr: `${result.stderr ?? ""}${result.error ? String(result.error) : ""}`,
  }
}

function fallbackRg(root: string, input: TgrepSearchInput): TgrepSearchResult {
  const args = buildTgrepSearchArgs(root, { ...input, freshness: "indexed" })
  const separator = args.indexOf("--")
  return resultFrom("fallback", spawnSync("rg", separator < 0 ? args : [...args.slice(0, separator), ...args.slice(separator + 1)], { cwd: root, encoding: "utf8", windowsHide: true }))
}

export function searchTgrep(root: string, input: TgrepSearchInput, readiness: TgrepReadiness): TgrepSearchResult {
  const indexed = (input.freshness ?? "indexed") === "indexed"
  if (indexed && readiness !== "server") {
    return fallbackRg(root, input)
  }
  const result = spawnSync("tgrep", buildTgrepSearchArgs(root, input), { cwd: root, encoding: "utf8", windowsHide: true })
  const mapped = resultFrom("tgrep", result)
  // current means correctness over acceleration: if the external CLI itself
  // cannot run, use the established full-scan backend instead.
  return input.freshness === "current" && mapped.status === "error" ? fallbackRg(root, input) : mapped
}
