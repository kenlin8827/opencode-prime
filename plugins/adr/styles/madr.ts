/**
 * MADR style adapter — MADR 4 grammar with the existing OCP scaffold shape.
 *
 * Canonical headings (kept EXACTLY, §7.2): `Context and Problem Statement`,
 * `Considered Options`, `Decision Outcome`, `Consequences`. `Decision Drivers`,
 * `Confirmation`, `Pros and Cons of the Options`, and `More Information`
 * follow MADR optional-section semantics — validate() never requires them.
 *
 * Every newly scaffolded record declares `style: madr` and writes
 * `created` (immutable) alongside `date` (last-status-change).
 *
 * Prose language (ADR-0008): placeholders are bilingual — team working
 * language first, English grammar hint second — so drafters never imitate
 * English-only prose. Grammar (canonical headings, the `Chosen option …,
 * because …` lead-in, Consequences labels) stays English.
 */

import type {
  AdrDocument,
  AdrHealthIssue,
  AdrLayer,
  AdrParseContext,
  AdrStyleAdapter,
  CreateAdrInput,
  NormalizedAdrRecord,
} from "../adr-types"
import { adrIdFromFilename, bareAdrId, extractFrontmatter, headingLineRe, normalizeAdrId } from "../adr-types"

function docFrontmatter(document: AdrDocument): Record<string, string> {
  // Engine-built documents arrive with frontmatter pre-populated; standalone
  // documents (tests, direct adapter use) fall back to parsing raw content.
  return Object.keys(document.frontmatter).length > 0 ? document.frontmatter : extractFrontmatter(document.rawContent)
}

function resolveRefList(raw: string | undefined, context?: AdrParseContext): string[] {
  if (!raw) return []
  const out: string[] = []
  for (const part of raw.split(",")) {
    const ref = part.trim()
    if (!ref) continue
    const byId = normalizeAdrId(ref)
    if (byId && (!context || context.resolveRef(ref) === byId)) {
      out.push(byId)
      continue
    }
    const resolved = context?.resolveRef(ref)
    if (resolved) out.push(resolved)
  }
  return out
}

