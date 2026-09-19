/**
 * Explicit style migration & audit (§13 Phase 5, §6.2 migration row).
 *
 * Two surfaces:
 *   - `auditAdrStyles` — the style audit behind `/adr check --report-style`:
 *     every document's resolved style plus a `legacy` flag (no `style`
 *     frontmatter). Report-only; never writes.
 *   - `planAdrStyleMigration` / `executeAdrStyleMigration` — the style
 *     conversion behind `/adr migrate --to <style>`. Planning is pure and
 *     deterministic (same ADL → same report bytes); the default command
 *     surface is a dry-run report and NOTHING is written without an
 *     explicit `--confirm` (§6.2: dry-run default, confirmation required).
 *
 * Invariants honored here:
 *   - Record IDs are frozen forever (§9.5 rule 3) — a conversion never
 *     renumbers; the filename is ID-derived and therefore never changes,
 *     so `destinationPath` currently always equals `sourcePath`. The
 *     field (and the link-rewrite machinery) exists for the day a
 *     conversion also renames.
 *   - `date` is the last-STATUS-change stamp: a style conversion is not a
 *     status change, so `date` (and `created`) are preserved verbatim.
 *   - Content fidelity is bounded by the target grammar (§7.4): MADR-only
 *     optional sections (Decision Drivers, Considered Options, Pros and
 *     Cons of the Options, Confirmation, More Information) have no Nygard
 *     home — the dry-run warns per section that its content would be
 *     DROPPED. Nygard → MADR loses nothing; the target template merely
 *     gains empty sections (system layer: Decision Drivers + Considered
 *     Options placeholders, flagged as informational notes).
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { checkAdrIntegrity, getAllAdrs, resolveAdrRef, toAdrDocument, type AdrMeta } from "./adr-engine"
import { resolveDocumentAdapter } from "./adr-style-registry"
import {
  adrTextCollator,
  bareAdrId,
  extractFrontmatter,
  normalizeAdrId,
  type AdrHealthIssue,
  type AdrStyle,
} from "./adr-types"

// ─── Style audit (`/adr check --report-style`) ───────────────────────

export interface AdrStyleAuditEntry {
  /** POSIX path relative to the project root. */
  sourcePath: string
  /** Adapter grammar the document parses through (`madr` for legacy docs). */
  resolvedStyle: AdrStyle
  /** Explicit `style` frontmatter value, lower-cased; null = legacy. */
  declaredStyle: string | null
  /** True when the document has no `style` frontmatter (Phase 1 legacy). */
  isLegacy: boolean
}

/**
 * Report the resolved style of every discovered ADR document, sorted by
 * source path for deterministic output. Read-only.
 */
export function auditAdrStyles(projectDir: string, defaultDir = "docs/adr"): AdrStyleAuditEntry[] {
  return getAllAdrs(projectDir, defaultDir)
    .map((adr) => {
      const { adapter } = resolveDocumentAdapter(toAdrDocument(adr))
      return {
        sourcePath: adr.relPath,
        resolvedStyle: adapter.style,
        declaredStyle: adr.style ?? null,
        isLegacy: !adr.style,
      }
    })
    .sort((a, b) => adrTextCollator.compare(a.sourcePath, b.sourcePath))
}

// ─── Migration plan (pure — NEVER writes) ────────────────────────────

export type AdrMigrationWarningKind = "dropped-section" | "empty-additions" | "missing-source-section"

export interface AdrStyleMigrationWarning {
  kind: AdrMigrationWarningKind
  /** Canonical section name (dropped-section / missing-source-section). */
  section?: string
  /** Sections added empty by the target template (empty-additions). */
  sections?: string[]
}

export interface AdrLinkRewrite {
  /** Frontmatter field carrying the reference (`parent`/`supersedes`/`superseded_by`). */
  field: string
  /** Raw reference value before conversion. */
  from: string
  /** Raw reference value after conversion. */
  to: string
}

