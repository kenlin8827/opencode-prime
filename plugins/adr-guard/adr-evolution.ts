/**
 * Evolution metadata, iteration views & the optional `evolution`
 * validation profile (Phase 3, §7.3 / §13).
 *
 * Universal protocol layer (§7.4): the status lifecycle, immutable
 * accepted semantics, supersession mechanics, AI-drafts/human-decides,
 * and readability rules apply to EVERY style; only the canonical body
 * template is style-specific. This module implements the universal
 * pieces evolution tracking adds on top of one-decision-per-file:
 *
 *   - evolution frontmatter (`baseline` / `iteration` / `domain`) with
 *     basic shape sanity, on any style;
 *   - generated per-iteration views (`INDEX.by-iteration.md`) — a
 *     generated summary can never drift from the records it summarizes
 *     (§7.3 requirement 2: generated, never hand-maintained);
 *   - iteration context bundling (active records + supersession chains,
 *     bounded, with a reported retrieval path);
 *   - the opt-in `evolution` validation profile (baijiu-shop discipline:
 *     non-empty Considered Options with per-option cons, good/bad
 *     Consequences split, Confirmation for frontmatter-flagged high-risk
 *     records). Nygard records get only what maps: non-empty canonical
 *     sections — MADR-specific requirements are never forced onto
 *     Nygard (§7.4 style isolation).
 *
 * Everything here is a pure function over NormalizedAdrRecord[] — file
 * discovery and writes stay in adr-engine.ts (one-direction imports:
 * engine → evolution).
 */

import { adrNumericCollator, adrTextCollator, extractFrontmatter, headingLineRe, type AdrHealthIssue, type NormalizedAdrRecord } from "./adr-types"

// ─── Frontmatter shape sanity (§7.3) ─────────────────────────────────

/** Dotted numeric segments (`0.2`, `54`, `0.2.54`). */
const EVOLUTION_VALUE_RE = /^\d+(\.\d+)*$/
/** Domain slug: lowercase kebab-ish identifier. */
const DOMAIN_VALUE_RE = /^[a-z0-9][a-z0-9-]*$/

/**
 * Validate evolution frontmatter shapes on normalized records (any
 * style). Malformed values are warnings, not errors — the metadata is
 * optional and grouping simply skips unshaped values.
 */
export function validateEvolutionMetadataShape(records: NormalizedAdrRecord[]): AdrHealthIssue[] {
  const issues: AdrHealthIssue[] = []
  for (const record of records) {
    if (record.baseline !== undefined && !EVOLUTION_VALUE_RE.test(record.baseline)) {
      issues.push(shapeIssue(record, "baseline", record.baseline))
    }
    if (record.iteration !== undefined && !EVOLUTION_VALUE_RE.test(record.iteration)) {
      issues.push(shapeIssue(record, "iteration", record.iteration))
    }
    if (record.domain !== undefined && !DOMAIN_VALUE_RE.test(record.domain)) {
      issues.push(shapeIssue(record, "domain", record.domain))
    }
  }
  return issues
}

function shapeIssue(record: NormalizedAdrRecord, key: string, value: string): AdrHealthIssue {
  return {
    type: "invalid-field",
    severity: "warn",
    file: record.sourcePath,
    message: `Invalid evolution metadata '${key}: ${value}' — expected a dotted numeric value` +
      (key === "domain" ? " (lowercase slug)" : " (e.g. 0.2, 54, 0.2.54)"),
  }
}

// ─── Iteration grouping & generated view (§6.1 rule 6, §7.3 req 2) ───

export function byCreatedThenPath(a: NormalizedAdrRecord, b: NormalizedAdrRecord): number {
  return adrTextCollator.compare(a.created ?? a.date ?? "", b.created ?? b.date ?? "") || adrTextCollator.compare(a.sourcePath, b.sourcePath)
}

export interface IterationGroup {
  iteration: string
  records: NormalizedAdrRecord[]
}

