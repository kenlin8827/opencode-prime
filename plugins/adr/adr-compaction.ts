/** ADR maintenance plans: deterministic analysis, bounded drafting, reviewed apply.
 * This module is an internal service; only the runtime's verified user channels
 * may call applyPlan. Model tools can draft/review but cannot authorize writes.
 */
import { randomBytes } from "node:crypto"
import { basename } from "node:path"
import { getAdrConfig, getAdrLayout } from "./adr-config"
import { renderAdrFilename, slugify } from "./adr-engine"
import { getAdrStyleAdapter } from "./adr-style-registry"
import { adrIdFromFilename, extractFrontmatter, type AdrDocument, type AdrStyle, type NormalizedAdrRecord } from "./adr-types"
import { acceptedAdrContent, decisionLedgerEntry, decisionsLedgerRelative, readDecidedIds } from "./adr-governance"
import { currentState, decisionUnits, snapshotForRecords } from "./adr-context"
import { evidencePage, isArchived, isRetired, pendingRecovery, recordEvidence, renderCurrent, resolveUnique, statusOf, takeSnapshot, type Snapshot, type SummaryItem } from "./adr-context"
import { applyJournal, atomicWrite, digest, maintenancePath, projectPath, readOptional, setFrontmatter, withMaintenanceLock, type FileChange } from "./adr-storage"
import { planPublication } from "./adr-publication"
import { inverseArchive, planArchiveChanges } from "./adr-archive"

// Zero-bare-import rule: OpenCode v2's plugin loader cannot resolve ANY bare
// package import from user plugins (verified on v2.0.15 — even CJS-ready
// packages with a proper node_modules fail with `Cannot find package`), so
// candidate validation is a hand-rolled parser, not zod. Keep shapes in sync
// with the JSON Schema tool inputs in adr-compaction-runtime.ts.
export interface CandidateSummaryItem { text: string; sources: string[] }
export interface CandidateReplacement { id: string; title: string; content: string }
export interface CandidateCoverage { source: string; disposition: "retain" | "replace" | "historical" | "unresolved"; targets: string[]; note: string }
export interface Candidate { summary: CandidateSummaryItem[]; replacements: CandidateReplacement[]; coverage: CandidateCoverage[] }
export type CandidateBatch = Candidate

const DISPOSITIONS = ["retain", "replace", "historical", "unresolved"] as const
const bad = (msg: string): never => { throw new Error(`Invalid ADR candidate: ${msg}`) }
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown, f: string, min: number, max: number): string =>
  typeof v === "string" && v.length >= min && v.length <= max ? v : bad(`${f} must be a string of ${min}–${max} chars`)
const strList = (v: unknown, f: string, min: number): string[] =>
  Array.isArray(v) && v.length >= min && v.every((x) => typeof x === "string") ? v as string[] : bad(`${f} must be an array of ${min}+ strings`)

function parseSummaryItem(v: unknown): CandidateSummaryItem {
  if (!isObj(v)) return bad("summary item must be an object")
  return { text: str(v.text, "summary.text", 1, 12000), sources: strList(v.sources, "summary.sources", 1) }
}
function parseReplacement(v: unknown): CandidateReplacement {
  if (!isObj(v)) return bad("replacement must be an object")
  return { id: str(v.id, "replacements.id", 0, Infinity), title: str(v.title, "replacements.title", 1, 200), content: str(v.content, "replacements.content", 1, 200000) }
}
function parseCoverage(v: unknown): CandidateCoverage {
  if (!isObj(v)) return bad("coverage item must be an object")
  if (!DISPOSITIONS.includes(v.disposition as never)) bad("coverage.disposition must be retain|replace|historical|unresolved")
  return {
    source: str(v.source, "coverage.source", 0, Infinity),
    disposition: v.disposition as CandidateCoverage["disposition"],
    targets: v.targets === undefined ? [] : strList(v.targets, "coverage.targets", 0),
    note: str(v.note, "coverage.note", 1, 2000),
  }
}
function parseCandidateInternal(input: unknown, requireSummary: boolean): Candidate {
  if (!isObj(input)) return bad("must be an object")
  if (!Array.isArray(input.summary) || (requireSummary && input.summary.length === 0)) return bad(`summary must be an array (${requireSummary ? "1+" : "0+"} items)`)
  if (!Array.isArray(input.coverage)) return bad("coverage must be an array")
  if (input.replacements !== undefined && !Array.isArray(input.replacements)) return bad("replacements must be an array")
  return {
    summary: (input.summary as unknown[]).map(parseSummaryItem),
    replacements: ((input.replacements ?? []) as unknown[]).map(parseReplacement),
    coverage: (input.coverage as unknown[]).map(parseCoverage),
  }
}
/** Final candidate: all-or-nothing, summary must be non-empty. */
export const parseCandidate = (input: unknown): Candidate => parseCandidateInternal(input, true)
/** Batches may contain just coverage, prose, or replacements; final validation
 * remains all-or-nothing. Stable batch keys make retries replace, never append. */