export const madrAdapter: AdrStyleAdapter = {
  style: "madr",

  /** Scaffold one MADR record. Layer-adapted body templates preserved
   * verbatim from the pre-refactor engine (system = full option-analysis
   * template; domain/component = lean template). */
  scaffold(input: CreateAdrInput): string {
    const id = bareAdrId(normalizeAdrId(input.id) ?? input.id)
    let content = `---\n`
    content += `style: madr\n`
    content += `status: ${input.status.charAt(0).toUpperCase() + input.status.slice(1)}\n`
    content += `created: ${input.created}\n`
    content += `date: ${input.date}\n`
    content += `layer: ${input.layer}\n`
    if (input.scope) content += `scope: ${input.scope}\n`
    if (input.baseline) content += `baseline: ${input.baseline}\n`
    if (input.iteration) content += `iteration: ${input.iteration}\n`
    if (input.domain) content += `domain: ${input.domain}\n`
    if (input.parent) content += `parent: ${input.parent}\n`
    if (input.supersedes) content += `supersedes: ${input.supersedes}\n`
    content += `---\n\n`

    content += `# ${id}. ${input.title}\n\n`
    content += `<!-- Drafting language (ADR-0008): write ALL prose below — title\n     included — in the working language derived from the language\n     environment (project declaration, else conversation language);\n     English is reserved for grammar (canonical headings, the Chosen\n     option/because lead-in, Consequences labels). -->\n\n`

    if (input.layer === "system") {
      content += `## Context and Problem Statement\n\n<Architectural context, system-level problem, and constraints — in the working language>\n\n`
      content += `## Decision Drivers\n\n- <Driver 1: e.g. scalability, security, maintainability — in the working language>\n- <Driver 2 — in the working language>\n\n`
      content += `## Considered Options\n\n- **<Option 1>**: <description — in the working language>\n- **<Option 2>**: <description — in the working language>\n\n`
      content += `## Decision Outcome\n\nChosen option: **<chosen option>**, because <rationales and trade-offs — in the working language>.\n\n`
      content += `### Consequences\n\n- **Positive**: <good impacts — in the working language>\n- **Negative / Risks**: <trade-offs & mitigations — in the working language>\n`
    } else {
      content += `## Context and Problem Statement\n\n<Situation, module context, and requirement — in the working language>\n\n`
      content += `## Decision Outcome\n\nChosen option: <what was decided>, because <why>. (Both — in the working language.)\n`
    }

    return content
  },

  /** True when the document declares MADR (explicit `style: madr`, or a
   * legacy MADR-shaped body without any style frontmatter). */
  detect(content: string, _path: string): boolean {
    const fm = extractFrontmatter(content)
    if (fm["style"]) return fm["style"].toLowerCase() === "madr"
    return /^##\s+Context and Problem Statement/m.test(content) || /^##\s+Decision Outcome/m.test(content)
  },

  parse(document: AdrDocument, context?: AdrParseContext): NormalizedAdrRecord {
    const fm = docFrontmatter(document)
    const stemId = adrIdFromFilename(document.filename) ?? "ADR-0000"
    const titleMatch = document.rawContent.match(/^#\s+(?:(?:ADR-)?[\d.]+[.)]?\s+)?([^\r\n]+)/m)

    const status = (fm["status"] ?? "proposed").toLowerCase()
    const supersededByFromStatus = /superseded by\s+((?:ADR-)?[\d.]+)/i.exec(status)?.[1]

    const layer: AdrLayer =
      fm["layer"] === "system" || fm["layer"] === "domain" || fm["layer"] === "component" ? fm["layer"] : "system"

    return {
      id: stemId,
      style: "madr",
      sourcePath: document.relPath,
      title: titleMatch ? titleMatch[1].trim() : document.filename.replace(/\.md$/, ""),
      status,
      created: fm["created"] ?? fm["date"],
      date: fm["date"],
      layer,
      domain: fm["domain"],
      scope: fm["scope"],
      baseline: fm["baseline"],
      iteration: fm["iteration"],
      parentIds: resolveRefList(fm["parent"], context),
      supersedes: resolveRefList(fm["supersedes"], context),
      supersededBy: resolveRefList(fm["superseded_by"] ?? fm["superseded-by"] ?? supersededByFromStatus, context),
      rawContent: document.rawContent,
    }
  },

  /** Structural validation only. Required: frontmatter status + the three
   * canonical sections. MADR optional sections (Decision Drivers,
   * Confirmation, Pros and Cons of the Options, More Information) are
   * never required (§7.2). */
  validate(document: AdrDocument, record: NormalizedAdrRecord): AdrHealthIssue[] {
    const issues: AdrHealthIssue[] = []
    if (!record.status) {
      issues.push({
        type: "missing-field",
        severity: "warn",
        file: document.relPath,
        message: "Missing 'status' in frontmatter",
      })
    }
    const required = ["Context and Problem Statement", "Decision Outcome"]
    // System-layer records use the full option-analysis template; the lean
    // domain/component template omits option enumeration by design.
    if (record.layer === "system") required.push("Considered Options")
    for (const section of required) {
      // headingLineRe: exact canonical name + optional display-only
      // language parenthetical (single English grammar authority).
      if (!headingLineRe(section, 2).test(document.rawContent)) {
        issues.push({
          type: "missing-section",
          severity: "error",
          file: document.relPath,
          message: `Missing canonical MADR section '## ${section}'`,
        })
      }
    }
    return issues
  },

  /** Display-layer formatting only — never a semantic edit (§9.5 rule 5). */
  format(document: AdrDocument): string {
    return document.rawContent.replace(/\s+$/, "") + "\n"
  },

  /** Unified index row (§9.3): ID link, title, style, layer, status badge,
   * optional domain/iteration, created — one shape for every style. */
  renderIndexEntry(record: NormalizedAdrRecord): string {
    const filename = record.sourcePath.split("/").pop() ?? record.sourcePath
    const status = String(record.status)
    let badge = `⚪ ${status}`
    if (status.includes("accepted")) badge = "🟢 Accepted"
    else if (status.includes("superseded")) badge = "⚪ Superseded"
    else if (status.includes("deprecated")) badge = "🟡 Deprecated"
    else if (status.includes("rejected")) badge = "🔴 Rejected"
    else if (status.includes("proposed")) badge = "🔵 Proposed"
    const date = record.created ?? record.date ?? ""
    return `| [${record.id}](./${filename}) | ${record.title} | \`${record.style}\` | \`${record.layer ?? "system"}\` | ${badge} | ${record.domain ?? ""} | ${record.iteration ?? ""} | ${date} |`
  },
}