export interface AdrStyleMigrationRecord {
  /** Frozen record ID (§9.5 rule 3) — identical before and after. */
  id: string
  title: string
  sourcePath: string
  destinationPath: string
  /** Resolved source grammar (`madr` for legacy documents). */
  fromGrammar: AdrStyle
  /** Explicit source `style` value, lower-cased; null = legacy. */
  declaredFromStyle: string | null
  /** True when the body grammar already matches the target and only the
   *  `style` frontmatter declaration is added/replaced. */
  frontmatterOnly: boolean
  linkRewrites: AdrLinkRewrite[]
  warnings: AdrStyleMigrationWarning[]
}

export interface AdrStyleMigrationReport {
  toStyle: AdrStyle
  records: AdrStyleMigrationRecord[]
  /** Documents already carrying the target style — reported, not converted. */
  skippedPaths: string[]
}

/** Frontmatter fields scanned for link rewrites (path → path on rename). */
const LINK_FIELDS = ["parent", "supersedes", "superseded_by", "superseded-by"] as const

function rawFrontmatterValue(rawContent: string, key: string): string | undefined {
  const fm = extractFrontmatter(rawContent)
  const v = fm[key]
  return v === undefined || v === "" ? undefined : v
}

/**
 * Build the deterministic migration plan for the whole ADL. Pure: reads
 * the ADL, never writes. Records needing conversion are sorted by source
 * path; already-target-style documents land in `skippedPaths`.
 */
export function planAdrStyleMigration(
  projectDir: string,
  toStyle: AdrStyle,
  defaultDir = "docs/adr",
): AdrStyleMigrationReport {
  if (toStyle === "ocp") {
    throw new Error(
      "style conversion to 'ocp' is not supported — the container grammar (baseline/iteration namespace, section payload) is not reachable by per-file conversion. Adopt ocp by creating a container (`/adr new --style ocp --baseline <b> --iteration <i> <title>`).",
    )
  }
  const adrs = getAllAdrs(projectDir, defaultDir)
  const records: AdrStyleMigrationRecord[] = []
  const skippedPaths: string[] = []

  for (const adr of adrs) {
    const document = toAdrDocument(adr)
    const { adapter } = resolveDocumentAdapter(document)
    const declared = adr.style ?? null
    if (declared === toStyle) {
      skippedPaths.push(adr.relPath)
      continue
    }

    const frontmatterOnly = adapter.style === toStyle
    const warnings: AdrStyleMigrationWarning[] = []
    if (!frontmatterOnly) {
      warnings.push(...conversionWarnings(adr, adapter.style, toStyle))
    }

    records.push({
      id: normalizeAdrId(adr.id) ?? adr.id,
      title: adr.title,
      sourcePath: adr.relPath,
      // Style conversion never renumbers (IDs frozen, §9.5 rule 3) and the
      // filename is ID-derived — the destination keeps the same path. The
      // field exists so a future rename-capable conversion stays explicit.
      destinationPath: adr.relPath,
      fromGrammar: adapter.style,
      declaredFromStyle: declared,
      frontmatterOnly,
      linkRewrites: planLinkRewrites(adr, adrs),
      warnings,
    })
  }

  records.sort((a, b) => adrTextCollator.compare(a.sourcePath, b.sourcePath))
  skippedPaths.sort()
  return { toStyle, records, skippedPaths }
}

/** Outgoing path references whose target would move. Empty today (style
 *  conversion never renames) but computed honestly so the dry-run report
 *  field is real, not hard-coded. */
function planLinkRewrites(adr: AdrMeta, all: AdrMeta[]): AdrLinkRewrite[] {
  const rewrites: AdrLinkRewrite[] = []
  for (const field of LINK_FIELDS) {
    const raw = field === "superseded-by" ? undefined : rawFrontmatterValue(adr.rawContent, field)
    if (!raw) continue
    for (const part of raw.split(",")) {
      const ref = part.trim()
      if (!ref || normalizeAdrId(ref)) continue // ID form: frozen, never rewritten
      const target = resolveAdrRef(ref, all)
      if (!target) continue
      const oldRel = target.relPath
      // A rename-capable conversion would set a new destination path; the
      // rewrite then maps the old reference string onto the new one.
      const newRel = oldRel
      if (newRel !== oldRel) {
        rewrites.push({ field, from: ref, to: ref.includes(oldRel) ? ref.replace(oldRel, newRel) : newRel })
      }
    }
  }
  return rewrites.sort((a, b) => adrTextCollator.compare(a.field, b.field) || adrTextCollator.compare(a.from, b.from))
}