export const parseCandidateBatch = (input: unknown): CandidateBatch => parseCandidateInternal(input, false)
export interface CompactionOptions { mode?: "summary" | "consolidate"; domain?: string; sources?: string[]; archive?: boolean; style?: AdrStyle; baseline?: string; iteration?: string; dryRun?: boolean }
export interface Plan {
  version: 1; id: string; sessionID: string; fingerprint: string; root: string; configHash: string
  sourceHashes: Record<string, string>;
  options: CompactionOptions; selected: string[]; evidencePaths: string[]; read: string[]
  slots: Array<{ id: string; scaffold: string }>; created: string
  state: "drafting" | "review" | "drafts" | "applying" | "complete" | "cancelled"
  batches?: Record<string, CandidateBatch>;
  revision: number; candidate?: Candidate; seal?: string; changes?: FileChange[]; archiveChanges?: FileChange[]
  blockers?: string[];
  viewChanges?: FileChange[]; relocatedViews?: FileChange[];
  summary?: SummaryItem[]; result?: string; kind: "summary" | "consolidate" | "archive" | "restore"
  costApproval?: { actor: string; at: string };
  ledgerBefore?: string | null;
  approval?: { actor: string; choice: string; seal: string; at: string }
}
export const planFile = (project: string, id: string): string => {
  if (!/^cp-[a-f0-9]{16}$/.test(id)) throw new Error("Invalid ADR plan ID")
  return `${maintenancePath(project)}/${id}.json`
}
export function loadPlan(project: string, id: string, sessionID?: string): Plan {
  const raw = readOptional(project, planFile(project, id))
  if (!raw) throw new Error(`Unknown ADR plan: ${id}`)
  const plan = JSON.parse(raw) as Plan
  if (plan.version !== 1 || plan.id !== id || !Array.isArray(plan.selected) || !Array.isArray(plan.slots)) throw new Error("Unsupported/corrupt ADR plan")
  if (sessionID && plan.sessionID !== sessionID) throw new Error("ADR plan belongs to another session; use its user command to resume")
  return plan
}
const save = (project: string, plan: Plan) => atomicWrite(project, planFile(project, plan.id), JSON.stringify(plan, null, 2))
const configHash = (project: string) => digest(JSON.stringify({ config: getAdrConfig(project), layout: getAdrLayout(project) }))

function assertReadySources(snapshot: Snapshot): void {
  const ids = new Set<string>()
  for (const r of snapshot.records) {
    if (ids.has(r.id)) throw new Error(`Ambiguous ADR ID: ${r.id}`)
    ids.add(r.id)
    if (!["proposed", "accepted", "superseded", "deprecated", "rejected"].includes(statusOf(r.status))) throw new Error(`Unknown status: ${r.id}`)
  }
  for (const r of snapshot.records) {
    for (const ref of [...r.parentIds, ...r.supersedes, ...r.supersededBy]) if (!ids.has(ref)) throw new Error(`Broken reference: ${r.id} -> ${ref}`)
    // Adapters omit unresolved refs, so also inspect raw relation fields.
    const fm = extractFrontmatter(r.rawContent)
    for (const key of ["parent", "supersedes", "superseded_by", "superseded-by"]) {
      for (const raw of (fm[key] ?? "").split(",").filter(Boolean)) resolveUnique(snapshot.records, raw.trim())
    }
  }
  const visited = new Set<string>(), stack = new Set<string>()
  const visit = (id: string, relation: "parentIds" | "supersededBy") => {
    if (stack.has(id)) throw new Error(`${relation === "parentIds" ? "Parent" : "Supersession"} cycle: ${id}`)
    if (visited.has(id)) return
    stack.add(id)
    const r = resolveUnique(snapshot.records, id)
    for (const ref of r[relation]) visit(ref, relation)
    stack.delete(id); visited.add(id)
  }
  for (const relation of ["parentIds", "supersededBy"] as const) {
    visited.clear(); stack.clear()
    snapshot.records.forEach(r => visit(r.id, relation))
  }
  for (const r of snapshot.records) {
    if (r.supersededBy.length && statusOf(r.status) !== "superseded") throw new Error(`Non-superseded record declares successors: ${r.id}`)
    for (const ref of r.supersededBy) {
      const successor = resolveUnique(snapshot.records, ref)
      if (!successor.supersedes.includes(r.id) || !["accepted", "superseded", "deprecated"].includes(statusOf(successor.status))) throw new Error(`Invalid reciprocal/accepted successor: ${r.id} -> ${ref}`)
    }
  }
}

function select(snapshot: Snapshot, options: CompactionOptions): NormalizedAdrRecord[] {
  if (options.domain && options.sources) throw new Error("--domain and --sources are mutually exclusive")
  const records = options.sources ? options.sources.map(id => resolveUnique(snapshot.records, id)) : snapshot.records.filter(r => !isArchived(r.sourcePath, snapshot.root) && (!options.domain || r.domain === options.domain))
  if (records.some(r => isArchived(r.sourcePath, snapshot.root))) throw new Error("Archived records cannot be implicit compaction targets")
  if (new Set(records.map(r => r.id)).size !== records.length) throw new Error("Duplicate selected source")
  return records
}

