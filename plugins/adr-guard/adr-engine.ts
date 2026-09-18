/**
 * Hierarchical ADR Engine — Core intelligence for living architecture decision records.
 *
 * Capabilities:
 *   - Multi-path ADR discovery (global docs/adr/ and subsystem sub-paths)
 *   - MADR frontmatter parsing & mutation (status, date, layer, scope, parent, superseded_by)
 *   - Sequential ID assignment per directory
 *   - Automated scaffolding with layer-adapted MADR templates
 *   - Decision lifecycle management (atomic superseding with bidirectional cross-links)
 *   - Living architecture visualization (Markdown hierarchy tree & Mermaid DAG)
 *   - Integrity & health verification (link validation, gap detection, index sync)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { getAdrConfig, type AdrLayout, getAdrLayout, normalizeAdrStyle, resolveAdrStyleForNew, setAdrLayout } from "./adr-guard-config"
import { groupByIteration, renderIterationIndex, validateEvolutionMetadataShape } from "./adr-evolution"
import { getAdrStyleAdapter, resolveDocumentAdapter } from "./adr-style-registry"
import { buildAdrTree, renderAdlIndex, type AdrTreeNode } from "./adr-views"
import {
  adrIdFromFilename,
  adrTextCollator,
  bareAdrId,
  extractFrontmatter,
  normalizeAdrId,
  type AdrDocument,
  type AdrHealthIssue,
  type AdrLayer,
  type AdrNumbering,
  type AdrParseContext,
  type AdrStyle,
  type NormalizedAdrRecord,
} from "./adr-types"

export type { AdrHealthIssue, AdrLayer } from "./adr-types"

/** @deprecated Legacy per-record shape retained as a compat wrapper for
 * current callers; new code consumes NormalizedAdrRecord via
 * getNormalizedAdrs(). Will be removed once all callers migrate. */
export interface AdrMeta {
  id: string
  slug: string
  filename: string
  relPath: string
  fullPath: string

  dir: string
  title: string
  status: string
  date: string
  layer: AdrLayer
  scope?: string
  parent?: string
  supersededBy?: string
  /** Explicit `style` frontmatter; undefined = legacy document (dispatches
   * to the madr adapter, reported, never silently rewritten). */
  style?: string
  created?: string
  baseline?: string
  iteration?: string
  domain?: string
  /** ID-based successor reference form (§9.5): `supersedes: ADR-XXXX`. */
  supersedes?: string
  rawContent: string
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".cache",
  ".agents",
  ".opencode",
  ".ocp",
  ".idea",
  ".vscode",
])

/**
 * Slugify a title for file naming (e.g., "Event Bus & Streaming" -> "event-bus-streaming")
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/**
 * Recursively discover all ADR directories within a project based on mode.
 */
export function discoverAdrDirectories(
  projectDir: string,
  defaultDir = "docs/adr",
  layout?: AdrLayout,
): string[] {
  const currentLayout = layout ?? getAdrLayout()
  const normalizedDefault = defaultDir.replace(/\\/g, "/").replace(/\/+$/, "")

  // In flat mode, strictly return only the single configured/default ADR directory
  if (currentLayout === "flat") {
    return [normalizedDefault]
  }

  const adrDirs = new Set<string>()
  adrDirs.add(normalizedDefault)

  // Localized ADR mirrors are reader-facing translations, not a second ADL:
  // their files deliberately retain the source IDs and would otherwise be
  // discovered as duplicate records. Keep the exclusion narrow and relative
  // to the configured ADL root so real package/domain ADR directories named
  // `zh` remain possible outside that root.
  const localizedMirrorRoot = `${normalizedDefault}/zh`

  function scan(dir: string, depth = 0) {
    if (depth > 6) return
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }

    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry)) continue
      const fullPath = join(dir, entry)
      try {
        const stat = statSync(fullPath)
        if (!stat.isDirectory()) continue

        const rel = relative(projectDir, fullPath).replace(/\\/g, "/")
        if (rel === localizedMirrorRoot || rel.startsWith(`${localizedMirrorRoot}/`)) continue
        if (rel.endsWith("/docs/adr") || rel === "docs/adr" || rel.includes("/adr/")) {
          adrDirs.add(rel)
        }
        scan(fullPath, depth + 1)
      } catch {}
    }
  }

  scan(projectDir, 0)
  return Array.from(adrDirs)
}

/**
 * Parse frontmatter and basic structure of an ADR file (any style —
 * dispatch happens at the adapter layer; this is the shared discovery
 * parser producing the legacy AdrMeta shape).
 */