// ─── Body section model & conversion ─────────────────────────────────

interface H2Section {
  heading: string
  /** Text before the first H3 inside this H2. */
  intro: string
  h3: Array<{ heading: string; body: string }>
}

interface ParsedBody {
  title: string | null
  h2: H2Section[]
}

/** Split a document body (frontmatter already stripped) into its H1 title
 *  and H2/H3 section tree. Canonical template names are matched exactly
 *  (§7.4); a heading like `## Status: accepted` lands in `h2` unmatched
 *  and is reported as dropped content on conversion. */
function parseBodySections(rawContent: string): ParsedBody {
  const fmEnd = rawContent.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  const body = fmEnd ? rawContent.slice(fmEnd[0].length) : rawContent
  const lines = body.split(/\r?\n/)

  let title: string | null = null
  const h2: H2Section[] = []
  let current: H2Section | null = null
  let currentH3: { heading: string; body: string } | null = null
  let titleConsumed = false

  const flush = () => {
    if (current && currentH3) {
      current.h3.push(currentH3)
      currentH3 = null
    }
  }

  for (const line of lines) {
    const h1 = /^#\s+(.+?)\s*$/.exec(line)
    if (h1 && !titleConsumed) {
      title = h1[1]
      titleConsumed = true
      continue
    }
    const h2m = /^##\s+(.+?)\s*$/.exec(line)
    if (h2m) {
      flush()
      current = { heading: h2m[1], intro: "", h3: [] }
      h2.push(current)
      continue
    }
    const h3m = /^###\s+(.+?)\s*$/.exec(line)
    if (h3m && current) {
      flush()
      currentH3 = { heading: h3m[1], body: "" }
      continue
    }
    if (currentH3) currentH3.body += line + "\n"
    else if (current) current.intro += line + "\n"
  }
  flush()
  for (const s of h2) {
    s.intro = s.intro.trim()
    for (const t of s.h3) t.body = t.body.trim()
  }
  return { title, h2 }
}

function findH2(parsed: ParsedBody, heading: string): H2Section | undefined {
  return parsed.h2.find((s) => s.heading === heading)
}

function sectionHasContent(section: H2Section | undefined, h3Name?: string): boolean {
  if (!section) return false
  if (h3Name) {
    const sub = section.h3.find((t) => t.heading === h3Name)
    return sub ? sub.body.trim().length > 0 : false
  }
  return section.intro.trim().length > 0
}

/** MADR optional sections with no Nygard home (§7.1/§7.2/§7.4). */
const MADR_ONLY_SECTIONS = [
  "Decision Drivers",
  "Considered Options",
  "Pros and Cons of the Options",
  "Confirmation",
  "More Information",
]