export function checkCompaction(project: string): string {
  const s = takeSnapshot(project), state = currentState(project, s), issues: string[] = []
  try { assertReadySources(s) } catch (err) { issues.push(String(err)) }
  for (const r of s.records) {
    for (const successor of r.supersededBy) {
      const other = s.records.find(x => x.id === successor)
      if (other && !other.supersedes.includes(r.id)) issues.push(`Non-reciprocal lineage: ${r.id} -> ${successor}`)
    }
    for (const predecessor of r.supersedes) {
      const other = s.records.find(x => x.id === predecessor)
      if (other && !other.supersededBy.includes(r.id)) issues.push(`Non-reciprocal lineage: ${predecessor} -> ${r.id}`)
    }
  }
  return JSON.stringify({ current: state.status, fingerprint: s.fingerprint, sources: s.records.length,
    roots: state.manifest?.views ? Object.keys(state.manifest.views) : [s.root],
    recovery: pendingRecovery(project), issues,
    limits: "Structural provenance/lineage check only; semantic preservation still requires human review. No writes or model calls.",
  }, null, 2)
}

export function analyzeCompaction(project: string, options: CompactionOptions = {}): string {
  const s = takeSnapshot(project), selected = select(s, options)
  const issues: string[] = []
  try { assertReadySources(s) } catch (err) { issues.push(String(err)) }
  const rows = selected.slice(0, 30).map(r => `${r.id} | ${statusOf(r.status)} | ${r.domain ?? "unclassified"} | ${Array.from(r.rawContent).length} chars`)
  return [`ADR compaction — read-only analysis`, `Root: ${s.root}; selected: ${selected.length}; total log: ${s.records.length}`, `Selected source characters: ${selected.reduce((n, r) => n + Array.from(r.rawContent).length, 0)} (not a token estimate).`, `CURRENT: ${currentState(project, s).status}. No model calls or writes.`, ...rows, ...(selected.length > 30 ? [`${selected.length - 30} more records; use --domain or --sources to narrow the preview.`] : []), ...issues, "Draft explicitly with --mode summary or --mode consolidate [--archive]. All current sources are evidence for a complete CURRENT view; only selected sources may be replaced."].join("\n")
}

function makeSlots(project: string, snapshot: Snapshot, options: CompactionOptions, count: number): Plan["slots"] {
  const cfg = getAdrConfig(project), style = options.style ?? cfg.style
  if (options.mode !== "consolidate") return []
  const iteration = options.baseline !== undefined || options.iteration !== undefined || cfg.numbering === "iteration"
  if (iteration && (!/^\d+\.\d+$/.test(options.baseline ?? "") || !/^\d+$/.test(options.iteration ?? ""))) throw new Error("Specify an approved --baseline N.N and --iteration N; numbering is never invented")
  const prefix = `${options.baseline}.${options.iteration}`
  if (iteration && snapshot.records.some(r => r.id === `ADR-${prefix}` || r.id.startsWith(`ADR-${prefix}.`))) throw new Error(`Iteration namespace already occupied: ${prefix}`)
  const max = Math.max(0, ...snapshot.records.map(r => /^ADR-\d{4}$/.test(r.id) ? Number(r.id.slice(4)) : 0))
  const date = new Date().toISOString().slice(0, 10)
  const n = iteration && style === "ocp" ? 1 : Math.max(1, count)
  return Array.from({ length: n }, (_, i) => {
    const id = iteration ? style === "ocp" ? prefix : `${prefix}.${String(i + 1).padStart(2, "0")}` : String(max + i + 1).padStart(4, "0")
    if (!iteration && max + i + 1 > 9999) throw new Error("Sequential ADR namespace exhausted")
    return { id: `ADR-${id}`, scaffold: getAdrStyleAdapter(style).scaffold({ id, title: "Consolidated decisions", status: "proposed", layer: "system", date, created: date, baseline: iteration ? options.baseline : undefined, iteration: iteration ? options.iteration : undefined, domain: options.domain }) }
  })
}

export function startCompaction(project: string, sessionID: string, options: CompactionOptions): Plan {
  if (!options.mode) throw new Error("Drafting requires --mode")
  if (options.mode === "summary" && (options.archive || options.style || options.baseline || options.iteration)) throw new Error("Summary mode rejects archive/style/numbering flags")
  return withMaintenanceLock(project, () => {
    if (pendingRecovery(project).length) throw new Error("Recover unfinished ADR transactions before drafting")
    const s = takeSnapshot(project); assertReadySources(s)
    const selected = select(s, options)
    if (!selected.length) throw new Error("No unarchived ADRs match the scope")
    const plan: Plan = {
      version: 1, id: `cp-${randomBytes(8).toString("hex")}`, sessionID, root: s.root, fingerprint: s.fingerprint, configHash: configHash(project),
      sourceHashes: Object.fromEntries(s.records.map(r => [r.sourcePath, digest(r.rawContent)])),
      options, selected: selected.map(r => r.id), evidencePaths: s.records.filter(r => !isArchived(r.sourcePath, s.root)).map(r => r.sourcePath), read: [],
      slots: makeSlots(project, s, options, selected.reduce((n, r) => n + decisionUnits(r).length, 0)), created: new Date().toISOString(), revision: 0, state: "drafting", kind: options.mode!,
    }
    save(project, plan)
    return plan
  })
}

function assertFresh(project: string, plan: Plan): Snapshot {
  const s = takeSnapshot(project)
  if (s.fingerprint !== plan.fingerprint || configHash(project) !== plan.configHash) throw new Error("ADR sources/configuration changed; create a new plan and review it")
  return s
}

