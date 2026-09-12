/**
 * Project Memory (project-memory) — lightweight opt-in project-level memory.
 *
 * Captures user-flagged "lessons learned" and injects the curated set into
 * LLM context. Three stages, opt-in at every one. Files live OUTSIDE the
 * project, under the ocp user-level config root
 * (<config root>/memory/<projectKey>/ — heavy memory must not live or die
 * with the checkout; survives project deletion, honors OCP_CONFIG_PATH):
 *   1. capture  — /memory capture "<lesson>"  → draft.md (pending review)
 *   2. review   — manual edit (phase 2 will tool this) draft.md → memory.md
 *   3. inject   — while `projectMemory: "on"` in the project opencode.jsonc,
 *                 memory.md is appended to the system prompt.
 *
 * Distinct from AGENTS.md (manually curated project facts, authoritative —
 * memory is advisory) and from opencode-mem (auto-captured session history,
 * heavier, different grain). Complementary, not duplicative.
 *
 * File layout (same pattern as e2e-guard):
 *   project-memory-config.ts        — switch + file paths + draft append
 *   project-memory-command.ts       — command hook (/memory capture|on|off|status)
 *   project-memory-system-inject.ts — system-transform hook: inject memory.md
 */

import type { Plugin } from "@opencode-ai/plugin"
import { HttpServerResponse } from "effect/unstable/http"
import { setProjectDir } from "./project-memory-config"
import { COMMAND_NAME, makeCommandHook } from "./project-memory-command"
import { makeSystemHook } from "./project-memory-system-inject"

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
          "Project memory — /memory capture \"<lesson>\" files a lesson into the project's draft.md under the ocp memory root; /memory on|off toggles injection of the curated memory.md into context; /memory status reports gate + counts",
      }
    },
    "command.execute.before": makeCommandHook(client, handled),
    "experimental.chat.system.transform": makeSystemHook(client) as any,
  }
}