function conversionWarnings(adr: AdrMeta, fromGrammar: AdrStyle, toStyle: AdrStyle): AdrStyleMigrationWarning[] {
  const warnings: AdrStyleMigrationWarning[] = []
  const parsed = parseBodySections(adr.rawContent)

  if (fromGrammar === "madr" && toStyle === "nygard") {
    for (const name of MADR_ONLY_SECTIONS) {
      const section = findH2(parsed, name)
      const body = section?.intro.trim() ?? ""
      // Also treat a populated Confirmation H3 under Decision Outcome as loss.
      const h3Body = name === "Confirmation" ? (findH2(parsed, "Decision Outcome")?.h3.find((t) => t.heading === "Confirmation")?.body.trim() ?? "") : ""
      if (body.length > 0 || h3Body.length > 0) {
        warnings.push({ kind: "dropped-section", section: name })
      }
    }
    // Non-canonical extra H2s (e.g. a hand-added `## Status:` or `## Amendment`)
    // have no Nygard home either — warn with their actual names.
    const known = new Set([...MADR_ONLY_SECTIONS, "Context and Problem Statement", "Decision Outcome", "Consequences"])
    for (const s of parsed.h2) {
      if (!known.has(s.heading) && (s.intro.length > 0 || s.h3.some((t) => t.body.length > 0))) {
        warnings.push({ kind: "dropped-section", section: s.heading })
      }
    }
    // Required target mappings with no usable source content.
    if (!sectionHasContent(findH2(parsed, "Context and Problem Statement"))) {
      warnings.push({ kind: "missing-source-section", section: "Context and Problem Statement" })
    }
    if (!sectionHasContent(findH2(parsed, "Decision Outcome"))) {
      warnings.push({ kind: "missing-source-section", section: "Decision Outcome" })
    }
    const consequences =
      sectionHasContent(findH2(parsed, "Decision Outcome"), "Consequences") ||
      sectionHasContent(findH2(parsed, "Consequences"))
    if (!consequences) {
      warnings.push({ kind: "missing-source-section", section: "Consequences" })
    }
  }

  if (fromGrammar === "nygard" && toStyle === "madr") {
    // Nothing is lost; the system-layer target template gains empty sections.
    if (adr.layer === "system") {
      warnings.push({ kind: "empty-additions", sections: ["Decision Drivers", "Considered Options"] })
    }
    for (const name of ["Context", "Decision", "Consequences"]) {
      if (!sectionHasContent(findH2(parsed, name))) {
        warnings.push({ kind: "missing-source-section", section: name })
      }
    }
  }
  return warnings
}

const FILL_IN = "<To be filled.>"

function buildNygardBody(adr: AdrMeta): string {
  const parsed = parseBodySections(adr.rawContent)
  const context = findH2(parsed, "Context and Problem Statement")
  const outcome = findH2(parsed, "Decision Outcome")
  const consequencesH3 = outcome?.h3.find((t) => t.heading === "Consequences")
  const consequencesH2 = findH2(parsed, "Consequences")

  const id = bareAdrId(normalizeAdrId(adr.id) ?? adr.id)
  return (
    `# ${id}. ${adr.title}\n\n` +
    `## Context\n\n${context?.intro.trim() || FILL_IN}\n\n` +
    `## Decision\n\n${outcome?.intro.trim() || FILL_IN}\n\n` +
    `## Consequences\n\n${consequencesH3?.body.trim() || consequencesH2?.intro.trim() || FILL_IN}\n`
  )
}

function buildMadrBody(adr: AdrMeta): string {
  const parsed = parseBodySections(adr.rawContent)
  const context = findH2(parsed, "Context")
  const decision = findH2(parsed, "Decision")
  const consequences = findH2(parsed, "Consequences")

  const system = adr.layer === "system"
  const id = bareAdrId(normalizeAdrId(adr.id) ?? adr.id)
  let body = `# ${id}. ${adr.title}\n\n`
  body += `## Context and Problem Statement\n\n${context?.intro.trim() || FILL_IN}\n\n`
  if (system) {
    body += `## Decision Drivers\n\n${FILL_IN}\n\n`
    body += `## Considered Options\n\n${FILL_IN}\n\n`
  }
  body += `## Decision Outcome\n\n${decision?.intro.trim() || FILL_IN}\n\n`
  body += `### Consequences\n\n${consequences?.intro.trim() || FILL_IN}\n`
  return body
}

// ─── Frontmatter handling ────────────────────────────────────────────

/** Return the frontmatter block lines (without the --- fences) of a raw
 *  document; empty array when the document has no frontmatter. */
function frontmatterLines(rawContent: string): string[] {
  const m = rawContent.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  return m ? m[1].split(/\r?\n/) : []
}

