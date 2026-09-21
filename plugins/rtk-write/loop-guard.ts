/**
 * Loop guard — the automatic loop breaker for rtk-write.
 *
 * Failure mode being fixed: RTK compression is lossy, so a model that needs
 * the elided data re-runs the same command. The rewrite cache serves the
 * identical compressed output every time, and the model loops forever.
 *
 * Two bypass rules, cheapest first:
 *   1. sticky elision — once a command's output was elided (RTK's recovery
 *      marker), that command passes through raw for the rest of the session.
 *      This is the precise loop signal and keeps compression working for
 *      commands that merely repeat for legitimate reasons (re-checking after
 *      edits).
 *   2. threshold — a fallback for lossy-but-unmarked output: after
 *      `loopThreshold` executions a command also passes through raw.
 *
 * Rule 2 is also the safety net if RTK ever changes its elision wording: the
 * loop breaker degrades to the threshold instead of silently reverting to the
 * original infinite loop.
 *
 * State is two-tiered so that memory bounds cannot undo a decision:
 *   - `counts`   — partial execution counts, bounded LRU. Evicting one only
 *                  loses progress toward the threshold, which is harmless.
 *   - `bypassed` — commands that must not be rewritten again (elided, or
 *                  threshold reached), bounded by a much larger cap. This is
 *                  the tier that breaks loops, so it is trimmed last and only
 *                  under pathological load (thousands of distinct looping
 *                  commands in a single session).
 */
import { normalizeCommand, type RtkWriteOptions } from "./config";

/** Cap on tracked sessions per process — opencode plugin processes are
 * long-lived; drop the oldest session (insertion order) when exceeded. */
const MAX_TRACKED_SESSIONS = 64;
/** Cap on distinct commands with a partial count, per session. */
const MAX_COUNTED_COMMANDS = 1024;
/** Cap on permanently bypassed commands, per session. Far above any realistic
 * number of distinct commands that repeat enough to loop. */
const MAX_BYPASSED_COMMANDS = 4096;

interface SessionState {
  counts: Map<string, number>;
  bypassed: Set<string>;
}

/** Drop oldest-inserted entries until the collection is within `max`.
 * Works for both Map and Set (both expose size/keys/delete). */
function trimOldest(collection: Map<string, unknown> | Set<string>, max: number): void {
  while (collection.size > max) {
    const oldest = collection.keys().next().value;
    if (oldest === undefined) break;
    collection.delete(oldest);
  }
}

export interface LoopGuard {
  /**
   * Record one execution of `command` in `sessionID` and report whether the
   * rewrite should be bypassed this time.
   */
  shouldBypass(sessionID: string, command: string): boolean;
  /** Record that `command` produced elided output in `sessionID`. */
  markElided(sessionID: string, command: string): void;
}

export function createLoopGuard(options: Pick<RtkWriteOptions, "loopThreshold">): LoopGuard {
  const threshold = options.loopThreshold;
  const sessions = new Map<string, SessionState>();

  function stateFor(sessionID: string): SessionState {
    let state = sessions.get(sessionID);
    if (!state) {
      if (sessions.size >= MAX_TRACKED_SESSIONS) {
        const oldest = sessions.keys().next().value;
        if (oldest !== undefined) sessions.delete(oldest);
      }
      state = { counts: new Map(), bypassed: new Set() };
      sessions.set(sessionID, state);
    }
    return state;
  }

  /** Promote to the non-rewrite tier and stop counting the command. */
  function bypassForever(state: SessionState, normalized: string): void {
    state.counts.delete(normalized);
    state.bypassed.add(normalized);
    trimOldest(state.bypassed, MAX_BYPASSED_COMMANDS);
  }

  return {
    shouldBypass(sessionID: string, command: string): boolean {
      const normalized = normalizeCommand(command);
      const state = stateFor(sessionID);
      if (state.bypassed.has(normalized)) return true;
      if (threshold <= 0) return false;
      const count = (state.counts.get(normalized) ?? 0) + 1;
      if (count >= threshold) {
        bypassForever(state, normalized);
        return true;
      }
      state.counts.set(normalized, count);
      trimOldest(state.counts, MAX_COUNTED_COMMANDS);
      return false;
    },

    markElided(sessionID: string, command: string): void {
      bypassForever(stateFor(sessionID), normalizeCommand(command));
    },
  };
}