export function compactionEvidence(project: string, id: string, session: string, cursor?: string) {
  return withMaintenanceLock(project, () => {
    const p = loadPlan(project, id, session), s = assertFresh(project, p)
    if (!["drafting", "review"].includes(p.state)) throw new Error("Plan is not open for evidence retrieval")
    const records = p.evidencePaths.map(path => resolveUnique(s.records, path))
    const page = evidencePage(records.map(r => recordEvidence(r, p.selected.includes(r.id) ? "selected for review" : "retain: CURRENT coverage only")), s.fingerprint, id, cursor)
    for (const item of page.entries) {
      // Consecutive delivered ranges, not a cursor at EOF, establish coverage.
      p.read.push(`${item.path}:${item.offset}:${item.end}`)
    }
    p.read = [...new Set(p.read)]
    save(project, p)
    return page
  })
}

/** Trusted user-event adapter only: permits model source ingestion, not decisions. */
export function approveDrafting(project: string, id: string, session: string, actor: string, cancelled = false): Plan {
  return withMaintenanceLock(project, () => {
    const p = loadPlan(project, id, session)
    assertFresh(project, p)
    if (p.state !== "drafting") throw new Error("Draft cost approval is no longer applicable")
    if (cancelled) p.state = "cancelled"
    else p.costApproval = { actor, at: new Date().toISOString() }
    save(project, p)
    return p
  })
}

function assertRead(plan: Plan, s: Snapshot): void {
  for (const path of plan.evidencePaths) {
    const length = Array.from(resolveUnique(s.records, path).rawContent).length
    const ranges = plan.read.filter(r => r.startsWith(`${path}:`)).map(r => r.slice(path.length + 1).split(":").map(Number)).sort((a, b) => a[0] - b[0])
    let end = 0
    for (const [start, stop] of ranges) { if (start > end) break; end = Math.max(end, stop) }
    if (end < length) throw new Error(`Evidence not fully retrieved: ${path}`)
  }
}

function parsedReplacement(project: string, p: Plan, item: Candidate["replacements"][number]): NormalizedAdrRecord {
  const cfg = getAdrConfig(project), style = p.options.style ?? cfg.style
  if (!p.slots.some(s => s.id === item.id)) throw new Error(`Unreserved replacement ID: ${item.id}`)
  const filename = renderAdrFilename(cfg.filenamePattern, item.id.slice(4), slugify(item.title, cfg.slugStyle) || "consolidated")
  const path = `${p.root}/${filename}`
  if (adrIdFromFilename(filename) !== item.id || !/^\d/.test(filename)) throw new Error("Filename pattern is not discoverable by the ADR engine; use a numeric-prefix pattern")
  if (readOptional(project, path) !== null) throw new Error(`Replacement target exists: ${path}`)
  const doc: AdrDocument = { fullPath: projectPath(project, path), relPath: path, filename, rawContent: item.content, frontmatter: extractFrontmatter(item.content) }
  if (doc.frontmatter.style !== style) throw new Error(`Replacement must declare style: ${style}`)
  if (statusOf(doc.frontmatter.status ?? "") !== "proposed") throw new Error("Replacement candidates must be proposed, never self-accepted")
  if (doc.frontmatter.supersedes || doc.frontmatter.superseded_by) throw new Error("Replacement relationships are generated from reviewed coverage, not candidate frontmatter")
  const adapter = getAdrStyleAdapter(style), record = adapter.parse(doc)
  const errors = adapter.validate(doc, record).filter(i => i.severity === "error")
  if (errors.length) throw new Error(errors.map(e => `${e.file}: ${e.message}`).join("\n"))
  if (record.id !== item.id || (style === "ocp" && !record.sections?.length)) throw new Error("Replacement identity/sections are invalid")
  if (record.sections?.some(s => statusOf(String(s.status)) !== "proposed")) throw new Error("New OCP sections must be proposed until user acceptance")
  return record
}

function flipSections(raw: string, status: "accepted" | "superseded"): string {
  return raw.replace(/^(\*\*Status\*\*(?:\s*[（(][^）)]*[）)])?\s*:\s*)([^\r\n]+)/gm, (whole, prefix: string, previous: string) => {
    if (status === "superseded" && !/\baccepted\b/i.test(previous)) return whole
    return `${prefix}${status === "accepted" ? "✅" : "🔄"} ${status}`
  })
}

