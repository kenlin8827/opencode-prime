/**
 * Hook: experimental.chat.system.transform — progressive-disclosure pointer
 * to the project's commit convention (docs/git-commits.md).
 *
 * Token policy: the convention FILE is never injected into context. Only a
 * compact pointer (~50 tokens) is injected while the file exists, telling
 * the agent where the convention lives and to read it before committing.
 * The full document is loaded on demand (one read per commit), and the
 * mechanical gate in project-manager-tool-guard.ts backstops any commit
 * made without reading it — so progressive disclosure carries no
 * compliance risk here.
 *
 * Opencode runtime note (verified 2026-09-11, see ADR 0002): the
 * runtime rebuilds `output.system` per chat request. See adr-guard
 * for the full Scenario A / B rationale — same fragment-cache +
 * defensive-strip pattern applies here. Marker match is line-start
 * (rather than substring) to avoid false positives from inline
 * mentions of the marker text elsewhere in the prompt.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import { scoped } from "../shared/plugin-scope"
import { appendBlock, escapeRegExp, stripBlockByLine } from "../shared/system-block"
import { GIT_COMMITS_REL, hasConventionFile } from "./project-manager-config"

export const MARKER = "[PROJECT COMMIT CONVENTION]"

// Line-start marker check is handled inside stripBlockByLine, which derives
// the regex from MARKER via escapeRegExp. Keeping the literal here as the
// single source of truth for both the marker text and the (now shared)
// idempotency check.

/**
 * Pointer fragment appended to the system prompt. Progressive disclosure:
 * names the file, defers reading it to commit time, and warns that the
 * structural rules are mechanically enforced. stripMarker() trims trailing
 * whitespace after cutting at the marker, so the leading \n\n separator
 * restores to a semantically identical prompt (same contract as adr-guard).
 */
function buildFragment(): string {
  return (
    `\n\n${MARKER}\n\n` +
    `This project defines a commit convention in ${GIT_COMMITS_REL} (progressive ` +
    `disclosure — the document is NOT in your context). Before ANY git commit: read ` +
    `${GIT_COMMITS_REL} and follow it. Structural rules are mechanically enforced ` +
    `(first line "type(scope): summary", known type, ≤ 72 chars) — non-conforming ` +
    `commits are blocked.\n`
  )
}

// ─── System prompt helpers ───────────────────────────────────────────

function hasMarker(system: string[]): boolean {
  // Line-start match — avoids false positives from inline mentions of the
  // marker text elsewhere in the prompt (same as project-profiler). The
  // shared stripBlockByLine uses the exact same regex shape, so this
  // check stays in sync with the strip path's match semantics.
  const re = new RegExp(`\\n${escapeRegExp(MARKER)}`)
  return system.some((s) => typeof s === "string" && re.test(s))
}

function stripMarker(system: string[]): boolean {
  return stripBlockByLine(system, MARKER)
}

/** Append the fragment to the LAST string entry, with a fallback push when
 * the runtime passes an empty or all-object array. Inherited from
 * `plugins/shared/system-block.ts` so this plugin benefits from the same
 * defensive fix project-profiler landed (see the 2026-09-11 hook regression). */
function appendFragment(system: string[], fragment: string): boolean {
  return appendBlock(system, fragment)
}

/** Cached rendered fragment. Same rationale as adr-guard's
 * `cachedPrompt` — the fragment text is constant for a given
 * `GIT_COMMITS_REL`. The path is a module-level constant
 * (`plugins/project-manager/project-manager-config.ts`), so the
 * fragment doesn't change within a process. */
let cachedPrompt: string | undefined

export function makeSystemHook(client: PluginInput["client"]) {
  const log = (level: "info" | "warn", message: string) =>
    client.app.log({ body: { service: "project-manager", level, message } })

  return async (input: { sessionID?: string } | undefined, output: { system: string[] }) => {
    // Lite mode: bare-prompt contract — no convention pointer for @lite.
    if (!await scoped(input, output.system, "project-manager", client)) return

    // Defensive strip — see adr-guard rationale (Scenario A/B).
    // Line-start match via the shared helper.
    const stripped = hasMarker(output.system) ? stripMarker(output.system) : false

    if (!hasConventionFile()) {
      if (stripped) await log("info", "system prompt: stale commit-convention block stripped (file missing)")
      return
    }

    if (!cachedPrompt) cachedPrompt = buildFragment()
    const changed = appendFragment(output.system, cachedPrompt)
    if (changed) await log("info", "system prompt: commit-convention pointer injected (progressive disclosure)")
  }
}