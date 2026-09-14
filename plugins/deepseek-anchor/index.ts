/**
 * DeepSeek Anchor Plugin — corrects LR (Likelihood Ranking) alignment bias in DeepSeek V4 Pro.
 *
 * DeepSeek V4 Pro's likelihood ranking prefers shallow tool-invoking trajectories ("Let me...")
 * over deep reasoning trajectories ("We need...") when the full tool set is visible.
 * This plugin injects a reasoning anchor into the system prompt for DeepSeek models,
 * forcing them to engage in deeper reasoning before tool invocation.
 *
 * Hook: experimental.chat.system.transform
 * - Only activates for DeepSeek V4 Pro (the model with the observed LR bias);
 *   other DeepSeek models (deepseek-v4-flash, deepseek-chat, ...) are no-ops
 * - Cache-friendly: injects once per session (tracked in memory, since
 *   OpenCode rebuilds output.system fresh on every generation step)
 * - No-op for non-target models (perfect compatibility)
 *
 * Reference:
 * - dsh-anchored-standard: https://github.com/xiaobright/dsh-anchored-standard
 * - Issue #11: Tool schema is the decisive variable for DeepSeek's first-request trajectory.
 */

// -- State tracking ----------------------------------------------------------
//
// IMPORTANT: OpenCode rebuilds the system prompt from scratch before every
// generation step — output.system never contains fragments injected on a
// previous step. Detecting "already anchored" via the MARKER in the incoming
// system therefore never fires in production, and relying on it leaves the
// tool block armed forever (the model sees HARD RULE errors on every tool
// call and concludes it has no tool capability). Track state per session in
// memory instead.
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

import type { Plugin } from "@opencode-ai/plugin"
import { HttpServerResponse } from "effect/unstable/http"
import { isEnabled, COMMAND_NAME } from "./deepseek-anchor-config"
import { makeCommandHook } from "./deepseek-anchor-command"
import { scoped } from "../shared/plugin-scope"

// -- System prompt helpers (same pattern as auto-advisor) ----------------

function hasMarker(system: string[]): boolean {
  return system.some((s) => typeof s === "string" && s.includes(MARKER))
}

/** Strip everything from the first MARKER occurrence onward in each fragment. */
function stripMarker(system: string[]): boolean {
  let changed = false
  for (let i = 0; i < system.length; i++) {
    const s = system[i]
    if (typeof s !== "string") continue
    const idx = s.indexOf(MARKER)
    if (idx === -1) continue
    system[i] = s.substring(0, idx)
    changed = true
  }
  return changed
}

/** Append the ANCHOR_PROMPT to every string fragment in the system array. */
function appendAnchor(system: string[]): boolean {
  let appended = false
  for (let i = 0; i < system.length; i++) {
    const s = system[i]
    if (typeof s !== "string") continue
    system[i] = s + ANCHOR_PROMPT
    appended = true
  }
  return appended
}

// Sessions where the anchor text has already been injected (anchor applies to
// the first turn only; later steps/turns keep the system prompt untouched so
// the provider's prompt-cache stays warm).
const injectedSessions = new Set<string>()

// Sessions currently in the anchored generation: tool.execute.before blocks
// tool calls until the next system.transform runs (i.e. the next generation
// step), at which point the block is lifted.
const anchoredSessions = new Set<string>()

// Contract: deepseek-anchor MUST NOT fire for subagent sessions.
// Rationale: the plugin blocks tool calls for the first turn to force a
// reasoning pass; if a subagent inherits that block, its dispatched task
// cannot execute any tool and the parent session hangs.
//
// Enforcement (single source of truth: `scoped()`):
//   - plugin-scope.json `*` deny = ["lite", "utility", "subagent:*"]
//     applies because deepseek-anchor has no per-plugin override.
//   - `experimental.chat.system.transform` line below calls
//     `scoped(...)`; a subagent state is detected via parentID and
//     returns false → early return → anchor never injected, so
//     `anchoredSessions` never holds a subagent ID.
//   - `tool.execute.before` only checks `anchoredSessions.has(sessionID)`,
//     which is therefore automatically inert for subagents — no local
//     subagent check needed here.
// Do NOT add a bypass for subagents; if the gate ever needs tuning, edit
// plugin-scope.json, not this file.

