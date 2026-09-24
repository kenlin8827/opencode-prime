/**
 * Hook: tool.execute.before — guard duty:
 *
 *   1. Full-mode auto-answer enforcement: if the after hook armed auto-answer
 *      for this session, block the question tool so the orchestrator can't
 *      ask the user. One-shot — consumed on the very next tool call.
 *
 * OFF-mode dispatch handling:
 *   OFF mode no longer hard-blocks @advisor dispatch at the tool layer.
 *   The system prompt tells the LLM "Do NOT auto-dispatch @advisor" — this
 *   is a soft guard that prevents LLM-initiated consultation while still
 *   allowing user-explicit @advisor to go through (the LLM sees the user's
 *   @advisor and dispatches it, which is the user's intent).
 *
 *   The hard block was removed because tool.execute.before cannot distinguish
 *   "LLM decided on its own to consult advisor" from "user typed @advisor and
 *   the LLM is faithfully executing that request" — both arrive as identical
 *   dispatch tool calls. Blocking both was too aggressive: OFF should mean
 *   "no automatic advisor flow", not "advisor is forbidden even when the user
 *   explicitly asks for it".
 *
 *   Full-inject (tool.execute.after) runs failure detection in all modes
 *   (including off), but never injects auto-execute directives when mode
 *   is off — the advisor's opinion is advisory only, the orchestrator
 *   decides alone.
 *
 * NOT wrapped in safeHook — throws are the blocking mechanism and must
 * propagate. Unexpected errors in the detection logic are unlikely (all
 * predicates are null-safe).
 */

import {
  clearAutoAnswer,
  isAutoAnswerActive,
  makeLogger,
} from "./auto-advisor-runtime"

/** V2 tool execute.before event fields this guard reads. */
interface ToolGuardEvent {
  tool?: string
  sessionID?: string
  // `input` is the tool-call args (shape-untrusted); defensive
  // sessionID fallback lives here for host-shape parity.
  input?: unknown
}

/** Resolve the session from the v2 event (top-level first, defensive
 *  fallback to nested input). */
function resolveSessionId(e: ToolGuardEvent): string {
  if (typeof e.sessionID === "string" && e.sessionID) return e.sessionID
  const nested = e.input as { sessionID?: unknown } | undefined
  if (typeof nested?.sessionID === "string" && nested.sessionID) return nested.sessionID
  return "default"
}

const QUESTION_TOOL_RE = /^(question|ask|prompt|confirm|select)$/i

/** V2 `ctx.tool.hook("execute.before", …)` handler. The deliberate throw
 *  IS the blocking mechanism — execute.before is the one v2 hook allowed
 *  to reject; NOT wrapped fail-open. */
export function makeToolGuardHook() {
  const log = makeLogger("auto-advisor-mode")

  return async (e: ToolGuardEvent): Promise<void> => {
    const sessionId = resolveSessionId(e)

    // ── 1. Full-mode auto-answer enforcement (one-shot) ───────────
    if (isAutoAnswerActive(sessionId)) {
      clearAutoAnswer(sessionId)
      if (e.tool && QUESTION_TOOL_RE.test(e.tool)) {
        await log(
          "info",
          `question tool "${e.tool}" blocked — auto-answer active for session ${sessionId}`,
        )
        throw new Error(
          "[Auto-Advisor Mode Guard] Full-mode auto-answer is active — " +
            "question tool blocked.\n" +
            "The advisor answered on the user's behalf (FACTUAL, confidence ≥ 8).\n" +
            "Execute the advisor's recommendation directly instead of asking the user.",
        )
      }
    }

    // ── 2. Off-mode dispatch: no hard block ────────────────────────
    // OFF mode relies on the system prompt's soft guard ("Do NOT auto-dispatch
    // @advisor"). User-explicit @advisor is allowed through — the LLM sees
    // the user's request and dispatches it. full-inject (tool.execute.after)
    // will not inject any auto-execute directive when mode is off, so the
    // advisor's opinion is treated as plain text, no auto-execute.
  }
}
