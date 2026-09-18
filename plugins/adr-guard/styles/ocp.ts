/**
 * OCP container style adapter — the OCP-native record grammar
 * (OCP discipline, ADR-0007 §7 amendment).
 *
 * One record = one ITERATION file: the container `ADR-<baseline>.<iteration>`
 * (`0.2.54-slug.md`) reserves the whole `<baseline>.<iteration>.*` sub-ID
 * space, and each section (a sub-decision) is an H3 block carrying the
 * five-part skeleton — Background / Decision / Rationale / Rejected
 * (each rejected alternative with its reason) / Impact — plus its own
 * emoji status line. The decision GRAPH (parent / supersession / INDEX /
 * history / context) operates at CONTAINER granularity: sections are
 * structured payload on the record, never records themselves; partial
 * supersession of one section stays a status-line annotation plus prose
 * cross-reference, exactly the OCP practice.
 *
 * Language policy (ADR-0008): field labels and scaffolding are English —
 * grammar is language-fixed, like MADR's section names. ALL prose —
 * container title, section titles, field bodies, cheatsheet lines, emoji
 * status decoration words — is drafted in the WORKING LANGUAGE derived
 * from the language environment (project declaration, else conversation
 * language). Scaffold placeholders are bilingual: working-language
 * guidance first, English grammar hint second. Emoji status markers are
 * language-neutral by design.
 *
 * Strict style isolation (§7.4): this adapter scaffolds and validates
 * ONLY the ocp container template; nothing here leaks into madr/nygard
 * records, and their grammar is never forced onto ocp files.
 */

import type {
  AdrDocument,
  AdrHealthIssue,
  AdrLayer,
  AdrParseContext,
  AdrSection,
  AdrStyleAdapter,
  CreateAdrInput,
  NormalizedAdrRecord,
} from "../adr-types"
import { adrIdFromFilename, bareAdrId, extractFrontmatter, normalizeAdrId } from "../adr-types"

// ─── Status markers (emoji → canonical lifecycle) ────────────────────
// Emoji are the canonical signal and language-neutral; the optional
// trailing word is decoration. A bare English lifecycle word also parses.

const STATUS_EMOJI: Array<[RegExp, string]> = [
  [/✅/, "accepted"],
  [/🟡/, "proposed"],
  [/🔄/, "superseded"],
  [/⛔/, "deprecated"],
]

function mapSectionStatus(raw: string): string {
  for (const [re, canonical] of STATUS_EMOJI) {
    if (re.test(raw)) return canonical
  }
  const lowered = raw.trim().toLowerCase()
  return lowered === "" ? "proposed" : lowered
}

// ─── Section heading grammar ──────────────────────────────────────────

/** H3 section heading, canonical SHORT form: `### 01. <title>` — the
 * canonical ID (`ADR-<baseline>.<iter>.NN`) is DERIVED from the container
 * namespace, never spelled out in the heading (one namespace authority;
 * local readability wins). Legacy full-ID headings
 * (`### ADR-0.2.54.01: <title>`) still parse so existing files keep
 * their IDs. */
const SECTION_SHORT_RE = /^###\s+(\d{1,})\s*[.:]?\s+([^\r\n]+?)\s*$/
const SECTION_FULL_RE = /^###\s+(ADR-\d+\.\d+\.\d+\.\d+)\s*:\s+([^\r\n]+?)\s*$/

interface SectionHeading {
  canonical: string
  seq: string
  title: string
}

/** Match one H3 line as a section heading. Short headings compose the
 * canonical `#`-form ID from the container namespace; legacy full-ID
 * headings (OCP dotted) whose prefix matches THIS container map
 * onto the same canonical form (same sequence), foreign full-IDs keep
 * their dotted form and fail validation later. */
function matchSectionHeading(line: string, containerId: string): SectionHeading | null {
  const full = SECTION_FULL_RE.exec(line)
  if (full) {
    const normalized = normalizeAdrId(full[1]) ?? full[1]
    if (normalized.startsWith(`${containerId}.`)) {
      const seq = (normalized.split(".").pop() ?? "").padStart(2, "0")
      return { canonical: `${containerId}#${seq}`, seq, title: full[2] }
    }
    return { canonical: normalized, seq: normalized.split(".").pop() ?? "", title: full[2] }
  }
  const short = SECTION_SHORT_RE.exec(line)
  if (short) {
    const seq = short[1].padStart(2, "0")
    return { canonical: `${containerId}#${seq}`, seq, title: short[2] }
  }
  return null
}

