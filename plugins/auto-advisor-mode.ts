/**
 * Auto-Advisor Mode Guard — 3-mode toggle for blocking decisions.
 * Modes: off (default) | lite | full.
 *
 *   off  — no auto-dispatch of @advisor; orchestrator decides alone.
 *         Manual @advisor from the user is still allowed (advisory only).
 *   lite — both opinions returned to user; advisor never answers for the user.
 *   full — FACTUAL question + confidence ≥ 8 → advisor answers on the user's
 *          behalf (auto-execute); PREFERENCE or < 8 → lite flow.
 *
 * File layout: one entry + one job per file.
 *   auto-advisor-config.ts            — mode normalize, project .ocp/ocp.json field IO, cold-start
 *   auto-advisor-runtime.ts           — log, advisor detection, output shaping,
 *                                  red-team + question-class guards,
 *                                  auto-answer state (session-keyed)
 *   auto-advisor-instructions.ts      — prompt fragment per mode (loads auto-advisor-protocol.md)
 *   auto-advisor-protocol.md         — advisor protocol body (markdown, read once + cached)
 *   auto-advisor-mode-tracker.ts      — command hook (writes state on slash command)
 *   auto-advisor-system-inject.ts     — system-transform hook (injects prompt)
 *   auto-advisor-tool-guard.ts        — tool.before hook: blocks question tool when
 *                                  auto-answer armed (full mode); off-mode relies
 *                                  on system prompt soft guard, no hard block
 *   auto-advisor-full-inject.ts       — tool.after hook: auto-answer FACTUAL ≥ 8 in
 *                                  full mode; arms auto-answer state on success
 *   auto-advisor-announce.ts          — toast feedback for /auto-advisor
 *                                  mode switches (confirmation toast)
 *
 * Mode storage: `autoAdvisorMode` field in the project-level .ocp/ocp.json —
 * project-level only (read + write); default is off.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { HttpServerResponse } from "effect/unstable/http"
import { makeCommandHook } from "./auto-advisor/auto-advisor-mode-tracker"
import { makeSystemHook } from "./auto-advisor/auto-advisor-system-inject"
import { makeToolGuardHook } from "./auto-advisor/auto-advisor-tool-guard"
import { makeFullInjectHook } from "./auto-advisor/auto-advisor-full-inject"
import { COMMAND_NAME, setProjectDir } from "./auto-advisor/auto-advisor-config"

// OpenCode's command hook has no cancel/noReply output. Throwing a raw
// Effect response is handled by OpenCode's HTTP layer as an empty
// successful command — the LLM never sees an empty prompt.
const handled = (): never => {
  throw HttpServerResponse.empty({ status: 204 })
}

export const AutoAdvisorModePlugin: Plugin = async ({ client, directory }) => {
  // Mode is project-level: pin state/config paths to this project's directory.
  setProjectDir(directory)
  return {
    config: async (cfg) => {
      cfg.command ??= {}
      cfg.command[COMMAND_NAME] = {
        template: "",
        description: "Switch auto-advisor mode (off | lite | full)",
      }
    },
    "command.execute.before": makeCommandHook(client, handled),
    "experimental.chat.system.transform": makeSystemHook(client),
    "tool.execute.before": makeToolGuardHook(client),
    "tool.execute.after": makeFullInjectHook(client),
  }
}