export function stageCandidate(project: string, id: string, session: string, batch: string, input: unknown): Plan {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(batch)) throw new Error("Batch key must be 1–64 letters, digits, underscores or hyphens")
  return withMaintenanceLock(project, () => {
    const p = loadPlan(project, id, session)
    if (!["drafting", "review"].includes(p.state) || !["summary", "consolidate"].includes(p.kind)) throw new Error("Plan is not open for candidate batches")
    const s = assertFresh(project, p)
    const data = parseCandidateBatch(input)
    if (Array.from(JSON.stringify(data)).length > 12000) throw new Error("Candidate batch exceeds 12,000 codepoints; split it into smaller batches")
    if (p.kind === "summary" && data.replacements.length) throw new Error("Summary cannot stage replacement ADRs")
    const units = new Set(s.records.filter(r => p.evidencePaths.includes(r.sourcePath)).flatMap(decisionUnits))
    if (data.coverage.some(row => !units.has(row.source))) throw new Error("Batch coverage names an unknown source unit")
    if (data.replacements.some(r => !p.slots.some(slot => slot.id === r.id))) throw new Error("Batch replacement ID was not reserved")
    // Validate identity uniqueness across batches now; semantic/whole-source
    // validation still runs at submit, after every evidence page was delivered.
    const batches = { ...p.batches, [batch]: data }
    for (const keys of [Object.values(batches).flatMap(b => b.coverage.map(c => c.source)), Object.values(batches).flatMap(b => b.replacements.map(r => r.id))]) {
      if (new Set(keys).size !== keys.length) throw new Error("Duplicate source/replacement across candidate batches; replace its existing batch")
    }
    if (JSON.stringify(p.batches?.[batch]) === JSON.stringify(data)) return p
    p.batches = batches
    p.state = "drafting"; p.revision++
    // Invalidating a reviewed candidate is durable; even a late native reply
    // cannot authorize the previous review after one batch changes.
    delete p.seal; delete p.candidate; delete p.summary; delete p.changes
    delete p.archiveChanges; delete p.viewChanges; delete p.relocatedViews; delete p.blockers
    save(project, p)
    atomicWrite(project, `${maintenancePath(project)}/${p.id}.review.md`, `# Review invalidated\n\nCandidate batches changed for ${p.id}. Submit and obtain a new native Ask before applying.\n`)
    return p
  })
}

export function candidateBatchPage(project: string, id: string, session: string, cursor?: string) {
  const p = loadPlan(project, id, session)
  assertFresh(project, p)
  const batches = Object.entries(p.batches ?? {}).sort(([a], [b]) => a.localeCompare(b, "en"))
  const fingerprint = digest(JSON.stringify([p.fingerprint, p.revision, batches]))
  return evidencePage(batches.map(([key, data]) => ({ id: key, path: planFile(project, id), status: "draft", via: "unaccepted candidate batch", hash: digest(JSON.stringify(data)), body: JSON.stringify(data) })), fingerprint, `${id}:batches`, cursor)
}

