/**
 * Multi-style ADL — normalized model, ID grammar, and style adapter contracts.
 *
 * One Architecture Decision Log (ADL) may contain several ADR styles
 * (nygard, madr). Every source document parses into ONE
 * NormalizedAdrRecord regardless of style; all shared tooling
 * (index, tree, history, integrity) consumes normalized records only.
 *
 * ID grammar (single authority — normalizeAdrId): `ADR-` + four digits
 * (`ADR-0001`) or `ADR-` + a dotted evolution path (`ADR-0.2.54.01`).
 * Bare forms (`0001`, `0.2.54.01`) canonicalize to the prefixed form.
 * Dotted and sequential IDs can never collide by grammar.
 *
 * Phase 1 ships the `madr` adapter only; the registry is shaped so
 * adding `styles/nygard.ts` (Phase 2) is a single registration call.
 */

export type AdrStyle = "nygard" | "madr" | "ocp"

export type AdrStatus = "proposed" | "accepted" | "rejected" | "superseded" | "deprecated"

export type AdrNumbering = "sequential" | "iteration"

export type AdrLayer = "system" | "domain" | "component"

export type AdrGovernance = "none" | "review" | "strict"

/** Style-independent internal representation consumed by all shared tools. */
/** One sub-decision section inside an `ocp` container record. The graph
 * (parent/supersession/INDEX/history) operates at CONTAINER granularity;
 * sections are structured payload parsed from H3 blocks, not records. */
export interface AdrSection {
  /** Canonical sub-ID, zero-padded dotted (`ADR-0.2.54.01`) — lives in
   * the container's reserved `<baseline>.<iteration>.*` namespace. */
  id: string
  /** Bare padded sequence (`01`). */
  seq: string
  title: string
  status: AdrStatus | string
  background?: string
  decision?: string
  rationale?: string
  /** Rejected alternatives, each carrying an explicit reason. */
  rejected?: Array<{ option: string; reason: string }>
  /** Impact bullets, as written by the author. */
  impact?: string[]
}

export interface NormalizedAdrRecord {
  id: string // canonical `ADR-NNNN`, `ADR-x.y.z.qq`, or container `ADR-x.y.z` — never a path
  style: AdrStyle
  sourcePath: string
  title: string
  status: AdrStatus | string
  created?: string // immutable creation date (falls back to `date` for legacy files)
  date?: string // last-status-change stamp
  layer?: AdrLayer
  domain?: string
  scope?: string
  baseline?: string
  iteration?: string
  parentIds: string[] // normalized ADR IDs, never file paths
  supersedes: string[] // normalized ADR IDs, never file paths
  supersededBy: string[]
  /** `ocp` containers only: parsed section payload (undefined for other styles). */
  sections?: AdrSection[]
  rawContent: string
}

/** One parsed ADR source document — adapter input. */
export interface AdrDocument {
  fullPath: string
  relPath: string
  filename: string
  rawContent: string
  /** Lower-cased frontmatter keys → raw (unquoted) values. */
  frontmatter: Record<string, string>
}

/** Reference-resolution context supplied by the engine during parse:
 * maps a `parent`/`superseded_by`/`supersedes` value (ID or path) to a
 * canonical ADR ID, or null when unresolvable. */
export interface AdrParseContext {
  resolveRef(ref: string): string | null
}

export interface AdrHealthIssue {
  type: "broken-parent" | "broken-supersede" | "missing-field" | "index-mismatch" | "duplicate-id" | "missing-section" | "invalid-field" | "profile"
  severity: "error" | "warn"
  file: string
  message: string
}

/** Adapter input for scaffolding one new record. */
export interface CreateAdrInput {
  id: string // bare ID (`0001` / `0.2.54.01`) — adapter renders it
  title: string
  status: string
  date: string // last-status-change stamp
  created: string // immutable creation date
  layer: AdrLayer
  scope?: string
  domain?: string
  baseline?: string
  iteration?: string
  /** Raw reference strings as given by the caller (ID or path form). */
  parent?: string
  supersedes?: string
}

/** One ADR style grammar (scaffold/parse/validate/format/index). */
export interface AdrStyleAdapter {
  readonly style: AdrStyle
  scaffold(input: CreateAdrInput): string
  /** Container styles only (`ocp`): render one new section block for
   * appending to an existing container file. Undefined for
   * one-decision-per-file styles. */
  scaffoldSection?(input: { id: string; title: string }): string
  detect(content: string, path: string): boolean
  parse(document: AdrDocument, context?: AdrParseContext): NormalizedAdrRecord
  validate(document: AdrDocument, record: NormalizedAdrRecord): AdrHealthIssue[]
  format(document: AdrDocument): string
  renderIndexEntry(record: NormalizedAdrRecord): string
}

/** Extract the lower-cased frontmatter key/value map from raw Markdown
 * (empty object when the document has no frontmatter block). */
