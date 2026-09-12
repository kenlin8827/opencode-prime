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
 * File layout:
 *   project-memory-config.ts        — switch + paths + lesson append (scoped)
 *   project-memory-command.ts       — command hook (/memory note|on|off|status)
 *   project-memory-tool.ts          — memory_note tool (agent-driven, scoped)
 *   project-memory-system-inject.ts — system-transform hook: inject both files
 */

import type { Plugin } from "@opencode-ai/plugin"
import { HttpServerResponse } from "effect/unstable/http"
import { setProjectDir } from "./project-memory-config"
import { COMMAND_NAME, makeCommandHook } from "./project-memory-command"
import { makeSystemHook } from "./project-memory-system-inject"
import { TOOL_NAME, makeCaptureTool } from "./project-memory-tool"

// OpenCode's command hook has no cancel/noReply output. Throwing a raw
// Effect response is handled by OpenCode's HTTP layer as an empty
// successful command — the LLM never sees the command text. (Same contract
// as project-manager.)
const handled = (): never => {
  throw HttpServerResponse.empty({ status: 204 })
}

export const ProjectMemoryPlugin: Plugin = async ({ client, directory }) => {
  // Switch + files are project-level: pin paths to this project's directory.
  setProjectDir(directory)
  return {
    config: async (cfg) => {
      cfg.command ??= {}
      cfg.command[COMMAND_NAME] = {
        template: "",
        description:
          "Project memory — two scopes, one gate. /memory note \"<lesson>\" appends a dated entry to .ocp/memory/public.md (committed to git, reviewed via the normal PR flow); /memory note --private \"<note>\" appends to .ocp/memory/private.md (gitignored escape hatch for notes the team should not see); /memory on|off toggles injection of both into the system prompt; /memory status reports gate + public/private entry counts. The agent may also call the `memory_note` tool itself (with scope='public' or 'private').",
      }
    },
    "command.execute.before": makeCommandHook(client, handled),
    "experimental.chat.system.transform": makeSystemHook(client) as any,
    tool: {
      [TOOL_NAME]: makeCaptureTool(client),
    },
  }
}