export function submitCandidate(project: string, id: string, session: string, input?: unknown): Plan {
  return withMaintenanceLock(project, () => {
    const p = loadPlan(project, id, session), s = assertFresh(project, p)
    if (!["drafting", "review"].includes(p.state)) throw new Error("This plan is no longer editable")
    if (!["summary", "consolidate"].includes(p.kind)) throw new Error("Archive/restore plans cannot accept semantic candidates")
    assertRead(p, s)
    const batches = Object.entries(p.batches ?? {}).sort(([a], [b]) => a.localeCompare(b, "en")).map(([, value]) => value)
    const c = parseCandidate(input ?? {
      summary: batches.flatMap(b => b.summary), replacements: batches.flatMap(b => b.replacements), coverage: batches.flatMap(b => b.coverage),
    })
    if (p.kind === "summary" && c.replacements.length) throw new Error("Summary cannot create replacement ADRs")
    const replacement = c.replacements.map(item => parsedReplacement(project, p, item))
    if (new Set(replacement.map(r => r.id)).size !== replacement.length) throw new Error("Duplicate replacement ID")
    const expected = s.records.filter(r => p.evidencePaths.includes(r.sourcePath)).flatMap(decisionUnits)
    if (c.coverage.length !== expected.length || new Set(c.coverage.map(x => x.source)).size !== expected.length || c.coverage.some(x => !expected.includes(x.source))) throw new Error("Coverage must account for every source decision unit exactly once")
    const changes: FileChange[] = [], retired: string[] = []
    const projected = s.records.map(r => ({ ...r }))
    for (const r of projected) {
      const coverage = c.coverage.filter(x => decisionUnits(r).includes(x.source))
      const replacing = coverage.filter(x => x.disposition === "replace")
      for (const row of coverage) {
        if (row.disposition !== "replace" && row.targets.length) throw new Error(`Only replacement coverage may name new targets: ${row.source}`)
        if (row.disposition === "historical" && !isRetired(r) && !(r.sections?.find(sec => sec.id === row.source) && ["superseded", "deprecated", "rejected"].includes(statusOf(String(r.sections.find(sec => sec.id === row.source)!.status))))) throw new Error(`Live constraint cannot be silently classified historical: ${row.source}`)
      }
      if (!replacing.length) continue
      if (p.kind !== "consolidate" || !p.selected.includes(r.id)) throw new Error(`Cannot replace evidence outside selected scope: ${r.id}`)
      if (statusOf(r.status) !== "accepted" || r.sections?.some(sec => !["accepted", "superseded", "deprecated", "rejected"].includes(statusOf(String(sec.status))))) throw new Error(`Only resolved accepted records may be consolidated: ${r.id}`)
      if (r.sections && replacing.some(row => statusOf(String(r.sections!.find(sec => sec.id === row.source)?.status)) !== "accepted")) throw new Error(`Historical sections cannot be implicitly reaccepted: ${r.id}`)
      if (coverage.some(x => !["replace", "historical"].includes(x.disposition))) throw new Error(`Partial replacement is unresolved; retain the whole source: ${r.id}`)
      const targets = [...new Set(replacing.flatMap(x => x.targets))]
      if (!targets.length || targets.some(id => !replacement.some(n => n.id === id))) throw new Error(`Invalid replacement mapping: ${r.id}`)
      for (const row of replacing) if (!row.targets.length) throw new Error(`Missing target: ${row.source}`)
      const before = r.rawContent
      r.status = "superseded"; r.supersededBy = targets
      r.rawContent = setFrontmatter(setFrontmatter(before, "status", "superseded"), "superseded_by", targets.join(", "))
      if (r.sections) { r.rawContent = flipSections(r.rawContent, "superseded"); r.sections = r.sections.map(sec => statusOf(String(sec.status)) === "accepted" ? { ...sec, status: "superseded" } : sec) }
      changes.push({ path: r.sourcePath, before, after: r.rawContent }); retired.push(r.id)
    }
    for (const r of replacement) {
      const sources = projected.filter(old => retired.includes(old.id) && old.supersededBy.includes(r.id)).map(old => old.id)
      if (!sources.length) throw new Error(`Replacement has no fully covered predecessors: ${r.id}`)
      r.rawContent = acceptedAdrContent(setFrontmatter(r.rawContent, "supersedes", sources.join(", ")))
      if (r.sections) { r.rawContent = flipSections(r.rawContent, "accepted"); r.sections = r.sections.map(sec => ({ ...sec, status: "accepted" })) }
      r.status = "accepted"; r.supersedes = sources
      changes.push({ path: r.sourcePath, before: null, after: r.rawContent }); projected.push(r)
    }
    const live = projected.filter(r => !isArchived(r.sourcePath, p.root) && !isRetired(r))
    const allowed = projected.flatMap(r => [r.id, ...decisionUnits(r)])
    for (const item of c.summary) if (item.sources.some(id => !allowed.includes(id))) throw new Error("CURRENT has an unknown source reference")
    for (const r of live) for (const unit of r.sections?.length ? r.sections.filter(sec => !["superseded", "deprecated", "rejected"].includes(statusOf(String(sec.status)))).map(sec => sec.id) : [r.id]) if (!c.summary.some(item => item.sources.includes(unit))) throw new Error(`CURRENT omits a live decision unit: ${unit}`)
    if (p.kind === "consolidate" && !replacement.length) throw new Error("Nothing to consolidate; use summary mode or retain the sources")
    p.changes = changes
    p.blockers = []; p.archiveChanges = []; p.viewChanges = []; p.relocatedViews = []
    try {
      // Never publish the optimistic in-memory lifecycle if the actual Markdown
      // parses differently (e.g. duplicate/indented status fields). Check the
      // bytes that will be written with the same style adapters as discovery.
      for (const r of projected.filter(r => changes.some(c => c.path === r.sourcePath))) {
        const actual = getAdrStyleAdapter(r.style).parse({ fullPath: projectPath(project, r.sourcePath), relPath: r.sourcePath, filename: basename(r.sourcePath), rawContent: r.rawContent, frontmatter: extractFrontmatter(r.rawContent) }, {
          resolveRef: ref => resolveUnique(projected, ref).id,
        })
        const lifecycle = (record: NormalizedAdrRecord) => JSON.stringify({ status: statusOf(record.status), sections: record.sections?.map(sec => [sec.id, statusOf(String(sec.status))]), supersedes: record.supersedes, supersededBy: record.supersededBy })
        if (lifecycle(actual) !== lifecycle(r)) throw new Error(`Serialized lifecycle does not match reviewed status/lineage: ${r.id}`)
      }
      assertReadySources(snapshotForRecords(project, s.root, projected))
      p.archiveChanges = p.options.archive ? planArchiveChanges(project, projected, retired, new Map(changes.filter(x => x.after !== null).map(x => [x.path, x.after!]))) : []
      const projectedSnapshot = snapshotForRecords(project, s.root, projected)
      p.viewChanges = planPublication(project, projectedSnapshot, c.summary)
      p.relocatedViews = p.archiveChanges.length ? planPublication(project, archiveProjection(project, projectedSnapshot, p.archiveChanges), c.summary, p.viewChanges) : []
    } catch (err) {
      // A publication/move blocker must not prevent inspection or saving valid
      // proposed successors. No acceptance option is registered while blocked.
      p.blockers.push(String(err))
    }
    if (input !== undefined) delete p.batches
    p.candidate = c; p.summary = c.summary; p.revision++; p.state = "review"
    p.seal = sealPlan(p)
    save(project, p)
    atomicWrite(project, `${maintenancePath(project)}/${p.id}.review.md`, renderReview(p))
    return p
  })
}

