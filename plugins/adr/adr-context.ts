/** Bounded, evidence-backed ADR retrieval. Local scans never imply model reads. */
import { readdirSync } from "node:fs"
import { getAdrDir, getAdrLayout } from "./adr-config"
import { discoverAdrDirectories, getNormalizedAdrs } from "./adr-engine"
import { adrIdFromFilename, normalizeAdrId, type NormalizedAdrRecord } from "./adr-types"
import { digest, maintenancePath, projectPath, readOptional } from "./adr-storage"

export const CONTEXT_BUDGET = 12000
function archiveOffset(path: string, root: string): number {
  const moduleRoot = /(?:^|\/)(?:docs\/)?adr\//.exec(path)
  const base = path.startsWith(`${root}/`) ? root.length + 1 : moduleRoot ? moduleRoot.index + moduleRoot[0].length : -1
  if (base < 0) return -1
  const archive = /(?:^|\/)archive\//.exec(path.slice(base))
  return archive ? base + archive.index : -1
}
export const isArchived = (path: string, root = "docs/adr"): boolean => archiveOffset(path, root) >= 0
export function recordRoot(path: string, root: string): string {
  const offset = archiveOffset(path, root)
  return offset < 0 ? path.slice(0, path.lastIndexOf("/")) : path.slice(0, offset).replace(/\/$/, "")
}
export const statusOf = (value: string): string => value.trim().toLowerCase().replace(/^superseded\s+by\b.*$/, "superseded")
export const isRetired = (r: NormalizedAdrRecord): boolean => ["superseded", "deprecated", "rejected"].includes(statusOf(r.status))
export interface Snapshot { root: string; records: NormalizedAdrRecord[]; fingerprint: string }
export interface SummaryItem { text: string; sources: string[] }
export interface CurrentManifest { version: 1; owner: "ocp-adr-compaction"; fingerprint: string; summaryHash: string; items: SummaryItem[]; displayItems?: SummaryItem[]; sources?: Array<{ id: string; path: string; hash: string; units: string[] }>; views?: Record<string, string> }

export function takeSnapshot(project: string): Snapshot {
  const root = getAdrDir(project)
  projectPath(project, root)
  const records = getNormalizedAdrs(project, root, getAdrLayout(project))
  for (const r of records) projectPath(project, r.sourcePath)
  const inventory = new Set(records.map(r => r.sourcePath))
  for (const dir of discoverAdrDirectories(project, root, getAdrLayout(project))) {
    let entries: import("node:fs").Dirent[]
    try { entries = readdirSync(projectPath(project, dir), { withFileTypes: true }) } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue
      throw err
    }
    for (const entry of entries) {
      if (entry.isFile() && adrIdFromFilename(entry.name) && !inventory.has(`${dir}/${entry.name}`)) throw new Error(`Canonical ADR could not be read/parsed: ${dir}/${entry.name}`)
    }
  }
  return snapshotForRecords(project, root, records)
}

export function snapshotForRecords(project: string, root: string, records: NormalizedAdrRecord[]): Snapshot {
  const ordered = [...records].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath, "en"))
  const fingerprint = digest(JSON.stringify({ root, layout: getAdrLayout(project), sources: ordered.map(r => [r.id, r.sourcePath, digest(r.rawContent)]) }))
  return { root, records: ordered, fingerprint }
}

export function pendingRecovery(project: string): string[] {
  let names: string[]
  try { names = readdirSync(projectPath(project, maintenancePath(project))) } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return []
    throw e
  }
  return names.filter(name => /^cp-[a-f0-9]{16}(?:\.(?:lifecycle|views|relocated-views|archive|drafts))?\.json$/.test(name)).filter(name => {
    try {
      const value = JSON.parse(readOptional(project, `${maintenancePath(project)}/${name}`) ?? "null")
      // The plan is durable before the first journal and between stages. A
      // crash in either gap must not allow another plan to reuse its authority.
      return /^cp-[a-f0-9]{16}\.json$/.test(name) ? value?.state === "applying" : value?.complete !== true
    } catch { return true }
  })
}