/** Bold-lead five-part field line (`**Decision**: …`). Labels are
 * English grammar. An optional parenthetical language note after the
 * label (`**Decision** (…): …`) is DISPLAY ONLY — the LLM fills it in
 * the team's language when drafting; the parser ignores it. */
const FIELD_LINE_RE =
  /^\*\*(Status|Background|Decision|Rationale|Rejected|Impact|Future extensions)\*\*(?:\s*[（(][^）)]*[）)])?\s*:\s*(.*)$/

const REASON_SPLIT_RE = /\s*[:—–-]\s*/

function splitBullets(body: string): string[] {
  return body.split(/\r?\n/).filter((line) => /^\s*[-*]\s+\S/.test(line)).map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
}

function parseRejected(body: string): Array<{ option: string; reason: string }> {
  const out: Array<{ option: string; reason: string }> = []
  for (const bullet of splitBullets(body)) {
    const m = REASON_SPLIT_RE.exec(bullet)
    if (m && m.index > 0) {
      out.push({ option: bullet.slice(0, m.index).trim(), reason: bullet.slice(m.index + m[0].length).trim() })
    } else {
      out.push({ option: bullet, reason: "" })
    }
  }
  return out
}

interface RawField {
  label: string
  value: string
}

/** Split one section body into named fields; each field value runs until
 * the next `**Field**:` line (continuation lines such as bullets belong
 * to the current field). */
function parseFields(body: string): RawField[] {
  const fields: RawField[] = []
  let current: RawField | null = null
  for (const line of body.split(/\r?\n/)) {
    const m = FIELD_LINE_RE.exec(line.trim())
    if (m) {
      current = { label: m[1].toLowerCase(), value: m[2] }
      fields.push(current)
    } else if (current) {
      current.value += `\n${line}`
    }
  }
  return fields
}

/** Parse every H3 section in the container body. `containerId` is the
 * single namespace authority: short headings derive their canonical ID
 * from it; full-ID headings are validated against it later. */
export function parseSections(rawContent: string, containerId: string): AdrSection[] {
  const lines = rawContent.split(/\r?\n/)
  const sections: AdrSection[] = []
  let current: { heading: SectionHeading; body: string[] } | null = null
  const flush = (): void => {
    if (!current) return
    const fields = parseFields(current.body.join("\n"))
    const field = (label: string): string | undefined => fields.find((f) => f.label === label)?.value.trim()
    sections.push({
      id: current.heading.canonical,
      seq: current.heading.seq,
      title: current.heading.title,
      status: mapSectionStatus(field("status") ?? ""),
      background: field("background") || undefined,
      decision: field("decision") || undefined,
      rationale: field("rationale") || undefined,
      rejected: field("rejected") !== undefined ? parseRejected(field("rejected") ?? "") : undefined,
      impact: field("impact") !== undefined ? splitBullets(field("impact") ?? "") : undefined,
    })
    current = null
  }
  for (const line of lines) {
    const heading = matchSectionHeading(line, containerId)
    if (heading) {
      flush()
      current = { heading, body: [] }
      continue
    }
    // Inside a section, any H1/H2 boundary closes it (cheatsheet/quick
    // view never follow the entries area; a stray `##` starts something else).
    if (current && /^#{1,2}\s/.test(line)) {
      flush()
      continue
    }
    if (current) current.body.push(line)
  }
  flush()
  return sections.sort((a, b) => parseInt(a.seq, 10) - parseInt(b.seq, 10))
}

