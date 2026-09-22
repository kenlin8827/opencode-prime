/** Explicit, reversible archive moves with repository-local link repair. */
import { readdirSync } from "node:fs"
import { basename, dirname, posix, relative } from "node:path"
import { isArchived, isRetired, statusOf } from "./adr-context"
import { type NormalizedAdrRecord } from "./adr-types"
import { projectPath, readOptional, type FileChange } from "./adr-storage"

import { getAdrDir } from "./adr-config"
import { ocpDir } from "../shared/opencode-prime"

const ignored = new Set([".git", ".ocp", ".opencode", "node_modules", ".cache", ".next", "dist", "build", "coverage", ".venv"])

function markdownFiles(project: string, dir = ""): string[] {
  if (dir === relative(project, ocpDir(project)).replace(/\\/g, "/")) return []
  const out: string[] = []
  for (const entry of readdirSync(dir ? projectPath(project, dir) : project, { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.name.startsWith(".tmp-") || entry.isSymbolicLink()) continue
    const path = dir ? `${dir}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...markdownFiles(project, path))
    else if (entry.isFile() && entry.name.endsWith(".md") && !/^INDEX(?:\.|$)|^CURRENT\.md$/.test(entry.name)) out.push(path)
  }
  return out.sort()
}

export function assertArchivable(record: NormalizedAdrRecord, records: NormalizedAdrRecord[]): void {
  if (!isRetired(record)) throw new Error(`Still live: ${record.id}`)
  if (record.sections?.some(s => !["superseded", "deprecated", "rejected"].includes(statusOf(String(s.status))))) throw new Error(`Mixed/live sections prevent archival: ${record.id}`)
  if (statusOf(record.status) === "superseded") {
    if (!record.supersededBy.length) throw new Error(`Missing successor: ${record.id}`)
    for (const id of record.supersededBy) {
      const found = records.filter(r => r.id === id)
      if (found.length !== 1 || !found[0].supersedes.includes(record.id)) throw new Error(`Missing reciprocal successor: ${record.id} -> ${id}`)
      if (!["accepted", "superseded", "deprecated"].includes(statusOf(found[0].status))) throw new Error(`Successor was not accepted: ${id}`)
      // A historical successor may itself have been superseded; its lineage must
      // remain resolvable, but it need not still be the accepted endpoint.
    }
  }
}

function rewriteLinks(raw: string, oldPath: string, newPath: string, moves: Map<string, string>): string {
  const rewrite = (target: string): string => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(target)) return target
    const hashIndex = target.search(/[?#]/)
    const path = hashIndex < 0 ? target : target.slice(0, hashIndex)
    const suffix = hashIndex < 0 ? "" : target.slice(hashIndex)
    const resolved = posix.normalize(posix.join(dirname(oldPath), path))
    const destination = moves.get(resolved) ?? resolved
    if (!moves.has(resolved) && oldPath === newPath) return target
    let relative = posix.relative(dirname(newPath), destination)
    if (!relative.startsWith(".")) relative = `./${relative}`
    return relative + suffix
  }
  // Inline Markdown links (including images) and reference definitions.
  let result = raw.replace(/(!?\[[^\]\n]*\]\()([^\s()]+)([^)\n]*\))/g, (_all, pre, url, post) => pre + rewrite(url) + post)
  result = result.replace(/^(\s*\[[^\]\n]+\]:\s*)([^\s]+)(.*)$/gm, (_all, pre, url, post) => pre + rewrite(url) + post)
  // ADR frontmatter relations and translation_of are project-relative paths.
  result = result.replace(/^(parent|supersedes|superseded_by|superseded-by|translation_of):[^\r\n]*$/gm, line => {
    for (const [from, to] of moves) line = line.split(from).join(to)
    return line
  })
  return result
}

/** Pure plan, including incoming links in reader mirrors. Caller reviews exact diff. */
export function planArchiveChanges(project: string, records: NormalizedAdrRecord[], ids: string[], overlay: Map<string, string> = new Map()): FileChange[] {
  const moves = new Map<string, string>()
  for (const id of ids) {
    const found = records.filter(r => r.id === id)
    if (found.length !== 1) throw new Error(`Archive ID missing/ambiguous: ${id}`)
    const record = found[0]
    if (isArchived(record.sourcePath, getAdrDir(project))) throw new Error(`Already archived: ${id}`)
    assertArchivable(record, records)
    const target = `${dirname(record.sourcePath)}/archive/${basename(record.sourcePath)}`
    if (readOptional(project, target) !== null || overlay.has(target)) throw new Error(`Archive collision: ${target}`)
    moves.set(record.sourcePath, target)
  }
  const paths = new Set([...markdownFiles(project), ...overlay.keys()])
  const changes = new Map<string, FileChange>()
  for (const path of paths) {
    const raw = overlay.get(path) ?? readOptional(project, path)
    if (raw === null) continue
    const target = moves.get(path) ?? path
    const next = rewriteLinks(raw, path, target, moves)
    // Unsupported path references must not silently become broken links. The
    // preview can be retried after replacing them with explicit Markdown links.
    for (const from of moves.keys()) {
      if (next.includes(from)) throw new Error(`Unrewritable path reference to ${from} in ${path}; use a canonical ADR ID or supported Markdown link`)
    }
    if (target !== path) {
      changes.set(target, { path: target, before: null, after: next })
      changes.set(path, { path, before: raw, after: null })
    } else if (raw !== next) changes.set(path, { path, before: raw, after: next })
  }
  // Write destinations/updated links before removing sources. Readers refuse
  // an incomplete journal, so temporary duplicate identities cannot be used.
  return [...changes.values()].sort((a, b) => Number(a.after === null) - Number(b.after === null) || a.path.localeCompare(b.path))
}

export function inverseArchive(changes: FileChange[]): FileChange[] {
  return changes.map(c => ({ path: c.path, before: c.after, after: c.before })).sort((a, b) => Number(a.after === null) - Number(b.after === null) || a.path.localeCompare(b.path))
}