/**
 * Group records by the `iteration` metadata field — NEVER by parsing ID
 * strings (§6.1 rule 6). Records inside a group order by `created`
 * (immutable), then source path. Groups order by iteration with numeric
 * segment awareness (`0.2.9` before `0.2.10`).
 */
export function groupByIteration(records: NormalizedAdrRecord[]): IterationGroup[] {
  const map = new Map<string, NormalizedAdrRecord[]>()
  for (const record of records) {
    const iteration = (record.iteration ?? "").trim()
    if (iteration === "") continue
    const list = map.get(iteration) || []
    list.push(record)
    map.set(iteration, list)
  }
  const groups: IterationGroup[] = Array.from(map.entries()).map(([iteration, groupRecords]) => ({
    iteration,
    records: groupRecords.slice().sort(byCreatedThenPath),
  }))
  groups.sort((a, b) => adrNumericCollator.compare(a.iteration, b.iteration))
  return groups
}

/** Render INDEX.by-iteration.md content (the caller writes the file). */
export function renderIterationIndex(records: NormalizedAdrRecord[], rootRel = "docs/adr"): string {
  const groups = groupByIteration(records)
  let out = `# Architecture Decisions by Iteration\n\n`
  out += `> ⚠️ **GENERATED VIEW — DO NOT EDIT BY HAND.** This file is regenerated from the\n`
  out += `> records' \`iteration\` frontmatter metadata (§7.3). Any hand edit is overwritten\n`
  out += `> on the next regeneration — change the records instead. Grouping uses the\n`
  out += `> \`iteration\` metadata field, never ID-string parsing; records order by\n`
  out += `> \`created\` (immutable), then source path (§6.1 rule 6).\n`

  for (const group of groups) {
    out += `\n## Iteration \`${group.iteration}\` (${group.records.length} record${group.records.length === 1 ? "" : "s"})\n\n`
    out += `| ID | Decision Title | Style | Status | Created | Source |\n`
    out += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`
    for (const record of group.records) {
      const filename = record.sourcePath.split("/").pop() ?? record.sourcePath
      const link = relativeLink(rootRel, record.sourcePath)
      const status = String(record.status)
      out += `| [${record.id}](${link}) | ${record.title} | \`${record.style}\` | ${status} | ${record.created ?? record.date ?? ""} | \`${filename}\` |\n`
    }
  }
  return out
}

/** Posix-relative link from the ADL root to a record path. */
function relativeLink(rootRel: string, sourcePath: string): string {
  const root = rootRel.replace(/\\/g, "/").replace(/\/+$/, "").split("/")
  const path = sourcePath.replace(/\\/g, "/").split("/")
  let common = 0
  while (common < root.length && common < path.length && root[common] === path[common]) common++
  const ups = root.length - common
  return `./${"../".repeat(ups)}${path.slice(common).join("/")}`
}

// ─── Iteration context bundling (§13, bounded, retrieval path) ───────

/**
 * True when a record belongs to the queried iteration: exact
 * `iteration` metadata match, or the `baseline.iteration` composite
 * form (`baseline: "0.2"` + `iteration: "54"` answers query `0.2.54`).
 */
export function matchesIteration(record: NormalizedAdrRecord, query: string): boolean {
  const iteration = (record.iteration ?? "").trim()
  if (iteration === "") return false
  if (iteration === query) return true
  const baseline = (record.baseline ?? "").trim()
  return baseline !== "" && `${baseline}.${iteration}` === query
}

export interface IterationContext {
  iteration: string
  /** Records carrying this iteration's metadata (sorted created→path). */
  matched: NormalizedAdrRecord[]
  /** Matched records that are still active (not superseded). */
  active: NormalizedAdrRecord[]
  /** Supersession-chain records OUTSIDE the iteration (cross-style OK). */
  chains: { record: NormalizedAdrRecord; via: string }[]
  /** Progressive-disclosure retrieval path, human-readable. */
  retrievalPath: string[]
  /** True when chain bounds were hit and output was truncated. */
  truncated: boolean
}

