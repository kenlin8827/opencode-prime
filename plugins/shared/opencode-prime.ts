/**
 * Shared OCP path contract + project-level ocp.json field IO.
 *
 * Several plugins (adr-guard, env-guard, auto-advisor) store a per-project
 * switch as a top-level field of the project's OCP config. They all need
 * the same plumbing: resolving the project directory, locating the config
 * file, parsing JSONC, and upserting/removing a single field without
 * touching comments or any other field. This module is the single source
 * of truth for both the path contract (ADR 0004 v2: `.ocp/` is OCP-owned,
 * `.opencode/` is platform-owned) and the field surgery.
 *
 * Design rules (ADR 0004 v2 — NO runtime compatibility):
 *   - One path per artifact: reads and writes resolve from exactly
 *     `<ocpDir()>/ocp.json` (and `<ocpDir()>/<rel>` for artifacts) — the
 *     `ocpDir()` choke honors the `OCP_PROJECT_DIR` env override. No
 *     fallback chains, no merge precedence, no dual-era reads.
 *   - Legacy `.opencode/` state is moved once by
 *     `migrateLegacyProjectArtifacts()` — run at project init (the
 *     `/project init` scaffold paths, the TUI wizard save path, and
 *     `/project sync` on demand). That function is the ONLY place runtime
 *     code may reference legacy paths.
 *   - Never throw from the write path: a read-only project dir degrades to
 *     a `false` return instead of crashing a plugin hook; migration
 *     degrades to warning lines.
 *   - Targeted field editing on the raw text (never a full reserialize), so
 *     comments and unrelated fields survive a write.
 *
 * The project directory is injected by each plugin entry via setProjectDir()
 * (PluginInput.directory); until then it falls back to process.cwd().
 *
 * This file lives in a subdirectory of plugins/ on purpose: OpenCode only
 * treats root-level plugins/*.ts files as plugin entries, so this shared
 * module is never auto-loaded as a plugin — it is imported by the plugins.
 * The only other place these paths are spelled out is the plain-js mirror in
 * `scripts/serena-workspace-daemon.mjs`, a standalone shipped script that
 * cannot import the plugin tree.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"

// ─── Project directory ───────────────────────────────────────────────
// Injected by the plugin entry from PluginInput.directory.

let projectDir = process.cwd()

export function setProjectDir(dir: string): void {
  if (typeof dir === "string" && dir.trim() !== "") projectDir = dir
}

export function getProjectDir(): string {
  return projectDir
}

// ─── OCP path contract (ADR 0004 v2) ─────────────────────────────────

/** OCP-owned project artifact directory. The platform's `.opencode/` stays
 *  platform-only; every OCP read and write resolves under `.ocp/` — or the
 *  `OCP_PROJECT_DIR` override (see `ocpDir`; the §3 migration target stays
 *  the fixed `.opencode` — a platform name, never env-overridable). */
export const OCP_DIR = ".ocp"
/** Project OCP config, relative to the project root (POSIX separators) —
 *  the DEFAULT location's display rel-path; the live location may move via
 *  `OCP_PROJECT_DIR`, so build filesystem paths with `ocpConfigFile()`. */
export const OCP_CONFIG_REL = ".ocp/ocp.json"
/** Legacy project dir — referenced ONLY by `migrateLegacyProjectArtifacts`
 *  (the one-shot move) below. No runtime read or write may use it. */
const LEGACY_DIR = ".opencode"

/**
 * The single choke point for every project OCP directory: all config,
 * artifact, log, handoff, and gitignore paths resolve through here.
 *
 * `OCP_PROJECT_DIR` env override — PROJECT-RELATIVE ONLY (ADR §2 amended):
 * the override exists to dodge in-project directory collisions, not to
 * relocate state out-of-tree or escape it. unset/empty/whitespace →
 * `<root>/.ocp`; relative value → `<root>/<value>`; ABSOLUTE values
 * (`isAbsolute` covers POSIX `/x` and win32 `C:\x`/`C:/x`/`\\srv\share`)
 * and values containing `..` segments are INVALID — silently ignored,
 * falling back to the `.ocp` default (config-fallback convention: no
 * warning emitted). The legacy `.opencode` migration source is NOT
 * overridable by design.
 */
export function ocpDir(root: string = getProjectDir()): string {
  const env = process.env.OCP_PROJECT_DIR?.trim()
  // Absolute or `..`-traversing overrides are invalid-by-contract → treated
  // as unset (state must stay inside the project, under a fixed name or a
  // simple in-project rename).
  if (!env || isAbsolute(env) || env.split(/[\\/]/).includes("..")) return join(root, OCP_DIR)
  return join(root, env)
}

