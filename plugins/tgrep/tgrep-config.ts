import { relative, resolve, sep } from "node:path"

export interface TgrepOptions {
  enabled: boolean
  indexPath?: string
  maxFileSize?: string
  exclude?: string[]
  noRequireGit?: boolean
}

/** Read the external (not MCP) tgrep setting from options JSONC text. */
export function tgrepEnabledFrom(text: string): boolean {
  try {
    const json = text.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n")
    const value = (JSON.parse(json) as { tools?: { tgrep?: unknown } }).tools?.tgrep
    return value === true || (typeof value === "object" && value !== null && (value as { enabled?: unknown }).enabled === true)
  } catch {
    return false
  }
}

export function tgrepOptionsFrom(root: string, text: string): TgrepOptions {
  try {
    const json = text.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n")
    return parseTgrepOptions(root, (JSON.parse(json) as { tools?: { tgrep?: unknown } }).tools?.tgrep)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("tools.tgrep")) throw error
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
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || /^[A-Za-z]:/.test(rel)) throw new Error("tools.tgrep.indexPath must stay inside the project root")
    result.indexPath = raw.indexPath
  }
  if (raw.maxFileSize !== undefined) {
    if (typeof raw.maxFileSize !== "string" || !/^\d+(?:[KMG]i?B?)?$/i.test(raw.maxFileSize)) throw new Error("tools.tgrep.maxFileSize must be a positive size such as 64MiB")
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
  if (options.maxFileSize) args.push("--max-file-size", options.maxFileSize)
  for (const excluded of options.exclude ?? []) args.push("--exclude", excluded)
  if (options.noRequireGit) args.push("--no-require-git")
  return args
}
