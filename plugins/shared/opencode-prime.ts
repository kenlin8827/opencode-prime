/**
 * Shared project-level opencode.jsonc field IO.
 *
 * Several plugins (adr-guard, env-guard, auto-advisor) store a per-project
 * switch as a top-level field of the project's opencode.jsonc. They all need
 * the same plumbing: resolving the project directory, locating the project
 * config file, parsing JSONC, and upserting/removing a single field without
 * touching comments or any other field. This module is that single source of
 * truth so the logic lives once and stays consistent across plugins.
 *
 * Design rules:
 *   - Project-level only: never reads or writes the global config.
 *   - Never throw from the write path: a read-only project dir degrades to a
 *     `false` return instead of crashing a plugin hook.
 *   - Targeted field editing on the raw text (never a full reserialize), so
 *     comments and unrelated fields survive a write.
 *
 * The project directory is injected by each plugin entry via setProjectDir()
 * (PluginInput.directory); until then it falls back to process.cwd().
 *
 * This file lives in a subdirectory of plugins/ on purpose: OpenCode only
 * treats root-level plugins/*.ts files as plugin entries, so this shared
 * module is never auto-loaded as a plugin — it is imported by the plugins.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// ─── Project directory ───────────────────────────────────────────────
// Injected by the plugin entry from PluginInput.directory.

let projectDir = process.cwd()

export function setProjectDir(dir: string): void {
  if (typeof dir === "string" && dir.trim() !== "") projectDir = dir
}

export function getProjectDir(): string {
  return projectDir
}

// ─── Config file discovery ───────────────────────────────────────────

/**
 * Candidate project config files, scanned in precedence order. The
 * `.opencode/` copies win: opencode itself merges them after the root files
 * (later merge = higher precedence), and `/project init` scaffolds the config
 * at `.opencode/opencode.jsonc`, so that is this repo's canonical location.
 */
export function projectConfigFiles(): string[] {
  return [
    join(projectDir, ".opencode", "opencode.jsonc"),
    join(projectDir, "opencode.jsonc"),
  ]
}

/**
 * The file a field write should target: the first existing project config
 * file, or <project>/.opencode/opencode.jsonc when none exists yet — the
 * same location `/project init` scaffolds.
 */
export function writableProjectConfigFile(): string {
  for (const path of projectConfigFiles()) {
    if (existsSync(path)) return path
  }
  return join(projectDir, ".opencode", "opencode.jsonc")
}

// ─── JSONC parsing ───────────────────────────────────────────────────

/**
 * Strip JSONC comments and trailing commas so we can JSON.parse a .jsonc file.
 * Two quote-aware passes:
 *   1. stripComments — removes line/block comments while respecting string
 *      literals (a `//` inside a quoted value is kept).
 *   2. stripTrailingCommas — drops a `,` only when the next non-whitespace
 *      char is `}` or `]`, skipping string literals so values like `"x,}"`
 *      survive untouched (a naive global replace would silently corrupt them).
 */
export function stripJsonc(raw: string): string {
  return stripTrailingCommas(stripComments(raw))
}

function stripComments(raw: string): string {
  let result = ""
  let i = 0
  const len = raw.length
  let state: "normal" | "string" | "lineComment" | "blockComment" = "normal"
  while (i < len) {
    const c = raw[i]
    const next = i + 1 < len ? raw[i + 1] : ""
    switch (state) {
      case "normal":
        if (c === '"') { result += c; state = "string" }
        else if (c === "/" && next === "/") { state = "lineComment"; i++ }
        else if (c === "/" && next === "*") { state = "blockComment"; i++ }
        else { result += c }
        break
      case "string":
        result += c
        if (c === "\\") { i++; if (i < len) result += raw[i] }
        else if (c === '"') { state = "normal" }
        break
      case "lineComment":
        if (c === "\n") { result += c; state = "normal" }
        break
      case "blockComment":
        if (c === "*" && next === "/") { state = "normal"; i++ }
        break
    }
    i++
  }
  return result
}

function stripTrailingCommas(src: string): string {
  let result = ""
  let inString = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inString) {
      result += c
      if (c === "\\") { if (i + 1 < src.length) result += src[++i] }
      else if (c === '"') { inString = false }
      continue
    }
    if (c === '"') { inString = true; result += c; continue }
    if (c === ",") {
      // Trailing when only whitespace separates it from the closing brace.
      let j = i + 1
      while (j < src.length && /\s/.test(src[j])) j++
      if (j < src.length && (src[j] === "}" || src[j] === "]")) continue
    }
    result += c
  }
  return result
}

/** First parseable project config as a plain object, or null. */
export function readProjectConfig(): Record<string, unknown> | null {
  for (const path of projectConfigFiles()) {
    if (!existsSync(path)) continue
    try {
      return JSON.parse(stripJsonc(readFileSync(path, "utf-8")))
    } catch {
      // unreadable or unparseable — try next source
    }
  }
  return null
}

