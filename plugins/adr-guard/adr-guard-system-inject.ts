/**
 * Hook: experimental.chat.system.transform — inject the ADR iron-law
 * protocol (loaded from adr-guard-protocol.md) into the system prompt
 * when the switch is on; strip any stale marker when it is off.
 *
 * Opencode runtime note (verified 2026-09-11, see ADR 0002): the
 * runtime rebuilds `output.system` per chat request — output.system
 * never contains fragments injected on a previous step. Behavior:
 *
 *   - on + fresh prompt → strip no-op + inject → marker present.
 *   - on + persistent prompt (Scenario B hypothetical) → strip stale
 *     + re-inject → byte-identical to previous turn → provider cache
 *     hit. The defensive strip is what keeps the cache stable under
 *     a future Scenario-B runtime.
 *   - off + fresh prompt → strip no-op + no inject → prompt clean.
 *   - off + persistent prompt → strip stale → prompt clean.
 *
 * The fragment is cached in `cachedPrompt` so we don't re-concat the
 * ~few-KB body every chat. The protocol body never changes during a
 * session; cache invalidation is unnecessary within a process lifetime.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import { scoped } from "../shared/plugin-scope"
import { appendBlock } from "../shared/system-block"
import { isEnabled } from "./adr-guard-config"
import { getGuardPrompt, MARKER } from "./adr-guard-instructions"
import { makeLogger } from "./adr-guard-runtime"

type Log = ReturnType<typeof makeLogger>

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

/** Cached rendered fragment. The protocol body is constant across
 * turns, so caching avoids re-concatenating the fragment on every
 * chat. Module-level: the on/off switch is a project-level
 * preference. */
let cachedPrompt: string | undefined

export function makeSystemHook(client: PluginInput["client"]) {
  const log: Log = makeLogger(client, "adr-guard")

  return async (input: { sessionID?: string } | undefined, output: { system: string[] }) => {
    // Lite mode: bare-prompt contract — no iron-law protocol for @lite.
    if (!await scoped(input, output.system, "adr-guard", client)) return

    // Defensive strip — correct under Scenario B (hypothetical
    // prompt-persistence), no-op under Scenario A (verified current
    // runtime, see ADR 0002). Cheap substring scan; keeps the
    // behavior correct if opencode ever changes to preserve
    // output.system across turns.
    const hadMarker = hasAnyMarker(output.system)
    const stripped = hadMarker ? stripMarker(output.system) : false

    if (!isEnabled()) {
      if (stripped) await log("info", "system prompt: stale iron-law block stripped (state=off)")
      return
    }

    if (!cachedPrompt) cachedPrompt = getGuardPrompt()
    const changed = appendBlock(output.system, cachedPrompt)
    if (changed) await log("info", "system prompt: iron-law protocol injected (state=on)")
  }
}