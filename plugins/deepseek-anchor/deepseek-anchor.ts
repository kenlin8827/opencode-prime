/**
 * DeepSeek Anchor Plugin — corrects LR (Likelihood Ranking) alignment bias in DeepSeek V4 Pro.
 *
 * DeepSeek V4 Pro's likelihood ranking prefers shallow tool-invoking trajectories ("Let me...")
 * over deep reasoning trajectories ("We need...") when the full tool set is visible. This plugin
 * injects a reasoning anchor into the system prompt for DeepSeek models, forcing them to engage
 * in deeper reasoning before tool invocation.
 *
 * V2 hook mapping (v1 → v2):
 *   • experimental.chat.system.transform → ctx.session.hook("context");
 *     `e.model` (Model.Ref {id, providerID}) replaces v1 input.model —
 *     target detection tests providerID and model id (v1's api.id had no
 *     separate v2 field; the id/providerID pair carries the same signal).
 *   • command.execute.before + config-hook registration → the command is
 *     plugin-owned (empty v1 template) → ctx.command.transform(editor.add).
 *   • event session.deleted cleanup → ctx.event.subscribe for-await loop
 *     (event payload `data.sessionID`; v1's properties.info.id path kept
 *     as a compatibility read).
 *   • tool.execute.before guard → ctx.tool.hook("execute.before"); the
 *     deliberate throw (HARD RULE block) stays legal — execute.before is
 *     the one hook allowed to reject.
 *
 * - Only activates for DeepSeek V4 Pro (the model with the observed LR bias);
 *   other DeepSeek models (deepseek-v4-flash, deepseek-chat, ...) are no-ops
 * - Cache-friendly: injects once per session (tracked in memory; the v2
 *   context hook rebuilds e.system per assembly)
 * - No-op for non-target models (perfect compatibility)
 *
 * Reference:
 * - dsh-anchored-standard: https://github.com/xiaobright/dsh-anchored-standard
 * - Issue #11: Tool schema is the decisive variable for DeepSeek's first-request trajectory.
 */

// -- State tracking ----------------------------------------------------------
//
// IMPORTANT: the host rebuilds the system prompt from scratch for every model
// request — e.system never contains fragments injected on a previous step.
// Detecting "already anchored" via the MARKER in the incoming system
// therefore never fires in production, and relying on it leaves the tool
// block armed forever (the model sees HARD RULE errors on every tool call and
// concludes it has no tool capability). Track state per session in memory.
//
const MARKER = "[DEEPSEEK REASONING ANCHOR]"

// Only DeepSeek V4 Pro exhibits the observed LR alignment bias; the anchor
// must NOT fire for other DeepSeek models (deepseek-v4-flash, deepseek-chat),
// which would pay the first-turn latency cost without the benefit. Tolerates
// separator variants (deepseek_v4_pro, deepseek v4 pro) case-insensitively.
const TARGET_MODEL_PATTERN = /deepseek[-_ ]?v4[-_ ]?pro/i

// The anchor prompt fragment — guides DeepSeek through a reasoning checklist
// before any tool invocation.
//
// NOTE: Use explicit \n escapes (not a template literal with a leading real
// newline) so the fragment starts with exactly "\n---\n..." — a leading
// real newline from a backtick-newline would create a double newline and
// make the fragment harder to reason about for cache byte-identity.
const ANCHOR_PROMPT = `\n---\n${MARKER}\n\n**Session anchor** — before your very first turn, you MUST:\n1. Restate the goal (what, not how).\n2. List 2-3 key constraints/assumptions.\n3. State your intended approach in one sentence.\n\nHARD RULE: You MUST NOT invoke any tool until you have completed steps 1-3.\nViolating this order will result in failure.\n`

import { Plugin } from "@opencode/plugin"
import { commandArgumentText, scopedForAgent, type V2Session } from "../shared/agent-scope"
import { systemTexts } from "../shared/plugin-scope"
import { isEnabled, COMMAND_NAME } from "./deepseek-anchor-config"
import { makeCommandHandler } from "./deepseek-anchor-command"

// -- System prompt helpers ---------------------------------------------------

function hasMarker(system: Array<unknown>): boolean {
  return systemTexts(system).some((s) => s.includes(MARKER))
}

