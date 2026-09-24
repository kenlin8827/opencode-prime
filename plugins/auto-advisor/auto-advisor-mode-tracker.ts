/**
 * Command handler — `/auto-advisor <mode>`.
 * V2: registered through ctx.command.transform in auto-advisor-mode.ts
 * (v1 equivalent: the `config` hook + command.execute.before).
 * One command, argument selects mode (off/lite/full).
 *
 *   /auto-advisor lite  → state=lite
 *   /auto-advisor full  → state=full
 *   /auto-advisor off   → state=off
 *   /auto-advisor       → no-op (no mode given)
 *
 * Feedback stays on the announce surface (v1: toast; v2: OCP-V2-GAP —
 * shared/notify.ts logs, no TUI surface exists for plugins).
 */

import { makeRuntimeLogger } from "../shared/notify"
import { announceSwitch } from "./auto-advisor-announce"
import { parseModeArg, setMode } from "./auto-advisor-config"
import { clearAutoAnswerCounts, clearAutoAnswerSessions } from "./auto-advisor-runtime"

const log = makeRuntimeLogger("auto-advisor-mode")

/** V2 command handler — returning normally consumes the command (v1's
 *  handled()/empty-204 throw). Fail-open: an announce error must never
 *  break the switch. */
export function makeCommandHandler() {
  return async (input: { arguments?: string; sessionID?: string }): Promise<void> => {
    try {
      const mode = parseModeArg(input.arguments)
      if (!mode) return
      const written = setMode(mode)
      clearAutoAnswerCounts()
      clearAutoAnswerSessions()
      if (written) {
        await log("info", `mode=${mode.toUpperCase()} — project .ocp/ocp.json written`)
      } else {
        // Read-only project dir or similar — never crash the command.
        await log("warn", `mode=${mode.toUpperCase()} — project config write failed (project dir not writable)`)
      }
      await announceSwitch(mode)
    } catch {
      // Fail-open: the mode toggle itself is best-effort UX.
    }
  }
}
