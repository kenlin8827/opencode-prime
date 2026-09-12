/**
 * Hook: experimental.chat.system.transform — inject the active-mode marker
 * and the advisor protocol (loaded from auto-advisor-protocol.md) into
 * the system prompt.
 *
 * Opencode runtime note (verified 2026-09-11, see ADR 0002): the
 * runtime rebuilds `output.system` per chat request — output.system
 * never contains fragments injected on a previous step. That means:
 *
 *   - The marker-presence fast-path from earlier revisions never fires
 *     in production — the prompt is always fresh, so we always inject.
 *   - Provider-side prompt-cache stays warm because the injected
 *     content is byte-identical across turns (mode unchanged → same
 *     fragment → same final system prompt → provider cache hit).
 *   - Per-turn cost is dominated by string concat + append. Cache the
 *     rendered fragment per mode so we don't re-concat ~8.7 KB on
 *     every chat. Mode rarely changes, so the cache hits almost
 *     every call.
 *
 * Same pattern as adr-guard / e2e-guard / project-manager (fragment
 * cache + always-inject when state says inject). The fragment-cache
 * pattern is mirrored after project-profiler's `injectedCwds` cache.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import type { AdvisorMode } from "./auto-advisor-config"
import { scoped } from "../shared/plugin-scope"
import { appendBlock } from "../shared/system-block"
import { getMode } from "./auto-advisor-config"
import { getAdvisorPrompt } from "./auto-advisor-instructions"
import { makeLogger } from "./auto-advisor-runtime"

type Log = ReturnType<typeof makeLogger>

/** Shared marker prefix across all three modes. MODE_MARKER entries
 * (`[AUTO-ADVISOR MODE: OFF]`, `[AUTO-ADVISOR MODE: LITE]`,
 * `[AUTO-ADVISOR MODE: FULL — ACTIVE NOW]`) all start with this
 * substring. Used for the defensive strip path. */
const MARKER_PREFIX = "[AUTO-ADVISOR MODE:"

function hasAnyMarker(system: string[]): boolean {
  return system.some((s) => typeof s === "string" && s.includes(MARKER_PREFIX))
}

/** Cut every `[AUTO-ADVISOR MODE: …]` block off `system`. Substring
 * match (not line-start regex) is sufficient because the marker
 * always appears at the start of an injected fragment; a substring
 * match preserves the historical behavior and matches the other
 * three plugins in this round (adr-guard / e2e-guard). */
function stripMarker(system: string[]): boolean {
  let changed = false
  for (let i = 0; i < system.length; i++) {
    const s = system[i]
    if (typeof s !== "string") continue
    const idx = s.indexOf(MARKER_PREFIX)
    if (idx === -1) continue
    system[i] = s.substring(0, idx).replace(/\s+$/, "")
    changed = true
  }
  return changed
}

/** Cached rendered fragment per mode. Module-level on purpose: the mode
 * is a project-level preference, not a per-cwd detection. Same pattern
 * as project-profiler's `injectedCwds` cache (different cache value:
 * full rendered text vs. profile key — both avoid per-turn work). */
let cachedPrompt: { mode: AdvisorMode; text: string } | undefined

/** Pure: is the cache entry for this mode? Returns a type predicate so
 * the call site narrows `cachedPrompt` to the non-undefined branch.
 * Exported for unit tests — the cache decision is just object
 * identity, kept pure for direct verification without the hook's I/O. */
export function isCachedForMode(
  cache: { mode: AdvisorMode; text: string } | undefined,
  mode: AdvisorMode,
): cache is { mode: AdvisorMode; text: string } {
  return cache?.mode === mode
}

export function makeSystemHook(client: PluginInput["client"]) {
  const log: Log = makeLogger(client, "auto-advisor-mode")

  return async (input: { sessionID?: string } | undefined, output: { system: string[] }) => {
    // Lite mode: bare-prompt contract — no advisor protocol for @lite.
    if (!await scoped(input, output.system, "auto-advisor", client)) return

    const mode = getMode()
    if (!isCachedForMode(cachedPrompt, mode)) {
      cachedPrompt = { mode, text: getAdvisorPrompt(mode) }
    }

    // Defensive strip — correct under Scenario B (hypothetical
    // prompt-persistence), no-op under Scenario A (verified current
    // runtime, see ADR 0002). Mirrors adr-guard / e2e-guard /
    // project-manager / project-profiler.
    if (hasAnyMarker(output.system)) stripMarker(output.system)

    // Always inject — under Scenario A the prompt is rebuilt fresh
    // each turn. Skipping would leave the LLM without the protocol
    // after the first turn.
    const changed = appendBlock(output.system, cachedPrompt.text)
    if (changed) await log("info", `system prompt: mode=${mode} injected`)
  }
}