/** Add or replace the `style:` declaration, preserving every other
 *  frontmatter line (status, created, date, layer, links, …) verbatim and
 *  in order. `date` is intentionally NOT touched — a style conversion is
 *  not a status change. */
export function rewriteStyleFrontmatter(rawContent: string, toStyle: AdrStyle): string {
  const lines = frontmatterLines(rawContent)
  const styleRe = /^style\s*:/i
  let replaced = false
  const out = lines.map((line) => {
    if (styleRe.test(line)) {
      replaced = true
      return `style: ${toStyle}`
    }
    return line
  })
  if (!replaced) out.unshift(`style: ${toStyle}`)
  const rest = rawContent.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
  return `---\n${out.join("\n")}\n---\n\n${rest.replace(/^\s+/, "")}`
}

// ─── Deterministic report rendering ──────────────────────────────────

export interface AdrStyleMigrationLabels {
  summary: string
  recordHead: string
  sourceLine: string
  destinationLine: string
  destinationUnchanged: string
  idLine: string
  linksNone: string
  linksHead: string
  linksRow: string
  warningsNone: string
  warningsHead: string
  warnDropped: string
  warnAdded: string
  warnMissing: string
}

export const EN_MIGRATION_LABELS: AdrStyleMigrationLabels = {
  summary: "Records to convert: **{count}** · already `{to}`: **{skipped}**",
  recordHead: "### {id} — {title}",
  sourceLine: "- Source: `{path}`",
  destinationLine: "- Destination: `{path}`{note}",
  destinationUnchanged: " (filename unchanged — IDs are frozen, §9.5 rule 3)",
  idLine: "- Record ID: `{id}` (unchanged)",
  linksNone: "- Link rewrites: none",
  linksHead: "- Link rewrites:",
  linksRow: "  - `{field}`: `{from}` → `{to}`",
  warningsNone: "- Unconvertible content warnings: none",
  warningsHead: "- Unconvertible content warnings:",
  warnDropped: "  - ⚠️ Section `{section}` has no `{to}` equivalent — its content would be **dropped** on conversion",
  warnAdded: "  - ℹ️ `{to}` adds empty section(s) {sections}; no source content is lost",
  warnMissing: "  - ⚠️ Source section `{section}` is missing or empty — the target section will be a placeholder",
}

function fill(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m))
}

function renderWarning(w: AdrStyleMigrationWarning, toStyle: AdrStyle, labels: AdrStyleMigrationLabels): string {
  if (w.kind === "dropped-section") return fill(labels.warnDropped, { section: w.section ?? "?", to: toStyle })
  if (w.kind === "empty-additions") {
    return fill(labels.warnAdded, { to: toStyle, sections: (w.sections ?? []).map((s) => `\`${s}\``).join(", ") })
  }
  return fill(labels.warnMissing, { section: w.section ?? "?" })
}

/**
 * Render the migration report as deterministic Markdown: same plan +
 * same labels → identical bytes. Contains no timestamps (dates are
 * preserved from source documents, not generated).
 */
export function renderMigrationReport(
  report: AdrStyleMigrationReport,
  labels: AdrStyleMigrationLabels = EN_MIGRATION_LABELS,
): string {
  let out = fill(labels.summary, { count: report.records.length, to: report.toStyle, skipped: report.skippedPaths.length })
  out += "\n\n"
  for (const rec of report.records) {
    out += fill(labels.recordHead, { id: rec.id, title: rec.title }) + "\n"
    out += fill(labels.sourceLine, { path: rec.sourcePath }) + "\n"
    const note = rec.destinationPath === rec.sourcePath ? labels.destinationUnchanged : ""
    out += fill(labels.destinationLine, { path: rec.destinationPath, note }) + "\n"
    out += fill(labels.idLine, { id: rec.id }) + "\n"
    if (rec.linkRewrites.length === 0) {
      out += labels.linksNone + "\n"
    } else {
      out += labels.linksHead + "\n"
      for (const lr of rec.linkRewrites) {
        out += fill(labels.linksRow, { field: lr.field, from: lr.from, to: lr.to }) + "\n"
      }
    }
    if (rec.warnings.length === 0) {
      out += labels.warningsNone + "\n"
    } else {
      out += labels.warningsHead + "\n"
      for (const w of rec.warnings) {
        out += renderWarning(w, report.toStyle, labels) + "\n"
      }
    }
    out += "\n"
  }
  return out
}