export function currentState(project: string, snapshot = takeSnapshot(project)): { status: "fresh" | "stale" | "missing" | "invalid"; manifest?: CurrentManifest } {
  const body = readOptional(project, `${snapshot.root}/CURRENT.md`)
  const raw = readOptional(project, `${snapshot.root}/CURRENT.sources.json`)
  if (body === null && raw === null) return { status: "missing" }
  try {
    const m = JSON.parse(raw ?? "null") as CurrentManifest
    if (!m || m.version !== 1 || m.owner !== "ocp-adr-compaction" || !Array.isArray(m.items) || !m.items.every(i => typeof i.text === "string" && Array.isArray(i.sources) && i.sources.every(s => typeof s === "string")) || body === null || m.summaryHash !== digest(body)) return { status: "invalid" }
    if (!body.startsWith(renderCurrent(m.displayItems ?? m.items)) || (m.displayItems && !body.includes(`<!-- ocp-adr-summary: ${digest(JSON.stringify(m.items))} -->`))) return { status: "invalid" }
    if (m.fingerprint === snapshot.fingerprint) {
      const expected = snapshot.records.map(r => [r.id, r.sourcePath, digest(r.rawContent), decisionUnits(r)])
      if (JSON.stringify(m.sources?.map(r => [r.id, r.path, r.hash, r.units])) !== JSON.stringify(expected)) return { status: "invalid" }
    }
    for (const [path, hash] of Object.entries(m.views ?? {})) {
      const view = readOptional(project, path)
      if (view === null || digest(view) !== hash) return { status: "invalid" }
      const pair = JSON.parse(readOptional(project, path.replace(/CURRENT\.md$/, "CURRENT.sources.json")) ?? "null") as CurrentManifest
      if (!pair || pair.owner !== m.owner || pair.version !== 1 || pair.summaryHash !== hash || pair.fingerprint !== m.fingerprint || !Array.isArray(pair.items)) return { status: "invalid" }
      if (!view.startsWith(renderCurrent(pair.displayItems ?? pair.items)) || !view.includes(`<!-- ocp-adr-summary: ${digest(JSON.stringify(pair.items))} -->`)) return { status: "invalid" }
    }
    return { status: m.fingerprint === snapshot.fingerprint && pendingRecovery(project).length === 0 ? "fresh" : "stale", manifest: m }
  } catch { return { status: "invalid" } }
}

export interface Evidence { id: string; path: string; status: string; via: string; hash: string; body: string }
export interface ContextQuery { id?: string; domain?: string; iteration?: string; intent?: "current" | "rationale" | "history"; cursor?: string }
export interface EvidencePage {
  fingerprint: string; freshness: string; coverage: "complete" | "incomplete"; total: number
  entries: Array<Omit<Evidence, "body"> & { excerpt: string; offset: number; end: number; length: number }>
  next?: string; issues: string[]
}

/** Same paginator serves task context, maintenance evidence, and full review artifacts. */
export function evidencePage(evidence: Evidence[], fingerprint: string, key: string, cursor?: string, freshness = "sources", issues: string[] = []): EvidencePage {
  let index = 0, offset = 0
  if (cursor) {
    let parsed: { f: string; k: string; i: number; o: number }
    try { parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) } catch { throw new Error("Invalid ADR cursor") }
    if (parsed.f !== fingerprint || parsed.k !== key) throw new Error("ADR cursor is stale or belongs to a different query")
    if (!Number.isSafeInteger(parsed.i) || parsed.i < 0 || parsed.i > evidence.length || !Number.isSafeInteger(parsed.o) || parsed.o < 0) throw new Error("Invalid ADR cursor position")
    index = parsed.i; offset = parsed.o
  }
  const page: EvidencePage = { fingerprint, freshness, coverage: "incomplete", total: evidence.length, entries: [], issues: issues.slice(0, 8).map(i => Array.from(i).slice(0, 240).join("")) }
  while (index < evidence.length && page.entries.length < 8) {
    const e = evidence[index]
    const chars = Array.from(e.body)
    if (offset > chars.length) throw new Error("Invalid ADR cursor offset")
    const end = Math.min(chars.length, offset + 1600)
    const { body: _, ...meta } = e
    const entry = { ...meta, excerpt: chars.slice(offset, end).join(""), offset, end, length: chars.length }
    page.entries.push(entry)
    // Reserve room for the cursor and final coverage fields; count JSON escaping.
    if (Array.from(JSON.stringify(page)).length > CONTEXT_BUDGET - 900) {
      page.entries.pop()
      if (!page.entries.length) throw new Error("ADR evidence metadata exceeds the response budget; shorten source paths/identifiers")
      break
    }
    if (end === chars.length) { index++; offset = 0 } else { offset = end }
  }
  if (index < evidence.length) page.next = Buffer.from(JSON.stringify({ f: fingerprint, k: key, i: index, o: offset })).toString("base64url")
  else page.coverage = "complete"
  if (Array.from(JSON.stringify(page)).length > CONTEXT_BUDGET) throw new Error("ADR output budget exceeded")
  return page
}