export function extractFrontmatter(rawContent: string): Record<string, string> {
  const fm: Record<string, string> = {}
  const fmMatch = rawContent.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fmMatch) return fm
  for (const line of fmMatch[1].split(/\r?\n/)) {
    const colonIdx = line.indexOf(":")
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim().toLowerCase()
    const val = line.slice(colonIdx + 1).split("#")[0].trim().replace(/^["']|["']$/g, "")
    fm[key] = val
  }
  return fm
}

// ─── ID grammar — single authority ───────────────────────────────────

const SEQUENTIAL_RE = /^ADR-(\d{1,4})$/
const DOTTED_RE = /^ADR-(\d+\.\d+\.\d+\.\d+)$/
/** Container form (`ADR-0.2.54`) — one record per iteration file. */
const CONTAINER_RE = /^ADR-(\d+\.\d+\.\d+)$/
/** Section form (`ADR-0.2.54#01`, `ADR-0042#01`) — one section inside a
 * container. `#` is the universal fragment sigil: structurally disjoint
 * from the per-decision dotted grammar (`ADR-0.2.54.01` is a RECORD,
 * `ADR-0.2.54#01` is a section), so container and section IDs can never
 * be confused. Numbering is orthogonal to container-ness (§6): the
 * container may carry a sequential (`ADR-0042`) or an iteration
 * (`ADR-0.2.54`) ID. */
const SECTION_RE = /^ADR-((?:\d{4})|(?:\d+\.\d+\.\d+))#(\d{1,})$/

/**
 * Canonicalize a bare or prefixed ADR ID to the `ADR-…` form.
 * Accepts `0001`/`ADR-0001` (digits padded to four),
 * `0.2.54.01`/`ADR-0.2.54.01` (per-decision dotted path),
 * `0.2.54`/`ADR-0.2.54` (container path, ocp style), and
 * `0.2.54#1`/`ADR-0.2.54#01` (container section, seq padded to two).
 * Returns null for anything else — every uniqueness check, supersession
 * reference, and index render routes through here.
 */
export function normalizeAdrId(raw: string): string | null {
  const s = raw.trim().replace(/^["']|["']$/g, "")
  if (s === "") return null
  const upper = s.toUpperCase()
  const seq = SEQUENTIAL_RE.exec(upper)
  if (seq) return `ADR-${seq[1].padStart(4, "0")}`
  const dotted = DOTTED_RE.exec(upper)
  if (dotted) return `ADR-${dotted[1]}`
  const container = CONTAINER_RE.exec(upper)
  if (container) return `ADR-${container[1]}`
  const section = SECTION_RE.exec(upper)
  if (section) return `ADR-${section[1]}#${section[2].padStart(2, "0")}`
  // Bare forms
  if (/^\d+$/.test(s)) return `ADR-${s.padStart(4, "0")}`
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) return `ADR-${s}`
  if (/^\d+\.\d+\.\d+$/.test(s)) return `ADR-${s}`
  const bareSection = /^((?:\d{4})|(?:\d+\.\d+\.\d+))#(\d{1,})$/.exec(s)
  if (bareSection) return `ADR-${bareSection[1]}#${bareSection[2].padStart(2, "0")}`
  return null
}

/** Strip the `ADR-` prefix, yielding the bare file-stem ID (`0001`, `0.2.54.01`, `0.2.54`). */
export function bareAdrId(canonicalId: string): string {
  return canonicalId.replace(/^ADR-/i, "")
}

/** Extract the ADR ID from a source filename (`0001-slug.md`, `0.2.54.01-slug.md`,
 * `0.2.54-slug.md` container). The four-segment alternative precedes the
 * three-segment one so per-decision stems win over the container prefix. */
export function adrIdFromFilename(filename: string): string | null {
  const m = /^(?:(\d{4})|(\d+\.\d+\.\d+\.\d+)|(\d+\.\d+\.\d+))-(.+)\.md$/.exec(filename)
  if (!m) return null
  return normalizeAdrId(m[1] ?? m[2] ?? m[3] ?? "")
}

// ─── Language-parenthetical tolerance ────────────────────────────────

/** Every style's grammar labels are a single English authority. An
 * optional parenthetical after a heading or field label — `## Context
 * and Problem Statement (…)` — is a DISPLAY-ONLY note the LLM fills in
 * the team's language when drafting. Parsers and validators ignore it.
 * Applies to EVERY style, not just ocp. */
export const LANG_PAREN_RE = "(?:\\s*[（(][^）)]*[）)])?"

/** Exact-heading test with parenthetical tolerance: `^#{level} <name>$`
 * (multiline) where an optional language parenthetical may follow
 * `<name>`. */
export function headingLineRe(name: string, level: number): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^#{${level}}\\s+${escaped}${LANG_PAREN_RE}\\s*$`, "m")
}

// ─── Pinned-locale collation (cross-environment determinism) ──────────
/** All user-visible string ordering routes through pinned-"en" collators:
 *  host-locale collation (tr/az i/I reordering, numeric drift) would
 *  reorder dry-run report and generated-view rows on a differently
 *  locale'd host (§13 Phase 5 determinism, §15 sorting contract). */
export const adrTextCollator = new Intl.Collator("en", { numeric: false, sensitivity: "variant" })

/** Numeric-segment-aware variant for iteration display grouping (`0.2.9`
 *  before `0.2.10`) — still pinned to "en". */
export const adrNumericCollator = new Intl.Collator("en", { numeric: true, sensitivity: "variant" })