// OpenCode's command hook has no cancel/noReply output. Throwing a raw
// Effect response is handled by OpenCode's HTTP layer as an empty
// successful command — the LLM never sees an empty prompt.
const handled = (): never => {
  throw HttpServerResponse.empty({ status: 204 })
}

export const DeepSeekAnchorPlugin: Plugin = async ({ client, directory }) => {
  // Note: no setProjectDir() — deepseek-anchor config is global (user
  // preference, follows the user), not project-scoped (commit convention,
  // env file protection). `directory` stays in the destructuring because
  // future hooks (e.g. session-scoped UI) may still need it.
  return {
    config: async (cfg) => {
      cfg.command ??= {}
      cfg.command[COMMAND_NAME] = {
        template: "",
        description: "Switch DeepSeek anchor mode (on | off)",
      }
    },
    "command.execute.before": makeCommandHook(client, handled),
    event: async (input: { event: any }) => {
      // Best-effort cleanup so the in-memory sets don't grow unbounded.
      // Subagent filtering is handled by `scoped()` (plugin-scope.json) —
      // no local session tracking needed.
      const info = input.event?.properties?.info
      if (input.event?.type === "session.deleted" && info?.id) {
        injectedSessions.delete(info.id)
        anchoredSessions.delete(info.id)
      }
    },
    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system: string[] },
    ) => {
      // Lite mode: bare-prompt contract — no session anchor for @lite.
      if (!await scoped(input, output.system, "deepseek-anchor", client)) return

      // ── Cache-friendly strip: if the plugin is disabled but a stale
      // MARKER from a previous turn is still in the system prompt, strip
      // it so the prompt is clean. This is the only case where we modify
      // output.system when disabled — after the strip, subsequent turns
      // are byte-identical no-ops (same strategy as auto-advisor).
      if (!isEnabled()) {
        if (hasMarker(output.system)) stripMarker(output.system)
        return
      }

      // Model detection: only activate for DeepSeek V4 Pro. providerID alone
      // (e.g. "deepseek") is NOT sufficient — the model ID must match.
      const model = (input as any).model
      if (!model) {
        return
      }

      const providerID = model.providerID ?? ""
      const modelID = model.modelID ?? ""
      const apiID = model.api?.id ?? ""

      const isTargetModel = [providerID, modelID, apiID].some((id) =>
        TARGET_MODEL_PATTERN.test(id),
      )

      if (!isTargetModel) {
        return
      }

      const sessionID = input.sessionID
      if (!sessionID) return

      // Anchor already injected earlier in this session: we are past the
      // anchored generation. Lift the tool block and leave the system prompt
      // byte-identical so the prompt-cache stays warm.
      if (injectedSessions.has(sessionID)) {
        anchoredSessions.delete(sessionID)
        return
      }

      // First injection. Append the anchor to every system string fragment,
      // then arm the tool block for this generation step only.
      appendAnchor(output.system)
      injectedSessions.add(sessionID)
      anchoredSessions.add(sessionID)
    },

    "tool.execute.before": async (input: unknown) => {
      // Check if the plugin is enabled
      if (!isEnabled()) {
        return
      }

      // Extract session ID and tool name from the hook input
      const sessionID = (input as any)?.sessionID as string | undefined
      const toolName = (input as any)?.tool as string | undefined

      // Subagent sessions never reach `anchoredSessions` (the system-transform
      // hook is gated by `scoped()`, which denies subagent:*), so the block
      // below is automatically inert for them — no local check needed.

      // If this session is in the anchored generation, block all tool calls.
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
    },
  }
}
