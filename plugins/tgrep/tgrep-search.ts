import { spawnSync } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import type { TgrepOptions } from "./tgrep-config"
import type { TgrepReadiness } from "./tgrep-service"

export interface TgrepSearchInput { pattern: string; path?: string; glob?: string[]; ignoreCase?: boolean; literal?: boolean; noIndex?: boolean; mode?: "locations" | "content" }
export type TgrepSearchStatus = "matches" | "no-matches" | "error"
export interface TgrepSearchResult { backend: "tgrep" | "fallback"; code: number; status: TgrepSearchStatus; stdout: string; stderr: string }
/** Sync spawns block the plugin host event loop, so every search is bounded;
 * a pathological pattern must never wedge the session. */
const SEARCH_TIMEOUT_MS = 60_000
const MAX_SEARCH_OUTPUT_BYTES = 8 * 1024 * 1024

/** Coerce a possibly-mis-shaped glob payload to a string array. */
function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string")
  if (typeof value === "string") return value.trim() ? [value] : []
  return []
}

export function resolveSearchPath(root: string, path = "."): string {
  // Relative paths resolve against `root` (OpenCode's project directory),
  // matching the platform contract: bash workdir, the glob tool default and
  // the system prompt's "Working directory" all mean the project dir. The
  // host process's launch cwd is arbitrary from the agent's perspective
  // (e.g. %USERPROFILE% when started from a shortcut) — anchoring there made
  // `.` search the wrong tree whenever opencode wasn't launched from the
  // project root. Absolute paths pass through untouched.
  const resolved = isAbsolute(path) ? path : resolve(root, path)
  return existsSync(resolved) ? realpathSync(resolved) : resolved
}

export function buildTgrepSearchArgs(root: string, input: TgrepSearchInput, options?: TgrepOptions): string[] {
  if (!input.pattern) throw new Error("search pattern must not be empty")
  // Globs are value-taking flags: they must travel as explicit "-g <value>"
  // pairs, never as a bare flag that would swallow the next argv.
  const globs = toStringArray(input.glob)
  if (globs.some((glob) => typeof glob !== "string" || !glob.trim() || glob.startsWith("-"))) {
    throw new Error("glob filters must be non-empty and must not start with '-'")
  }
  const target = resolveSearchPath(root, input.path)
  return [
    ...(input.noIndex ? ["--no-index"] : []),
    ...(input.ignoreCase ? ["--ignore-case"] : []),
    ...(input.literal ? ["--fixed-strings"] : []),
    ...globs.flatMap((glob) => ["-g", glob]),
    ...(options?.indexPath ? ["--index-path", options.indexPath] : []),
    ...(options?.maxFileSize ? ["--max-filesize", options.maxFileSize] : []),
    ...(options?.noRequireGit ? ["--no-require-git"] : []),
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

function runSearch(binary: "tgrep" | "rg", root: string, input: TgrepSearchInput, options: TgrepOptions | undefined, extraArgs: string[] = []): TgrepSearchResult {
  // rg is the full-scan fallback, but does not share tgrep's corpus-policy
  // switches. Passing them through would turn a recoverable tgrep failure into
  // an invalid fallback command.
  const args = buildTgrepSearchArgs(root, { ...input, noIndex: binary === "rg" ? false : input.noIndex }, binary === "tgrep" ? options : undefined)
  const separator = args.indexOf("--")
  args.splice(separator, 0, ...extraArgs)
  return resultFrom(binary === "tgrep" ? "tgrep" : "fallback", spawnSync(binary, args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: SEARCH_TIMEOUT_MS, maxBuffer: MAX_SEARCH_OUTPUT_BYTES }))
}

function fallbackRg(root: string, input: TgrepSearchInput, extraArgs: string[] = []): TgrepSearchResult {
  // rg understands every remaining argument, "--" included, so the argv
  // stream is forwarded verbatim and dash-leading patterns stay protected.
  return runSearch("rg", root, input, undefined, extraArgs)
}

export function searchTgrep(root: string, input: TgrepSearchInput, readiness: TgrepReadiness, options?: TgrepOptions, extraArgs: string[] = []): TgrepSearchResult {
  // Trust-the-index path needs the live watcher; anything else (disk-index
  // or no-index) skips the server check entirely.
  if (!input.noIndex && readiness !== "server") {
    return fallbackRg(root, input, extraArgs)
  }
  const mapped = runSearch("tgrep", root, input, options, extraArgs)
  // Any tgrep failure degrades to the established full-scan backend: current
  // mode exists for correctness, and a server dying between probe and search
  // must not surface as an error either.
  return mapped.status === "error" ? fallbackRg(root, input, extraArgs) : mapped
}

export interface TgrepSearchSummary { backend: TgrepSearchResult["backend"]; counts: string[]; matchedFiles: number; matchedLines: number; complete: true }

export function summarizeTgrepSearch(root: string, input: TgrepSearchInput, readiness: TgrepReadiness, options?: TgrepOptions): TgrepSearchSummary {
  const result = searchTgrep(root, input, readiness, options, ["-c", "--with-filename"])
  if (result.status === "error") throw new Error(result.stderr || "tgrep count failed")
  const counts = result.stdout.split(/\r?\n/).filter(Boolean)
  const matchedLines = counts.reduce((total, line) => total + Number(line.slice(line.lastIndexOf(":") + 1)), 0)
  return { backend: result.backend, counts, matchedFiles: counts.length, matchedLines, complete: true }
}
