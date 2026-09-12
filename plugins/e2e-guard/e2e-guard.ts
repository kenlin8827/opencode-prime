/**
 * E2E Guard (e2e-guard) — project-level switch guiding E2E testing best practices.
 *
 * When on:
 *   - Injects the E2E Testing Protocol into the system prompt via experimental.chat.system.transform.
 *   - Instructs the LLM to assess E2E requirements on `feat`/`fix` tasks, task completion, and git commit/push.
 *   - Guides the LLM to evaluate impact (full vs targeted) and detect missing E2E test cases.
 *   - Ensures the LLM interactively asks the user for authorization/choices via the `ask` tool.
 *
 * When off:
 *   - No-op; strips any injected prompt block.
 *
 * File layout:
 *   e2e-guard-config.ts        — project .ocp/ocp.json `e2eGuard` switch read/write
 *   e2e-guard-protocol.md      — protocol markdown definition
 *   e2e-guard-instructions.ts  — prompt fragment builder (marker + cached protocol)
 *   e2e-guard-system-inject.ts — system prompt injection hook
 *   e2e-guard-command.ts       — /e2e-guard on|off|status user command hook
 *   e2e-guard-runtime.ts       — command detection & git diff utilities
 */

import type { Plugin } from "@opencode-ai/plugin"
import { setProjectDir } from "./e2e-guard-config"
import { COMMAND_NAME, makeCommandHook } from "./e2e-guard-command"
import { makeEventHook } from "./e2e-guard-announce"
import { makeSystemHook } from "./e2e-guard-system-inject"

export const E2eGuardPlugin: Plugin = async ({ client, directory }) => {
  // Switch is project-level: pin state/config paths to this project's directory.
  setProjectDir(directory)
  return {
    config: async (cfg) => {
      cfg.command ??= {}
      cfg.command[COMMAND_NAME] = {
        template: "",
        description:
          "E2E guard project controls — /e2e-guard status shows gate state; /e2e-guard on|off flips the project gate in .ocp/ocp.json",
      }
    },
    "experimental.chat.system.transform": makeSystemHook(client) as any,
    "command.execute.before": makeCommandHook(),
    event: makeEventHook(client) as any,
  }
}
