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
 *   auto-advisor-mode-tracker.ts      — command handler (writes state on slash command)
 *   auto-advisor-system-inject.ts     — v2 "context" hook (injects prompt)
 *   auto-advisor-tool-guard.ts        — tool execute.before hook: blocks question tool when
 *                                  auto-answer armed (full mode); off-mode relies
 *                                  on system prompt soft guard, no hard block
 *   auto-advisor-full-inject.ts       — tool execute.after hook: auto-answer FACTUAL ≥ 8 in
 *                                  full mode; arms auto-answer state on success
 *   auto-advisor-announce.ts          — announce feedback for /auto-advisor
 *                                  mode switches (v2: server-log line — see OCP-V2-GAP note)
 *
 * V2 MAPPING (v1 → v2):
 *   • `config` hook + `command.execute.before` → ctx.command.transform
 *     (plugin-owned command; returning from execute consumes it).
 *   • `experimental.chat.system.transform` → ctx.session.hook("context").
 *   • `tool.execute.before`/`after` → ctx.tool.hook(...) single mutable event.
 *   • v1 announce toast has no v2 plugin surface → shared/notify log line
 *     (OCP-V2-GAP: TUI notification domain absent from the v2 Context).
 *
 * Mode storage: `autoAdvisorMode` field in the project-level .ocp/ocp.json —
 * project-level only (read + write); default is off.
 */

import type { Plugin } from "@opencode/plugin"
import { commandArgumentText, type V2Session } from "./shared/agent-scope"
import { COMMAND_NAME, setProjectDir } from "./auto-advisor/auto-advisor-config"
import { makeCommandHandler } from "./auto-advisor/auto-advisor-mode-tracker"
import { makeFullInjectHook } from "./auto-advisor/auto-advisor-full-inject"
import { makeSystemHook } from "./auto-advisor/auto-advisor-system-inject"
import { makeToolGuardHook } from "./auto-advisor/auto-advisor-tool-guard"

export const AutoAdvisorModePlugin: Plugin.Plugin = {
  id: "opencode-prime.auto-advisor-mode",
  async setup(ctx) {
    // Mode is project-level: pin state/config paths to this project's directory.
    setProjectDir(ctx.location.directory)
    const session = ctx.session as unknown as V2Session

    const context = await ctx.session.hook("context", (e) =>
      makeSystemHook(session)({
        agent: e.agent,
        system: e.system,
        sessionID: e.sessionID,
      }),
    )
    const before = await ctx.tool.hook("execute.before", (e) =>
      makeToolGuardHook()({ tool: e.tool, sessionID: e.sessionID, input: e.input }),
    )
    const after = await ctx.tool.hook("execute.after", (e) =>
      makeFullInjectHook()({
        tool: e.tool,
        sessionID: e.sessionID,
        input: e.input,
        status: e.status,
        result: e.status === "completed" ? (e.result as never) : undefined,
      }),
    )
    const commands = await ctx.command.transform((editor) => {
      const handler = makeCommandHandler()
      editor.add({
        name: COMMAND_NAME,
        description: "Switch auto-advisor mode (off | lite | full)",
        execute: async (invocation) => {
          await handler({
            arguments: commandArgumentText(invocation.prompt?.text, COMMAND_NAME),
            sessionID: invocation.sessionID,
          })
        },
      })
    })

    return async () => {
      await Promise.allSettled([context.dispose(), before.dispose(), after.dispose(), commands.dispose()])
    }
  },
}

export default AutoAdvisorModePlugin