function docFrontmatter(document: AdrDocument): Record<string, string> {
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

export const ocpAdapter: AdrStyleAdapter = {
  style: "ocp",

  /** Scaffold one empty iteration container (zero sections — a fresh
   * container validates with a zero-sections warning until its first
   * section lands via /adr section).
   *
   * The scaffold is opinionated about the output protocol so the drafter
   * fills a structure rather than improvising one. Cheatsheet is numbered
   * (1–6, ≤60 chars per line, ADR ref suffix); Quick view is the restate
   * layer (mermaid flowchart LR + tables); sections carry the five-part
   * skeleton with table-based Decision and Rejected, layered Impact, and
   * bold-keyword Rationale. See `docs/adr/README.md` §OCP output protocol
   * for the full rule set. */
  scaffold(input: CreateAdrInput): string {
    const id = bareAdrId(normalizeAdrId(input.id) ?? input.id)
    let content = `---\n`
    content += `style: ocp\n`
    content += `status: ${input.status.charAt(0).toUpperCase() + input.status.slice(1)}\n`
    content += `created: ${input.created}\n`
    content += `date: ${input.date}\n`
    if (input.baseline) content += `baseline: "${input.baseline}"\n`
    if (input.iteration) content += `iteration: "${input.iteration}"\n`
    if (input.domain) content += `domain: ${input.domain}\n`
    content += `---\n\n`

    content += `# ${input.title}\n\n`
    content += `> Index: [\`README.md\`](./README.md). Supersedes / amends: <list prior IDs this iteration supersedes or amends; "—" if none>.\n`
    content += `>\n`
    content += `> Cheatsheet & quick view are restatement layers: diagrams/tables restate the\n`
    content += `> section prose and never add facts — on conflict the prose wins.\n`
    content += `> Amend/supersede relations are declared in each section's status line;\n`
    content += `> accepted semantics never move one character.\n\n`
    content += `## Cheatsheet\n\n`
    content += `1. <Conclusion 1 — ≤60 chars, in the working language> (ADR-${id}#01)\n`
    content += `2. <Conclusion 2 — ≤60 chars> (ADR-${id}#01)\n`
    content += `3. <Conclusion 3 — ≤60 chars> (ADR-${id}#01)\n`
    content += `4. <Conclusion 4 — ≤60 chars> (ADR-${id}#01)\n`
    content += `5. <Conclusion 5 — ≤60 chars> (ADR-${id}#01)\n`
    content += `6. <Conclusion 6 — ≤60 chars> (ADR-${id}#01)\n\n`
    content += `---\n\n`
    content += `## Quick view\n\n`
    content += `<!-- Draw only when there is structure. mermaid \`flowchart LR\` preferred (horizontal flow reads better than vertical chains). Tables for: >=2 candidates x >=3 dimensions, old->new mapping, enum semantics, decision lists, rejected-option lists. <=2 figures per section; the restate layer fills the rest by table. -->\n\n`
    content += `\`\`\`mermaid\n`
    content += `flowchart LR\n`
    content += `  A[<entry / iteration start>] --> B{<key decision>}\n`
    content += `  B -- <branch a> --> C[<branch a outcome>]\n`
    content += `  B -- <branch b> --> D[<branch b outcome>]\n`
    content += `\`\`\`\n\n`
    content += `| Aspect | Before | After |\n`
    content += `| --- | --- | --- |\n`
    content += `| <old-vs-new row 1> | <old> | <new> |\n`
    content += `| <old-vs-new row 2> | <old> | <new> |\n\n`
    content += `---\n\n`
    content += `<!-- Sections: /adr section ADR-${id} "<title>" appends the next one.\n`
    content += `     H3 short form "### NN. <title>" — the canonical ID derives from the\n`
    content += `     container namespace and is never spelled out in the heading.\n`
    content += `     Drafter (ADR-0.40.0#02): fill ALL prose — cheatsheet, section titles,\n`
    content += `     field bodies, status decoration words — in the working language\n`
    content += `     derived from the language environment; the Cheatsheet is the\n`
    content += `     reader's primary entry (pure conclusions). Field labels stay English.\n`
    content += `\n`
    content += `     Output protocol (see docs/adr/README.md OCP output protocol section):\n`
    content += `     - Cheatsheet: <=6 numbered items, each <=60 chars, ADR ref suffix\n`
    content += `     - Background: <=3 sentences — situation + pain, no solution detail\n`
    content += `     - Decision: TABLE form \`| # | Point | Content |\` — no prose dump\n`
    content += `     - Rationale: >=2 bullets, bold-keyword led (e.g. "**Why X**: ...")\n`
    content += `     - Rejected: TABLE form \`| Option | Reason rejected |\` — no prose dump\n`
    content += `     - Impact: bullets grouped by layer (Plugins / Runtime / Dispatcher / Installer / Tests / Docs)\n`
    content += `     - Paragraphs <=4 lines; one sentence = one idea; no nested dashes\n`
    content += `     - mermaid \`flowchart LR\`; <=2 figures per section; restate layer fills the rest by table -->\n`
    return content
  },

  /** Render one new section block for appendAdrSection — canonical short
   * heading (`### NN. <title>`); the canonical ID rides the caller.
   * Placeholder values keep the section valid-shaped and teach the
   * five-part skeleton. The placeholders explicitly call for table-based
   * Decision and Rejected (no prose dump), bold-keyword Rationale bullets,
   * and layer-grouped Impact bullets — the OCP output protocol. */
  scaffoldSection(input: { id: string; title: string }): string {
    const bare = bareAdrId(input.id)
    const seq = bare.includes("#") ? bare.slice(bare.indexOf("#") + 1) : bare.split(".").pop() ?? input.id
    return (
      `### ${seq.padStart(2, "0")}. ${input.title}\n` +
      `**Status**: 🟡 Proposed\n` +
      `**Background**: <situation + pain, ≤3 sentences, no solution detail — in the working language>\n\n` +
      `**Decision**:\n` +
      `\n` +
      `| # | Point | Content |\n` +
      `| --- | --- | --- |\n` +
      `| 1 | <decision point 1> | <what was decided — in the working language> |\n` +
      `| 2 | <decision point 2> | <what was decided — in the working language> |\n\n` +
      `**Rationale**:\n` +
      `- **<bold keyword>**: <single-line justification>\n` +
      `- **<bold keyword>**: <single-line justification>\n\n` +
      `**Rejected**:\n` +
      `\n` +
      `| Option | Reason rejected |\n` +
      `| --- | --- |\n` +
      `| <rejected option 1> | <why rejected — in the working language> |\n` +
      `| <rejected option 2> | <why rejected — in the working language> |\n\n` +
      `**Impact**:\n` +
      `- **<layer 1 — Plugins / Runtime / Dispatcher / Installer / Tests / Docs>**: <what changes — in the working language>\n` +
      `- **<layer 2>**: <what changes — in the working language>\n\n` +
      `**Future extensions**: <optional — delete the line when none>\n`
    )
  },

  /** True when the document declares ocp, or carries no style frontmatter
   * but is shaped like a container (H3 section headings + a status field
   * line). Per-decision dotted files never match — they have no H3
   * sections. */
  detect(content: string, _path: string): boolean {
    const fm = extractFrontmatter(content)
    if (fm["style"]) return fm["style"].toLowerCase() === "ocp"
    const hasSectionHeading = SECTION_SHORT_RE.test(content) || SECTION_FULL_RE.test(content)
    return hasSectionHeading && /^\*\*Status\*\*(?:\s*[（(][^）)]*[）)])?\s*:/m.test(content)
  },

  parse(document: AdrDocument, context?: AdrParseContext): NormalizedAdrRecord {
    const fm = docFrontmatter(document)
    const stemId = adrIdFromFilename(document.filename) ?? "ADR-0.0.0"
    const titleMatch = document.rawContent.match(/^#\s+(?:(?:ADR-)?[\d.]+\s+)?([^\r\n]+)/m)

    const status = (fm["status"] ?? "proposed").toLowerCase()
    const supersededByFromStatus = /superseded by\s+((?:ADR-)?[\d.]+)/i.exec(status)?.[1]

    const layer: AdrLayer =
      fm["layer"] === "system" || fm["layer"] === "domain" || fm["layer"] === "component" ? fm["layer"] : "system"

    return {
      id: stemId,
      style: "ocp",
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
      sections: parseSections(document.rawContent, stemId),
      rawContent: document.rawContent,
    }
  },

  /** Structural validation. Container level: baseline/iteration metadata
   * (the namespace anchor) required. Section level: namespace membership,
   * sequential numbering, decision/rationale present, every rejected
   * alternative carries a reason. Shape errors are errors; the rest is
   * the author's editorial choice and stays unvalidated. */
  validate(document: AdrDocument, record: NormalizedAdrRecord): AdrHealthIssue[] {
    const issues: AdrHealthIssue[] = []
    const push = (type: AdrHealthIssue["type"], severity: AdrHealthIssue["severity"], message: string): void => {
      issues.push({ type, severity, file: document.relPath, message })
    }

    if (!record.status) push("missing-field", "warn", "Missing 'status' in frontmatter")
    // baseline/iteration anchor the ITERATION container's namespace.
    // Sequential containers (ADR-NNNN) are numbering-orthogonal (§6) and
    // carry the metadata only when the project groups by iteration.
    const bareRecordId = record.id.replace(/^ADR-/, "")
    if (/^\d+\.\d+\.\d+$/.test(bareRecordId) && (!record.baseline || !record.iteration)) {
      push("missing-field", "error", "iteration container requires 'baseline' and 'iteration' frontmatter (the sub-ID namespace anchor)")
    }

    const sections = record.sections ?? []
    if (sections.length === 0) {
      push("missing-section", "warn", "container has no sections yet — use /adr section to append the first one")
    }

    // Locate each section's own H3 block once, so status extraction
    // cannot match an ID mentioned in an earlier cross-reference.
    const rawStatusById = new Map<string, string | undefined>()
    {
      const lines = document.rawContent.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const heading = matchSectionHeading(lines[i], record.id)
        if (!heading) continue
        let statusLine: string | undefined
        for (let j = i + 1; j < lines.length; j++) {
          if (/^#{1,3}\s/.test(lines[j])) break
          const sm = /^\*\*Status\*\*(?:\s*[（(][^）)]*[）)])?\s*:\s*([^\r\n]+)/.exec(lines[j].trim())
          if (sm) {
            statusLine = sm[1]
            break
          }
        }
        rawStatusById.set(heading.canonical, statusLine)
      }
    }

    const seen = new Set<string>()
    let prevSeq = 0
    for (const section of sections) {
      if (!section.id.startsWith(`${record.id}#`)) {
        push("invalid-field", "error", `section '${section.id}' is outside the container namespace '${record.id}#*'`)
      }
      if (seen.has(section.seq)) {
        push("duplicate-id", "error", `duplicate section sequence '${section.seq}'`)
      }
      seen.add(section.seq)
      const seqNum = parseInt(section.seq, 10)
      if (!isNaN(seqNum) && prevSeq > 0 && seqNum > prevSeq + 1) {
        push("invalid-field", "warn", `section sequence gap: '${section.seq}' follows '${String(prevSeq).padStart(2, "0")}'`)
      }
      if (!isNaN(seqNum)) prevSeq = seqNum

      if (rawStatusById.get(section.id) === undefined) {
        push("missing-field", "error", `section '${section.id}' has no **Status** line`)
      }
      if (!section.decision || section.decision === "") {
        push("missing-section", "error", `section '${section.id}' missing **Decision** content`)
      }
      if (!section.rationale || section.rationale === "") {
        push("missing-section", "error", `section '${section.id}' missing **Rationale** content`)
      }
      for (const rejected of section.rejected ?? []) {
        if (rejected.reason === "") {
          push("invalid-field", "warn", `section '${section.id}' rejected alternative has no reason: "${rejected.option.slice(0, 60)}"`)
        }
      }
    }

    return issues
  },

  /** Display-layer formatting only — never a semantic edit (§9.5 rule 5;
   * the co-governance red line: presentation-layer restatement is
   * allowed, semantics frozen). */
  format(document: AdrDocument): string {
    return document.rawContent.replace(/\s+$/, "") + "\n"
  },

  /** Unified index row (§9.3) — one row per CONTAINER; the section count
   * rides the title so the table shape stays identical across styles. */
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
    const sectionNote = record.sections && record.sections.length > 0 ? ` (${record.sections.length} sections)` : ""
    return `| [${record.id}](./${filename}) | ${record.title}${sectionNote} | \`${record.style}\` | \`${record.layer ?? "system"}\` | ${badge} | ${record.domain ?? ""} | ${record.iteration ?? ""} | ${date} |`
  },
}
