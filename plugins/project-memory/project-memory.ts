/**
 * Project Memory (project-memory) — lightweight project-level memory.
 *
 * Two scopes, one gate. File names self-describe visibility (no
 * ambiguity when scanning `.ocp/memory/`):
 *   public.md   → committed to git, reviewed by your team through the
 *                  normal PR flow. Same authority tier as AGENTS.md.
 *   private.md  → gitignored, only the current user sees it
 *                  (auto-gitignored on first capture).
 *
 * Files live INSIDE the project at `<projectDir>/.ocp/memory/` —
 * same convention as `.ocp/handoffs/`, `.ocp/logs/`,
 * `.ocp/recovery/`. Legacy `.opencode/memory/` files are moved here once
 * by the project-init migration (ADR 0004 v2); runtime reads are
 * single-path.
 *
 * Entry points:
 *   • /memory note "<lesson>"             (user command, public default)
 *   • /memory note --private "<lesson>"   (user command, explicit private)
 *   • memory_note tool                    (agent judges + notes)
 *
 * Top-tier reference designs (Cursor Rules, Claude Projects memory, Copilot
 * Custom Instructions, Aider conventions, Continue.dev) all edit a single
 * file directly; we mirror that for the public file and ADD a private
 * scope rather than splitting — the public file stays diff/PR-reviewable,
 * the private file stays scratchpad-ish.
 *
 * Distinct from AGENTS.md (manually curated project facts, authoritative —
 * memory is advisory) and from opencode-mem (auto-captured session history,
 * heavier, different grain). Complementary, not duplicative.
 *
 * V2 MAPPING NOTES (v1 → v2):
 *   • v1 `config` hook + `command.execute.before` → v2 `ctx.command.
 *     transform(editor.add)`: the /memory command is plugin-OWNED (empty
 *     template in v1, programmatic handling only), so it belongs on the
 *     v2 command registry directly — execute() resolves with no model
 *     turn for handled branches (v1's handled()/204-throw equivalent).
 *   • v1 `experimental.chat.system.transform` → v2 "context" hook.
 *   • v1 `tool: { memory_note }` → v2 `ctx.tool.transform(editor.add)`
 *     with `options: { codemode: false }` (first-class model tool).
 *   • v1 user-visible replies via `client.session.prompt({noReply,
 *     ignored})` → v2 `session.synthetic` (shared/agent-scope.injectReply).
 *
 * File layout:
 *   project-memory-config.ts        — switch + paths + lesson append (scoped)
 *   project-memory-command.ts       — command handler (/memory note|on|off|status)
 *   project-memory-tool.ts          — memory_note tool (agent-driven, scoped)
 *   project-memory-system-inject.ts — context hook: inject both files
 */

import type { Plugin } from "@opencode/plugin"
import { commandArgumentText, type V2Session } from "../shared/agent-scope"
import { setProjectDir } from "./project-memory-config"
import { COMMAND_NAME, makeCommandHandler } from "./project-memory-command"
import { makeSystemHook } from "./project-memory-system-inject"
import { memoryNoteTool } from "./project-memory-tool"

export const ProjectMemoryPlugin: Plugin.Plugin = {
  id: "opencode-prime.project-memory",
  async setup(ctx) {
    // Switch + files are project-level: pin paths to this project's directory.
    const directory = ctx.location.directory
    setProjectDir(directory)
    const session = ctx.session as unknown as V2Session

    const context = await ctx.session.hook("context", (e) => makeSystemHook(session)(e))
    const commands = await ctx.command.transform((editor) => {
      const handler = makeCommandHandler(session)
      editor.add({
        name: COMMAND_NAME,
        description:
          "Project memory — two scopes, one gate. /memory note \"<lesson>\" appends a dated entry to .ocp/memory/public.md (committed to git, reviewed via the normal PR flow); /memory note --private \"<note>\" appends to .ocp/memory/private.md (gitignored escape hatch for notes the team should not see); /memory on|off toggles injection of both into the system prompt; /memory status reports gate + public/private entry counts. The agent may also call the `memory_note` tool itself (with scope='public' or 'private').",
        execute: async (invocation) => {
          await handler({ arguments: commandArgumentText(invocation.prompt?.text, COMMAND_NAME), sessionID: invocation.sessionID })
        },
      })
    })
    // Custom tool registration: the payload is fully static (schema +
    // closures over ctx.session) — sync-cheap and idempotent per contract.
    const tools = await ctx.tool.transform((editor) => {
      editor.add(memoryNoteTool(session))
    })

    return async () => {
      await Promise.allSettled([context.dispose(), commands.dispose(), tools.dispose()])
    }
  },
}

export default ProjectMemoryPlugin