export function recordEvidence(record: NormalizedAdrRecord, via = "selected"): Evidence {
  return { id: record.id, path: record.sourcePath, status: String(record.status), via, hash: digest(record.rawContent), body: record.rawContent }
}

export function decisionUnits(record: NormalizedAdrRecord): string[] {
  return record.sections?.length ? record.sections.map(s => s.id) : [record.id]
}

export function resolveUnique(records: NormalizedAdrRecord[], ref: string): NormalizedAdrRecord {
  const id = normalizeAdrId(ref)?.split("#")[0]
  const found = records.filter(r => r.id === id || r.sourcePath === ref)
  if (found.length !== 1) throw new Error(`ADR reference is missing or ambiguous: ${ref}`)
  return found[0]
}

export function queryAdrContext(project: string, query: ContextQuery = {}): EvidencePage {
  const s = takeSnapshot(project)
  const recovery = pendingRecovery(project)
  if (recovery.length) throw new Error(`ADR maintenance recovery required: ${recovery.join(", ")}. Use /adr compaction status.`)
  if ([query.id, query.domain, query.iteration].filter(Boolean).length > 1) throw new Error("Choose one ADR context selector")
  const intent = query.intent ?? "current"
  const selected = query.id ? [resolveUnique(s.records, query.id)] : s.records.filter(r => !isArchived(r.sourcePath, s.root) && (!query.domain || r.domain === query.domain) && (!query.iteration || r.iteration === query.iteration))
  const issues: string[] = []
  const byId = (id: string) => resolveUnique(s.records, id)
  let targets = selected
  if (query.id && intent === "current" && isRetired(targets[0])) {
    const successors: NormalizedAdrRecord[] = [], seen = new Set<string>()
    const queue = [{ r: targets[0], hop: 0, trail: [] as string[] }]
    while (queue.length) {
      const { r, hop, trail } = queue.shift()!
      if (seen.has(r.id)) continue
      seen.add(r.id)
      if (statusOf(r.status) === "accepted") { successors.push(r); continue }
      if (!isRetired(r) || !r.supersededBy.length || hop >= 3) {
        issues.push(`No resolved accepted endpoint within the relation budget: ${r.id}; inspect that ID explicitly.`); continue
      }
      for (const ref of r.supersededBy) {
        try {
          if ([...trail, r.id].includes(ref)) { issues.push(`Supersession cycle at ${ref}; resolve before treating this branch as current.`); continue }
          queue.push({ r: byId(ref), hop: hop + 1, trail: [...trail, r.id] })
        } catch (err) { issues.push(String(err)) }
      }
    }
    if (successors.length) targets = successors
    else issues.push("No accepted successor resolved; historical evidence is not a current constraint.")
  }
  const bundled = new Map<string, { r: NormalizedAdrRecord; via: string; archiveHops: number }>()
  const add = (r: NormalizedAdrRecord, via: string, archiveHops = 0) => {
    if (!bundled.has(r.sourcePath)) bundled.set(r.sourcePath, { r, via, archiveHops })
  }
  // Applicable global constraints precede incidental relationships.
  for (const r of s.records) if (!isArchived(r.sourcePath, s.root) && r.layer === "system" && statusOf(r.status) === "accepted") add(r, "system constraint")
  for (const r of targets) {
    if (!query.id && intent === "current" && isRetired(r)) continue
    add(r, "selected", isArchived(r.sourcePath, s.root) ? 1 : 0)
  }
  let frontier = [...bundled.values()]
  for (let hop = 0; hop < 3; hop++) {
    const next: typeof frontier = []
    for (const { r, archiveHops } of frontier) {
      const refs = intent === "current" ? r.parentIds : [...r.parentIds, ...r.supersedes, ...r.supersededBy]
      for (const ref of refs) {
        try {
          const related = byId(ref)
          const depth = archiveHops + (isArchived(related.sourcePath, s.root) ? 1 : 0)
          if (depth > 1 || (intent === "current" && isArchived(related.sourcePath, s.root))) {
            issues.push(`History remains unloaded: ${ref}; request that ID with history intent if needed.`); continue
          }
          if (!bundled.has(related.sourcePath)) { add(related, `relation of ${r.id}`, depth); next.push({ r: related, via: `relation of ${r.id}`, archiveHops: depth }) }
        } catch (err) { issues.push(String(err)) }
      }
    }
    frontier = next
  }
  const remaining = [...new Set(frontier.flatMap(({ r }) => intent === "current" ? r.parentIds : [...r.parentIds, ...r.supersedes, ...r.supersededBy]))].filter(id => ![...bundled.values()].some(({ r }) => r.id === id))
  if (remaining.length) issues.push(`Relation budget reached; ${remaining.length} references remain: ${remaining.slice(0, 6).join(", ")}. Request necessary IDs explicitly.`)
  const current = currentState(project, s)
  let evidence: Evidence[] = [...bundled.values()].map(({ r, via }) => recordEvidence(r, via))
  if (intent === "current" && !query.id && current.status === "fresh" && current.manifest) {
    const ids = new Set([...bundled.values()].flatMap(({ r }) => [r.id, ...decisionUnits(r)]))
    evidence = current.manifest.items.filter(item => item.sources.some(id => ids.has(id))).map((item, i) => ({
      id: `CURRENT-${i + 1}`, path: `${s.root}/CURRENT.md`, status: "derived", via: item.sources.join(", "), hash: current.manifest!.summaryHash, body: item.text,
    }))
  } else if (!query.id && !query.domain && !query.iteration && intent === "current") {
    evidence = s.records.filter(r => !isArchived(r.sourcePath, s.root)).map(r => ({ ...recordEvidence(r), body: `${r.title}\nDomain: ${r.domain ?? "unclassified"}\nUse adr_context with this ID to retrieve its decisions.` }))
  }
  if (query.id?.includes("#")) {
    const target = resolveUnique(s.records, query.id)
    const section = target.sections?.find(sec => sec.id === normalizeAdrId(query.id!))
    if (!section) throw new Error(`Missing ADR section: ${query.id}`)
    const item = evidence.find(e => e.id === target.id)
    if (item) {
      const blocks = target.rawContent.split(/(?=^###\s+\d+\.)/m)
      item.body = blocks.find(b => new RegExp(`^###\\s+0*${Number(section.seq)}\\.`).test(b)) ?? JSON.stringify(section)
      item.id = section.id
    }
  }
  const key = digest(JSON.stringify({ ...query, cursor: undefined }))
  const page = evidencePage(evidence, s.fingerprint, key, query.cursor, current.status, issues)
  if (issues.length) page.coverage = "incomplete"
  return page
}

export function renderCurrent(items: SummaryItem[]): string {
  return "# Current architecture decisions\n\n<!-- ocp-adr-compaction: generated, reviewed derived view -->\n\n> Verify freshness with adr_context or /adr compaction status. Sources remain authoritative; this is not proof of code conformance.\n\n" + items.map(item => `${item.text}\n\nSources: ${item.sources.map(id => `\`${id}\``).join(", ")}\n`).join("\n")
}
