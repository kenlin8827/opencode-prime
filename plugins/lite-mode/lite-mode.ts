/**
 * Lite-Mode — L2 disclosure layer.
 *
 * The `lite` agent's inline prompt carries the lite identifier (matrix
 * identifiers.lite). When detection recognizes the request as lite, this
 * plugin strips every `Instructions from: <path>` block (L0 instruction
 * files, project AGENTS.md, ~/.claude/CLAUDE.md, remote instructions) from
 * the system text.
 *
 * The identifier itself is KEPT: it is the cross-plugin lite signal — every
 * protocol injector's gate (agent-scope.scopedForAgent) also scans system
 * text, and hook order is not controllable, so injectors running AFTER this
 * plugin must still identify lite from the text.
 *
 * V2: registered on ctx.session.hook("context") — the v2 replacement of
 * experimental.chat.system.transform. `e.system` is a SystemPart[]; the
 * hook runs its string logic over a toSystemView() copy and flushes it
 * through writeBackSystem() so part identity and cache hints survive.
 *
 * Fail-open: any error leaves the system prompt untouched. Pure string ops —
 * no I/O, no session lookup, costs only a few string checks per step.
 */

import { detectAgent, detectAgentByName } from "../shared/plugin-scope"
import { toSystemView, writeBackSystem } from "../shared/system-block"

const INSTRUCTION_MARKER = "Instructions from: "

/** True when the marker's path argument looks like a file path or URL. */
export function isInstructionPath(path: string): boolean {
  const t = path.trim()
  return /^(https?:\/\/|\.{0,2}\/|~\/|[A-Za-z]:\\)/.test(t) || /\.(md|txt)$/.test(t)
}

// Blocks that follow the instruction segments in opencode's joined system
// (session/prompt: system = [env, instructions, mcpInstructions, skills]).
const SYSTEM_TAG = /^<(available_skills|mcp_instructions|env)\b/

/**
 * Strip all instruction blocks (the lite identifier itself is kept as the
 * cross-plugin lite signal). A block starts at a line
 * beginning with `Instructions from: <path-like>` and runs until the next
 * such marker, a system block tag, or end of text — internal blank lines in
 * instruction files stay inside the block.
 */
export function stripLiteOverhead(system: string): string {
  const lines = system.split("\n")
  const kept: string[] = []
  let inBlock = false
  for (const line of lines) {
    if (line.startsWith(INSTRUCTION_MARKER) && isInstructionPath(line.slice(INSTRUCTION_MARKER.length))) {
      inBlock = true
      continue
    }
    if (inBlock && SYSTEM_TAG.test(line)) inBlock = false
    if (!inBlock) kept.push(line)
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

/** V2 "context" hook callback. `e.agent` is the v2 primary identification
 *  channel; the system-text sentinel stays the fallback (auxiliary requests
 *  and older event shapes). Exported for unit tests; fail-open internally —
 *  a throw here must never abort the request flow. */
export async function liteModeContextHook(e: {
  agent?: string | null
  system?: Array<unknown>
}): Promise<void> {
  try {
    const system = Array.isArray(e.system) ? e.system : []
    const identity = detectAgentByName(e.agent ?? undefined) ?? detectAgent(system)
    if (identity !== "lite") return
    const view = system.map((entry) => (typeof entry === "string" ? entry : (entry as { text?: string })?.text ?? ""))
    for (let i = 0; i < view.length; i++) {
      if (detectAgent([view[i]]) !== "lite") continue
      try {
        view[i] = stripLiteOverhead(view[i])
      } catch {
        // Fail-open: keep the original system text.
      }
    }
    // Flush only changed entries back through the shared writer (keeps
    // SystemPart identity + non-text fields intact for untouched parts).
    for (let i = 0; i < system.length; i++) {
      const entry = system[i]
      const text = typeof entry === "string" ? entry : (entry as { text?: string })?.text
      if (text === undefined || text === view[i]) continue
      if (entry && typeof entry === "object") (entry as { text: string }).text = view[i]
      else system[i] = view[i]
    }
  } catch {
    // Fail-open: the hook must never abort the session flow.
  }
}

// V2 SDK import — types resolve once @opencode/plugin is installed
// (package.json is owned by the parallel migration stream).
import type { Plugin } from "@opencode/plugin"

/** V2 plugin definition (id kept identical to the v1 plugin name). */
export const LiteModePlugin: Plugin.Plugin = {
  id: "opencode-prime.lite-mode",
  async setup(ctx) {
    const context = await ctx.session.hook("context", (e) => liteModeContextHook(e))
    return async () => {
      await context.dispose()
    }
  },
}

export default LiteModePlugin