/** The project OCP config file: `<ocpDir>/ocp.json`. */
export function ocpConfigFile(root: string = getProjectDir()): string {
  return join(ocpDir(root), "ocp.json")
}

/**
 * WRITE path for an OCP project artifact: `<root>/.ocp/<rel>`. `rel` uses
 * POSIX separators (e.g. "memory", "logs", "md-to-pdf.css"). Reads stat
 * exactly this path — one path, no lookup chain (ADR §2).
 */
export function ocpArtifactPath(rel: string, root: string = getProjectDir()): string {
  return join(ocpDir(root), ...rel.split("/"))
}

/**
 * The file a field write targets: always `<project>/.ocp/ocp.json`.
 */
export function writableProjectConfigFile(): string {
  return ocpConfigFile()
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

/** Parse one config file as a plain object; null when unreadable/unparseable. */
function parseConfigFile(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(stripJsonc(readFileSync(path, "utf-8"))) as Record<string, unknown>
  } catch {
    // unreadable, unparseable, or a non-object root — no config.
    return null
  }
}

/**
 * Effective project config: parse `.ocp/ocp.json` — the ONLY runtime source
 * (ADR 0004 v2: no fallback chain, no merge). Null when absent or
 * unparseable (callers fall back to their defaults). `root` is injectable
 * for processes that do not set the module-level project dir (the TUI
 * sidebar reads the active directory per call).
 */
export function readProjectConfig(root: string = getProjectDir()): Record<string, unknown> | null {
  const file = ocpConfigFile(root)
  return existsSync(file) ? parseConfigFile(file) : null
}

// ─── Field manipulation (pure, on raw text) ─────────────────────────
// Targeted upsert/remove: comments and every other field stay untouched
// (never a full reserialize).

// One value pattern everywhere: `"(?:[^"\\]|\\.)*"` so a value containing
// escaped quotes (`"we\"ird"`) matches whole — a naive `"[^"]*"` would stop
// at the first inner quote and leave residue on re-upsert (N4).
function fieldValueRe(field: string, flags = "g"): RegExp {
  return new RegExp(`"${field}"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*"`, flags)
}

function fieldRe(field: string): RegExp {
  return new RegExp(`"${field}"(\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`)
}

