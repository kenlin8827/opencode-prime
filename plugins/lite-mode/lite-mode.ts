/**
 * Lite-Mode — L2 disclosure layer.
 *
 * The `lite` agent's inline prompt carries the lite identifier (matrix
 * identifiers.lite). When detectAgent() recognizes the joined system prompt
 * as lite, this plugin strips every `Instructions from: <path>` block (L0
 * instruction files, project AGENTS.md, ~/.claude/CLAUDE.md, remote
 * instructions) from the system text.
 *
 * The identifier itself is KEPT: it is the cross-plugin lite signal — every
 * protocol injector's scoped() gate still needs to see it in the system
 * text. Hook order is not controllable, so injectors running AFTER this
 * plugin must still identify lite from the text.
 *
 * Fail-open: any error leaves the system prompt untouched. Pure string ops —
 * no I/O, no session lookup, costs only a few string checks per step.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { detectAgent } from "../shared/plugin-scope"

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

export const LiteModePlugin: Plugin = async () => ({
  "experimental.chat.system.transform": async (
    _input: unknown,
    output: { system: string[] },
  ) => {
    if (detectAgent(output.system) !== "lite") return
    for (let i = 0; i < output.system.length; i++) {
      const s = output.system[i]
      if (typeof s !== "string" || detectAgent([s]) !== "lite") continue
      try {
        output.system[i] = stripLiteOverhead(s)
      } catch {
        // Fail-open: keep the original system text.
      }
    }
  },
})
