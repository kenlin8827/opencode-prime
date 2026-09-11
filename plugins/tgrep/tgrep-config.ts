import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

export interface TgrepOptions {
  enabled: boolean
  indexPath?: string
  maxFileSize?: string
  exclude?: string[]
  noRequireGit?: boolean
}

/** Strip // and block comments plus trailing commas from JSONC text in one
 * string-aware pass, so comment-like content inside strings ("http://x")
 * survives and tokens never merge across a removed block comment. */
export function stripJsonc(text: string): string {
  let out = ""
  let index = 0
  let inString = false
  while (index < text.length) {
    const char = text[index]
    if (inString) {
      out += char
      if (char === "\\") { out += text[index + 1] ?? ""; index += 2; continue }
      if (char === '"') inString = false
      index += 1
      continue
    }
    if (char === '"') { inString = true; out += char; index += 1; continue }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1
      continue // the newline itself is kept by the next iteration
    }
    if (char === "/" && text[index + 1] === "*") {
      index += 2
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1
      index += 2
      out += " " // keep tokens separated even inside an unterminated file
      continue
    }
    if (char === ",") {
      let probe = index + 1
      while (probe < text.length && /\s/.test(text[probe])) probe += 1
      if (text[probe] === "}" || text[probe] === "]") { index += 1; continue }
    }
    out += char
    index += 1
  }
  return out
}

function toolsTgrepValue(text: string): unknown {
  return (JSON.parse(stripJsonc(text)) as { tools?: { tgrep?: unknown } }).tools?.tgrep
}

export function tgrepOptionsFrom(root: string, text: string): TgrepOptions {
  try {
    return parseTgrepOptions(root, toolsTgrepValue(text))
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("tools.tgrep")) throw error
    return { enabled: false }
  }
}

/** Read tools.tgrep from the user's options.jsonc; any failure (missing file,
 * unparseable text, invalid values) safely disables the integration. Shared
 * by the tgrep tool, the project profiler, and the project-manager probes. */
export function loadTgrepOptions(root: string): TgrepOptions {
  try {
    return tgrepOptionsFrom(root, readFileSync(join(homedir(), ".config", "opencode", "options.jsonc"), "utf8"))
  } catch {
    return { enabled: false }
  }
}

/** Validate settings without allowing index files outside the workspace. */
export function parseTgrepOptions(root: string, value: unknown): TgrepOptions {
  if (value === undefined || value === false) return { enabled: false }
  if (value === true) return { enabled: true }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("tools.tgrep must be a boolean or object")
  const raw = value as Record<string, unknown>
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") throw new Error("tools.tgrep.enabled must be a boolean")
  const enabled = raw.enabled === true
  const result: TgrepOptions = { enabled }
  if (raw.indexPath !== undefined) {
    if (typeof raw.indexPath !== "string" || !raw.indexPath.trim()) throw new Error("tools.tgrep.indexPath must be a non-empty relative path")
    const absolute = resolve(root, raw.indexPath)
    const rel = relative(resolve(root), absolute)
    // isAbsolute also rejects Windows UNC (\\server\share) and \\?\ targets
    // that a drive-letter regex alone would let through.
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("tools.tgrep.indexPath must stay inside the project root")
    result.indexPath = raw.indexPath
  }
  if (raw.maxFileSize !== undefined) {
    // tgrep accepts digits with an optional single K/M/G suffix (case-insensitive);
    // "64MiB"/"64MB" are rejected by the real CLI (verified against tgrep 1.0.5).
    if (typeof raw.maxFileSize !== "string" || !/^\d+[KMG]?$/i.test(raw.maxFileSize)) throw new Error("tools.tgrep.maxFileSize must be a positive size such as 64M")
    result.maxFileSize = raw.maxFileSize
  }
  if (raw.exclude !== undefined) {
    if (!Array.isArray(raw.exclude) || raw.exclude.some((item) => typeof item !== "string" || !item.trim())) throw new Error("tools.tgrep.exclude must contain non-empty paths")
    if ((raw.exclude as string[]).some((item) => item === ".." || item.startsWith(`..${sep}`) || /^[\\/]/.test(item))) throw new Error("tools.tgrep.exclude must stay inside the project root")
    result.exclude = raw.exclude as string[]
  }
  if (raw.noRequireGit !== undefined) {
    if (typeof raw.noRequireGit !== "boolean") throw new Error("tools.tgrep.noRequireGit must be a boolean")
    result.noRequireGit = raw.noRequireGit
  }
  return result
}

export function tgrepIndexArgs(options: TgrepOptions): string[] {
  const args: string[] = []
  if (options.indexPath) args.push("--index-path", options.indexPath)
  if (options.maxFileSize) args.push("--max-filesize", options.maxFileSize)
  for (const excluded of options.exclude ?? []) args.push("--exclude", excluded)
  if (options.noRequireGit) args.push("--no-require-git")
  return args
}
