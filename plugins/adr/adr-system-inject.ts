/**
 * Hook: ctx.session.hook("context") — inject the ADR system hint
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
 * runtime rebuilds `e.system` per chat request — e.system
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

import { scopedForAgent, type V2Session } from "../shared/agent-scope"
import { systemTexts } from "../shared/plugin-scope"
import { appendBlock } from "../shared/system-block"
import {
  getAdrConfigRuntimeFragmentWithHistory,
  getGuardHintPrompt,
  MARKER_CONFIG,
  MARKER_HINT,
} from "./adr-instructions"
import { makeLogger } from "./adr-runtime"

type Log = ReturnType<typeof makeLogger>

/** Common prefix for all ADR markers we own — must cover both
 *  `[ADR]` (hint) and `[ADR-CONFIG-RUNTIME]` (config). The trailing `-`
 *  would miss the hint, so the prefix stops at `[ADR`. */
const ANY_MARKER = "[ADR"

function hasAnyMarker(system: Array<unknown>): boolean {
  return systemTexts(system).some(
    (s) => s.includes(MARKER_HINT) || s.includes(MARKER_CONFIG) || s.includes(ANY_MARKER),
  )
}

/** Read a system entry's text; supports v1 strings and v2 SystemPart objects. */
function entryText(entry: unknown): string | null {
  if (typeof entry === "string") return entry
  if (entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string")
    return (entry as { text: string }).text
  return null
}

function setEntryText(system: Array<unknown>, i: number, text: string): void {
  const entry = system[i]
  if (entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string")
    (entry as { text: string }).text = text
  else system[i] = text
}

/** Strip every ADR block we own from `system` in place. Each injected
 *  fragment owns the span from its marker to the next ADR marker (or
 *  end of string) — fragments are appended sequentially at the tail —
 *  so cutting whole spans byte-restores the pre-injection prompt.
 *  Returns which markers were found. */
function stripAllMarkers(system: Array<unknown>): { hint: boolean; config: boolean } {
  const found = { hint: false, config: false }
  for (let i = 0; i < system.length; i++) {
    const raw = entryText(system[i])
    if (raw === null) continue
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
    setEntryText(system, i, s)
  }
  return found
}

/** V2 "context" hook (replaces v1 experimental.chat.system.transform).
 *  Fail-open internally — a session-hook throw must never abort the flow.
 *  `session` (v2 ctx.session) is forwarded to the last-good history scan,
 *  which duck-types it and never throws. */
export function makeSystemHook(session: V2Session | undefined) {
  const log = makeLogger("adr")

  return async (e: { agent?: string | null; system?: Array<unknown>; sessionID?: string }): Promise<void> => {
    try {
      const system = Array.isArray(e.system) ? e.system : []
      // Lite mode: bare-prompt contract — no iron-law protocol for @lite.
      if (!(await scopedForAgent(e, "adr", session))) return

      // Defensive strip — correct under Scenario B (hypothetical
      // prompt-persistence), no-op under Scenario A (verified current
      // runtime, see ADR 0002).
      if (hasAnyMarker(system)) stripAllMarkers(system)

      // 1. Hint block — ~117 tokens, stable for the whole session.
      //    appendBlock's marker-absence check keeps this idempotent
      //    within a turn.
      const hintPrompt = getGuardHintPrompt()
      const hintChanged = appendBlock(system, hintPrompt)
      if (hintChanged) await log("info", "system prompt: ADR hint injected")

      // 2. Runtime config block — re-rendered every turn from .ocp/ocp.json.
      //    No cache at this layer: a project edit or `/adr config <key>
      //    <value>` mid-session shows up on the next chat request.
      //    On corrupt+Map-miss (restart) we low-frequency try to recover the
      //    last good block from the session history via shared/last-good.
      const configBlock = await getAdrConfigRuntimeFragmentWithHistory(session, e.sessionID)
      const configChanged = appendBlock(system, configBlock)
      if (configChanged) await log("info", "system prompt: runtime config block injected")
    } catch {
      // Fail-open: never abort a request over an injector.
    }
  }
}