/**
 * Bundle an iteration's records plus their supersession chains.
 * Bounded: ≤ `maxHops` chain hops (default 3) and ≤ `maxChainRecords`
 * chain records (default 8) — a context bundle must stay a quick read,
 * not a corpus dump. The retrieval path reports exactly how every
 * bundled record was reached (iteration metadata match → record →
 * supersession edge → chain record).
 */
export function buildIterationContext(
  records: NormalizedAdrRecord[],
  rawQuery: string,
  opts: { maxHops?: number; maxChainRecords?: number } = {},
): IterationContext {
  const query = rawQuery.trim()
  const maxHops = opts.maxHops ?? 3
  const maxChainRecords = opts.maxChainRecords ?? 8

  const matched = records.filter((r) => matchesIteration(r, query)).sort(byCreatedThenPath)
  const byId = new Map(records.map((r) => [r.id, r]))
  const seen = new Set(matched.map((r) => r.id))
  const chains: { record: NormalizedAdrRecord; via: string }[] = []
  const retrievalPath: string[] = [`iteration:${query}`]
  let truncated = false

  let frontier = matched
  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const next: NormalizedAdrRecord[] = []
    for (const rec of frontier) {
      retrievalPath.push(`record:${rec.id} (${rec.style}, ${String(rec.status)})`)
      const edges: [string, NormalizedAdrRecord | undefined][] = [
        ...rec.supersedes.map((id): [string, NormalizedAdrRecord | undefined] => [`supersedes ${id}`, byId.get(id)]),
        ...rec.supersededBy.map((id): [string, NormalizedAdrRecord | undefined] => [`superseded by ${id}`, byId.get(id)]),
      ]
      for (const [via, target] of edges) {
        if (!target) {
          retrievalPath.push(`${rec.id} → ${via} (unresolved)`)
          continue
        }
        retrievalPath.push(`${rec.id} → ${via}`)
        if (seen.has(target.id)) continue
        if (chains.length >= maxChainRecords) {
          truncated = true
          continue
        }
        seen.add(target.id)
        chains.push({ record: target, via: `${rec.id} ${via}` })
        next.push(target)
      }
    }
    frontier = next
  }

  const active = matched.filter((r) => !String(r.status).includes("superseded") && r.supersededBy.length === 0)
  return { iteration: query, matched, active, chains, retrievalPath, truncated }
}

const CONTEXT_LINE_CAP = 80

/** Bounded Markdown rendering of an iteration context bundle. */
export function renderIterationContext(ctx: IterationContext): string {
  const cap = (s: string): string => (s.length > CONTEXT_LINE_CAP ? `${s.slice(0, CONTEXT_LINE_CAP - 1)}…` : s)
  let out = `### 🔁 Iteration \`${ctx.iteration}\` — context bundle\n\n`
  out += `*Retrieval path:*\n\`\`\`text\n${ctx.retrievalPath.join("\n")}\n\`\`\`\n\n`
  out += `**Active records (${ctx.active.length})**\n\n`
  for (const r of ctx.active) {
    out += `- **[${r.id}]** ${cap(r.title)} — \`${r.style}\`, ${String(r.status)} — \`${r.sourcePath}\`\n`
  }
  if (ctx.chains.length > 0) {
    out += `\n**Supersession chains (${ctx.chains.length})**\n\n`
    for (const { record, via } of ctx.chains) {
      out += `- **[${record.id}]** ${cap(record.title)} — \`${record.style}\`, ${String(record.status)} — \`${record.sourcePath}\` *(via ${via})*\n`
    }
  }
  out += `\n_Bounded bundle: chain hops ≤ 3, chain records ≤ 8._\n`
  if (ctx.truncated) out += `\n⚠️ *Truncated — chain bound reached; run \`/adr history <ID>\` for the full chain.*\n`
  return out
}

// ─── `evolution` validation profile (§7.3 req 5, opt-in) ─────────────

/** Frontmatter flag key requiring a Confirmation section. */
export const EVOLUTION_RISK_FLAG_KEY = "risk"
/** Flag value that triggers the Confirmation requirement. */
export const EVOLUTION_RISK_FLAG_VALUE = "high"
/** The only profile name `/adr check --profile` accepts in Phase 3. */
export const EVOLUTION_PROFILE_NAME = "evolution"