export function sealPlan(p: Plan): string {
  return digest(JSON.stringify({ id: p.id, fingerprint: p.fingerprint, configHash: p.configHash, revision: p.revision, sourceHashes: p.sourceHashes, candidate: p.candidate, changes: p.changes, archive: p.archiveChanges, summary: p.summary, blockers: p.blockers, views: p.viewChanges, relocatedViews: p.relocatedViews, kind: p.kind }))
}
export function renderReview(p: Plan): string {
  return `# ADR compaction review ${p.id}\n\nRevision: ${p.revision}\nSeal: ${p.seal}\nMode: ${p.kind}\n\n` +
    (p.blockers?.length ? `## Execution blockers\n\n${p.blockers.join("\n")}\n\nOnly inspect, revise, cancel, or save proposed drafts; acceptance is disabled.\n\n` : "") +
    (p.candidate ? `## Coverage and deliberate changes\n\n${p.candidate.coverage.map(c => `- ${c.source}: ${c.disposition} -> ${c.targets.join(", ") || "unchanged"}. ${c.note}`).join("\n")}\n\n` : "") +
    (p.summary ? `## Proposed CURRENT\n\n${renderCurrent(p.summary)}\n` : "") +
    [...(p.changes ?? []), ...(p.viewChanges ?? []), ...(p.archiveChanges ?? []), ...(p.relocatedViews ?? [])].map(c => `## ${c.path}\n\n### Before\n\n${c.before ?? "(absent)"}\n\n### After\n\n${c.after ?? "(removed)"}\n`).join("\n") +
    "\nArchival preserves history but may break external links; repository-local supported links are repaired. Review all changes before accepting.\n"
}

export function reviewPage(project: string, id: string, session: string, cursor?: string) {
  const p = loadPlan(project, id, session)
  if (!p.seal) throw new Error("Submit a complete candidate before review")
  return evidencePage([{ id, path: `${maintenancePath(project)}/${id}.review.md`, status: p.state, via: "review artifacts", hash: p.seal, body: renderReview(p) }], p.seal, `${id}:review`, cursor)
}

export function planArchive(project: string, session: string, sources?: string[], restore?: string): Plan {
  return withMaintenanceLock(project, () => {
    if (pendingRecovery(project).length) throw new Error("Recover pending transactions first")
    const s = takeSnapshot(project); assertReadySources(s)
    let changes: FileChange[], selected: string[]
    if (restore) {
      const original = loadPlan(project, restore)
      const journalRaw = readOptional(project, `${maintenancePath(project)}/${restore}.archive.json`)
      if (!journalRaw || !JSON.parse(journalRaw).complete || !original.archiveChanges?.length) throw new Error("No completed archive transaction to restore")
      changes = inverseArchive(original.archiveChanges); selected = original.selected
    } else {
      selected = sources ?? s.records.filter(r => !isArchived(r.sourcePath, s.root) && isRetired(r)).map(r => r.id)
      changes = planArchiveChanges(project, s.records, selected)
    }
    for (const c of changes) if (readOptional(project, c.path) !== c.before) throw new Error(`Changed archive/restore input: ${c.path}`)
    const p: Plan = { version: 1, id: `cp-${randomBytes(8).toString("hex")}`, sessionID: session, fingerprint: s.fingerprint, root: s.root, configHash: configHash(project), sourceHashes: Object.fromEntries(s.records.map(r => [r.sourcePath, digest(r.rawContent)])), options: {}, selected, evidencePaths: [], read: [], slots: [], created: new Date().toISOString(), revision: 1, state: "review", kind: restore ? "restore" : "archive", changes: [], archiveChanges: changes }
    const existing = currentState(project, s)
    if (existing.status === "fresh") p.summary = existing.manifest!.items
    p.relocatedViews = planPublication(project, archiveProjection(project, s, changes), p.summary)
    p.seal = sealPlan(p); save(project, p)
    atomicWrite(project, `${maintenancePath(project)}/${p.id}.review.md`, renderReview(p))
    return p
  })
}

function archiveProjection(project: string, s: Snapshot, changes: FileChange[]): Snapshot {
  const records = s.records.map(r => {
    const change = changes.find(c => c.path === r.sourcePath)
    if (!change) return r
    const destination = change.after === null ? changes.find(c => c.before === null && c.after !== null && adrIdFromFilename(basename(c.path)) === r.id) : change
    if (!destination?.after) throw new Error(`Missing archive counterpart: ${r.id}`)
    return { ...r, sourcePath: destination.path, rawContent: destination.after }
  })
  return snapshotForRecords(project, s.root, records)
}

/** Recovery permits only original or explicitly planned source states. New or
 * edited unrelated ADRs must never be blessed by a recomputed CURRENT fingerprint. */
function assertRecoverySources(project: string, p: Plan): void {
  if (configHash(project) !== p.configHash) throw new Error("Configuration changed during recovery")
  const allowed = new Map<string, Set<string | null>>(Object.entries(p.sourceHashes).map(([path, hash]) => [path, new Set([hash])]))
  for (const c of [...(p.changes ?? []), ...(p.archiveChanges ?? [])]) {
    if (!adrIdFromFilename(basename(c.path))) continue
    const hashes = allowed.get(c.path) ?? new Set<string | null>()
    hashes.add(c.before === null ? null : digest(c.before)); hashes.add(c.after === null ? null : digest(c.after))
    const candidate = p.candidate?.replacements.find(r => r.id === adrIdFromFilename(basename(c.path)))
    if (candidate) hashes.add(digest(candidate.content))
    allowed.set(c.path, hashes)
  }
  for (const [path, hashes] of allowed) {
    const current = readOptional(project, path)
    if (!hashes.has(current === null ? null : digest(current))) throw new Error(`Unplanned source change during recovery: ${path}`)
  }
  for (const r of takeSnapshot(project).records) if (!allowed.has(r.sourcePath)) throw new Error(`New ADR appeared during recovery: ${r.sourcePath}`)
}

