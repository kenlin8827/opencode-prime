/**
 * Hook: experimental.chat.system.transform — inject the project memory
 * files into the system prompt.
 *
 * Two files, one marker `[PROJECT MEMORY]`, two sections in the fragment:
 *   `=== Public (last edited ..., N entries) ===`  — `.opencode/memory/public.md`  (committed)
 *   `=== Private (last edited ..., N entries) ===` — `.opencode/memory/private.md` (gitignored)
 * Both share the marker so the existing strip logic (`stripBlockByLine`)
 * keeps working without plugin-scope changes. AGENTS.md wins on conflict
 * against both — stated inside each section so the model resolves without
 * a human in the loop.
 *
 * The gate is the project-config switch (`projectMemory`, default on).
 * Either file being non-empty triggers injection; both files empty /
 * switch off / file missing → complete no-op plus defensive strip of any
 * stale block. Default-on is safe because both empty files are themselves
 * no-ops.
 *
 * Over-cap handling is per-file independent — each section has its own
 * pointer block if its source has outgrown the cap, so a bloated private
 * notes file does not silence the public memory (and vice versa).
 *
 * Staleness signal: the fragment header carries a `Project memory last
 * updated: …` line so the model can see how fresh memory is on each chat
 * request and surface a `/memory-summarize` review suggestion when
 * notes are old. Sections whose source is older than `STALE_THRESHOLD_MS`
 * also get a `— STALE` suffix in their header — explicit, not just a soft
 * hint, so the model can mechanically act on it.
 *
 * Opencode runtime note (verified 2026-09-11, see ADR 0002): the runtime
 * rebuilds `output.system` per chat request — same defensive-strip pattern
 * as the other injectors. No fragment cache here: the body is file content
 * that a review edit can change mid-session, so it must stay fresh.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import { scoped } from "../shared/plugin-scope"
import { appendBlock, escapeRegExp, stripBlockByLine } from "../shared/system-block"
import {
  countEntries,
  fileMtimeMs,
  formatMtimeLocal,
  isEnabled,
  memoryMtime,
  privatePath,
  publicPath,
  readPrivate,
  readPublic,
} from "./project-memory-config"

export const MARKER = "[PROJECT MEMORY]"

/** Injection ceiling in characters, PER section. Past this the section has
 * outgrown its context budget and full injection would crowd out the actual
 * task. ponytail: naive size gate; upgrade path is a future prune tool
 * that keeps the file under the cap by curation (PR review handles
 * low-quality entries; stale ones accumulate on their own — this cap is
 * the safety net). */
export const INJECT_CHAR_CAP = 16_000

/** A section is flagged "stale" once its source file is older than this.
 * 30 days is a UX choice — long enough that "stale" actually means
 * "review this", short enough to fire for projects with seasonal
 * activity. */
const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000

/** Section header: `=== <Label> (<count> entries, last edited <mtime>) <staleTag> ===`.
 * Stale suffix (`— STALE`) appears when the source is older than the
 * threshold so the model can spot stale content without parsing dates. */
function sectionHeader(label: string, count: number, sourcePath: string): string {
  const mtime = formatMtimeLocal(new Date(fileMtimeMs(sourcePath) ?? 0))
  const mtimeMs = fileMtimeMs(sourcePath) ?? 0
  const stale = mtimeMs > 0 && Date.now() - mtimeMs > STALE_THRESHOLD_MS
  const staleTag = stale ? " — STALE" : ""
  return `=== ${label} (${count} ${count === 1 ? "entry" : "entries"}, last edited ${mtime})${staleTag} ===\n`
}

/** Build a single-section block. Over-cap → progressive-disclosure pointer
 * naming the source path so the agent can read it itself. */
function section(content: string, sourcePath: string, authority: string): string {
  if (content.length > INJECT_CHAR_CAP) {
    return (
      `${sourcePath} is ${content.length} chars — over the ${INJECT_CHAR_CAP}-char injection cap, ` +
      `so it is NOT in your context. Read ${sourcePath} when making decisions it could affect, ` +
      `and ask the user to prune/summarize stale entries.\n`
    )
  }
  return authority + content + "\n"
}

/** Build the fragment: marker + staleness line + (optional) Public
 * section + (optional) Private section. Returns an empty string when both
 * sources are null so the caller's `appendBlock` becomes a no-op (the
 * strip handles stale state). Pure — exported for tests. */
export function buildFragment(
  publicContent: string | null,
  publicPathStr: string,
  privateContent: string | null,
  privatePathStr: string,
): string {
  if (publicContent === null && privateContent === null) return ""

  const publicAuthority =
    `Project lessons from ${publicPathStr} — advisory: follow them unless ` +
    `the user or AGENTS.md says otherwise (AGENTS.md is authoritative on conflict).\n\n`
  const privateAuthority =
    `Personal notes from ${privatePathStr} (gitignored) — current-user preferences/environment only; ` +
    `do NOT generalize to other developers. AGENTS.md is authoritative on conflict.\n\n`

  // Staleness signal at the top of the fragment. The model uses this to
  // gauge freshness on each chat request; on stale content it nudges
  // the user toward `/memory-summarize` so memory stays current.
  const overallMtime = memoryMtime()
  const stalenessLine = overallMtime === null
    ? ""
    : `(Project memory last updated: ${formatMtimeLocal(overallMtime)}. ` +
      `If notes are stale, suggest /memory-summarize to refresh.)\n`

  const parts: string[] = []
  if (publicContent !== null) {
    parts.push(sectionHeader("Public", countEntries(publicContent), publicPathStr) + section(publicContent, publicPathStr, publicAuthority))
  }
  if (privateContent !== null) {
    parts.push(sectionHeader("Private", countEntries(privateContent), privatePathStr) + section(privateContent, privatePathStr, privateAuthority))
  }

  return `\n\n${MARKER}\n\n${stalenessLine}` + parts.join("\n---\n\n")
}

function hasMarker(system: string[]): boolean {
  const re = new RegExp(`\\n${escapeRegExp(MARKER)}`)
  return system.some((s) => typeof s === "string" && re.test(s))
}

export function makeSystemHook(client: PluginInput["client"]) {
  const log = (level: "info" | "warn", message: string) =>
    client.app.log({ body: { service: "project-memory", level, message } })

  return async (input: { sessionID?: string } | undefined, output: { system: string[] }) => {
    // Lite/utility/subagent sessions are denied via plugin-scope.json "*".
    if (!(await scoped(input, output.system, "project-memory", client))) return

    // Defensive strip — stale block from a previous turn / flipped switch.
    const stripped = hasMarker(output.system) ? stripBlockByLine(output.system, MARKER) : false

    if (!isEnabled()) {
      if (stripped) await log("info", "system prompt: stale project-memory block stripped (switch off)")
      return
    }

    const pub = readPublic()
    const priv = readPrivate()
    if (pub === null && priv === null) {
      if (stripped) await log("info", "system prompt: stale project-memory block stripped (both files missing/empty)")
      return
    }

    const fragment = buildFragment(pub, publicPath(), priv, privatePath())
    if (fragment === "") return
    if (appendBlock(output.system, fragment))
      await log("info", "system prompt: project memory injected")
  }
}