/**
 * Multi-view ADL — directory-mirroring indexes, deterministic logical
 * tree views, history traversal, and bounded context bundles
 * (Phase 4, §9.1 progressive disclosure / §9.3 indexes / §9.4 tree,
 * history, context).
 *
 * Everything here is a pure function over NormalizedAdrRecord[] — file
 * discovery and writes stay in adr-engine.ts (one-direction imports:
 * engine → views → evolution). The generated artifacts are deterministic
 * derivations of the records: regenerating over an unchanged ADL yields
 * byte-identical output (idempotent), and no generated file is ever a
 * hand-maintained source of truth.
 */

import { adrTextCollator, normalizeAdrId, type NormalizedAdrRecord } from "./adr-types"
import { byCreatedThenPath, groupByIteration, matchesIteration } from "./adr-evolution"
import { getAdrStyleAdapter } from "./adr-style-registry"

// ─── Directory tree (§9.3 — indexes mirror the ADR tree) ─────────────

export interface AdrTreeNode {
  /** POSIX relative directory (e.g. `docs/adr/domains/commission`). */
  relDir: string
  parent: AdrTreeNode | null
  /** Records located DIRECTLY in this directory (never descendants). */
  records: NormalizedAdrRecord[]
  children: AdrTreeNode[]
}

/**
 * Build the ADR directory tree from normalized records. Every directory
 * that contains at least one record becomes a node; a node's parent is
 * the nearest ancestor directory that also contains records (intermediate
 * directories without records get no index — §9.3). The designated ADL
 * root is always present, even when empty. Roots (no record-bearing
 * ancestor, e.g. `packages/x/docs/adr`) form a forest.
 */
export function buildAdrTree(records: NormalizedAdrRecord[], rootRel: string): AdrTreeNode[] {
  const root = rootRel.replace(/\\/g, "/").replace(/\/+$/, "")
  const dirs = new Set<string>([root])
  for (const record of records) {
    dirs.add(dirnamePosix(record.sourcePath))
  }

  const sortedDirs = Array.from(dirs).sort()
  const nodes = new Map<string, AdrTreeNode>()
  for (const dir of sortedDirs) {
    nodes.set(dir, { relDir: dir, parent: null, records: [], children: [] })
  }

  const forest: AdrTreeNode[] = []
  for (const dir of sortedDirs) {
    const node = nodes.get(dir)
    if (!node) continue
    let parent: AdrTreeNode | null = null
    for (const other of sortedDirs) {
      if (other === dir || !dir.startsWith(`${other}/`)) continue
      if (parent === null || other.length > parent.relDir.length) {
        parent = nodes.get(other) ?? null
      }
    }
    node.parent = parent
    if (parent) {
      parent.children.push(node)
    } else {
      forest.push(node)
    }
  }

  for (const record of records) {
    const node = nodes.get(dirnamePosix(record.sourcePath))
    node?.records.push(record)
  }
  for (const node of nodes.values()) {
    node.records.sort(byCreatedThenPath)
    node.children.sort((a, b) => adrTextCollator.compare(a.relDir, b.relDir))
  }
  // Stable forest order: the designated root first, then other roots by path.
  forest.sort((a, b) => (a.relDir === root ? -1 : b.relDir === root ? 1 : adrTextCollator.compare(a.relDir, b.relDir)))
  return forest
}

/** Total record count in a node's subtree (direct + descendants). */
export function subtreeRecordCount(node: AdrTreeNode): number {
  let count = node.records.length
  for (const child of node.children) {
    count += subtreeRecordCount(child)
  }
  return count
}

function dirnamePosix(path: string): string {
  const normalized = path.replace(/\\/g, "/")
  const idx = normalized.lastIndexOf("/")
  return idx === -1 ? "." : normalized.slice(0, idx)
}

/** POSIX relative link from one directory to another's INDEX.md. */
function indexRelLink(fromDir: string, toDir: string): string {
  const from = fromDir.split("/")
  const to = toDir.split("/")
  let common = 0
  while (common < from.length && common < to.length && from[common] === to[common]) common++
  const segments = [...Array<string>(from.length - common).fill(".."), ...to.slice(common)]
  return `${segments.join("/")}/INDEX.md`
}

// ─── Generated directory indexes (§9.3) ──────────────────────────────

const DEFAULT_INDEX_COLUMNS = [
  "id",
  "title",
  "style",
  "layer",
  "status",
  "domain",
  "iteration",
  "created",
] as const

