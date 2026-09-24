/**
 * SDD Plugin (Specification-Driven Development) — v2 entry.
 *
 * Engine-only: the `/prd | /adr | /plan | /impl | /sdd` commands are
 * registered as command files (commands/*.md — thin launchers that load the
 * sdd-workflow skill on demand), and the protocol itself lives at L2
 * (skills/sdd-workflow/SKILL.md). This plugin contributes only the runtime
 * logic that markdown cannot express:
 *
 *   prompt hook — scaffold docs/prd|plan artifacts on first use,
 *   answer `/sdd status|help`, and announce `/sdd handoff` packaging.
 *
 * V2 MAPPING NOTE (v1 → v2): v1 `command.execute.before` → the "prompt"
 * hook matching leading "/<cmd>" text. Choice rationale (per-stream
 * contract): these commands are template-defined files, NOT plugin-owned —
 * ctx.command.transform would replace them. The handler never cancels the
 * command in v1 either; it only performs side effects and lets the prompt
 * through, which the prompt hook expresses exactly.
 */

import { Plugin } from "@opencode/plugin"
import type { V2Session } from "../shared/agent-scope"
import { IMPL_COMMAND, PLAN_COMMAND, PRD_COMMAND, SDD_COMMAND, makeSddCommandHook } from "./sdd-command"

/** Parse a submitted prompt's leading slash command. Pure — exported for
 *  tests. Returns null when the text is not one of the SDD commands. */
export function parseSddCommand(
  text: string | undefined,
): { command: string; arguments: string } | null {
  const match = /^\/(sdd|prd|plan|impl)(?:[ \t]+([\s\S]*))?/.exec(text ?? "")
  if (!match) return null
  const command = match[1]
  if (![SDD_COMMAND, PRD_COMMAND, PLAN_COMMAND, IMPL_COMMAND].includes(command)) return null
  return { command, arguments: match[2] ?? "" }
}

export const SddPlugin = Plugin.define({
  id: "sdd",
  async setup(ctx) {
    const session = ctx.session as unknown as V2Session
    const handler = makeSddCommandHook(session)
    const prompt = await ctx.session.hook("prompt", async (e) => {
      // Fail-open: a scaffold announcement must never abort admission.
      try {
        const parsed = parseSddCommand(e.prompt?.text)
        if (!parsed) return
        await handler({ ...parsed, sessionID: e.sessionID })
      } catch {
        // Degrade to no announcement.
      }
    })
    return async () => {
      await prompt.dispose()
    }
  },
})

export default SddPlugin