/** JSON-escape an arbitrary value for embedding inside a quoted member. */
function jsonEscape(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

/**
 * String-aware scan of one line: index of the `//` line-comment marker
 * between `lineStart` and `upto` (inclusive), or -1. A `//` inside a quoted
 * value (e.g. `https://`) does not count — same scan semantics as the old
 * `isInsideLineComment`, which now delegates here.
 */
function lineCommentStart(src: string, lineStart: number, upto: number): number {
  let inString = false
  for (let i = lineStart; i <= upto; i++) {
    const c = src[i]
    if (inString) {
      if (c === "\\") i++
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; continue }
    if (c === "/" && src[i + 1] === "/") return i
  }
  return -1
}

/**
 * Index of the last character before the closing brace at `close` that is
 * neither whitespace nor line-comment text (stepping back over `//` comment
 * tails string-aware), or -1. Block comments stop the walk (conservative:
 * the caller only acts on an exact `,`/`,`/`{` hit).
 */
function prevSignificant(src: string, close: number): number {
  let j = close - 1
  for (;;) {
    while (j >= 0 && /\s/.test(src[j])) j--
    if (j < 0) return -1
    const lineStart = src.lastIndexOf("\n", j) + 1
    const slash = lineCommentStart(src, lineStart, j)
    if (slash !== -1) {
      j = slash - 1 // the line's tail is a comment — step before the marker
      continue
    }
    return j
  }
}

/** True when the char at `index` sits inside a string literal (quote parity). */
function inStringAt(src: string, index: number): boolean {
  let inString = false
  for (let i = 0; i < index; i++) {
    const c = src[i]
    if (inString) {
      if (c === "\\") i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
  }
  return inString
}

/** Drop a dangling member-comma sitting right before the closing brace. */
function dropCommaBeforeClose(src: string, close: number): string {
  const j = prevSignificant(src, close)
  if (j >= 0 && src[j] === "," && !inStringAt(src, j)) return src.slice(0, j) + src.slice(j + 1)
  return src
}

/**
 * Append a new member to the root object keeping the file STRICT JSON:
 * effectively-empty object → the member is the sole one (no comma);
 * otherwise insert before the closing brace, adding the separating comma
 * right after the previous last member (its trailing line comment stays
 * put) while the new last member carries NO trailing comma.
 */
function insertMember(raw: string, member: string): string {
  const open = raw.indexOf("{")
  const close = raw.lastIndexOf("}")
  if (open === -1 || close <= open) throw new Error("no root object in config file")
  if (stripComments(raw.slice(open + 1, close)).replace(/[,\s]/g, "") === "") {
    // Sole member lands AFTER the preserved inter-brace content (a user's
    // hand comment in an otherwise-empty object survives — N3). No trailing
    // comma: the member is last.
    const kept = raw.slice(open + 1, close).replace(/\s+$/, "")
    return raw.slice(0, open + 1) + kept + `\n  ${member}\n` + raw.slice(close)
  }
  const head = raw.slice(0, close)
  const prev = prevSignificant(head, head.length)
  // `{` guard: a `{` seen inside a leading comment can defeat the empty
  // check above — never emit a leading comma in that case.
  const withComma = prev >= 0 && head[prev] !== "," && head[prev] !== "{"
    ? head.slice(0, prev + 1) + "," + head.slice(prev + 1)
    : head
  return withComma.replace(/\s+$/, "") + `\n  ${member}\n` + raw.slice(close)
}

/**
 * True when `index` sits after a `//` line-comment marker on its own line.
 * String-aware via `lineCommentStart` — a `//` inside a quoted value does
 * not count.
 */
function isInsideLineComment(raw: string, index: number): boolean {
  const lineStart = raw.lastIndexOf("\n", index - 1) + 1
  return lineCommentStart(raw, lineStart, index - 1) !== -1
}

/**
 * Upsert `"field": "value"` into a config's raw text, in precedence order:
 *   1. an active (non-commented) occurrence — replace its value in place;
 *   2. a commented-out template line (`// "field": "..."`) — uncomment that
 *      line in place and set the value, keeping the trailing explanation
 *      comment (templates ship switches commented; this avoids a duplicate
 *      active field next to the still-commented template line);
 *   3. otherwise append into the root object via `insertMember` — the result
 *      stays STRICT-JSON-valid (no trailing comma on the new last member).
 * Interpolated values are JSON-escaped, so a value containing `"` or `\`
 * can never break out of the quoted context.
 */
export function upsertConfigField(raw: string, field: string, value: string): string {
  const member = `"${field}": "${jsonEscape(value)}"`
  if (raw.trim() === "") return `{\n  ${member}\n}\n`
  const gre = fieldValueRe(field)
  let commented: RegExpExecArray | null = null
  let m: RegExpExecArray | null
  while ((m = gre.exec(raw)) !== null) {
    if (!isInsideLineComment(raw, m.index)) {
      return raw.slice(0, m.index) + member + raw.slice(m.index + m[0].length)
    }
    if (!commented) commented = m
  }
  if (commented) {
    const lineStart = raw.lastIndexOf("\n", commented.index - 1) + 1
    let lineEnd = raw.indexOf("\n", commented.index)
    if (lineEnd === -1) lineEnd = raw.length
    const fixed = raw.slice(lineStart, lineEnd)
      .replace(/^(\s*)\/\/\s*/, "$1")
      .replace(fieldRe(field), () => member)
    return raw.slice(0, lineStart) + fixed + raw.slice(lineEnd)
  }
  return insertMember(raw, member)
}

/** How `removeConfigField` deactivates a key. `.ocp/ocp.json` and legacy
 * `.json` files must stay strict JSON → `"delete"` (line + comma repair);
 * legacy `.jsonc` keeps documentation → `"recomment"` (existing behavior). */
export type ConfigFieldRemoval = "recomment" | "delete"

/**
 * Deactivate an active `"field": "..."` occurrence — first one only; lines
 * already commented are left alone; no-op when none is active.
 * `"recomment"` re-comments the line (mirror of the uncomment-on-upsert, so
 * reset keeps the template shape and its trailing explanation comment).
 * `"delete"` excises the member span plus its adjacent comma — preferring a
 * trailing `,`, else consuming the preceding one — and collapses the line
 * entirely when the cut leaves it blank; a final `dropCommaBeforeClose` pass
 * repairs any dangling comma before the brace. Strict-JSON files
 * (`.ocp/ocp.json`, plain `.json` configs) therefore stay `JSON.parse`-valid
 * even when several members share one line — `//` never appears in them.
 */
export function removeConfigField(raw: string, field: string, mode: ConfigFieldRemoval = "recomment"): string {
  const gre = fieldValueRe(field)
  let m: RegExpExecArray | null
  while ((m = gre.exec(raw)) !== null) {
    if (isInsideLineComment(raw, m.index)) continue
    const lineStart = raw.lastIndexOf("\n", m.index - 1) + 1
    let lineEnd = raw.indexOf("\n", m.index)
    if (mode === "delete") {
      let cutStart = m.index
      let cutEnd = m.index + m[0].length
      // Prefer the comma right after the span ("a","k" minus k → keep a's
      // comma); fall back to the comma before it (minus a → drop a's comma).
      let t = cutEnd
      while (t < raw.length && /[ \t]/.test(raw[t])) t++
      if (raw[t] === ",") {
        cutEnd = t + 1
      } else {
        let p = cutStart - 1
        while (p >= 0 && /[ \t]/.test(raw[p])) p--
        if (p >= 0 && raw[p] === ",") cutStart = p
      }
      // Cut left an empty line → remove the line and its newline too.
      const nl = raw.indexOf("\n", cutEnd)
      if (nl !== -1 && raw.slice(lineStart, cutStart).trim() === "" && raw.slice(cutEnd, nl).trim() === "") {
        cutStart = lineStart
        cutEnd = nl + 1
      }
      const next = raw.slice(0, cutStart) + raw.slice(cutEnd)
      const close = next.lastIndexOf("}")
      return close === -1 ? next : dropCommaBeforeClose(next, close)
    }
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

/**
 * Write `"field": "value"` into `.ocp/ocp.json`. A missing file bootstraps
 * as a bare JSON object via `upsertConfigField("")` — pure-JSON config needs
 * no commented template, unset keys already mean defaults (ADR §3). Returns
 * the failure reason on error (string) — `null` on success, never throws.
 * Plugin hooks log the reason to `client.app.log({ level: "warn" })` so
 * users see a real diagnosis (read-only fs vs parse error vs permission
 * denied) instead of an opaque "couldn't set switch".
 */
export type SetConfigResult =
  | { ok: true }
  | { ok: false; reason: "read-only-fs" | "permission-denied" | "parse-error" | "no-target" | "unknown"; detail: string }

export function setConfigField(field: string, value: string): SetConfigResult {
  const file = writableProjectConfigFile()
  const isNew = !existsSync(file)
  let raw: string
  try {
    raw = isNew ? "" : readFileSync(file, "utf-8")
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
    // First create also bootstraps (or heals) `.ocp/.gitignore` so logs,
    // handoffs, and private memory are protected from the very first write.
    if (isNew) ensureOcpGitignore()
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
 * Deactivate `field` so the switch reverts to its default — touches
 * `.ocp/ocp.json` only (single source: with no runtime fallback there is
 * nothing else that could resurface). Returns the same result envelope as
 * `setConfigField`; a missing file is success (nothing to do). Removal uses
 * the strict-JSON `"delete"` mode — a re-commented line would make
 * `.ocp/ocp.json` unparseable for strict consumers.
 */
export function clearConfigField(field: string): SetConfigResult {
  const file = ocpConfigFile()
  if (!existsSync(file)) return { ok: true }
  try {
    const existing = readFileSync(file, "utf-8")
    const updated = removeConfigField(existing, field, "delete")
    if (updated !== existing) writeFileSync(file, updated, "utf-8")
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

// ─── One-shot legacy migration (ADR 0004 §3 — the only legacy-path code) ──

/** Project-level OCP switch keys the §3.1 migration moves. Shared with
 *  `project-manager-options.detectProjectSwitches`. */
export const OCP_SWITCH_KEYS = [
  "autoAdvisorMode",
  "adrGuard",
  "adrLayout",
  "adrDir",
  "envGuard",
  "e2eGuard",
  "projectMemory",
] as const
export type OcpSwitchKey = (typeof OCP_SWITCH_KEYS)[number]

export interface MigrationReport {
  /** Switch keys copied into `.ocp/ocp.json` (and removed from legacy files). */
  switchedKeys: string[]
  /** Legacy artifact paths moved into `.ocp/` (POSIX-relative, e.g. "memory/public.md"). */
  movedFiles: string[]
  /** Items left behind because the `.ocp/` target already existed. */
  skipped: string[]
  /** Per-item failures — migration never throws; each line names the path. */
  warnings: string[]
}

/** Legacy config locations, newest-last (§3.1: later file wins per key). */
function legacyConfigFiles(root: string): string[] {
  return [
    join(root, LEGACY_DIR, "opencode.jsonc"),
    join(root, LEGACY_DIR, "opencode.json"),
    join(root, "opencode.jsonc"),
    join(root, "opencode.json"),
  ]
}

/** True when `raw` carries an active (non-commented) occurrence of `key`. */
function hasActiveKey(raw: string, key: string): boolean {
  return new RegExp(`"${key}"\\s*:`).test(stripJsonc(raw))
}

/**
 * One-shot, idempotent move of legacy `.opencode/` OCP state into `.ocp/`
 * (ADR 0004 §3): runs at project init (`/project init`, the TUI wizard save
 * path) and on demand via `/project sync`. This is the ONLY runtime code
 * allowed to look at legacy paths. Never throws — per-item failures land in
 * `report.warnings`. A second run finds nothing (switch keys were removed,
 * files were moved), so the report is empty.
 *
 * 1. switches: collect per-key from the legacy config files (newest wins),
 *    copy into `.ocp/ocp.json` (existing `.ocp` values are kept), then
 *    deactivate each key ONLY after it is durably present in `.ocp/ocp.json`
 *    (written now or already active there) — a failed copy must never delete
 *    the only surviving value. Legacy deactivation is text surgery:
 *    `.jsonc` files re-comment the line (comments preserved), strict `.json`
 *    files drop it; platform keys are untouched everywhere.
 * 2. memory/{public,private}.md: rename; merge-append + delete if target exists.
 * 3. md-to-pdf.css / md-to-docx.css / md-to-docx.docx: rename, skip if target exists.
 * 4. handoffs/: rename whole dir if `.ocp/handoffs` absent.
 * 5. best-effort: dev-ultra-state.md + logs/ (same target-exists rules).
 */
export function migrateLegacyProjectArtifacts(root: string = getProjectDir()): MigrationReport {
  const report: MigrationReport = { switchedKeys: [], movedFiles: [], skipped: [], warnings: [] }
  const warn = (path: string, err: unknown): void => {
    report.warnings.push(`${path}: ${errMsg(err)}`)
  }

  // (1) switch keys — legacy→newest order, newest wins per key.
  const found = new Map<OcpSwitchKey, string>()
  for (const file of legacyConfigFiles(root)) {
    if (!existsSync(file)) continue
    const parsed = parseConfigFile(file)
    if (!parsed) continue
    for (const key of OCP_SWITCH_KEYS) {
      const value = parsed[key]
      if (typeof value === "string") found.set(key, value)
      else if (typeof value === "boolean") found.set(key, String(value))
    }
  }

  // Keys durably present in `.ocp/ocp.json` after step 1 — the ONLY keys
  // deactivation may touch (P1-1: a failed copy must not delete the only
  // surviving value).
  const durable = new Set<string>()
  if (found.size > 0) {
    const target = ocpConfigFile(root)
    try {
      const targetExists = existsSync(target)
      let raw = targetExists ? readFileSync(target, "utf-8") : ""
      const written: string[] = []
      for (const [key, value] of found) {
        if (targetExists && hasActiveKey(raw, key)) {
          // `.ocp` is the runtime source of truth — never overwrite it.
          report.skipped.push(key)
          durable.add(key)
        } else {
          raw = upsertConfigField(raw, key, value)
          written.push(key)
        }
      }
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, raw, "utf-8")
      if (!targetExists) ensureOcpGitignore(root)
      report.switchedKeys.push(...written)
      for (const key of written) durable.add(key)
    } catch (err) {
      warn(ocpConfigFile(root), err)
    }
  }

  // Deactivate the migrated keys in every legacy file that carried one —
  // gated on `durable` (see above). Sanctioned legacy write; mode follows
  // the file's own syntax so it stays parseable.
  for (const file of legacyConfigFiles(root)) {
    try {
      if (!existsSync(file)) continue
      const parsed = parseConfigFile(file)
      if (!parsed) continue
      const keys = OCP_SWITCH_KEYS.filter((key) => parsed[key] !== undefined && durable.has(key))
      if (keys.length === 0) continue
      const mode: ConfigFieldRemoval = file.endsWith(".jsonc") ? "recomment" : "delete"
      let text = readFileSync(file, "utf-8")
      for (const key of keys) text = removeConfigField(text, key, mode)
      writeFileSync(file, text, "utf-8")
    } catch (err) {
      warn(file, err)
    }
  }

  // (2) memory files — rename; merge-append + delete when the target exists
  // (committed lessons must never vanish, cp-dataloss).
  for (const name of ["public.md", "private.md"] as const) {
    const rel = `memory/${name}`
    const src = join(root, LEGACY_DIR, "memory", name)
    const dst = ocpArtifactPath(rel, root)
    if (!existsSync(src)) continue
    try {
      if (existsSync(dst)) {
        const extra = readFileSync(src, "utf-8")
        appendFileSync(dst, (extra.startsWith("\n") ? "" : "\n") + extra, "utf-8")
        // ponytail: crash between append+unlink duplicates entries on rerun; sentinel file if it bites
        unlinkSync(src)
      } else {
        mkdirSync(dirname(dst), { recursive: true })
        renameSync(src, dst)
      }
      report.movedFiles.push(rel)
    } catch (err) {
      warn(src, err)
    }
  }

  // (3) style overrides — per-file rename, skip when the target exists.
  for (const name of ["md-to-pdf.css", "md-to-docx.css", "md-to-docx.docx"] as const) {
    const src = join(root, LEGACY_DIR, name)
    const dst = ocpArtifactPath(name, root)
    if (!existsSync(src)) continue
    if (existsSync(dst)) {
      report.skipped.push(name)
      continue
    }
    try {
      renameSync(src, dst)
      report.movedFiles.push(name)
    } catch (err) {
      warn(src, err)
    }
  }

  // (4)+(5) disposable dirs and files — whole-dir moves, skipped when the
  // target exists (handoffs required, logs/dev-ultra-state best-effort).
  for (const name of ["handoffs", "logs", "dev-ultra-state.md"] as const) {
    const src = join(root, LEGACY_DIR, name)
    const dst = ocpArtifactPath(name, root)
    if (!existsSync(src)) continue
    if (existsSync(dst)) {
      report.skipped.push(name)
      continue
    }
    try {
      renameSync(src, dst)
      report.movedFiles.push(name)
    } catch (err) {
      warn(src, err)
    }
  }

  return report
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Local alias for typed `code` access on node fs errors.
type ErrnoException = NodeJS.ErrnoException

// ─── Project Log & Gitignore Utilities ────────────────────────────────

/**
 * Ensures `<project>/.ocp/.gitignore` exists to ignore OCP runtime
 * artifacts (ADR §5). The legacy `.opencode/.gitignore` is frozen — until
 * the init migration moves the files it still protects a legacy
 * `memory/private.md`, but OCP never writes it again. If `.ocp/.gitignore`
 * already exists, heals missing entries instead of overwriting.
 *
 * `ocp.json` and `memory/public.md` are deliberately NOT ignored — both are
 * committed, team-shared files. (`node_modules`/lockfile guards from the old
 * `.opencode/` bootstrap are dropped: plugin-dependency installs only ever
 * happen in the platform dir.)
 */
export function ensureOcpGitignore(root: string = getProjectDir()): void {
  const dir = ocpDir(root)
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    const gitignorePath = join(dir, ".gitignore")
    const defaultIgnore = ".gitignore\nlogs/\n*.log\nhandoffs/\nmemory/private.md\ndev-ultra-state.md\n"
    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, defaultIgnore, "utf-8")
      return
    }
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
    if (!content.includes("dev-ultra-state.md")) {
      nextContent = nextContent.trimEnd() + "\ndev-ultra-state.md\n"
      needsUpdate = true
    }
    if (needsUpdate) {
      writeFileSync(gitignorePath, nextContent, "utf-8")
    }
  } catch { }
}

/**
 * Resolves `<project>/.ocp/logs` directory, creating it and ensuring
 * `.ocp/.gitignore` is configured automatically.
 */
export function getProjectLogDir(root: string = getProjectDir()): string {
  const dir = ocpArtifactPath("logs", root)
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    ensureOcpGitignore(root)
  } catch { }
  return dir
}

/**
 * Resolves `<project>/.ocp/handoffs` directory, creating it and ensuring
 * `.ocp/.gitignore` is configured automatically. Kept even though no plugin
 * code calls it: it is the canonical path anchor the handoff/sdd skills
 * reference.
 */
export function getProjectHandoffDir(root: string = getProjectDir()): string {
  const dir = ocpArtifactPath("handoffs", root)
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    ensureOcpGitignore(root)
  } catch { }
  return dir
}