// ─── Execution (writes ONLY with an explicit confirm at the call site) ─

export interface AdrStyleMigrationResult {
  written: string[]
  verification: {
    ok: boolean
    issues: AdrHealthIssue[]
  }
}

/** Convert one document's raw content to the target style. Body rebuilt
 *  only when the source grammar differs; otherwise frontmatter-only. */
export function convertAdrContent(rawContent: string, rec: AdrStyleMigrationRecord, toStyle: AdrStyle): string {
  const fm = rewriteStyleFrontmatter(rawContent, toStyle)
  if (rec.frontmatterOnly) return fm
  const layerRaw = extractFrontmatter(rawContent)["layer"]
  const adr: AdrMeta = {
    id: rec.id.replace(/^ADR-/i, ""),
    slug: "",
    filename: rec.sourcePath.split("/").pop() ?? "",
    relPath: rec.sourcePath,
    fullPath: "",
    dir: "",
    title: rec.title,
    status: "",
    date: "",
    layer: layerRaw === "domain" || layerRaw === "component" ? layerRaw : "system",
    rawContent,
  }
  const body = toStyle === "nygard" ? buildNygardBody(adr) : buildMadrBody(adr)
  const fmBlock = fm.match(/^---\r?\n[\s\S]*?\r?\n---/)
  const fmText = fmBlock ? fmBlock[0] : "---\n---"
  return `${fmText}\n\n${body}`
}

/**
 * Execute a previously planned migration: rewrites each declared source
 * path in place (destination === source for style-only conversion), then
 * verifies every written document re-parses as the target style, passes
 * its own adapter's validation, and leaves the ADL integrity check
 * error-free. Writes nothing beyond the declared record paths.
 */
export function executeAdrStyleMigration(
  projectDir: string,
  report: AdrStyleMigrationReport,
): AdrStyleMigrationResult {
  const written: string[] = []
  const issues: AdrHealthIssue[] = []

  for (const rec of report.records) {
    const fullPath = join(projectDir, rec.sourcePath)
    let raw: string
    try {
      raw = readFileSync(fullPath, "utf-8")
    } catch (err) {
      issues.push({
        type: "missing-field",
        severity: "error",
        file: rec.sourcePath,
        message: `Migration target unreadable: ${String(err)}`,
      })
      continue
    }
    const converted = convertAdrContent(raw, rec, report.toStyle)
    writeFileSync(fullPath, converted, "utf-8")
    written.push(rec.destinationPath)

    // Verify the written result re-parses as the target style.
    const verifyRaw = readFileSync(fullPath, "utf-8")
    const document = {
      fullPath,
      relPath: rec.destinationPath,
      filename: rec.destinationPath.split("/").pop() ?? "",
      rawContent: verifyRaw,
      frontmatter: extractFrontmatter(verifyRaw),
    }
    const { adapter, declaredStyle } = resolveDocumentAdapter(document)
    if (declaredStyle !== report.toStyle || adapter.style !== report.toStyle) {
      issues.push({
        type: "invalid-field",
        severity: "error",
        file: rec.destinationPath,
        message: `Written document does not re-parse as '${report.toStyle}' (declared '${declaredStyle ?? "none"}')`,
      })
      continue
    }
    const record = adapter.parse(document)
    for (const iss of adapter.validate(document, record)) {
      if (iss.severity === "error") issues.push(iss)
    }
  }

  // Whole-ADL integrity after conversion (duplicate IDs, broken links, …).
  for (const iss of checkAdrIntegrity(projectDir)) {
    if (iss.severity === "error") issues.push(iss)
  }

  return { written, verification: { ok: issues.length === 0, issues } }
}
