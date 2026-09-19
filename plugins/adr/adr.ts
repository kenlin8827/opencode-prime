/**
 * ADR (adr) — the full ADR lifecycle workbench: creation, supersession,
 * multi-style ADL (Nygard / MADR / OCP), migration, governance, evolution,
 * views — plus the iron-law guard, the enforcement submodule that makes
 * ADRs non-optional for feat/refactor commits.
 *
 * Iron law (the guard submodule, off by default):
 *   on  — every feat/refactor commit MUST include a new or updated ADR
 *         (hard-blocked at git commit) + protocol injected into the system
 *         prompt so agents write the ADR proactively.
 *   off — default; the guard is a complete no-op and `/adr` keeps working.
 *
 * ADRs follow the industry-standard MADR template, exactly as defined:
 * frontmatter `status` + `date`, then Context/Decision Outcome sections.
 * File numbers stay sequential (0001-slug.md) and never reset — they are a
 * stable identity; *when* a decision happened lives in `date` and git
 * history, never in the number.
 *
 * File layout: one entry + one job per file.
 *   adr-config.ts              — state normalize, project .ocp/ocp.json field IO,
 *                                  ADR dir resolution
 *   adr-runtime.ts             — log, bash tokenizer, commit message/type
 *                                  parsing, git working-tree ADR detection
 *   adr-command.ts             — command hook (/adr … incl. `guard`;
 *                                  /adr-guard kept as a switch alias)
 *   adr-instructions.ts  — prompt fragment builder (marker + live
 *                                  ADR dir)
 *   adr-system-inject.ts — system-transform hook (injects protocol
 *                                  when on, strips stale block when off)
 *   adr-tool-guard.ts    — tool.before hook: blocks feat/refactor
 *                                  git commit with no ADR change
 *   adr-announce.ts      — toast feedback for the guard switch
 *                                  (confirmations and status reports)
 *
 * Switch: `adrGuard` field in the project-level .ocp/ocp.json (no state file).
 */

import type { Plugin } from "@opencode-ai/plugin"
import { HttpServerResponse } from "effect/unstable/http"
import { makeCommandHook } from "./adr-command"
import { ADR_COMMAND, COMMAND_NAME, setProjectDir } from "./adr-config"
import { makeSystemHook } from "./adr-system-inject"
import { makeToolGuardHook } from "./adr-tool-guard"

// OpenCode's command hook has no cancel/noReply output. Throwing a raw
// Effect response is handled by OpenCode's HTTP layer as an empty
// successful command — the LLM never sees an empty prompt.
const handled = (): never => {
  throw HttpServerResponse.empty({ status: 204 })
}

export const AdrPlugin: Plugin = async ({ client, directory }) => {
  // Switch is project-level: pin state/config paths to this project's directory.
  setProjectDir(directory)
  return {
    config: async (cfg) => {
      cfg.command ??= {}
      cfg.command[COMMAND_NAME] = {
        template: "",
        description:
          "Alias of /adr guard — toggle the ADR iron law for this project — every feat/refactor commit requires a new/updated ADR (on | off | reset | status)",
      }
      cfg.command[ADR_COMMAND] = {
        template: "/adr $ARGUMENTS",
        description:
          "Manage Architecture Decision Records and the commit guard (new | supersede | tree | check | guard | help)",
      }
    },
    "command.execute.before": makeCommandHook(client, handled),
    "experimental.chat.system.transform": makeSystemHook(client),
    "tool.execute.before": makeToolGuardHook(client),
  }
}