/**
 * `evolution` profile checks over normalized records. Severity is
 * "warn" — the profile is opt-in discipline layered on top of the
 * default structural check, which MUST NOT flag any of these (§13).
 */
export function checkEvolutionProfile(records: NormalizedAdrRecord[]): AdrHealthIssue[] {
  const issues: AdrHealthIssue[] = []
  for (const record of records) {
    if (record.style === "madr") issues.push(...checkMadrDiscipline(record))
    else if (record.style === "nygard") issues.push(...checkNygardDiscipline(record))
  }
  return issues
}

/** Extract one section body by exact heading (null when absent).
 * headingLineRe gives canonical-name matching with language-parenthetical
 * tolerance — an LLM-filled display note never breaks profile checks. */
function findSection(raw: string, level: number, name: string): string | null {
  const m = headingLineRe(name, level).exec(raw)
  if (!m) return null
  const after = raw.slice(m.index + m[0].length)
  const stop = new RegExp(`^#{1,${level}}\\s`, "m").exec(after)
  return stop ? after.slice(0, stop.index) : after
}

function profileIssue(record: NormalizedAdrRecord, message: string): AdrHealthIssue {
  return { type: "profile", severity: "warn", file: record.sourcePath, message: `[${EVOLUTION_PROFILE_NAME}] ${message}` }
}

function bulletLines(body: string): string[] {
  return body.split(/\r?\n/).filter((line) => /^\s*[-*]\s+\S/.test(line))
}

function checkMadrDiscipline(record: NormalizedAdrRecord): AdrHealthIssue[] {
  const issues: AdrHealthIssue[] = []
  const raw = record.rawContent

  // Rejected-alternative content: non-empty Considered Options, each
  // option carrying explicit cons.
  const optionsBody = findSection(raw, 2, "Considered Options")
  const options = optionsBody === null ? [] : bulletLines(optionsBody)
  if (optionsBody === null || options.length === 0) {
    issues.push(profileIssue(record, "MADR record must list rejected alternatives: '## Considered Options' is missing or lists no options"))
  } else {
    for (const option of options) {
      if (!/\bcons?\s*:/i.test(option)) {
        issues.push(profileIssue(record, `considered option has no cons: "${option.trim().slice(0, 60)}"`))
      }
    }
  }

  // Consequences must split good and bad.
  const consequences = findSection(raw, 3, "Consequences")
  const hasGood = consequences !== null && /(\bpositive\b|\bgood\b|\bbenefit|\badvantage)/i.test(consequences)
  const hasBad = consequences !== null && /(\bnegative\b|\bbad\b|\brisk|\bdrawback|trade-?offs?)/i.test(consequences)
  if (!hasGood || !hasBad) {
    issues.push(profileIssue(record, "'### Consequences' must split good and bad (positive/negative markers)"))
  }

  // High-risk records (frontmatter-flagged) require a Confirmation section.
  const risk = extractFrontmatter(raw)[EVOLUTION_RISK_FLAG_KEY]?.trim().toLowerCase()
  if (risk === EVOLUTION_RISK_FLAG_VALUE && findSection(raw, 2, "Confirmation") === null) {
    issues.push(
      profileIssue(record, `record is flagged '${EVOLUTION_RISK_FLAG_KEY}: ${EVOLUTION_RISK_FLAG_VALUE}' but has no '## Confirmation' section`),
    )
  }
  return issues
}

/** Nygard maps only this far: its three canonical sections, non-empty.
 * MADR-specific requirements are never forced onto Nygard (§7.4). */
function checkNygardDiscipline(record: NormalizedAdrRecord): AdrHealthIssue[] {
  const issues: AdrHealthIssue[] = []
  for (const section of ["Context", "Decision", "Consequences"]) {
    const body = findSection(record.rawContent, 2, section)
    if (body !== null && body.trim() === "") {
      issues.push(profileIssue(record, `Nygard section '## ${section}' is empty`))
    }
  }
  return issues
}
