/**
 * Nygard style adapter — Michael Nygard's canonical ADR grammar (§7.1).
 *
 * Canonical template (kept EXACTLY): H1 `# <number>. <Title>`, then the
 * three sections `Context`, `Decision`, `Consequences` — nothing more.
 * Strict style isolation (§7.4): this adapter scaffolds and validates ONLY
 * the Nygard template; no OCP-specific headings or metadata are injected
 * into the body. The normalized record ID is still `ADR-NNNN` — style
 * fidelity is the body template, not the internal ID vocabulary.
 *
 * Every newly scaffolded record declares `style: nygard` and writes
 * `created` (immutable) alongside `date` (last-status-change).
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

/** Exact-heading test with language-parenthetical tolerance (§7.4):
 * `## Context` matches, `## Context and Problem Statement` does not
 * (Nygard sections are single-word canonical names); an optional
 * display-only parenthetical (`## Context (…)`) is ignored. */
function hasSection(rawContent: string, section: string): boolean {
  return headingLineRe(section, 2).test(rawContent)
}

export const nygardAdapter: AdrStyleAdapter = {
  style: "nygard",

  /** Scaffold one Nygard record. One canonical template regardless of
   * layer (§7.1) — optional evolution metadata rides in frontmatter only. */
  scaffold(input: CreateAdrInput): string {
    const id = bareAdrId(normalizeAdrId(input.id) ?? input.id)
    let content = `---\n`
    content += `style: nygard\n`
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
    content += `## Context\n\n<Describe the forces at play: technical, business, project context.>\n\n`
    content += `## Decision\n\n<State the decision made in response to the context.>\n\n`
    content += `## Consequences\n\n<Describe the resulting context: what becomes easier or harder.>\n`

    return content
  },

  /** True when the document declares Nygard (explicit `style: nygard`, or
   * a Nygard-shaped body: numbered H1 plus the three exact canonical
   * sections and no style frontmatter). MADR bodies never match — the
   * exact-heading test rejects `Context and Problem Statement` and
   * `Decision Outcome` (§7.4 — no style cross-talk). */
  detect(content: string, _path: string): boolean {
    const fm = extractFrontmatter(content)
    if (fm["style"]) return fm["style"].toLowerCase() === "nygard"
    const hasNygardH1 = /^#\s+\d+[.)]?\s+\S/m.test(content)
    return hasNygardH1 && hasSection(content, "Context") && hasSection(content, "Decision") && hasSection(content, "Consequences")
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
      style: "nygard",
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

  /** Structural validation only. Required: frontmatter status + Nygard's
   * three canonical sections — NOTHING beyond them (§7.1/§7.4). A Nygard
   * record is never required to carry MADR-only sections. */
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
    const required = ["Context", "Decision", "Consequences"]
    for (const section of required) {
      if (!hasSection(document.rawContent, section)) {
        issues.push({
          type: "missing-section",
          severity: "error",
          file: document.relPath,
          message: `Missing canonical Nygard section '## ${section}'`,
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
