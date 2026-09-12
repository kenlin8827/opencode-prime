/**
 * ADR Iron Law (adr-guard) — project-level switch enforcing ADRs on feat/refactor commits.
 * `adr-guard` is the enforcement mechanism; the rule it enforces is still
 * called the ADR iron law in the protocol.
 *
 *   on  — every feat/refactor commit MUST include a new or updated ADR
 *         (hard-blocked at git commit) + protocol injected into the system
 *         prompt so agents write the ADR proactively.
 *   off — default; the plugin is a complete no-op.
 *
 * ADRs follow the industry-standard MADR template, exactly as defined:
 * frontmatter `status` + `date`, then Context/Decision Outcome sections.
 * File numbers stay sequential (0001-slug.md) and never reset — they are a
 * stable identity; *when* a decision happened lives in `date` and git
 * history, never in the number.
 *
 * File layout: one entry + one job per file.
 *   adr-guard-config.ts        — state normalize, project .ocp/ocp.json field IO,
 *                                  ADR dir resolution
 *   adr-guard-runtime.ts       — log, bash tokenizer, commit message/type
 *                                  parsing, git working-tree ADR detection
 *   adr-guard-protocol.md      — iron-law protocol body (markdown, read
 *                                  once + cached)
 *   adr-guard-instructions.ts  — prompt fragment builder (marker + live
 *                                  ADR dir)
 *   adr-guard-system-inject.ts — system-transform hook (injects protocol
 *                                  when on, strips stale block when off)
 *   adr-guard-tool-guard.ts    — tool.before hook: blocks feat/refactor
 *                                  git commit with no ADR change
 *   adr-guard-command.ts       — command hook (/adr-guard on|off|status)
 *   adr-guard-announce.ts      — toast feedback for /adr-guard
 *                                  on|off|status (switch confirmations
 *                                  and status reports)
 *
 * Switch: `adrGuard` field in the project-level .ocp/ocp.json (no state file).
 */

import type { Plugin } from "@opencode-ai/plugin"
import { HttpServerResponse } from "effect/unstable/http"
import { makeCommandHook } from "./adr-guard-command"
import { ADR_COMMAND, COMMAND_NAME, setProjectDir } from "./adr-guard-config"
import { makeSystemHook } from "./adr-guard-system-inject"
import { makeToolGuardHook } from "./adr-guard-tool-guard"

// OpenCode's command hook has no cancel/noReply output. Throwing a raw
// Effect response is handled by OpenCode's HTTP layer as an empty
// successful command — the LLM never sees an empty prompt.
const handled = (): never => {
  throw HttpServerResponse.empty({ status: 204 })
}

export const AdrGuardPlugin: Plugin = async ({ client, directory }) => {
  // Switch is project-level: pin state/config paths to this project's directory.
  setProjectDir(directory)
  return {
    config: async (cfg) => {
      cfg.command ??= {}
      cfg.command[COMMAND_NAME] = {
        template: "",
        description:
          "Toggle the ADR iron law for this project — every feat/refactor commit requires a new/updated ADR (on | off | status)",
      }
      cfg.command[ADR_COMMAND] = {
        template: "/adr $ARGUMENTS",
        description:
          "Manage Architecture Decision Records (new | supersede | tree | check | help)",
      }
    },
    "command.execute.before": makeCommandHook(client, handled),
    "experimental.chat.system.transform": makeSystemHook(client),
    "tool.execute.before": makeToolGuardHook(client),
  }
}