/** Strip everything from the first MARKER occurrence onward in each fragment. */
function stripMarker(system: Array<unknown>): boolean {
  let changed = false
  for (let i = 0; i < system.length; i++) {
    const entry = system[i]
    const text = typeof entry === "string" ? entry : (entry as { text?: string } | undefined)?.text
    if (text === undefined) continue
    const idx = text.indexOf(MARKER)
    if (idx === -1) continue
    if (entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string")
      (entry as { text: string }).text = text.substring(0, idx)
    else system[i] = text.substring(0, idx)
    changed = true
  }
  return changed
}

/** Append the ANCHOR_PROMPT to every text fragment in the system array. */
function appendAnchor(system: Array<unknown>): boolean {
  let appended = false
  for (let i = 0; i < system.length; i++) {
    const entry = system[i]
    const text = typeof entry === "string" ? entry : (entry as { text?: string } | undefined)?.text
    if (text === undefined) continue
    if (entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string")
      (entry as { text: string }).text = text + ANCHOR_PROMPT
    else system[i] = text + ANCHOR_PROMPT
    appended = true
  }
  return appended
}

// Sessions where the anchor text has already been injected (anchor applies to
// the first turn only; later steps/turns keep the system prompt untouched so
// the provider's prompt-cache stays warm).
const injectedSessions = new Set<string>()

// Sessions currently in the anchored generation: tool execute.before blocks
// tool calls until the next context hook runs (i.e. the next generation
// step), at which point the block is lifted.
const anchoredSessions = new Set<string>()

/** Pure target-model check — exported for unit tests. V2 Model.Ref carries
 *  {id, providerID}; v1 had providerID/modelID/api.id. */
export function isTargetModel(model: { id?: string; providerID?: string } | null | undefined): boolean {
  if (!model) return false
  return [model.providerID ?? "", model.id ?? ""].some((id) => TARGET_MODEL_PATTERN.test(id))
}

/**
 * Best-effort cleanup so the in-memory sets don't grow unbounded.
 * Subagent filtering is handled by the scope policy — no local session
 * tracking needed. Exported so the event loop in setup() and unit tests
 * drive the SAME handler. V2 durable event shape: `data.sessionID`;
 * the v1 `properties.info.id` path is kept as a compatibility read.
 */
export function handleAnchorEvent(event: unknown): void {
  const ev = event as { type?: string; data?: { sessionID?: string }; properties?: { info?: { id?: string } } }
  const id = ev?.data?.sessionID ?? ev?.properties?.info?.id
  if (ev?.type === "session.deleted" && id) {
    injectedSessions.delete(id)
    anchoredSessions.delete(id)
  }
}

// Contract: deepseek-anchor MUST NOT fire for subagent sessions.
// Rationale: the plugin blocks tool calls for the first turn to force a
// reasoning pass; if a subagent inherits that block, its dispatched task
// cannot execute any tool and the parent session hangs.
//
// Enforcement (single source of truth: plugin-scope.json policy):
//   - plugin-scope.json `*` deny = ["lite", "utility", "subagent:*"]
//     applies because deepseek-anchor has no per-plugin override.
//   - the context hook below calls scopedForAgent(); a subagent state is
//     detected via parentID and returns false → early return → anchor never
//     injected, so `anchoredSessions` never holds a subagent ID.
//   - execute.before only checks `anchoredSessions.has(sessionID)`, which is
//     therefore automatically inert for subagents — no local check needed.
// Do NOT add a bypass for subagents; if the gate ever needs tuning, edit
// plugin-scope.json, not this file.

export const DeepSeekAnchorPlugin = Plugin.define({
  id: "deepseek-anchor",
  async setup(ctx) {
    // Note: no setProjectDir() — deepseek-anchor config is global (user
    // preference, follows the user), not project-scoped.
    const session = ctx.session as unknown as V2Session
    const abort = new AbortController()

    const commands = await ctx.command.transform((editor) => {
      const handler = makeCommandHandler(session)
      editor.add({
        name: COMMAND_NAME,
        description: "Switch DeepSeek anchor mode (on | off)",
        execute: async (invocation) => {
          await handler({
            arguments: commandArgumentText(invocation.prompt?.text, COMMAND_NAME),
            sessionID: invocation.sessionID,
          })
        },
      })
    })

    const context = await ctx.session.hook("context", async (e) => {
      const system = Array.isArray(e.system) ? e.system : []
      try {
        // Lite mode: bare-prompt contract — no session anchor for @lite.
        if (!(await scopedForAgent(e, "deepseek-anchor", session))) return

        // ── Cache-friendly strip: if the plugin is disabled but a stale
        // MARKER from a previous turn is still in the system prompt, strip
        // it so the prompt is clean. This is the only case where we modify
        // e.system when disabled — after the strip, subsequent turns are
        // byte-identical no-ops (same strategy as auto-advisor).
        if (!isEnabled()) {
          if (hasMarker(system)) stripMarker(system)
          return
        }

        // Model detection: only activate for DeepSeek V4 Pro. providerID
        // alone (e.g. "deepseek") is NOT sufficient — the model id must
        // match too (isTargetModel tests both fields).
        if (!isTargetModel(e.model as { id?: string; providerID?: string } | undefined)) return

        const sessionID = e.sessionID
        if (!sessionID) return

        // Anchor already injected earlier in this session: we are past the
        // anchored generation. Lift the tool block and leave the system
        // prompt byte-identical so the prompt-cache stays warm.
        if (injectedSessions.has(sessionID)) {
          anchoredSessions.delete(sessionID)
          return
        }

        // First injection. Append the anchor to every system text part,
        // then arm the tool block for this generation step only.
        appendAnchor(system)
        injectedSessions.add(sessionID)
        anchoredSessions.add(sessionID)
      } catch {
        // Fail-open: an injector throw must never abort the request flow.
      }
    })

    const toolGuard = await ctx.tool.hook("execute.before", (e) => {
      // Check if the plugin is enabled
      if (!isEnabled()) return

      // If this session is in the anchored generation, block all tool calls.
      // Subagent sessions never reach `anchoredSessions` (the context hook is
      // gated by plugin-scope.json), so the block is inert for them.
      // execute.before MAY deliberately reject via throw — this is the
      // blocking mechanism and must propagate (not wrapped fail-open).
      const sessionID = e.sessionID as string | undefined
      const toolName = e.tool
      if (sessionID && anchoredSessions.has(sessionID)) {
        // Exception: allow these base tools if needed, otherwise leave empty to block all.
        const allowedTools = new Set<string>([]) // e.g. "str_replace_editor", "bash"
        if (toolName && !allowedTools.has(toolName)) {
          throw new Error(
            `[DEEPSEEK ANCHOR] HARD RULE violated: You MUST NOT invoke tools during your first turn.\n` +
            `Restate the goal, list constraints, state your approach—then tools will open on the next turn.`,
          )
        }
      }
    })

    // Event loop: session teardown cleanup (handler shared with tests).
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: abort.signal })) {
          handleAnchorEvent(ev)
        }
      } catch {
        // Subscription died with the server — process state goes with it.
      }
    })()

    return async () => {
      abort.abort()
      await Promise.allSettled([commands.dispose(), context.dispose(), toolGuard.dispose()])
    }
  },
})

export default DeepSeekAnchorPlugin
