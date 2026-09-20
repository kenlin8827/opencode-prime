/** ADR maintenance storage. Intentional internal API, never a plugin entry.
 * Writes are recoverable, not a claim of multi-file filesystem atomicity.
 */
import { createHash, randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"

import { ocpArtifactPath } from "../shared/opencode-prime"

export const maintenanceDir = ".ocp/adr-compaction"
export const maintenancePath = (project: string): string => relative(project, ocpArtifactPath("adr-compaction", project)).replace(/\\/g, "/")
export const digest = (value: string): string => createHash("sha256").update(value).digest("hex")

/** Refuse symlinks (including intermediate directories), traversal, and root writes. */
export function projectPath(project: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some(p => p === ".." || p === "." || !p)) {
    throw new Error(`Unsafe project-relative path: ${path}`)
  }
  const root = realpathSync(project)
  const full = resolve(root, path)
  const rel = relative(root, full)
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Path outside project: ${path}`)
  let cursor = root
  for (const part of path.split("/")) {
    cursor = resolve(cursor, part)
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Symlink is not supported for ADR maintenance: ${path}`)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    }
  }
  return full
}

export function readOptional(project: string, path: string): string | null {
  const full = projectPath(project, path)
  try { return readFileSync(full, "utf8") } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
}

export function atomicWrite(project: string, path: string, text: string): void {
  const full = projectPath(project, path)
  mkdirSync(dirname(full), { recursive: true })
  const temp = `${full}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, text, { encoding: "utf8", flag: "wx" })
    renameSync(temp, full)
  } finally { if (existsSync(temp)) unlinkSync(temp) }
}

export function withMaintenanceLock<T>(project: string, fn: () => T): T {
  const lock = projectPath(project, `${maintenancePath(project)}/lock`)
  mkdirSync(dirname(lock), { recursive: true })
  // Never automatically steal a lock: a stale lock requires an explicit operator
  // check, preventing two processes from deciding independently that it is stale.
  try { writeFileSync(lock, JSON.stringify({ pid: process.pid, created: new Date().toISOString() }), { flag: "wx" }) }
  catch { throw new Error(`ADR maintenance is locked. Inspect ${maintenancePath(project)}/lock; remove only after verifying its owner has stopped.`) }
  try { return fn() } finally { unlinkSync(lock) }
}

export interface FileChange { path: string; before: string | null; after: string | null }
export interface Journal { version: 1; changes: FileChange[]; complete: boolean }

/** Caller holds the maintenance lock. Unexpected user edits stop recovery. */
export function applyJournal(project: string, path: string, changes?: FileChange[]): void {
  const existing = readOptional(project, path)
  const journal: Journal = existing ? JSON.parse(existing) : { version: 1, changes: changes ?? [], complete: false }
  if (journal.version !== 1 || typeof journal.complete !== "boolean" || !Array.isArray(journal.changes) || !journal.changes.every(c => c && typeof c.path === "string" && (c.before === null || typeof c.before === "string") && (c.after === null || typeof c.after === "string"))) throw new Error("Unsupported maintenance journal")
  const signature = (entries: FileChange[]) => JSON.stringify(entries.map(c => [c.path, c.before, c.after]))
  if (existing && changes && signature(journal.changes) !== signature(changes)) throw new Error("Recovery journal differs from the authorized transaction")
  if (!existing) {
    if (!changes) throw new Error("Missing transaction")
    const seen = new Set<string>()
    for (const change of changes) {
      if (seen.has(change.path)) throw new Error(`Duplicate transaction path: ${change.path}`)
      seen.add(change.path)
      if (readOptional(project, change.path) !== change.before) throw new Error(`Source changed: ${change.path}`)
    }
    atomicWrite(project, path, JSON.stringify(journal, null, 2))
  }
  if (journal.complete) return
  for (const change of journal.changes) {
    const current = readOptional(project, change.path)
    if (current === change.after) continue
    if (current !== change.before) throw new Error(`Recovery paused: unexpected edit to ${change.path}`)
    if (change.after === null) unlinkSync(projectPath(project, change.path))
    else atomicWrite(project, change.path, change.after)
  }
  journal.complete = true
  atomicWrite(project, path, JSON.stringify(journal, null, 2))
}

export function setFrontmatter(raw: string, key: string, value: string): string {
  if (!/^[a-z_]+$/.test(key) || /[\r\n]/.test(value)) throw new Error("Invalid frontmatter update")
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (!fm) throw new Error("ADR maintenance requires an explicit frontmatter block")
  const eol = raw.includes("\r\n") ? "\r\n" : "\n"
  const body = fm[1]
  const pattern = new RegExp(`^${key}:.*$`, "im")
  const next = pattern.test(body) ? body.replace(pattern, `${key}: ${value}`) : `${body}${eol}${key}: ${value}`
  return `---${eol}${next}${eol}---` + raw.slice(fm[0].length)
}
