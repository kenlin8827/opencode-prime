/**
 * Adoption apply + status for `/e2e-adopt`.
 *
 * Writes exactly two artifacts into the adopting project:
 *   1. docs/e2e-redline.md          — the detailed policy doc (created only
 *                                      if absent; an existing file is NEVER
 *                                      overwritten — the project owns it)
 *   2. AGENTS.md red-line section   — framed by e2e-redline markers; the
 *                                      section is inserted, updated
 *                                      in-place, or skipped when identical.
 *                                      Nothing outside the markers is touched.
 *
 * If AGENTS.md is missing, the doc is still written but the section is NOT:
 * a minimal AGENTS.md would make `/project init` skip its full baseline
 * (init never overwrites). The command reports the follow-up instead.
 *
 * Uninstall = delete docs/e2e-redline.md + the marked section. No command
 * machinery for a trivial manual edit (advisor ruling 2026-09-22).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { AGENTS_MARKER_END, AGENTS_MARKER_START } from "./e2e-adopt-template"

export const E2E_REDLINE_DOC_REL = "docs/e2e-redline.md"
export const AGENTS_REL = "AGENTS.md"

export interface ApplyResult {
  docWritten: boolean
  docSkippedExisting: boolean
  agentsSectionWritten: boolean
  agentsSectionUpdated: boolean
  agentsSectionIdentical: boolean
  agentsMissing: boolean
  /** Marker framing is malformed (crossed / duplicated / inline-in-prose) —
   * nothing was written; the user must clean up the markers by hand. */
  agentsMalformed: boolean
}

/** Markers are only honored when they sit on a line of their own — our
 * writer always emits them that way, and inline prose mentions of the
 * marker text must never be mistaken for the real framing. */
function markerLineIndexes(agentsContent: string, marker: string): number[] {
  const lines = agentsContent.split("\n")
  const indexes: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === marker) indexes.push(i)
  }
  return indexes
}

/** True when the project already carries the adopted section. */
export function agentsHasSection(agentsContent: string): boolean {
  return markerLineIndexes(agentsContent, AGENTS_MARKER_START).length > 0 &&
    markerLineIndexes(agentsContent, AGENTS_MARKER_END).length > 0
}

/** Insert or update the marked section in AGENTS.md content. Pure.
 * Returns null when the existing marker framing is malformed (crossed,
 * duplicated, or not line-anchored) — the caller must not write and
 * should ask the user to clean up the markers by hand. */
export function upsertAgentsSection(agentsContent: string, section: string): string | null {
  const starts = markerLineIndexes(agentsContent, AGENTS_MARKER_START)
  const ends = markerLineIndexes(agentsContent, AGENTS_MARKER_END)
  if (starts.length === 0 && ends.length === 0) {
    // Append path. Empty file: no separator at all (nit — no leading blank line).
    const sep = agentsContent === "" ? "" : agentsContent.endsWith("\n") ? "\n" : "\n\n"
    return agentsContent + sep + section + "\n"
  }
  if (starts.length !== 1 || ends.length !== 1) return null
  const [start] = starts
  const [end] = ends
  if (end <= start) return null // crossed markers
  const lines = agentsContent.split("\n")
  return [...lines.slice(0, start), ...section.split("\n"), ...lines.slice(end + 1)].join("\n")
}

/** Apply the adoption to disk. Never throws on write failure paths the
 * caller reports; throws only on truly unexpected IO errors. */
export function applyAdoption(root: string, doc: string, agentsSection: string): ApplyResult {
  const result: ApplyResult = {
    docWritten: false,
    docSkippedExisting: false,
    agentsSectionWritten: false,
    agentsSectionUpdated: false,
    agentsSectionIdentical: false,
    agentsMissing: false,
    agentsMalformed: false,
  }

  // 1. Detailed doc — create-only.
  const docPath = join(root, E2E_REDLINE_DOC_REL)
  if (existsSync(docPath)) {
    result.docSkippedExisting = true
  } else {
    mkdirSync(dirname(docPath), { recursive: true })
    writeFileSync(docPath, doc, "utf-8")
    result.docWritten = true
  }

  // 2. AGENTS.md section — missing file → report, don't create a minimal one.
  const agentsPath = join(root, AGENTS_REL)
  if (!existsSync(agentsPath)) {
    result.agentsMissing = true
    return result
  }
  const before = readFileSync(agentsPath, "utf-8")
  if (agentsHasSection(before) && before.includes(agentsSection)) {
    result.agentsSectionIdentical = true
    return result
  }
  const after = upsertAgentsSection(before, agentsSection)
  if (after === null) {
    // Malformed framing (crossed / duplicated markers) — refuse to write
    // rather than splice at the wrong place; manual cleanup required.
    result.agentsMalformed = true
    return result
  }
  writeFileSync(agentsPath, after, "utf-8")
  if (agentsHasSection(before)) result.agentsSectionUpdated = true
  else result.agentsSectionWritten = true
  return result
}

export interface AdoptionStatus {
  docExists: boolean
  agentsExists: boolean
  agentsHasSection: boolean
}

/** Read-only adoption status for `/e2e-adopt status`. Read failures
 * (e.g. AGENTS.md path exists but is a directory, permission denied)
 * degrade to "section not adopted" — status never crashes the hook. */
export function adoptionStatus(root: string): AdoptionStatus {
  const docExists = existsSync(join(root, E2E_REDLINE_DOC_REL))
  const agentsPath = join(root, AGENTS_REL)
  const agentsExists = existsSync(agentsPath)
  let hasSection = false
  if (agentsExists) {
    try {
      hasSection = agentsHasSection(readFileSync(agentsPath, "utf-8"))
    } catch {
      hasSection = false
    }
  }
  return { docExists, agentsExists, agentsHasSection: hasSection }
}
