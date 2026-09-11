import { spawnSync } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import type { TgrepReadiness } from "./tgrep-service"

export interface TgrepSearchInput { pattern: string; path?: string; glob?: string[]; flags?: string[]; freshness?: "indexed" | "current" }
export type TgrepSearchStatus = "matches" | "no-matches" | "error"
export interface TgrepSearchResult { backend: "tgrep" | "fallback"; code: number; status: TgrepSearchStatus; stdout: string; stderr: string }
const ALLOWED_FLAGS = new Set(["-i", "--ignore-case", "-F", "--fixed-strings"])
/** Sync spawns block the plugin host event loop, so every search is bounded;
 * a pathological pattern must never wedge the session. */
const SEARCH_TIMEOUT_MS = 60_000

/** Coerce a possibly-mis-shaped flags/glob payload to a string array.
 * The schema declares `array(string)` but some callers (LLM tool-call
 * middleboxes seen in the wild) occasionally send a bare string or a
 * non-array value — we normalize here so `buildTgrepSearchArgs` never
 * dereferences `.some` on a non-array. Unknown or empty values drop
 * silently rather than throwing — the caller is the LLM, which retries
 * with the correct shape; an opaque error buys nothing. */
function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string")
  if (typeof value === "string") return value.trim() ? [value] : []
  return []
}

export function resolveSearchPath(root: string, path = "."): string {
  const base = realpathSync(root)
  const unresolved = resolve(base, path)
  const target = existsSync(unresolved) ? realpathSync(unresolved) : unresolved
  const rel = relative(base, target)
  // isAbsolute also rejects Windows UNC (\\server\share) and \\?\ targets
  // that a drive-letter regex alone would let through.
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("search path escapes workspace root")
  return target
}

export function buildTgrepSearchArgs(root: string, input: TgrepSearchInput): string[] {
  if (!input.pattern) throw new Error("search pattern must not be empty")
  const flags = toStringArray(input.flags)
  if (flags.some((flag) => !ALLOWED_FLAGS.has(flag))) throw new Error("unsupported tgrep search flag; use current/full scan fallback")
  // Globs are value-taking flags: they must travel as explicit "-g <value>"
  // pairs, never as a bare flag that would swallow the next argv.
  const globs = toStringArray(input.glob)
  if (globs.some((glob) => typeof glob !== "string" || !glob.trim() || glob.startsWith("-"))) {
    throw new Error("glob filters must be non-empty and must not start with '-'")
  }
  const target = resolveSearchPath(root, input.path)
  return [
    ...(input.freshness === "current" ? ["--no-index"] : []),
    ...flags,
    ...globs.flatMap((glob) => ["-g", glob]),
    "--",
    input.pattern,
    target,
  ]
}

function resultFrom(backend: "tgrep" | "fallback", result: ReturnType<typeof spawnSync>): TgrepSearchResult {
  const code = result.status ?? 2
  // spawnSync's return type unions string and Buffer across overloads; the
  // encoding:"utf8" calls always produce strings, but guard anyway.
  const stdout = typeof result.stdout === "string" ? result.stdout : ""
  const stderr = typeof result.stderr === "string" ? result.stderr : ""
  return {
    backend, code, status: code === 0 ? "matches" : code === 1 ? "no-matches" : "error",
    stdout, stderr: `${stderr}${result.error ? String(result.error) : ""}`,
  }
}

function fallbackRg(root: string, input: TgrepSearchInput): TgrepSearchResult {
  // rg understands every remaining argument, "--" included, so the argv
  // stream is forwarded verbatim and dash-leading patterns stay protected.
  const args = buildTgrepSearchArgs(root, { ...input, freshness: "indexed" })
  return resultFrom("fallback", spawnSync("rg", args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: SEARCH_TIMEOUT_MS }))
}

export function searchTgrep(root: string, input: TgrepSearchInput, readiness: TgrepReadiness): TgrepSearchResult {
  const indexed = (input.freshness ?? "indexed") === "indexed"
  if (indexed && readiness !== "server") {
    return fallbackRg(root, input)
  }
  const mapped = resultFrom("tgrep", spawnSync("tgrep", buildTgrepSearchArgs(root, input), { cwd: root, encoding: "utf8", windowsHide: true, timeout: SEARCH_TIMEOUT_MS }))
  // Any tgrep failure degrades to the established full-scan backend: current
  // mode exists for correctness, and a server dying between probe and search
  // must not surface as an error either.
  return mapped.status === "error" ? fallbackRg(root, input) : mapped
}