const COLUMN_HEADERS: Record<string, string> = {
  id: "ID",
  title: "Decision Title",
  style: "Style",
  layer: "Layer",
  status: "Status",
  domain: "Domain",
  iteration: "Iteration",
  created: "Created",
}

/** Project-level column projection — every adapter renders the same
 * shape given the same column set, so the unified row stays valid. */
export type IndexColumn =
  | "id"
  | "title"
  | "style"
  | "layer"
  | "status"
  | "domain"
  | "iteration"
  | "created"

function buildIndexHeader(columns: readonly IndexColumn[]): string {
  return (
    `| ${columns.map((c) => COLUMN_HEADERS[c] ?? c).join(" | ")} |\n` +
    `| ${columns.map(() => ":---").join(" | ")} |\n`
  )
}

/**
 * Render one directory's generated INDEX.md. Local indexes list ONLY the
 * records directly in that directory plus concise child-directory
 * summaries — descendants are never flattened into every level (§9.3).
 * The root index is the ADL entry point: its own records (the global /
 * system decisions) come first, then child scope links. Every index
 * carries a parent link (when applicable) and a generated-file banner.
 * Pure + deterministic → byte-stable regeneration.
 *
 * `columns` is the project-supplied column set from `adr.indexColumns`
 * (Phase 7); when omitted, the canonical 8-column shape is used and the
 * output stays byte-identical to pre-Phase-7 renderings.
 */
export function renderAdlIndex(node: AdrTreeNode, columns: readonly IndexColumn[] = DEFAULT_INDEX_COLUMNS): string {
  let out = `# Architecture Decision Log\n\n`
  out += `> ⚠️ **GENERATED INDEX — DO NOT EDIT BY HAND.** This file is regenerated from the\n`
  out += `> ADR records in this directory and its subtree (§9.3). Any hand edit is overwritten\n`
  out += `> on the next regeneration — change the records instead. It is a navigation aid,\n`
  out += `> never a hand-maintained source of truth.\n\n`

  out += `*Directory: \`${node.relDir}\`*\n`

  if (node.parent) {
    out += `\n**Parent:** [${node.parent.relDir}](${indexRelLink(node.relDir, node.parent.relDir)})\n`
  }

  out += `\n## Records (${node.records.length})\n\n`
  if (node.records.length === 0) {
    out += `*(No records in this directory.)*\n`
  } else {
    out += buildIndexHeader(columns)
    for (const record of node.records) {
      out += renderUnifiedIndexRow(record, columns) + `\n`
    }
  }

  if (node.children.length > 0) {
    out += `\n## Child scopes\n\n`
    out += `| Directory | Records (subtree) | Index |\n`
    out += `| :--- | :--- | :--- |\n`
    for (const child of node.children) {
      out += `| [${child.relDir.slice(node.relDir.length + 1)}](${indexRelLink(node.relDir, child.relDir)}) | ${subtreeRecordCount(child)} | \`${child.relDir}/INDEX.md\` |\n`
    }
  }

  return out
}

/**
 * One unified index row via the record's own style adapter
 * (registry dispatch) — the same style-aware link rendering every
 * adapter ships. Row shape (§9.3): ID, title, style, status, source
 * link, optional layer/domain/iteration. `columns` lets a project
 * narrow or reorder the projection; columns not produced by an
 * adapter's renderIndexEntry are filled with an empty cell.
 */
export function renderUnifiedIndexRow(
  record: NormalizedAdrRecord,
  columns: readonly IndexColumn[] = DEFAULT_INDEX_COLUMNS,
): string {
  // Delegate to the adapter so per-style formatting (e.g. Nygard's badge
  // text) stays style-true, then project onto the requested columns by
  // removing columns the project dropped. The adapter's full row carries
  // all 8 columns in the canonical order, so we map by token presence.
  const fullRow = getAdrStyleAdapter(record.style).renderIndexEntry(record)
  const cells = splitRow(fullRow)
  const canonicalCells = mapRowToCanonical(cells, record)
  const projected = columns.map((c) => canonicalCells[c] ?? "").join(" | ")
  return `| ${projected} |`
}

/** Split a `| a | b | c |` row into raw cells (length 9 incl. outer empties). */
function splitRow(row: string): string[] {
  // Drop leading/trailing pipe + split on ` | ` for clean cells.
  return row.replace(/^\s*\||\|\s*$/g, "").split(/\s*\|\s*/)
}

