/**
 * Hook: experimental.chat.system.transform — inject the ADR system hint
 * + live runtime config into the system prompt on EVERY chat request.
 * Stale markers are stripped defensively on every turn.
 *
 * Phase 7.8: the full protocol body is NO LONGER injected here — it
 * lives as `skills/adr-protocol/SKILL.md` and the LLM loads it on
 * demand via `read_file`. This file now injects only:
 *
 *   1. **Hint block** (`[ADR-GUARD]`) — ~117 tokens, advertises the
 *      engine + commands + points at the protocol skill. Stable across
 *      the entire session.
 *
 *   2. **Runtime config block** (`[ADR-CONFIG-RUNTIME]`) — ~192 tokens,
 *      re-rendered every chat from `.ocp/ocp.json`. Honors mid-session
 *      `/adr config <key> <value>` edits without restart.
 *
 * Opencode runtime note (verified 2026-09-11, see ADR 0002): the
 * runtime rebuilds `output.system` per chat request — output.system
 * never contains fragments injected on a previous step. Behavior:
 *
 *   - fresh prompt → strip no-op + inject hint + inject config.
 *   - persistent prompt (Scenario B hypothetical) → strip stale of
 *     both markers + re-inject → byte-identical hint prefix across
 *     turns → provider cache hit. The config block may shift byte-
 *     for-byte, but it's the LAST block — provider cache hits the
 *     stable hint prefix and only re-bills the trailing config delta.
 *
 * The iron-law switch `adrGuard` no longer affects prompt content —
 * it still controls the `tool.execute.before` commit guard
 * (`adr-tool-guard.ts`), but ON/OFF state is no longer surfaced
 * in the system prompt. Users discover the switch via `/adr help` or
 * the hint's command list.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import { scoped } from "../shared/plugin-scope"
import { appendBlock } from "../shared/system-block"
import {
  getAdrConfigRuntimeFragment,
  getGuardHintPrompt,
  MARKER_CONFIG,
  MARKER_HINT,
} from "./adr-instructions"
import { makeLogger } from "./adr-runtime"

type Log = ReturnType<typeof makeLogger>

/** Common prefix for all ADR markers we own. */
const ANY_MARKER = "[ADR-"

function hasAnyMarker(system: Array<unknown>): boolean {
  return system.some((s) => typeof s === "string" && s.includes(ANY_MARKER))
}

/** Strip every ADR block we own from `system` in place. Each injected
 *  fragment owns the span from its marker to the next ADR marker (or
 *  end of string) — fragments are appended sequentially at the tail —
 *  so cutting whole spans byte-restores the pre-injection prompt.
 *  Returns which markers were found. */
function stripAllMarkers(system: Array<unknown>): { hint: boolean; config: boolean } {
  const found = { hint: false, config: false }
  for (let i = 0; i < system.length; i++) {
    const raw = system[i]
    if (typeof raw !== "string") continue
    let s = raw
    for (;;) {
      // Locate the leftmost ADR marker and the span end (the next ADR
      // marker after it, or EOF). Re-scan each round because each cut
      // invalidates downstream offsets.
      const hi = s.indexOf(MARKER_HINT)
      const ci = s.indexOf(MARKER_CONFIG)
      if (hi === -1 && ci === -1) break
      let start: number
      let end: number
      let kind: "hint" | "config"
      if (hi === -1 || (ci !== -1 && ci < hi)) {
        start = ci
        kind = "config"
      } else {
        start = hi
        kind = "hint"
      }
      const nextMarker = kind === "hint" ? (ci > start ? ci : -1) : hi > start ? hi : -1
      end = nextMarker === -1 ? s.length : nextMarker
      // Trim the separator whitespace that preceded the marker so the
      // original prompt restores without leftover blank space.
      const head = s.substring(0, start).replace(/\s+$/, "")
      s = head + s.substring(end)
      found[kind] = true
    }
    system[i] = s
  }
  return found
}

export function makeSystemHook(client: PluginInput["client"]) {
  const log: Log = makeLogger(client, "adr")

  return async (input: { sessionID?: string } | undefined, output: { system: string[] }) => {
    // Lite mode: bare-prompt contract — no iron-law protocol for @lite.
    if (!await scoped(input, output.system, "adr", client)) return

    // Defensive strip — correct under Scenario B (hypothetical
    // prompt-persistence), no-op under Scenario A (verified current
    // runtime, see ADR 0002).
    const hadMarker = hasAnyMarker(output.system)
    if (hadMarker) stripAllMarkers(output.system)

    // 1. Hint block — ~117 tokens, stable for the whole session.
    //    appendBlock's marker-absence check keeps this idempotent
    //    within a turn.
    const hintPrompt = getGuardHintPrompt()
    const hintChanged = appendBlock(output.system, hintPrompt)
    if (hintChanged) await log("info", "system prompt: ADR hint injected")

    // 2. Runtime config block — re-rendered every turn from .ocp/ocp.json.
    //    No cache at this layer: a project edit or `/adr config <key>
    //    <value>` mid-session shows up on the next chat request.
    const configBlock = getAdrConfigRuntimeFragment()
    const configChanged = appendBlock(output.system, configBlock)
    if (configChanged) await log("info", "system prompt: runtime config block injected")
  }
}
