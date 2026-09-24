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

import { Plugin } from "@opencode/plugin"
import { commandArgumentText, type V2Session } from "../shared/agent-scope"
import { makeCommandHandler } from "./adr-command"
import { ADR_COMMAND, COMMAND_NAME, setProjectDir } from "./adr-config"
import { makeSystemHook } from "./adr-system-inject"
import { makeToolGuardHook } from "./adr-tool-guard"
import { createCompactionRuntime } from "./adr-compaction-runtime"
import { createReadGuard } from "./adr-read-guard"

/** Join `output.parts` (v1 command-mutation channel) into prompt text. */
function partsText(parts: Array<unknown>): string {
  return parts
    .map((p) => (typeof p === "string" ? p : (p as { text?: unknown })?.text))
    .filter((t): t is string => typeof t === "string")
    .join("\n")
}

// V2 MAPPING NOTES (v1 → v2):
//   • `config` hook (template commands) + `command.execute.before` → the
//     two commands are plugin-OWNED → ctx.command.transform(editor.add)
//     for /adr plus the /adr-guard alias. v1 "handled" (throw empty-204)
//     = return from execute; v1 "continue" (template proceeded) /
//     output.parts mutation = session.prompt with the (mutated) text.
//   • `experimental.chat.system.transform` → "context" hook.
//   • `tool.execute.before` chain (maintenance → readGuard → commitGuard)
//     keeps v1 order; the deliberate throws are legal rejections on this
//     hook only. `tool.execute.after` → execute.after (question
//     authorization + receipt, see adr-compaction-runtime notes).
//   • `tool: {...}` registration → ctx.tool.transform(editor.add) with
//     options { codemode:false } (first-class model tools).
//   • `event` hook → ctx.event.subscribe for-await loop (session.deleted
//     cleanup), aborted on plugin cleanup.

export const AdrPlugin = Plugin.define({
  id: "adr",
  async setup(ctx) {
    // Switch is project-level: pin state/config paths to this project's directory.
    const directory = ctx.location.directory
    setProjectDir(directory)
    const session = ctx.session as unknown as V2Session
    const maintenance = createCompactionRuntime(directory, session)
    const command = makeCommandHandler()
    const commitGuard = makeToolGuardHook()
    const readGuard = createReadGuard(directory, session)
    const abort = new AbortController()

    const context = await ctx.session.hook("context", (e) => makeSystemHook(session)(e))
    // Tool execute.before: the guards' deliberate throws are the blocking
    // mechanism (execute.before is the one v2 hook allowed to reject).
    const before = await ctx.tool.hook("execute.before", async (e) => {
      await maintenance.before({ tool: e.tool, sessionID: e.sessionID, id: e.id, input: e.input })
      await readGuard({ tool: e.tool, sessionID: e.sessionID, agent: e.agent, input: e.input })
      await commitGuard({ tool: e.tool, input: e.input })
    })
    const after = await ctx.tool.hook("execute.after", (e) =>
      maintenance.after({
        tool: e.tool,
        sessionID: e.sessionID,
        id: e.id,
        input: e.input,
        status: e.status,
        result: e.status === "completed"
          ? (e.result as { content?: string; output?: { answers?: unknown } })
          : undefined,
      }),
    )
    // Tools: static payloads (schema + closures) — sync-cheap, idempotent.
    const tools = await ctx.tool.transform((editor) => {
      for (const payload of maintenance.toolPayloads) editor.add(payload as never)
    })
    // Commands: /adr (primary) + /adr-guard (iron-law switch alias).
    // Returns "handled" | "dispatched" for TEST OBSERVABILITY only (the v2
    // host ignores execute() return values): "handled" = command consumed
    // with no model turn (v1's 204 throw), "dispatched" = a model turn was
    // triggered (v1's template fall-through / output.parts injection).
    const runCommand = async (name: string, invocation: { sessionID: string; prompt: { text: string } }): Promise<"handled" | "dispatched"> => {
      const args = commandArgumentText(invocation.prompt?.text, name)
      const input = { command: name, arguments: args, sessionID: invocation.sessionID }
      const output: { parts: Array<unknown> } = { parts: [] }
      const m = await maintenance.command(input, output)
      if (m === "handled") return "handled"
      if (m === "continue") {
        const text = output.parts.length ? partsText(output.parts) : `/${name} ${args}`.trim()
        if (invocation.sessionID) await session.prompt?.({ sessionID: invocation.sessionID, text })
        return "dispatched"
      }
      const res = await command(input)
      // v1 parity: unhandled /adr input fell through to the template
      // "/adr $ARGUMENTS" (a model turn); /adr-guard always handled itself.
      if (res !== "handled" && name === ADR_COMMAND && invocation.sessionID) {
        await session.prompt?.({ sessionID: invocation.sessionID, text: `/${name} ${args}`.trim() })
        return "dispatched"
      }
      return "handled"
    }
    const commands = await ctx.command.transform((editor) => {
      editor.add({
        name: COMMAND_NAME,
        description:
          "Alias of /adr guard — toggle the ADR iron law for this project — every feat/refactor commit requires a new/updated ADR (on | off | reset | status)",
        execute: async (invocation) => {
          // Test-observability seam: the v2 host ignores execute() return
          // values, so surface the handled/dispatched status on the
          // invocation object for unit tests (v1's 204-vs-fall-through).
          ;(invocation as { __status?: string }).__status = await runCommand(COMMAND_NAME, invocation)
        },
      })
      editor.add({
        name: ADR_COMMAND,
        description:
          "Manage Architecture Decision Records and the commit guard (new | supersede | context | compaction | tree | check | guard | help)",
        execute: async (invocation) => {
          // Test-observability seam: the v2 host ignores execute() return
          // values, so surface the handled/dispatched status on the
          // invocation object for unit tests (v1's 204-vs-fall-through).
          ;(invocation as { __status?: string }).__status = await runCommand(ADR_COMMAND, invocation)
        },
      })
    })
    // Event loop: session teardown cleanup for maintenance state.
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: abort.signal })) {
          await maintenance.event(ev)
        }
      } catch {
        // Subscription died with the server — plugin state goes with it.
      }
    })()

    return async () => {
      abort.abort()
      await Promise.allSettled([context.dispose(), before.dispose(), after.dispose(), tools.dispose(), commands.dispose()])
    }
  },
})

export default AdrPlugin