/** Map the canonical 8-cell adapter row to a {column: value} object. */
function mapRowToCanonical(cells: string[], record: NormalizedAdrRecord): Record<string, string> {
  // Every adapter ships the same 8-column shape:
  // [id, title, style, layer, status, domain, iteration, created]
  // so we can read by position safely. `cells` carries the trim-aware
  // pieces from splitRow (it splits on `\s*\|\s*`, so each cell is
  // already trimmed); the missing-cell fallbacks rebuild from the
  // record to keep a malformed adapter row self-healing.
  const filename = record.sourcePath.split("/").pop() ?? record.sourcePath
  const trim = (s: string | undefined): string => (s ?? "").trim()
  return {
    id: trim(cells[0]) || `[${record.id}](./${filename})`,
    title: trim(cells[1]) || record.title,
    style: trim(cells[2]) || `\`${record.style}\``,
    layer: trim(cells[3]) || `\`${record.layer ?? "system"}\``,
    status: trim(cells[4]) || String(record.status),
    domain: trim(cells[5]) || record.domain || "",
    iteration: trim(cells[6]) || record.iteration || "",
    created: trim(cells[7]) || record.created || record.date || "",
  }
}

// ─── Tree views (§9.4 — `/adr tree [--by path|layer|domain|iteration]`) ──

export type AdrTreeGroupBy = "path" | "layer" | "domain" | "iteration"

export const ADR_TREE_GROUP_BY: readonly AdrTreeGroupBy[] = ["path", "layer", "domain", "iteration"]

const LAYER_ORDER = ["system", "domain", "component"] as const

function recordLine(record: NormalizedAdrRecord): string {
  return `- [${record.id}] ${record.title} — \`${record.style}\`, ${String(record.status)} — \`${record.sourcePath}\``
}

/**
 * Render a deterministic logical view of the whole ADL. `path` mirrors
 * the directory tree; `layer` / `domain` / `iteration` group by the
 * normalized metadata (iteration via the `iteration` field, never ID
 * parsing — §6.1 rule 6). Groups and records sort stably, so two runs
 * over the same records produce identical bytes.
 */
export function renderTreeView(records: NormalizedAdrRecord[], rootRel: string, by: AdrTreeGroupBy): string {
  const sorted = records.slice().sort(byCreatedThenPath)
  let out = `### ADR tree — by ${by} (${sorted.length} record${sorted.length === 1 ? "" : "s"})\n`

  if (by === "path") {
    const forest = buildAdrTree(sorted, rootRel)
    const renderNode = (node: AdrTreeNode, prefix: string): string => {
      let block = `\n${prefix}${node.relDir}/ (${node.records.length} record${node.records.length === 1 ? "" : "s"})\n`
      for (const record of node.records) {
        block += `${prefix}${recordLine(record)}\n`
      }
      for (const child of node.children) {
        block += renderNode(child, `${prefix}  `)
      }
      return block
    }
    for (const node of forest) {
      out += renderNode(node, "")
    }
    return out
  }

  if (by === "layer") {
    for (const layer of LAYER_ORDER) {
      const group = sorted.filter((r) => (r.layer ?? "system") === layer)
      out += `\n#### ${layer} (${group.length})\n\n`
      for (const record of group) {
        out += `${recordLine(record)}\n`
      }
    }
    return out
  }

  if (by === "domain") {
    const keys = Array.from(new Set(sorted.map((r) => r.domain ?? ""))).sort((a, b) => {
      // Ungrouped records always come last.
      if (a === "") return 1
      if (b === "") return -1
      return adrTextCollator.compare(a, b)
    })
    for (const key of keys) {
      const group = sorted.filter((r) => (r.domain ?? "") === key)
      out += `\n#### ${key === "" ? "(no domain)" : `\`${key}\``} (${group.length})\n\n`
      for (const record of group) {
        out += `${recordLine(record)}\n`
      }
    }
    return out
  }

  // by === "iteration"
  const groups = groupByIteration(sorted)
  const grouped = new Set(groups.flatMap((g) => g.records.map((r) => r.id)))
  for (const group of groups) {
    out += `\n#### Iteration \`${group.iteration}\` (${group.records.length})\n\n`
    for (const record of group.records) {
      out += `${recordLine(record)}\n`
    }
  }
  const rest = sorted.filter((r) => !grouped.has(r.id))
  if (rest.length > 0) {
    out += `\n#### No iteration metadata (${rest.length})\n\n`
    for (const record of rest) {
      out += `${recordLine(record)}\n`
    }
  }
  return out
}

