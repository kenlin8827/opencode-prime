/**
 * Hook: experimental.chat.system.transform — inject the curated project
 * memory file (user-level, outside the project:
 * <ocp config root>/memory/<projectKey>/memory.md) into the system prompt.
 *
 * Only the CURATED file is ever injected; the draft file stays
 * out of context until a human promotes entries (capture → review → inject,
 * opt-in at every stage). The gate is the project-config switch
 * (`projectMemory`, default off) AND file presence: off or missing file →
 * complete no-op plus defensive strip of any stale block.
 *
 * Authority: memory is ADVISORY. AGENTS.md (manually curated project facts)
 * wins on conflict — stated in the fragment so the model resolves it without
 * a human in the loop.
 *
 * Opencode runtime note (verified 2026-09-11, see ADR 0002): the runtime
 * rebuilds `output.system` per chat request — same defensive-strip pattern
 * as the other injectors. No fragment cache here: the body is file content
 * that a review edit can change mid-session, so it must stay fresh.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import { scoped } from "../shared/plugin-scope"
import { appendBlock, escapeRegExp, stripBlockByLine } from "../shared/system-block"
import { isEnabled, memoryPath, readMemory } from "./project-memory-config"

export const MARKER = "[PROJECT MEMORY]"

/** Injection ceiling in characters. Past this the curated file has outgrown
 * its context budget and full injection would crowd out the actual task.
 * ponytail: naive size gate; upgrade path is the phase-2 review tool
 * (promote/summarize/prune) so the file stays under the cap by curation. */
export const INJECT_CHAR_CAP = 16_000

/** Build the fragment: header + curated content, or — over the cap — a
 * progressive-disclosure pointer telling the agent to read the file itself.
 * `path` is the absolute memory file location (outside the project checkout)
 * so pointer mode can name it. Pure — exported for tests. */
export function buildFragment(content: string, path: string): string {
  const head = `\n\n${MARKER}\n\n`
  const authority =
    `Curated project lessons from ${path} — advisory: follow them unless ` +
    `the user or AGENTS.md says otherwise (AGENTS.md is authoritative on conflict).\n\n`
  if (content.length > INJECT_CHAR_CAP) {
    return (
      head +
      `${path} is ${content.length} chars — over the ${INJECT_CHAR_CAP}-char injection cap, ` +
      `so it is NOT in your context. Read ${path} when making decisions it could affect, ` +
      `and ask the user to prune/summarize stale entries.\n`
    )
  }
  return head + authority + content + "\n"
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

    const content = readMemory()
    if (content === null) {
      if (stripped) await log("info", "system prompt: stale project-memory block stripped (file missing/empty)")
      return
    }

    if (appendBlock(output.system, buildFragment(content, memoryPath())))
      await log("info", "system prompt: project memory injected")
  }
}