// ─── Field manipulation (pure, on raw text) ─────────────────────────
// Targeted upsert/remove: comments and every other field stay untouched
// (never a full reserialize).

function fieldRe(field: string): RegExp {
  return new RegExp(`"${field}"(\\s*:\\s*)"[^"]*"`)
}

/**
 * True when `index` sits after a `//` line-comment marker on its own line.
 * Scans string-aware from the line start, so a `//` inside a quoted value
 * does not count.
 */
function isInsideLineComment(raw: string, index: number): boolean {
  const lineStart = raw.lastIndexOf("\n", index - 1) + 1
  let inString = false
  for (let i = lineStart; i < index; i++) {
    const c = raw[i]
    if (inString) {
      if (c === "\\") i++
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; continue }
    if (c === "/" && raw[i + 1] === "/") return true
  }
  return false
}

/**
 * Upsert `"field": "value"` into a config's raw text, in precedence order:
 *   1. an active (non-commented) occurrence — replace its value in place;
 *   2. a commented-out template line (`// "field": "..."`) — uncomment that
 *      line in place and set the value, keeping the trailing explanation
 *      comment (templates ship switches commented; this avoids a duplicate
 *      active field next to the still-commented template line);
 *   3. otherwise insert right after the root `{` (a trailing comma is valid
 *      JSONC and avoids double-comma collisions).
 */
export function upsertConfigField(raw: string, field: string, value: string): string {
  if (raw.trim() === "") return `{\n  "${field}": "${value}"\n}\n`
  const gre = new RegExp(`"${field}"\\s*:\\s*"[^"]*"`, "g")
  let commented: RegExpExecArray | null = null
  let m: RegExpExecArray | null
  while ((m = gre.exec(raw)) !== null) {
    if (!isInsideLineComment(raw, m.index)) {
      return raw.slice(0, m.index) + `"${field}": "${value}"` + raw.slice(m.index + m[0].length)
    }
    if (!commented) commented = m
  }
  if (commented) {
    const lineStart = raw.lastIndexOf("\n", commented.index - 1) + 1
    let lineEnd = raw.indexOf("\n", commented.index)
    if (lineEnd === -1) lineEnd = raw.length
    const fixed = raw.slice(lineStart, lineEnd)
      .replace(/^(\s*)\/\/\s*/, "$1")
      .replace(fieldRe(field), `"${field}": "${value}"`)
    return raw.slice(0, lineStart) + fixed + raw.slice(lineEnd)
  }
  const idx = raw.indexOf("{")
  if (idx === -1) throw new Error("no root object in config file")
  return raw.slice(0, idx + 1) + `\n  "${field}": "${value}",` + raw.slice(idx + 1)
}

/**
 * Deactivate an active `"field": "..."` by re-commenting its line — the
 * mirror of the uncomment-on-upsert above, so reset puts the switch back to
 * the template shape (`// "field": "..."` with its trailing explanation
 * kept) instead of dropping the documentation line. Lines that are already
 * commented are left untouched. No-op when no active occurrence exists.
 */
export function removeConfigField(raw: string, field: string): string {
  const gre = new RegExp(`"${field}"\\s*:\\s*"[^"]*"`, "g")
  let m: RegExpExecArray | null
  while ((m = gre.exec(raw)) !== null) {
    if (isInsideLineComment(raw, m.index)) continue
    const lineStart = raw.lastIndexOf("\n", m.index - 1) + 1
    let lineEnd = raw.indexOf("\n", m.index)
    if (lineEnd === -1) lineEnd = raw.length
    const line = raw.slice(lineStart, lineEnd)
    const fixed = line
      .replace(/,([ \t]*)(\/\/)/, "$1$2") // drop the comma before a trailing comment
      .replace(/,[ \t]*$/, "")            // ...or a dangling trailing comma
      .replace(/^(\s*)/, "$1// ")
    return raw.slice(0, lineStart) + fixed + raw.slice(lineEnd)
  }
  return raw
}

// ─── Never-throw field write/remove ─────────────────────────────────
// Project-scoped writes that degrade to a false return instead of throwing,
// so plugin hooks never crash the session on a read-only project dir.

// When a project has no OpenCode Prime yet, bootstrap from the /project
// init template (commented, uncomment-ready switch documentation) instead of
// a bare `{ "field": "value" }` stub. Cached; null when the template is not
// deployed next to the plugins (falls back to the bare bootstrap).
let projectTemplateCache: string | null | undefined

function readProjectTemplate(): string | null {
  if (projectTemplateCache !== undefined) return projectTemplateCache
  try {
    const tpl = fileURLToPath(
      new URL("../project-manager/templates/opencode.jsonc", import.meta.url),
    )
    projectTemplateCache = readFileSync(tpl, "utf-8")
  } catch {
    projectTemplateCache = null
  }
  return projectTemplateCache
}