// ─── History traversal (§9.4 — `/adr history <ADR-ID>`) ──────────────

export interface AdrHistoryEntry {
  record: NormalizedAdrRecord
  relation: "predecessor" | "target" | "successor"
  /** Human-readable edge label, e.g. `superseded by ADR-0003`. */
  via: string
}

export interface AdrHistory {
  target: NormalizedAdrRecord
  /** Chronological chain: predecessors (oldest first), target, successors. */
  entries: AdrHistoryEntry[]
  /** Supersession edges pointing at records absent from the ADL. */
  unresolved: string[]
}

/** Resolve an ID form (`0001`, `ADR-0001`, `0.2.54`, `0.2.54#01`) or a
 * source path. Section-ID fallback (ADR-0007 §7 amendment): a `#`-form
 * ref addresses a section inside an ocp container, and the graph operates
 * at CONTAINER granularity — resolve to the container record so `/adr
 * history ADR-x#NN` and `/adr context` work without fabricating
 * section-level graph nodes. Dotted 4-segment refs are the PER-DECISION
 * RECORD grammar and get NO fallback: no such record → null, so prose
 * references stay unambiguous (`x.y.z.qq` = record, `x.y.z#qq` = section). */
export function resolveRecordByRef(records: NormalizedAdrRecord[], ref: string): NormalizedAdrRecord | null {
  const clean = ref.trim().replace(/^["']|["']$/g, "")
  if (!clean) return null
  const byPath = records.find((r) => r.sourcePath === clean || r.sourcePath.endsWith(`/${clean}`))
  if (byPath) return byPath
  const canonical = normalizeAdrId(clean)
  if (!canonical) return null
  const byId = records.find((r) => r.id === canonical)
  if (byId) return byId
  const bare = canonical.replace(/^ADR-/, "")
  const hashIdx = bare.indexOf("#")
  if (hashIdx !== -1 && /^(\d{4}|\d+\.\d+\.\d+)$/.test(bare.slice(0, hashIdx))) {
    const containerId = `ADR-${bare.slice(0, hashIdx)}`
    return records.find((r) => r.id === containerId) ?? null
  }
  return null
}

// ─── Section-level annotation edges (§7 amendment) ───────────────────
// Section bodies carry prose cross-references between sub-decisions
// ("supersedes ADR-x#NN"). Relation keywords are ENGLISH GRAMMAR — the
// same policy as field labels: the tool understands one canonical
// vocabulary, content authors use it for cross-reference clauses.
// These are ANNOTATION-GRADE relations — deliberately NOT graph edges (the
// graph stays at container granularity) — but surfacing them in /adr
// history makes the partial-supersession web readable. Pure derivation,
// deterministic order.

export interface AdrSectionEdge {
  /** Canonical section ID the reference originates from. */
  from: string
  fromTitle: string
  /** Referenced section ID (`#`-form; unresolved targets still listed). */
  to: string
  /** Container of the referenced section — for chain filtering. */
  toContainer: string
  relation: "supersedes" | "amends"
  via: string
}

const SECTION_EDGE_RE = /\b(supersedes|amends|revises)\s+(ADR-(?:\d{4}|\d+\.\d+\.\d+)#\d{1,})\b/gi

/** Container ID of a `#`-form section reference. */
function containerOfRef(ref: string): string {
  const bare = ref.replace(/^ADR-/, "")
  return `ADR-${bare.slice(0, bare.indexOf("#"))}`
}

export function buildSectionEdges(records: NormalizedAdrRecord[]): AdrSectionEdge[] {
  const edges: AdrSectionEdge[] = []
  for (const record of records) {
    for (const section of record.sections ?? []) {
      const text = [
        section.background,
        section.decision,
        section.rationale,
        ...(section.rejected ?? []).map((r) => `${r.option} ${r.reason}`),
        ...(section.impact ?? []),
      ]
        .filter(Boolean)
        .join("\n")
      SECTION_EDGE_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = SECTION_EDGE_RE.exec(text)) !== null) {
        const keyword = m[1].toLowerCase()
        const relation: AdrSectionEdge["relation"] = keyword === "supersedes" ? "supersedes" : "amends"
        const to = m[2].toUpperCase()
        edges.push({
          from: section.id,
          fromTitle: section.title,
          to,
          toContainer: containerOfRef(to),
          relation,
          via: `${record.id} ${section.seq} "${m[1]} ${m[2]}"`,
        })
      }
    }
  }
  edges.sort((a, b) => adrTextCollator.compare(a.from, b.from) || adrTextCollator.compare(a.to, b.to))
  return edges
}

/**
 * Traverse the normalized supersession relationships around a target:
 * backward along `supersedes`, forward along `supersededBy` (plus the
 * inverse of every record's `supersedes`, so a chain renders fully even
 * when only the successor's frontmatter was updated). Deterministic:
 * breadth-first, record ID as tiebreak, predecessors reversed into
 * chronological order. Returns null when the reference resolves to
 * nothing.
 */
export function buildAdrHistory(records: NormalizedAdrRecord[], ref: string): AdrHistory | null {
  const target = resolveRecordByRef(records, ref)
  if (!target) return null

  const byId = new Map(records.map((r) => [r.id, r]))
  // Forward edges come from BOTH the target's supersededBy list and the
  // inverse of every record's supersedes list — a chain renders fully
  // even when only the successor's frontmatter was updated.
  const forwardEdges = new Map<string, string[]>()
  for (const record of records) {
    for (const supersedesId of record.supersedes) {
      const key = normalizedOrRaw(supersedesId)
      const list = forwardEdges.get(key) ?? []
      list.push(record.id)
      forwardEdges.set(key, list)
    }
  }

  const unresolved: string[] = []
  const predecessors: AdrHistoryEntry[] = []
  const successors: AdrHistoryEntry[] = []
  const seen = new Set<string>([target.id])

  const backwardFrontier: NormalizedAdrRecord[] = [target]
  for (let hop = 0; hop < 64 && backwardFrontier.length > 0; hop++) {
    const next: NormalizedAdrRecord[] = []
    for (const record of backwardFrontier) {
      for (const edgeId of record.supersedes) {
        const found = byId.get(normalizedOrRaw(edgeId))
        if (!found) {
          unresolved.push(`${record.id} supersedes ${edgeId} (unresolved)`)
          continue
        }
        if (seen.has(found.id)) continue
        seen.add(found.id)
        predecessors.push({ record: found, relation: "predecessor", via: `superseded by ${record.id}` })
        next.push(found)
      }
    }
    backwardFrontier.length = 0
    backwardFrontier.push(...next.sort((a, b) => adrTextCollator.compare(a.id, b.id)))
  }

  const forwardFrontier: NormalizedAdrRecord[] = [target]
  for (let hop = 0; hop < 64 && forwardFrontier.length > 0; hop++) {
    const next: NormalizedAdrRecord[] = []
    for (const record of forwardFrontier) {
      const edgeIds = new Set<string>([...record.supersededBy, ...(forwardEdges.get(record.id) ?? [])])
      for (const edgeId of Array.from(edgeIds).sort()) {
        const found = byId.get(normalizedOrRaw(edgeId))
        if (!found) {
          unresolved.push(`${record.id} superseded by ${edgeId} (unresolved)`)
          continue
        }
        if (seen.has(found.id)) continue
        seen.add(found.id)
        successors.push({ record: found, relation: "successor", via: `supersedes ${record.id}` })
        next.push(found)
      }
    }
    forwardFrontier.length = 0
    forwardFrontier.push(...next.sort((a, b) => adrTextCollator.compare(a.id, b.id)))
  }

  const entries: AdrHistoryEntry[] = [
    ...predecessors.reverse(),
    { record: target, relation: "target", via: "" },
    ...successors,
  ]
  return { target, entries, unresolved: Array.from(new Set(unresolved)).sort() }
}

function normalizedOrRaw(id: string): string {
  return normalizeAdrId(id) ?? id
}

/** Deterministic Markdown rendering of a history chain. `sectionEdges`
 * (optional) lists annotation-grade section cross-references around the
 * chain — prose relations, never graph edges (§7 amendment). */
export function renderAdrHistory(history: AdrHistory, sectionEdges: AdrSectionEdge[] = []): string {
  let out = `### History — ${history.target.id}: ${history.target.title}\n\n`
  out += `*Source:* \`${history.target.sourcePath}\` — \`${history.target.style}\`, ${String(history.target.status)}\n\n`
  if (history.entries.length === 1) {
    out += `No supersession relations — this record neither supersedes nor is superseded by another ADR.\n`
  } else {
    out += `Supersession chain (chronological):\n\n`
    for (const entry of history.entries) {
      const marker = entry.relation === "target" ? " ← target" : ""
      out += `1. [${entry.record.id}] ${entry.record.title} — \`${entry.record.style}\`, ${String(entry.record.status)} — \`${entry.record.sourcePath}\`${marker}\n`
    }
  }
  if (sectionEdges.length > 0) {
    out += `\n**Section-level cross-references (annotation-grade, not graph edges)**\n\n`
    for (const edge of sectionEdges) {
      out += `- ${edge.from} → ${edge.relation} ${edge.to} — ${edge.fromTitle} *(via ${edge.via})*\n`
    }
  }
  if (history.unresolved.length > 0) {
    out += `\n⚠️ Unresolved edges:\n`
    for (const edge of history.unresolved) {
      out += `- ${edge}\n`
    }
  }
  return out
}

// ─── Bounded context bundles (§9.1 / §9.4 — `/adr context`) ──────────

export type AdrContextSelector =
  | { kind: "id"; value: string }
  | { kind: "domain"; value: string }
  | { kind: "iteration"; value: string }

export interface AdrContextItem {
  record: NormalizedAdrRecord
  /** How the record was reached, e.g. `parent of ADR-0003`. */
  via: string
}

export interface AdrContextBundle {
  selector: AdrContextSelector
  /** Records directly matching the selector (sorted created→path). */
  matched: NormalizedAdrRecord[]
  /** Bounded related set: direct parents, supersession chain, same-iteration. */
  related: AdrContextItem[]
  /** Progressive-disclosure retrieval path, human-readable (§9.1). */
  retrievalPath: string[]
  /** True when relation bounds were hit and output was truncated. */
  truncated: boolean
}

export interface AdrContextOptions {
  maxHops?: number
  maxRelated?: number
  /** ADL root used to name the nearest index in the retrieval path. */
  rootRel?: string
}

/**
 * Build the smallest evidence-backed context package for a target ID or
 * domain (§9.1 algorithm): nearest index first, then ONLY the selected
 * records and their direct parent / supersession / same-iteration
 * relations. Bounded — it MUST NOT dump the full corpus: chain hops ≤
 * maxHops (default 3), related records ≤ maxRelated (default 12). The
 * retrieval path discloses every index and record the bundle read.
 */
export function buildAdrContext(
  records: NormalizedAdrRecord[],
  selector: AdrContextSelector,
  opts: AdrContextOptions = {},
): AdrContextBundle | null {
  const maxHops = opts.maxHops ?? 3
  const maxRelated = opts.maxRelated ?? 12
  const rootRel = (opts.rootRel ?? "docs/adr").replace(/\\/g, "/").replace(/\/+$/, "")

  let matched: NormalizedAdrRecord[]
  if (selector.kind === "id") {
    const found = resolveRecordByRef(records, selector.value)
    matched = found ? [found] : []
  } else if (selector.kind === "domain") {
    matched = records.filter((r) => r.domain === selector.value).sort(byCreatedThenPath)
  } else {
    matched = records.filter((r) => matchesIteration(r, selector.value)).sort(byCreatedThenPath)
  }
  if (matched.length === 0) return null

  const byId = new Map(records.map((r) => [r.id, r]))
  const seen = new Set(matched.map((r) => r.id))
  const related: AdrContextItem[] = []
  const retrievalPath: string[] = []
  let truncated = false

  // First read: the nearest applicable index (§9.1 step 1).
  if (selector.kind === "id") {
    retrievalPath.push(`index:${dirnamePosix(matched[0]?.sourcePath ?? rootRel)}/INDEX.md (nearest ADL index)`)
  } else {
    retrievalPath.push(`index:${rootRel}/INDEX.md (ADL root index)`)
  }

  // Deepen: direct parents + supersession chain (bounded BFS), then
  // same-iteration records (§9.1 step 3, §9.4 items 2–3).
  const addRelated = (record: NormalizedAdrRecord, via: string): boolean => {
    if (seen.has(record.id)) return true
    if (related.length >= maxRelated) {
      truncated = true
      return false
    }
    seen.add(record.id)
    related.push({ record, via })
    retrievalPath.push(`record:${record.id} (${record.style}, ${String(record.status)}) ← ${via}`)
    return true
  }

  let frontier = matched
  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const next: NormalizedAdrRecord[] = []
    for (const record of frontier) {
      retrievalPath.push(`record:${record.id} (${record.style}, ${String(record.status)})`)
      const parentEdges = record.parentIds.map((id): [string, string] => [`parent of ${record.id}`, id])
      const chainEdges = [
        ...record.supersedes.map((id): [string, string] => [`supersedes edge of ${record.id}`, id]),
        ...record.supersededBy.map((id): [string, string] => [`superseded-by edge of ${record.id}`, id]),
      ]
      for (const [via, edgeId] of [...parentEdges, ...chainEdges]) {
        const target = byId.get(normalizedOrRaw(edgeId))
        if (!target) {
          retrievalPath.push(`${record.id} → ${via} → ${edgeId} (unresolved)`)
          continue
        }
        retrievalPath.push(`${record.id} → ${edgeId} (${via})`)
        if (seen.has(target.id)) continue
        if (addRelated(target, via)) next.push(target)
      }
    }
    frontier = next.sort((a, b) => adrTextCollator.compare(a.id, b.id))
  }

  // Same-iteration relations for every bundled record with metadata.
  const iterationSources = [...matched, ...related.map((r) => r.record)].filter((r) => (r.iteration ?? "").trim() !== "")
  for (const source of iterationSources) {
    const mates = records.filter(
      (r) => r.id !== source.id && !seen.has(r.id) && r.iteration !== undefined && r.iteration === source.iteration,
    )
    for (const mate of mates.sort(byCreatedThenPath)) {
      if (seen.has(mate.id)) continue
      addRelated(mate, `same iteration ${source.iteration} as ${source.id}`)
    }
  }

  for (const record of matched) {
    retrievalPath.push(`selected:${record.id} (\`${record.sourcePath}\`)`)
  }

  return { selector, matched, related, retrievalPath, truncated }
}

