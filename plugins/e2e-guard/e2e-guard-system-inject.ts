/**
 * Hook: experimental.chat.system.transform — inject the E2E guard protocol
 * (loaded from e2e-guard-protocol.md) into the system prompt when the
 * switch is on AND the agent is primary; strip any stale marker otherwise.
 *
 * Scoped to Primary Delivery Agents only (code, build, architect, or root orchestrator session):
 *   - Subagents (with parentID or specialized non-delivery agents) do not have
 *     interactive `ask` tool permissions and do not perform git commit/handoff,
 *     so injecting E2E protocol into them would cause noise and context pollution.
 *
 * Opencode runtime note (verified 2026-09-11, see ADR 0002): the
 * runtime rebuilds `output.system` per chat request. See adr-guard
 * for the full Scenario A / B rationale — same fragment-cache +
 * defensive-strip pattern applies here.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import { scoped } from "../shared/plugin-scope"
import { appendBlock } from "../shared/system-block"
import { isEnabled } from "./e2e-guard-config"
import { getGuardPrompt, MARKER } from "./e2e-guard-instructions"

// Known primary delivery agents with interaction & commit capabilities
const PRIMARY_AGENTS = new Set(["code", "build", "architect", "general", ""])

export function isPrimaryAgent(input?: { agent?: string; parentID?: string }): boolean {
  if (!input) return true
  // Subagents have parentID set
  if (input.parentID) return false
  const agent = (input.agent ?? "").toLowerCase()
  return PRIMARY_AGENTS.has(agent)
}

function hasAnyMarker(system: string[]): boolean {
  return system.some((s) => typeof s === "string" && s.includes(MARKER))
}

function stripMarker(system: string[]): boolean {
  let changed = false
  for (let i = 0; i < system.length; i++) {
    const s = system[i]
    if (typeof s !== "string") continue
    const idx = s.indexOf(MARKER)
    if (idx === -1) continue
    // Trim the separator whitespace that preceded the marker so the
    // original prompt restores without leftover blank space.
    system[i] = s.substring(0, idx).replace(/\s+$/, "")
    changed = true
  }
  return changed
}

/** Cached rendered fragment. Same rationale as adr-guard's
 * `cachedPrompt` — the protocol body is constant across turns;
 * module-level cache avoids re-concat every chat. */
let cachedPrompt: string | undefined

export function makeSystemHook(client: PluginInput["client"]) {
  const log = (level: "info" | "warn", message: string) =>
    client.app.log({ body: { service: "e2e-guard", level, message } })

  return async (input: { agent?: string; parentID?: string; sessionID?: string } | undefined, output: { system: string[] }) => {
    // Lite mode: bare-prompt contract — no e2e protocol for @lite.
    if (!await scoped(input, output.system, "e2e-guard", client)) return

    // Defensive strip — see adr-guard rationale (Scenario A/B).
    const stripped = hasAnyMarker(output.system) ? stripMarker(output.system) : false

    if (!isEnabled() || !isPrimaryAgent(input)) {
      if (stripped) await log("info", "system prompt: stale e2e-guard block stripped")
      return
    }

    if (!cachedPrompt) cachedPrompt = getGuardPrompt()
    const changed = appendBlock(output.system, cachedPrompt)
    if (changed) await log("info", "system prompt: e2e-guard protocol injected (primary agent)")
  }
}