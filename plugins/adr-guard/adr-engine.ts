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
import { type AdrLayout, getAdrLayout, setAdrLayout } from "./adr-guard-config"

export type AdrLayer = "system" | "domain" | "component"

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
  rawContent: string
}

export interface AdrHealthIssue {
  type: "broken-parent" | "broken-supersede" | "missing-field" | "index-mismatch" | "duplicate-id"
  severity: "error" | "warn"
  file: string
  message: string
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".cache",
  ".agents",
  ".opencode",
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
 * Parse frontmatter and basic structure of a MADR file.
 */
export function parseAdrFile(fullPath: string, projectDir: string): AdrMeta | null {
  try {
    const rawContent = readFileSync(fullPath, "utf-8")
    const filename = fullPath.replace(/\\/g, "/").split("/").pop() || ""
    const match = filename.match(/^(\d{4})-(.+)\.md$/)
    if (!match) return null

    const id = match[1]
    const slug = match[2]
    const relPath = relative(projectDir, fullPath).replace(/\\/g, "/")
    const dir = dirname(relPath).replace(/\\/g, "/")

    let status = "proposed"
    let date = new Date().toISOString().split("T")[0]
    let layer: AdrLayer = "system"
    let scope: string | undefined
    let parent: string | undefined
    let supersededBy: string | undefined

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
        else if (key === "layer" && (val === "system" || val === "domain" || val === "component")) {
          layer = val as AdrLayer
        } else if (key === "scope") scope = val
        else if (key === "parent") parent = val
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

    // Extract title from `# [NNNN.] <Title>`
    let title = slug.replace(/-/g, " ")
    const titleMatch = rawContent.match(/^#\s+(?:\d{4}\.?\s+)?([^\r\n]+)/m)
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

  return adrs.sort((a, b) => a.relPath.localeCompare(b.relPath) || a.id.localeCompare(b.id))
}

/**
 * Get next sequential number in a specific directory.
 */
export function getNextAdrNumber(projectDir: string, targetRelDir: string): string {
  const fullDir = join(projectDir, targetRelDir)
  if (!existsSync(fullDir)) return "0001"

  let maxNum = 0
  try {
    const files = readdirSync(fullDir)
    for (const f of files) {
      const m = f.match(/^(\d{4})-/)
      if (m) {
        const n = parseInt(m[1], 10)
        if (n > maxNum) maxNum = n
      }
    }
  } catch {}

  return (maxNum + 1).toString().padStart(4, "0")
}

/**
 * Re-generate INDEX.md in a given ADR directory.
 */
export function updateAdrIndex(projectDir: string, targetRelDir: string): void {
  const fullDir = join(projectDir, targetRelDir)
  if (!existsSync(fullDir)) return

  const files = readdirSync(fullDir)
  const adrs: AdrMeta[] = []
  for (const f of files) {
    if (!f.endsWith(".md") || f.toUpperCase() === "INDEX.MD") continue
    const parsed = parseAdrFile(join(fullDir, f), projectDir)
    if (parsed) adrs.push(parsed)
  }

  adrs.sort((a, b) => a.id.localeCompare(b.id))

  let indexContent = `# Architecture Decision Log\n\n`
  indexContent += `*Directory: \`${targetRelDir}\`*\n\n`
  indexContent += `| ID | Decision Title | Layer | Status | Date |\n`
  indexContent += `| :--- | :--- | :--- | :--- | :--- |\n`

  for (const adr of adrs) {
    const badge = statusBadge(adr.status)
    indexContent += `| [${adr.id}](./${adr.filename}) | ${adr.title} | \`${adr.layer}\` | ${badge} | ${adr.date} |\n`
  }

  writeFileSync(join(fullDir, "INDEX.md"), indexContent, "utf-8")
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
  parent?: string
  status?: string
  layout?: AdrLayout
}

/**
 * Scaffold a new ADR file and update its index.
 */
export function createAdr(options: CreateAdrOptions): { relPath: string; fullPath: string; id: string } {
  const currentLayout = options.layout ?? getAdrLayout()
  let {
    projectDir,
    title,
    layer = "system",
    scope,
    parent,
    status = "accepted",
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

  const id = getNextAdrNumber(projectDir, targetRelDir)
  const slug = slugify(title) || "decision"
  const filename = `${id}-${slug}.md`
  const fullPath = join(fullDir, filename)
  const relPath = `${targetRelDir}/${filename}`
  const today = new Date().toISOString().split("T")[0]

  let content = `---\n`
  content += `status: ${status}\n`
  content += `date: ${today}\n`
  content += `layer: ${layer}\n`
  if (scope) content += `scope: ${scope}\n`
  if (parent) content += `parent: ${parent}\n`
  content += `---\n\n`

  content += `# ${id}. ${title}\n\n`

  if (layer === "system") {
    content += `## Context and Problem Statement\n\n<Describe the architectural context, system-level problem, and constraints.>\n\n`
    content += `## Decision Drivers\n\n- Driver 1 (e.g. scalability, security, maintainability)\n- Driver 2\n\n`
    content += `## Considered Options\n\n- **Option 1**: <Description>\n- **Option 2**: <Description>\n\n`
    content += `## Decision Outcome\n\nChosen option: **Option 1**, because <rationales and trade-offs>.\n\n`
    content += `### Consequences\n\n- **Positive**: <Good impacts>\n- **Negative / Risks**: <Trade-offs & mitigations>\n`
  } else {
    content += `## Context and Problem Statement\n\n<Describe the situation, module context, and requirement.>\n\n`
    content += `## Decision Outcome\n\nChosen option: <what was decided>, because <why>.\n`
  }

  writeFileSync(fullPath, content, "utf-8")
  updateAdrIndex(projectDir, targetRelDir)

  return { relPath, fullPath, id }
}

/**
 * Mark an old ADR as superseded and scaffold a new replacement ADR.
 */
export function supersedeAdr(
  projectDir: string,
  oldRef: string,
  newTitle: string,
  newOptions: Partial<CreateAdrOptions> = {},
): { newAdr: { relPath: string; fullPath: string; id: string }; oldAdr: AdrMeta } {
  const cleanRef = oldRef.trim().replace(/^["']|["']$/g, "")
  const num = /^\d+$/.test(cleanRef) ? parseInt(cleanRef, 10) : NaN
  const paddedId = !isNaN(num) ? String(num).padStart(4, "0") : null

  const adrs = getAllAdrs(projectDir)
  const oldAdr = adrs.find(
    (a) =>
      a.id === cleanRef ||
      (paddedId !== null && a.id === paddedId) ||
      a.relPath === cleanRef ||
      a.filename === cleanRef ||
      a.filename.startsWith(`${cleanRef}-`) ||
      (paddedId !== null && a.filename.startsWith(`${paddedId}-`)),
  )

  if (!oldAdr) {
    throw new Error(`Cannot find existing ADR matching '${oldRef}' to supersede.`)
  }

  // Create new ADR in same directory or target dir
  const targetDir = newOptions.targetDir || oldAdr.dir
  const created = createAdr({
    projectDir,
    title: newTitle,
    layer: newOptions.layer || oldAdr.layer,
    scope: newOptions.scope || oldAdr.scope,
    targetDir,
    parent: oldAdr.relPath,
    status: "accepted",
  })

  // Update old ADR file
  let oldContent = oldAdr.rawContent
  if (/status:\s*[^\r\n]+/i.test(oldContent)) {
    oldContent = oldContent.replace(
      /status:\s*[^\r\n]+/i,
      `status: superseded by ${created.id}`,
    )
  } else {
    oldContent = `---\nstatus: superseded by ${created.id}\n---\n\n` + oldContent
  }

  // Append superseded note if not present
  if (!oldContent.includes("superseded_by:")) {
    oldContent = oldContent.replace(/^---\r?\n/m, `---\nsuperseded_by: ${created.relPath}\n`)
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
      const parentMatch = adr.parent.match(/(\d{4})/)
      if (parentMatch) {
        output += `  ADR_${parentMatch[1]} -->|constrains| ${nodeId}\n`
      }
    }

    if (adr.supersededBy) {
      const supMatch = adr.supersededBy.match(/(\d{4})/)
      if (supMatch) {
        output += `  ${nodeId} -.->|superseded by| ADR_${supMatch[1]}\n`
      }
    } else if (adr.status.includes("superseded by")) {
      const supMatch = adr.status.match(/superseded by\s+(\d{4})/i)
      if (supMatch) {
        output += `  ${nodeId} -.->|superseded by| ADR_${supMatch[1]}\n`
      }
    }
  }

  output += "```\n"

  return output
}

/**
 * Integrity & Health checker.
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

    // Check parent links
    if (adr.parent) {
      const parentFound = adrs.some(
        (a) => a.relPath === adr.parent || a.filename === adr.parent || a.id === adr.parent,
      )
      if (!parentFound) {
        issues.push({
          type: "broken-parent",
          severity: "error",
          file: adr.relPath,
          message: `Parent reference '${adr.parent}' cannot be resolved to an existing ADR`,
        })
      }
    }

    // Check supersede links
    if (adr.status.includes("superseded by")) {
      const supId = adr.status.match(/superseded by\s+(\d{4})/i)?.[1]
      if (supId) {
        const targetFound = adrs.some((a) => a.id === supId)
        if (!targetFound) {
          issues.push({
            type: "broken-supersede",
            severity: "error",
            file: adr.relPath,
            message: `Superseded target ID '${supId}' does not exist in workspace`,
          })
        }
      }
    }
  }

  // Check duplicate IDs within same directory
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
  }

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