export function parseAdrFile(fullPath: string, projectDir: string): AdrMeta | null {
  try {
    const rawContent = readFileSync(fullPath, "utf-8")
    const filename = fullPath.replace(/\\/g, "/").split("/").pop() || ""
    // Accepts sequential (`0001-slug.md`), per-decision dotted iteration
    // (`0.2.54.01-slug.md`), and container (`0.2.54-slug.md`, ocp style)
    // stems. The four-segment alternative precedes the three-segment one
    // so per-decision stems win over the container prefix.
    const match = filename.match(/^((?:\d{4})|(?:\d+\.\d+\.\d+\.\d+)|(?:\d+\.\d+\.\d+))-(.+)\.md$/)
    if (!match) return null

    const id = match[1]
    const slug = match[2]
    const relPath = relative(projectDir, fullPath).replace(/\\/g, "/")
    const dir = dirname(relPath).replace(/\\/g, "/")

    let status = "proposed"
    let date = new Date().toISOString().split("T")[0]
    let created: string | undefined
    let layer: AdrLayer = "system"
    let scope: string | undefined
    let parent: string | undefined
    let supersededBy: string | undefined
    let supersedes: string | undefined
    let style: string | undefined
    let baseline: string | undefined
    let iteration: string | undefined
    let domain: string | undefined

    // Extract frontmatter
    const fmMatch = rawContent.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (fmMatch) {
      const fmLines = fmMatch[1].split(/\r?\n/)
      for (const line of fmLines) {
        const colonIdx = line.indexOf(":")
        if (colonIdx === -1) continue
        const key = line.slice(0, colonIdx).trim().toLowerCase()
        const val = line.slice(colonIdx + 1).split("#")[0].trim().replace(/^["']|["']$/g, "")

        if (key === "status") status = val.toLowerCase()
        else if (key === "date") date = val
        else if (key === "created") created = val
        else if (key === "style") style = val.toLowerCase()
        else if (key === "baseline") baseline = val
        else if (key === "iteration") iteration = val
        else if (key === "domain") domain = val
        else if (key === "layer" && (val === "system" || val === "domain" || val === "component")) {
          layer = val as AdrLayer
        } else if (key === "scope") scope = val
        else if (key === "parent") parent = val
        else if (key === "supersedes") supersedes = val
        else if (key === "superseded_by" || key === "superseded-by") supersededBy = val
      }
    }

    // Infer layer if not explicit
    if (!fmMatch || !rawContent.includes("layer:")) {
      if (dir.includes("apps/") || dir.includes("services/") || dir.includes("packages/")) {
        layer = "domain"
      } else if (dir.includes("components/") || dir.includes("modules/")) {
        layer = "component"
      } else {
        layer = "system"
      }
    }

    // Extract title from `# [ADR-NNNN[.]] <Title>`
    let title = slug.replace(/-/g, " ")
    const titleMatch = rawContent.match(/^#\s+(?:(?:ADR-)?[\d.]+[.)]?\s+)?([^\r\n]+)/im)
    if (titleMatch) {
      title = titleMatch[1].trim()
    }

    return {
      id,
      slug,
      filename,
      relPath,
      fullPath,
      dir,
      title,
      status,
      date,
      layer,
      scope,
      parent,
      supersededBy,
      style,
      created,
      baseline,
      iteration,
      domain,
      supersedes,
      rawContent,
    }
  } catch {
    return null
  }
}

/**
 * Discover all ADRs in the project.
 */
export function getAllAdrs(projectDir: string, defaultDir = "docs/adr", layout?: AdrLayout): AdrMeta[] {
  const dirs = discoverAdrDirectories(projectDir, defaultDir, layout)
  const adrs: AdrMeta[] = []

  for (const relDir of dirs) {
    const fullDir = join(projectDir, relDir)
    if (!existsSync(fullDir)) continue
    try {
      const files = readdirSync(fullDir)
      for (const file of files) {
        if (!file.endsWith(".md") || file.toUpperCase() === "INDEX.MD" || file.toUpperCase() === "README.MD") {
          continue
        }
        const fullPath = join(fullDir, file)
        const adr = parseAdrFile(fullPath, projectDir)
        if (adr) {
          adrs.push(adr)
        }
      }
    } catch {}
  }

  return adrs.sort((a, b) => adrTextCollator.compare(a.relPath, b.relPath) || adrTextCollator.compare(a.id, b.id))
}

// ─── Normalized records (§8) — the engine's primary output ───────────

/** Legacy AdrMeta → adapter input document. */
export function toAdrDocument(adr: AdrMeta): AdrDocument {
  return {
    fullPath: adr.fullPath,
    relPath: adr.relPath,
    filename: adr.filename,
    rawContent: adr.rawContent,
    frontmatter: extractFrontmatter(adr.rawContent),
  }
}

/**
 * Resolve a `parent` / `superseded_by` / `supersedes` value to a canonical
 * ADR ID. Both ID forms (`0001`, `ADR-0001`, dotted) and legacy path forms
 * (relPath, filename) resolve here; relationship fields are normalized IDs,
 * never paths. Cross-directory duplicate IDs (legal under the old
 * per-directory engine) resolve by first match — callers that hold a path
 * SHOULD pass it so resolution is path-scoped.
 */
export function resolveAdrRef(ref: string, adrs: AdrMeta[]): AdrMeta | null {
  const clean = ref.trim().replace(/^["']|["']$/g, "")
  if (!clean) return null
  const byPath = adrs.find((a) => a.relPath === clean || a.filename === clean)
  if (byPath) return byPath
  const canonical = normalizeAdrId(clean)
  if (canonical) {
    const bare = canonical.replace(/^ADR-/i, "")
    return adrs.find((a) => a.id === bare) ?? null
  }
  return null
}

/** Parse-context factory: closes over the discovered records so adapters
 * normalize path references into canonical IDs. */
export function makeParseContext(adrs: AdrMeta[]): AdrParseContext {
  return {
    resolveRef(ref: string): string | null {
      const clean = ref.trim()
      const direct = normalizeAdrId(clean)
      if (direct && adrs.some((a) => normalizeAdrId(a.id) === direct)) return direct
      const found = resolveAdrRef(clean, adrs)
      return found ? normalizeAdrId(found.id) : null
    },
  }
}

/** AdrMeta → NormalizedAdrRecord through the style registry. */
export function toNormalizedRecord(adr: AdrMeta, all: AdrMeta[]): NormalizedAdrRecord {
  const document = toAdrDocument(adr)
  const { adapter } = resolveDocumentAdapter(document)
  return adapter.parse(document, makeParseContext(all))
}

/**
 * Discover all ADRs and return normalized records — the primary engine
 * API. getAllAdrs() above remains as a temporary legacy compat wrapper
 * for callers still consuming the AdrMeta shape.
 */
export function getNormalizedAdrs(projectDir: string, defaultDir = "docs/adr", layout?: AdrLayout): NormalizedAdrRecord[] {
  const adrs = getAllAdrs(projectDir, defaultDir, layout)
  return adrs.map((a) => toNormalizedRecord(a, adrs))
}

/**
 * Whole-ADL sequential allocation (§6.1): scans EVERY discovered ADR root,
 * not the creating directory — per-directory counters are unsound (two
 * nested directories would both mint 0001 and integrity would fail).
 * Duplicate legacy IDs are absorbed into the max, so a warned ID is never
 * reused. The targetRelDir parameter is kept for call-site compatibility
 * and intentionally ignored.
 */
export function getNextAdrNumber(projectDir: string, _targetRelDir?: string): string {
  return allocateAdrSequentialId(projectDir)
}

function allocateAdrSequentialId(projectDir: string): string {
  const adrs = getAllAdrs(projectDir, "docs/adr", getAdrLayout())
  let maxNum = 0
  for (const a of adrs) {
    if (/^\d{4}$/.test(a.id)) {
      const n = parseInt(a.id, 10)
      if (n > maxNum) maxNum = n
    }
    // Dotted iteration IDs live in a disjoint grammar — never counted here.
  }
  return (maxNum + 1).toString().padStart(4, "0")
}

/**
 * Iteration allocation (§6.1): `baseline.iter.seq` with seq per
 * (baseline, iteration), e.g. 0.2.54.01 → 0.2.54.02. Dotted IDs are
 * globally unique by construction. Namespace guard (ADR-0007 §7
 * amendment): a container record `ADR-<baseline>.<iteration>` reserves
 * the WHOLE `<baseline>.<iteration>.*` space — per-decision IDs are never
 * minted under an occupied iteration (append a section instead).
 */
export function allocateAdrIterationId(projectDir: string, baseline: string, iteration: string): string {
  const prefix = `${baseline}.${iteration}.`
  const containerId = `${baseline}.${iteration}`
  const adrs = getAllAdrs(projectDir, "docs/adr", getAdrLayout())
  if (adrs.some((a) => a.id === containerId)) {
    throw new Error(
      `iteration ${containerId} is claimed by container ADR-${containerId} — append a section with \`/adr section ADR-${containerId} <title>\` instead of minting a per-decision ID.`,
    )
  }
  let maxSeq = 0
  for (const a of adrs) {
    if (!a.id.startsWith(prefix)) continue
    const seq = parseInt(a.id.slice(prefix.length), 10)
    if (!isNaN(seq) && seq > maxSeq) maxSeq = seq
  }
  return `${prefix}${String(maxSeq + 1).padStart(2, "0")}`
}

/**
 * Re-generate the directory-mirroring INDEX.md tree (§9.3): the ADL root
 * index plus a local index in every directory that contains ADR source
 * documents. Local indexes list only their own records + child-scope
 * summaries (never flattened descendants); the root index puts its own
 * (global/system) records first, then child scope links. Regeneration is
 * deterministic — an unchanged ADL yields byte-identical files.
 * Returns the written INDEX.md paths (POSIX, relative to projectDir).
 */
export function regenerateAdlIndexes(projectDir: string, defaultDir = "docs/adr", layout?: AdrLayout): string[] {
  const rootRel = defaultDir.replace(/\\/g, "/").replace(/\/+$/, "")
  const records = getNormalizedAdrs(projectDir, rootRel, layout)
  const forest = buildAdrTree(records, rootRel)

  const written: string[] = []
  const writeNode = (node: AdrTreeNode): void => {
    const relPath = `${node.relDir}/INDEX.md`
    writeFileSync(join(projectDir, relPath), renderAdlIndex(node), "utf-8")
    written.push(relPath)
    for (const child of node.children) {
      writeNode(child)
    }
  }
  for (const node of forest) {
    // A node with neither records nor children has nothing to index;
    // never create an index file in a directory that does not exist.
    if (node.records.length === 0 && node.children.length === 0 && !existsSync(join(projectDir, node.relDir))) continue
    writeNode(node)
  }
  return written
}

/**
 * Re-generate INDEX.md for a given ADR directory. §9.3: indexes mirror
 * the whole ADL tree, so this regenerates every directory index (the
 * targetRelDir parameter is kept for call-site compatibility and
 * intentionally ignored — a single-directory refresh would let child
 * summaries and parent links drift).
 */
export function updateAdrIndex(projectDir: string, targetRelDir: string): void {
  regenerateAdlIndexes(projectDir, targetRelDir)
}

/**
 * Re-generate INDEX.by-iteration.md at the ADL root from the shared
 * `iteration` frontmatter metadata (§7.3 requirement 2 — a generated
 * view can never drift from the records it summarizes; it is never
 * hand-maintained). Grouping uses the metadata field, never ID-string
 * parsing (§6.1 rule 6). Writes nothing and returns null when no
 * record carries iteration metadata. The filename never matches the
 * ADR stem grammar, so discovery never picks it up as a record.
 */
export function regenerateIterationIndex(projectDir: string, defaultDir = "docs/adr", layout?: AdrLayout): string | null {
  const rootRel = defaultDir.replace(/\\/g, "/").replace(/\/+$/, "")
  const records = getNormalizedAdrs(projectDir, rootRel, layout)
  if (groupByIteration(records).length === 0) return null
  const relPath = `${rootRel}/INDEX.by-iteration.md`
  writeFileSync(join(projectDir, relPath), renderIterationIndex(records, rootRel), "utf-8")
  return relPath
}

function statusBadge(status: string): string {
  if (status.includes("accepted")) return `🟢 Accepted`
  if (status.includes("superseded")) return `⚪ Superseded`
  if (status.includes("deprecated")) return `🟡 Deprecated`
  if (status.includes("rejected")) return `🔴 Rejected`
  if (status.includes("proposed")) return `🔵 Proposed`
  return `⚪ ${status}`
}

/**
 * Options for creating an ADR.
 */
export interface CreateAdrOptions {
  projectDir: string
  title: string
  layer?: AdrLayer
  scope?: string
  targetDir?: string
  /** parent reference — ID form (ADR-0001) or legacy path form; both
   * resolve into the normalized model. */
  parent?: string
  /** superseded record reference — ID form (§9.5) or legacy path form. */
  supersedes?: string
  status?: string
  layout?: AdrLayout
  /** Explicit style for the new record; falls back to adr.style >
   * madr (§6). Both `nygard` and `madr` are registered (Phase 2). */
  style?: AdrStyle
  numbering?: AdrNumbering
  baseline?: string
  iteration?: string
  domain?: string
}

/**
 * Scaffold a new ADR file and update its index. New records are scaffolded
 * through their style adapter with explicit `style` frontmatter and
 * `created` (immutable) alongside `date`. Default status is `proposed` in
 * every governance mode (§6.2 — no code path ever writes `accepted`).
 */
export function createAdr(options: CreateAdrOptions): { relPath: string; fullPath: string; id: string; warnings: string[] } {
  const currentLayout = options.layout ?? getAdrLayout()
  const warnings: string[] = []
  let {
    projectDir,
    title,
    layer = "system",
    scope,
    parent,
    supersedes,
    status = "proposed",
  } = options

  // In flat mode, force single root docs/adr target
  let targetRelDir = options.targetDir
  if (currentLayout === "flat") {
    targetRelDir = "docs/adr"
    layer = "system"
  } else if (!targetRelDir) {
    if (scope && (layer === "domain" || layer === "component")) {
      targetRelDir = `packages/${scope}/docs/adr`
    } else {
      targetRelDir = "docs/adr"
    }
  }
  targetRelDir = targetRelDir.replace(/\\/g, "/").replace(/\/+$/, "")

  const fullDir = join(projectDir, targetRelDir)
  if (!existsSync(fullDir)) {
    mkdirSync(fullDir, { recursive: true })
  }

  // Numbering (§6.1): iteration requires explicit --baseline/--iteration;
  // otherwise fall back to sequential with a visible warning — never invent
  // or guess iteration values.
  const numbering = options.numbering ?? getAdrConfig().numbering
  let id: string
  if (numbering === "iteration") {
    if (options.baseline && options.iteration) {
      id = allocateAdrIterationId(projectDir, options.baseline, options.iteration)
    } else {
      warnings.push(
        `adr.numbering is 'iteration' but --baseline/--iteration were not given — fell back to sequential numbering for this record.`,
      )
      id = allocateAdrSequentialId(projectDir)
    }
  } else {
    id = allocateAdrSequentialId(projectDir)
  }

  const slug = slugify(title) || "decision"
  const filename = `${id}-${slug}.md`
  const fullPath = join(fullDir, filename)
  const relPath = `${targetRelDir}/${filename}`
  const today = new Date().toISOString().split("T")[0]

  const style = resolveAdrStyleForNew(options.style)
  if (style === "ocp") {
    throw new Error(
      "style 'ocp' is a container style — use createAdrContainer (`/adr new --style ocp --baseline <b> --iteration <i> <title>`) instead of per-record creation; containers always need baseline+iteration.",
    )
  }
  const adapter = getAdrStyleAdapter(style)
  const content = adapter.scaffold({
    id,
    title,
    status,
    date: today,
    created: today,
    layer,
    scope,
    domain: options.domain,
    baseline: options.baseline,
    iteration: options.iteration,
    parent,
    supersedes,
  })

  writeFileSync(fullPath, content, "utf-8")
  updateAdrIndex(projectDir, targetRelDir)

  return { relPath, fullPath, id, warnings }
}

// ─── OCP container records (ADR-0007 §7 amendment) ────────────────────

/**
 * Container namespace guard: `ADR-<baseline>.<iteration>` reserves the
 * whole `<baseline>.<iteration>.*` sub-ID space the moment the container
 * is created — a container never claims an iteration that already holds
 * per-decision records, and per-decision allocation refuses an occupied
 * iteration (see allocateAdrIterationId). This is what keeps ONE grammar
 * collision-free while both record shapes coexist.
 */
function assertContainerNamespaceFree(adrs: AdrMeta[], baseline: string, iteration: string): void {
  const bare = `${baseline}.${iteration}`
  if (adrs.some((a) => a.id === bare)) {
    throw new Error(
      `ADR-${bare} already exists as a container — append a section with \`/adr section ADR-${bare} <title>\` instead.`,
    )
  }
  const occupied = adrs.filter((a) => a.id.startsWith(`${bare}.`))
  if (occupied.length > 0) {
    throw new Error(
      `iteration ${bare} already has per-decision records (${occupied
        .map((a) => `ADR-${a.id}`)
        .join(", ")}) — a container cannot claim it.`,
    )
  }
}

export interface CreateAdrContainerOptions {
  projectDir: string
  title: string
  /** Both or neither: given → ITERATION container (`ADR-<b>.<i>`, the
   * OCP shape, reserves the iteration namespace); omitted →
   * SEQUENTIAL container (`ADR-NNNN`, shares the sequential allocator
   * with per-decision records — numbering is orthogonal to the
   * container style, §6). */
  baseline?: string
  iteration?: string
  domain?: string
  targetDir?: string
  status?: string
}

/**
 * Scaffold one `ocp` container record. Same lifecycle rule as createAdr:
 * scaffolded `proposed` in every governance mode — no code path writes
 * `accepted`. Sections are appended afterwards via appendAdrSection.
 */
export function createAdrContainer(
  options: CreateAdrContainerOptions,
): { relPath: string; fullPath: string; id: string; warnings: string[] } {
  const { projectDir, title, baseline, iteration } = options
  const warnings: string[] = []
  if ((baseline && !iteration) || (!baseline && iteration)) {
    throw new Error(
      "--baseline and --iteration must be given TOGETHER (iteration container) or omitted TOGETHER (sequential container) — the missing half is never invented (§6.1).",
    )
  }

  const targetRelDir = (options.targetDir ?? "docs/adr").replace(/\\/g, "/").replace(/\/+$/, "")
  const fullDir = join(projectDir, targetRelDir)
  if (!existsSync(fullDir)) {
    mkdirSync(fullDir, { recursive: true })
  }

  const slug = slugify(title) || "batch"
  let id: string
  let filename: string
  if (baseline && iteration) {
    if (!/^\d+(\.\d+)*$/.test(baseline) || !/^\d+$/.test(iteration)) {
      throw new Error(`invalid baseline/iteration shape: '${baseline}' / '${iteration}' (dotted numeric, e.g. 0.2 / 54).`)
    }
    const adrs = getAllAdrs(projectDir, "docs/adr", getAdrLayout())
    assertContainerNamespaceFree(adrs, baseline, iteration)
    const bare = `${baseline}.${iteration}`
    id = normalizeAdrId(bare) ?? `ADR-${bare}`
    filename = `${bare}-${slug}.md`
  } else {
    const seq = allocateAdrSequentialId(projectDir)
    id = `ADR-${seq}`
    filename = `${seq}-${slug}.md`
  }

  const fullPath = join(fullDir, filename)
  const relPath = `${targetRelDir}/${filename}`
  const today = new Date().toISOString().split("T")[0]

  const adapter = getAdrStyleAdapter("ocp")
  const content = adapter.scaffold({
    id: bareAdrId(id),
    title,
    status: options.status ?? "proposed",
    date: today,
    created: today,
    layer: "system",
    domain: options.domain,
    baseline,
    iteration,
  })

  writeFileSync(fullPath, content, "utf-8")
  updateAdrIndex(projectDir, targetRelDir)

  return { relPath, fullPath, id, warnings }
}

/**
 * Append one section to an existing ocp container. Sequence allocation scans
 * the container's parsed sections (never ID-string guessing across
 * files); the new block renders through the adapter's scaffoldSection.
 * Appending a section is NOT a status change — `date` stays untouched.
 */
export function appendAdrSection(
  projectDir: string,
  containerRef: string,
  title: string,
): { relPath: string; fullPath: string; id: string } {
  const cleanRef = containerRef.trim().replace(/^["']|["']$/g, "")
  const adrs = getAllAdrs(projectDir, "docs/adr", getAdrLayout())
  const container = resolveAdrRef(cleanRef, adrs)
  if (!container) {
    throw new Error(`Cannot find container ADR matching '${containerRef}'.`)
  }
  // Style gate before the ID grammar check: a sequential MADR/Nygard record
  // passes the grammar below, but an appended ocp block would be invisible
  // to style-dispatched tooling. Legacy (no style) dispatches as madr.
  const containerStyle = normalizeAdrStyle(container.style) ?? "madr"
  if (containerStyle !== "ocp") {
    throw new Error(
      `'${cleanRef}' is a '${containerStyle}' record — /adr section appends sections to ocp container records only.`,
    )
  }
  const canonical = normalizeAdrId(container.id)
  const bareId = canonical?.replace(/^ADR-/, "") ?? ""
  if (!/^\d{4}$/.test(bareId) && !/^\d+\.\d+\.\d+$/.test(bareId)) {
    throw new Error(
      `'${cleanRef}' is not a container (expected ADR-NNNN or ADR-<baseline>.<iteration>) — /adr section appends sections to ocp container records only.`,
    )
  }

  const adapter = getAdrStyleAdapter("ocp")
  const record = adapter.parse(toAdrDocument(container), makeParseContext(adrs))
  const seqs = (record.sections ?? []).map((s) => parseInt(s.seq, 10)).filter((n) => !isNaN(n))
  const next = (seqs.length > 0 ? Math.max(...seqs) : 0) + 1
  const seq = String(next).padStart(2, "0")
  const id = `${canonical}#${seq}`

  const scaffoldSection = adapter.scaffoldSection
  if (!scaffoldSection) {
    throw new Error(`style '${adapter.style}' does not support section appends.`)
  }
  const block = scaffoldSection({ id, title })

  const content = readFileSync(container.fullPath, "utf-8").replace(/\s+$/, "")
  writeFileSync(container.fullPath, `${content}\n\n${block}`, "utf-8")

  return { relPath: container.relPath, fullPath: container.fullPath, id }
}

/**
 * Supersession (§9.5) — a uniform document-level operation:
 *   1. creates a NEW file with `supersedes: ADR-<old-ID>` (ID-based form)
 *   2. flips ONLY the old file's status line to `superseded by ADR-<new-ID>`
 *      — a status change, never a semantic edit; the old body stays
 *      byte-stable. (The pre-refactor engine rewrote the old frontmatter
 *      wholesale; Phase 1 narrowed it to the status line.)
 *   3. indexes are regenerated by createAdr / the flip below.
 */
export function supersedeAdr(
  projectDir: string,
  oldRef: string,
  newTitle: string,
  newOptions: Partial<CreateAdrOptions> = {},
): { newAdr: { relPath: string; fullPath: string; id: string; warnings: string[] }; oldAdr: AdrMeta } {
  const cleanRef = oldRef.trim().replace(/^["']|["']$/g, "")

  const adrs = getAllAdrs(projectDir)
  const oldAdr = resolveAdrRef(cleanRef, adrs)

  if (!oldAdr) {
    throw new Error(`Cannot find existing ADR matching '${oldRef}' to supersede.`)
  }

  // Create new ADR in same directory or target dir; the successor carries
  // the normalized ID reference to the record it replaces. Successor
  // style: explicit override wins; otherwise inherit the old record's
  // per-decision style. A container successor would need a
  // baseline/iteration that must never be invented (§6.1), so a
  // superseded container's successor uses the safe per-decision style.
  const targetDir = newOptions.targetDir || oldAdr.dir
  const oldStyle = normalizeAdrStyle(oldAdr.style)
  const requestedStyle = newOptions.style ?? (oldStyle && oldStyle !== "ocp" ? oldStyle : undefined)
  const effectiveStyle = requestedStyle ?? getAdrConfig().style
  const successorStyle: AdrStyle | undefined = effectiveStyle === "ocp" ? "madr" : requestedStyle
  const created = createAdr({
    projectDir,
    title: newTitle,
    layer: newOptions.layer || oldAdr.layer,
    scope: newOptions.scope || oldAdr.scope,
    targetDir,
    style: successorStyle,
    supersedes: `ADR-${oldAdr.id}`,
    status: "proposed",
  })

  // Flip ONLY the old file's status line. Old IDs stay frozen forever.
  let oldContent = oldAdr.rawContent
  if (/status:\s*[^\r\n]+/i.test(oldContent)) {
    oldContent = oldContent.replace(/status:\s*[^\r\n]+/i, `status: Superseded by ADR-${created.id}`)
  } else {
    oldContent = `---\nstatus: Superseded by ADR-${created.id}\n---\n\n` + oldContent
  }

  writeFileSync(oldAdr.fullPath, oldContent, "utf-8")
  updateAdrIndex(projectDir, oldAdr.dir)

  return { newAdr: created, oldAdr }
}

/**
 * Generate full Markdown hierarchy tree and Mermaid DAG diagram.
 */
export function generateDecisionMap(projectDir: string, layout?: AdrLayout): string {
  const currentLayout = layout ?? getAdrLayout()
  const adrs = getAllAdrs(projectDir, "docs/adr", currentLayout)
  if (adrs.length === 0) {
    return `### Architecture Decision Map\n\n*No Architecture Decision Records found in this workspace.*\nUse \`/adr new <title>\` to initialize your first decision.`
  }

  let output = `### 🏛️ Architecture Decision Map\n\n`

  if (currentLayout === "flat") {
    output += `#### Decisions (${adrs.length})\n\n`
    for (const item of adrs) {
      const badge = statusBadge(item.status)
      output += `- **[${item.id}] [${item.title}](file:///${resolve(projectDir, item.relPath).replace(/\\/g, "/")})** — ${badge} (${item.date})\n`
    }
    return output
  }

  // Hierarchical / Auto Mode
  // Group by Layer
  const layers: Record<AdrLayer, AdrMeta[]> = {
    system: [],
    domain: [],
    component: [],
  }

  for (const adr of adrs) {
    layers[adr.layer || "system"].push(adr)
  }

  output += `#### 1. Decision Hierarchy (Coarse to Fine)\n\n`


  const layerTitles: Record<AdrLayer, string> = {
    system: "🌐 L1: System & Macro Decisions",
    domain: "📦 L2: Domain & Subsystem Decisions",
    component: "🧩 L3: Component & Module Decisions",
  }

  for (const l of ["system", "domain", "component"] as AdrLayer[]) {
    const list = layers[l]
    output += `##### ${layerTitles[l]} (${list.length})\n`
    if (list.length === 0) {
      output += `*(None)*\n\n`
      continue
    }

    for (const item of list) {
      const badge = statusBadge(item.status)
      output += `- **[${item.id}] [${item.title}](file:///${resolve(projectDir, item.relPath).replace(/\\/g, "/")})** (\`${item.relPath}\`) — ${badge}\n`
      if (item.parent) output += `  - *Parent: \`${item.parent}\`*\n`
    }
    output += `\n`
  }

  // Mermaid Diagram
  output += `#### 2. Architecture Decision Topology (DAG)\n\n`
  output += "```mermaid\ngraph TD\n"

  for (const adr of adrs) {
    const safeTitle = adr.title.replace(/["()]/g, "")
    const nodeLabel = `\"[${adr.id}] ${safeTitle}\"`
    const nodeId = `ADR_${adr.id}`
    output += `  ${nodeId}[${nodeLabel}]\n`

    if (adr.parent) {
      const parentId = refToBareId(adr.parent)
      if (parentId) {
        output += `  ADR_${parentId} -->|constrains| ${nodeId}\n`
      }
    }

    if (adr.supersededBy) {
      const supId = refToBareId(adr.supersededBy)
      if (supId) {
        output += `  ${nodeId} -.->|superseded by| ADR_${supId}\n`
      }
    } else if (adr.status.includes("superseded by")) {
      const supId = refToBareId(adr.status)
      if (supId) {
        output += `  ${nodeId} -.->|superseded by| ADR_${supId}\n`
      }
    }
  }

  output += "```\n"

  return output
}

/** Extract a bare ADR ID (`0001`, `0.2.54.01`) from a reference string
 * that may be an ID form (ADR-0001), a legacy path, or a status line. */
function refToBareId(ref: string): string | null {
  const canonical = normalizeAdrId(ref)
  if (canonical) return canonical.replace(/^ADR-/, "")
  const m = ref.match(/ADR-(\d{4}(?:\.\d+\.\d+\.\d+)?)/i) ?? ref.match(/(\d{4}(?:\.\d+\.\d+\.\d+)?)/)
  return m?.[1] ?? null
}

/**
 * Integrity & Health checker. Global-ID uniqueness across the whole ADL:
 * same-directory duplicates are errors; cross-directory duplicate
 * sequential IDs (legal under the old per-directory engine) are tolerated
 * as warnings — ID resolution falls back to path-scoped lookup and new
 * allocations never reuse a warned ID (§6.1 rule 3). Dotted iteration IDs
 * are a disjoint grammar and always fail validation on collision.
 */
export function checkAdrIntegrity(projectDir: string): AdrHealthIssue[] {
  const adrs = getAllAdrs(projectDir)
  const issues: AdrHealthIssue[] = []
  const idMap = new Map<string, AdrMeta[]>()

  for (const adr of adrs) {
    const list = idMap.get(adr.id) || []
    list.push(adr)
    idMap.set(adr.id, list)

    // Check mandatory fields
    if (!adr.status) {
      issues.push({
        type: "missing-field",
        severity: "warn",
        file: adr.relPath,
        message: "Missing 'status' in frontmatter",
      })
    }

    // Check parent links — ID form and legacy path form both resolve
    if (adr.parent) {
      if (!resolveAdrRef(adr.parent, adrs)) {
        issues.push({
          type: "broken-parent",
          severity: "error",
          file: adr.relPath,
          message: `Parent reference '${adr.parent}' cannot be resolved to an existing ADR`,
        })
      }
    }

    // Check supersede links (status line and/or superseded_by frontmatter)
    const supersedeRefs: string[] = []
    if (adr.status.includes("superseded by")) {
      const supId = refToBareId(adr.status)
      if (supId) supersedeRefs.push(supId)
    }
    if (adr.supersededBy) supersedeRefs.push(adr.supersededBy)
    if (adr.supersedes && !resolveAdrRef(adr.supersedes, adrs)) {
      issues.push({
        type: "broken-supersede",
        severity: "error",
        file: adr.relPath,
        message: `Supersedes target '${adr.supersedes}' does not exist in workspace`,
      })
    }
    for (const ref of supersedeRefs) {
      if (!resolveAdrRef(ref, adrs)) {
        issues.push({
          type: "broken-supersede",
          severity: "error",
          file: adr.relPath,
          message: `Superseded target '${ref}' does not exist in workspace`,
        })
      }
    }
  }

  // Duplicate IDs: same directory → error; cross-directory → legacy warning
  for (const [id, list] of idMap.entries()) {
    const dirGroups = new Map<string, AdrMeta[]>()
    for (const item of list) {
      const g = dirGroups.get(item.dir) || []
      g.push(item)
      dirGroups.set(item.dir, g)
    }
    for (const [dir, inDir] of dirGroups.entries()) {
      if (inDir.length > 1) {
        issues.push({
          type: "duplicate-id",
          severity: "error",
          file: dir,
          message: `Duplicate ADR ID '${id}' found in directory '${dir}': ${inDir.map((x) => x.filename).join(", ")}`,
        })
      }
    }
    if (dirGroups.size > 1) {
      issues.push({
        type: "duplicate-id",
        severity: "warn",
        file: list.map((x) => x.relPath).join(", "),
        message: `Cross-directory duplicate ADR ID '${id}' tolerated as legacy (pre-global allocation): ${list
          .map((x) => x.relPath)
          .join(", ")}. ID resolution falls back to path-scoped lookup; new allocations never reuse this ID.`,
      })
    }
  }

  // Style-structural validation (§7.4 strict style isolation): every
  // document is validated ONLY by its own adapter's canonical template —
  // a malformed Nygard file reports Nygard sections, a malformed MADR
  // file reports MADR sections, never cross-talk. Records are parsed
  // once and shared with the evolution-metadata shape check below.
  const records = adrs.map((a) => toNormalizedRecord(a, adrs))
  for (let i = 0; i < adrs.length; i++) {
    const document = toAdrDocument(adrs[i])
    const { adapter } = resolveDocumentAdapter(document)
    issues.push(...adapter.validate(document, records[i]))
  }

  // Evolution metadata shape sanity (§7.3) — universal, any style.
  issues.push(...validateEvolutionMetadataShape(records))

  return issues
}

// ─── Complexity Advisor & Refactoring Migration Engine ──────────────

export interface ComplexityAnalysis {
  totalAdrs: number
  rootAdrCount: number
  discoveredPackages: string[]
  currentLayout: AdrLayout
  isComplex: boolean
  recommendation?: {
    suggestedLayout: AdrLayout
    reason: string
  }
}

export interface AdrMovePlan {
  fromRelPath: string
  toRelPath: string
  fromId: string
  toId: string
  title: string
  targetLayer: AdrLayer
  targetScope?: string
}

export interface MigrationPlan {
  currentLayout: AdrLayout
  targetLayout: AdrLayout
  moves: AdrMovePlan[]
  summary: string
}

/**
 * Scan workspace for possible subpackages/apps.
 */
export function discoverWorkspacePackages(projectDir: string): string[] {
  const pkgs: string[] = []
  const candidateDirs = ["packages", "apps", "services", "modules", "libs"]

  for (const parent of candidateDirs) {
    const parentPath = join(projectDir, parent)
    if (!existsSync(parentPath)) continue
    try {
      const items = readdirSync(parentPath)
      for (const item of items) {
        const full = join(parentPath, item)
        if (statSync(full).isDirectory()) {
          pkgs.push(`${parent}/${item}`)
        }
      }
    } catch {}
  }
  return pkgs
}

/**
 * Analyze ADR complexity and recommend mode switches when thresholds are reached.
 */
export function analyzeAdrComplexity(projectDir: string): ComplexityAnalysis {
  const currentLayout = getAdrLayout()
  const adrs = getAllAdrs(projectDir, "docs/adr", "auto")
  const rootAdrs = adrs.filter((a) => a.dir === "docs/adr")
  const packages = discoverWorkspacePackages(projectDir)

  let isComplex = false
  let recommendation: { suggestedLayout: AdrLayout; reason: string } | undefined

  if (currentLayout === "flat" || currentLayout === "auto") {
    // Triggers for recommending hierarchical mode:
    // 1. High number of root ADRs (> 12)
    // 2. Monorepo structure with multiple domain ADRs
    const hasMonorepo = packages.length >= 2
    if (rootAdrs.length >= 12 || (hasMonorepo && rootAdrs.length >= 6)) {
      isComplex = true
      recommendation = {
        suggestedLayout: "hierarchical",
        reason: hasMonorepo
          ? `Detected ${packages.length} packages and ${rootAdrs.length} ADRs in root docs/adr/. Migrating to hierarchical mode will scope decisions per subsystem.`
          : `High density of decisions (${rootAdrs.length} ADRs in root docs/adr/). Upgrading to hierarchical mode improves discoverability and governance.`,
      }
    }
  } else if (currentLayout === "hierarchical") {
    // Triggers for recommending flat mode:
    // Very few ADRs (<= 4) and no subpackages
    if (adrs.length <= 4 && packages.length === 0) {
      recommendation = {
        suggestedLayout: "flat",
        reason: `Lightweight project with only ${adrs.length} ADRs and no subpackages. Switching to flat mode simplifies management.`,
      }
    }
  }

  return {
    totalAdrs: adrs.length,
    rootAdrCount: rootAdrs.length,
    discoveredPackages: packages,
    currentLayout,
    isComplex,
    recommendation,
  }
}

/**
 * Plan restructuring and file movements for ADR layout migration.
 */
export function planAdrMigration(projectDir: string, targetLayout: AdrLayout): MigrationPlan {
  const currentLayout = getAdrLayout()
  const allAdrs = getAllAdrs(projectDir, "docs/adr", "auto")
  const moves: AdrMovePlan[] = []
  const packages = discoverWorkspacePackages(projectDir)

  if (targetLayout === "hierarchical") {
    // Migrate flat root ADRs into subsystem or domain directories
    const rootAdrs = allAdrs.filter((a) => a.dir === "docs/adr")
    const dirCounters = new Map<string, number>()

    for (const adr of rootAdrs) {
      let targetDir = "docs/adr"
      let targetLayer: AdrLayer = "system"
      let targetScope: string | undefined

      // Heuristic: check if title or slug mentions a discovered package or domain
      const text = `${adr.slug} ${adr.title} ${adr.scope || ""}`.toLowerCase()

      for (const pkg of packages) {
        const pkgName = pkg.split("/").pop() || ""
        if (text.includes(pkgName.toLowerCase())) {
          targetDir = `${pkg}/docs/adr`
          targetLayer = "domain"
          targetScope = pkgName
          break
        }
      }

      // If matched a domain subfolder
      if (targetDir !== "docs/adr") {
        const count = (dirCounters.get(targetDir) || 0) + 1
        dirCounters.set(targetDir, count)
        const newId = count.toString().padStart(4, "0")
        const toRelPath = `${targetDir}/${newId}-${adr.slug}.md`

        moves.push({
          fromRelPath: adr.relPath,
          toRelPath,
          fromId: adr.id,
          toId: newId,
          title: adr.title,
          targetLayer,
          targetScope,
        })
      }
    }
  } else if (targetLayout === "flat") {
    // Flatten all non-root ADRs back to docs/adr/
    const nonRootAdrs = allAdrs.filter((a) => a.dir !== "docs/adr")
    let maxRootNum = 0
    for (const a of allAdrs) {
      if (a.dir === "docs/adr") {
        const n = parseInt(a.id, 10)
        if (n > maxRootNum) maxRootNum = n
      }
    }

    for (const adr of nonRootAdrs) {
      maxRootNum++
      const newId = maxRootNum.toString().padStart(4, "0")
      const toRelPath = `docs/adr/${newId}-${adr.slug}.md`

      moves.push({
        fromRelPath: adr.relPath,
        toRelPath,
        fromId: adr.id,
        toId: newId,
        title: adr.title,
        targetLayer: "system",
      })
    }
  }

  let summary = `Migration Plan (${currentLayout} $\\to$ ${targetLayout}): ${moves.length} file(s) to restructure.`
  if (moves.length === 0) {
    summary = `Migration Plan (${currentLayout} $\\to$ ${targetLayout}): No file movements needed.`
  }

  return {
    currentLayout,
    targetLayout,
    moves,
    summary,
  }
}

/**
 * Execute the migration plan atomically and synchronize indexes and project configuration.
 */
export function executeAdrMigration(
  projectDir: string,
  plan: MigrationPlan,
): { executedCount: number; touchedDirs: string[] } {
  const touchedDirs = new Set<string>(["docs/adr"])

  // Path rewrite map for cross-reference updates
  const pathMap = new Map<string, string>()
  const idMap = new Map<string, string>()

  for (const m of plan.moves) {
    pathMap.set(m.fromRelPath, m.toRelPath)
    idMap.set(m.fromId, m.toId)
  }

  // Execute file moves
  for (const move of plan.moves) {
    const srcFull = join(projectDir, move.fromRelPath)
    const dstFull = join(projectDir, move.toRelPath)
    const dstDir = dirname(dstFull)

    if (!existsSync(srcFull)) continue

    if (!existsSync(dstDir)) {
      mkdirSync(dstDir, { recursive: true })
    }

    let content = readFileSync(srcFull, "utf-8")

    // Update frontmatter
    if (content.includes("layer:")) {
      content = content.replace(/layer:\s*[^\r\n]+/i, `layer: ${move.targetLayer}`)
    } else {
      content = content.replace(/^---\r?\n/m, `---\nlayer: ${move.targetLayer}\n`)
    }

    if (move.targetScope) {
      if (content.includes("scope:")) {
        content = content.replace(/scope:\s*[^\r\n]+/i, `scope: ${move.targetScope}`)
      } else {
        content = content.replace(/^---\r?\n/m, `---\nscope: ${move.targetScope}\n`)
      }
    }

    // Update Title with new ID if changed
    if (move.fromId !== move.toId) {
      content = content.replace(
        new RegExp(`^#\\s+${move.fromId}\\.\\s+`, "m"),
        `# ${move.toId}. `,
      )
    }

    // Update parent/superseded cross-references
    for (const [oldPath, newPath] of pathMap.entries()) {
      if (content.includes(oldPath)) {
        content = content.split(oldPath).join(newPath)
      }
    }

    writeFileSync(dstFull, content, "utf-8")
    try {
      unlinkSync(srcFull)
    } catch {}

    touchedDirs.add(dirname(move.fromRelPath).replace(/\\/g, "/"))
    touchedDirs.add(dirname(move.toRelPath).replace(/\\/g, "/"))
  }

  // Update indexes in all touched directories
  for (const dir of touchedDirs) {
    updateAdrIndex(projectDir, dir)
  }

  // Update project configuration
  setAdrLayout(plan.targetLayout)

  return {
    executedCount: plan.moves.length,
    touchedDirs: Array.from(touchedDirs),
  }
}