/** ONLY call from verified native question events or a user command hook. */
export function applyPlan(project: string, id: string, seal: string, actor: string, choice: "accept" | "drafts" | "cancel"): Plan {
  return withMaintenanceLock(project, () => {
    const p = loadPlan(project, id)
    if (p.seal !== seal || sealPlan(p) !== seal) throw new Error("Reviewed plan changed; request a fresh Ask")
    if (p.state === "complete" || p.state === "drafts" || p.state === "cancelled") return p
    if (p.state === "applying" && (p.approval?.seal !== seal || p.approval.choice !== choice)) throw new Error("Resume must retain the exact authorized choice")
    if (choice === "cancel") { p.state = "cancelled"; save(project, p); return p }
    if (choice === "accept" && p.blockers?.length) throw new Error(`Plan has execution blockers: ${p.blockers.join("; ")}`)
    if (choice === "drafts" && p.kind !== "consolidate") throw new Error("Save drafts only applies to consolidation")
    const recovering = p.state === "applying"
    if (!recovering) {
      if (pendingRecovery(project).length) throw new Error("Recover unfinished ADR transactions before applying another plan")
      if (p.state !== "review") throw new Error("Plan has no reviewed candidate")
      assertFresh(project, p)
      for (const c of p.changes ?? []) if (readOptional(project, c.path) !== c.before) throw new Error(`Changed input: ${c.path}`)
      if (choice === "accept") {
        for (const c of p.archiveChanges ?? []) {
          const projected = p.changes?.find(x => x.path === c.path)?.after
          if ((projected ?? readOptional(project, c.path)) !== c.before) throw new Error(`Archive link/target changed: ${c.path}`)
        }
        for (const c of p.viewChanges ?? []) if (readOptional(project, c.path) !== c.before) throw new Error(`Reviewed view changed: ${c.path}`)
        for (const c of p.relocatedViews ?? []) {
          const prior = p.viewChanges?.find(v => v.path === c.path)
          if (readOptional(project, c.path) !== (prior ? prior.before : c.before)) throw new Error(`Reviewed post-archive view changed: ${c.path}`)
        }
        const current = currentState(project)
        if (p.summary && current.status === "invalid") throw new Error("CURRENT is modified or user-owned; reconcile it before publishing")
      }
      p.ledgerBefore = readOptional(project, decisionsLedgerRelative(project))
      p.approval = { actor, choice, seal, at: new Date().toISOString() }; p.state = "applying"; save(project, p)
    } else {
      assertRecoverySources(project, p)
    }
    const effectiveChoice = p.approval!.choice
    if (effectiveChoice === "drafts") {
      if (p.kind !== "consolidate") throw new Error("Save drafts only applies to consolidation")
      const changes = (p.changes ?? []).filter(c => c.before === null && c.after !== null).map(c => {
        // Use the submitted proposed content, without authoritative supersedes.
        const ref = adrIdFromFilename(basename(c.path))
        const item = p.candidate!.replacements.find(r => r.id === ref)!
        return { ...c, after: item.content }
      })
      applyJournal(project, `${maintenancePath(project)}/${id}.drafts.json`, changes)
      p.state = "drafts"; p.result = "Proposed drafts saved. Original decisions unchanged; CURRENT may now be stale."; save(project, p); return p
    }
    // Accepted successors must exist before any predecessor is retired.
    const lifecycle = [...(p.changes ?? [])].sort((a, b) => Number(a.before !== null) - Number(b.before !== null))
    const accepted = lifecycle.filter(c => c.before === null && c.after !== null).map(c => ({ id: adrIdFromFilename(basename(c.path))!, path: c.path }))
    if (accepted.length) {
      const before = p.ledgerBefore
      if (before !== null && typeof before !== "string") throw new Error("Missing approved ledger baseline; reconcile recovery state")
      const at = p.approval!.at
      const lines = accepted.map(r => decisionLedgerEntry(r.id, r.path, `compaction ${id}; ${p.approval!.actor}`, at)).join("")
      lifecycle.unshift({ path: decisionsLedgerRelative(project), before, after: (before ?? "") + lines })
    }
    applyJournal(project, `${maintenancePath(project)}/${id}.lifecycle.json`, lifecycle)
    const decided = readDecidedIds(project)
    if (accepted.some(r => !decided.has(r.id))) throw new Error("Accepted lifecycle is missing its audit ledger; reconcile the journal before continuing")
    // Exact reviewed view bytes are journaled separately from decision acceptance.
    if (p.viewChanges?.length) applyJournal(project, `${maintenancePath(project)}/${id}.views.json`, p.viewChanges)
    if (p.archiveChanges?.length) {
      applyJournal(project, `${maintenancePath(project)}/${id}.archive.json`, p.archiveChanges)
      if (p.relocatedViews?.length) applyJournal(project, `${maintenancePath(project)}/${id}.relocated-views.json`, p.relocatedViews)
    }
    p.state = "complete"; p.result = "Decision lifecycle, CURRENT/index updates, and authorized archive operations completed."; save(project, p)
    return p
  })
}