const CONTEXT_LINE_CAP = 80

/** Bounded Markdown rendering of a context bundle (§9.4). */
export function renderAdrContext(bundle: AdrContextBundle): string {
  const cap = (s: string): string => (s.length > CONTEXT_LINE_CAP ? `${s.slice(0, CONTEXT_LINE_CAP - 1)}…` : s)
  const label =
    bundle.selector.kind === "id"
      ? bundle.selector.value
      : `${bundle.selector.kind} \`${bundle.selector.value}\``

  let out = `### Context — ${label}\n\n`
  out += `*Retrieval path:*\n\`\`\`text\n${bundle.retrievalPath.join("\n")}\n\`\`\`\n\n`

  out += `**Target records (${bundle.matched.length})**\n\n`
  for (const record of bundle.matched) {
    out += `- **[${record.id}]** ${cap(record.title)} — \`${record.style}\`, ${String(record.status)} — \`${record.sourcePath}\`\n`
  }

  if (bundle.related.length > 0) {
    out += `\n**Related records (${bundle.related.length})**\n\n`
    for (const { record, via } of bundle.related) {
      out += `- **[${record.id}]** ${cap(record.title)} — \`${record.style}\`, ${String(record.status)} — \`${record.sourcePath}\` *(via ${via})*\n`
    }
  }

  // §9.4 item 4 — relevant current constraints (accepted) and unresolved
  // proposals (proposed) among the bundled records only.
  const bundled = [...bundle.matched, ...bundle.related.map((r) => r.record)]
  const constraints = bundled.filter((r) => String(r.status).includes("accepted"))
  const proposals = bundled.filter((r) => String(r.status).includes("proposed"))
  if (constraints.length > 0 || proposals.length > 0) {
    out += `\n**Current constraints & open proposals**\n\n`
    for (const record of constraints) {
      out += `- **[${record.id}]** constraint (accepted): ${cap(record.title)}\n`
    }
    for (const record of proposals) {
      out += `- **[${record.id}]** open proposal: ${cap(record.title)}\n`
    }
  }

  out += `\n_Bounded bundle: chain hops ≤ 3, related records ≤ 12 — unrelated corpus entries stay unloaded (§9.1)._\n`
  if (bundle.truncated) {
    out += `\n⚠️ *Truncated — relation bound reached; narrow the target or run \`/adr history <ID>\` for the full chain.*\n`
  }
  return out
}