/**
 * Write `"field": "value"` into the project-level config. Returns the
 * failure reason on error (string) — `null` on success, never throws.
 * Plugin hooks log the reason to `client.app.log({ level: "warn" })` so
 * users see a real diagnosis (read-only fs vs parse error vs permission
 * denied) instead of an opaque "couldn't set switch". Backward compat:
 * the previous boolean contract is preserved via `SetConfigOk`/`SetConfigFail`.
 */
export type SetConfigResult =
  | { ok: true }
  | { ok: false; reason: "read-only-fs" | "permission-denied" | "parse-error" | "no-target" | "unknown"; detail: string }

export function setConfigField(field: string, value: string): SetConfigResult {
  let file: string
  try {
    file = writableProjectConfigFile()
  } catch (err) {
    return { ok: false, reason: "no-target", detail: errMsg(err) }
  }
  let raw: string
  try {
    raw = existsSync(file) ? readFileSync(file, "utf-8") : (readProjectTemplate() ?? "")
  } catch (err) {
    return { ok: false, reason: "read-only-fs", detail: errMsg(err) }
  }
  let updated: string
  try {
    updated = upsertConfigField(raw, field, value)
  } catch (err) {
    return { ok: false, reason: "parse-error", detail: errMsg(err) }
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, updated, "utf-8")
    return { ok: true }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    return {
      ok: false,
      reason: code === "EACCES" || code === "EPERM" ? "permission-denied" : "unknown",
      detail: errMsg(err),
    }
  }
}

/**
 * Remove `field` from the project-level config so the switch reverts to its
 * default. Returns the same result envelope as `setConfigField`. Missing
 * file is success (nothing to do).
 */
export function clearConfigField(field: string): SetConfigResult {
  let file: string
  try {
    file = writableProjectConfigFile()
    if (!existsSync(file)) return { ok: true }
  } catch (err) {
    return { ok: false, reason: "no-target", detail: errMsg(err) }
  }
  let updated: string
  try {
    updated = removeConfigField(readFileSync(file, "utf-8"), field)
    writeFileSync(file, updated, "utf-8")
    return { ok: true }
  } catch (err) {
    const code = (err as ErrnoException)?.code
    return {
      ok: false,
      reason: code === "EACCES" || code === "EPERM" ? "permission-denied" : "unknown",
      detail: errMsg(err),
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Internal alias so the existing `plugin-switch.ts` boolean contract keeps
// compiling; plugin-switch can opt into the rich result in a follow-up.
type ErrnoException = NodeJS.ErrnoException

// ─── Project Log & Gitignore Utilities ────────────────────────────────

/**
 * Automatically ensures `<project>/.opencode/.gitignore` exists to ignore logs, handoffs, and runtime artifacts.
 * If `.gitignore` already exists, ensures `logs/`, `*.log`, `handoffs/`, and `memory/private.md` are present.
 */
export function ensureOpencodeGitignore(root: string = getProjectDir()): void {
  const opencodeDir = join(root, ".opencode")
  try {
    if (!existsSync(opencodeDir)) {
      mkdirSync(opencodeDir, { recursive: true })
    }
    const gitignorePath = join(opencodeDir, ".gitignore")
    const defaultIgnore = "node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore\nlogs/\n*.log\nhandoffs/\nmemory/private.md\n"
    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, defaultIgnore, "utf-8")
    } else {
      const content = readFileSync(gitignorePath, "utf-8")
      let needsUpdate = false
      let nextContent = content
      if (!content.includes("logs")) {
        nextContent = nextContent.trimEnd() + "\nlogs/\n*.log\n"
        needsUpdate = true
      }
      if (!content.includes("handoffs")) {
        nextContent = nextContent.trimEnd() + "\nhandoffs/\n"
        needsUpdate = true
      }
      if (!content.includes("memory/private.md")) {
        nextContent = nextContent.trimEnd() + "\nmemory/private.md\n"
        needsUpdate = true
      }
      if (needsUpdate) {
        writeFileSync(gitignorePath, nextContent, "utf-8")
      }
    }
  } catch { }
}

/**
 * Resolves `<project>/.opencode/logs` directory, creating it and ensuring
 * `.opencode/.gitignore` is configured automatically.
 */
export function getProjectLogDir(root: string = getProjectDir()): string {
  const dir = join(root, ".opencode", "logs")
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    ensureOpencodeGitignore(root)
  } catch { }
  return dir
}

/**
 * Resolves `<project>/.opencode/handoffs` directory, creating it and ensuring
 * `.opencode/.gitignore` is configured automatically.
 */
export function getProjectHandoffDir(root: string = getProjectDir()): string {
  const dir = join(root, ".opencode", "handoffs")
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    ensureOpencodeGitignore(root)
  } catch { }
  return dir
}


