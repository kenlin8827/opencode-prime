/**
 * Hook: ctx.tool.hook("execute.after") — finalize advisor's response.
 *
 *   - V2 event shape: one mutable object `{ tool, sessionID, input, status,
 *     result }`. `result` is the Tool.Result (mutable); we append directives
 *     to its content in place. `status: "error"` carries no result — treated
 *     as the lite flow (NO auto-execute), same stance as v1's output.error.
 *   - fail-open: exceptions never crash the user's session.
 *   - isDispatchTool: skip non-dispatch tools (perf).
 *   - Format validation: warn on unparseable confidence/class.
 *   - Frequency limit: max MAX_AUTO_ANSWERS per session.
 *
 * OFF mode: failure detection and fallback warnings still run (so the user
 * gets told if their manual @advisor dispatch failed). Auto-execute never
 * fires — shouldAuto requires mode === "full".
 */

import { getMode } from "./auto-advisor-config"
import { advisorFailureWarning, fullDirective, fallbackWarning } from "./auto-advisor-instructions"
import {
  CONFIDENCE_THRESHOLD,
  MAX_AUTO_ANSWERS,
  appendDirective,
  autoAnswerQuotaReached,
  containsIrreversibilityMarker,
  containsPreferenceMarker,
  detectQuestionClass,
  extractQuestionText,
  extractResponseText,
  getAdvisorFailureReason,
  isAdvisorDispatch,
  isDispatchTool,
  isRedTeamOutput,
  isModelFallback,
  makeLogger,
  parseConfidence,
  recordAutoAnswer,
  setAutoAnswer,
} from "./auto-advisor-runtime"

/** V2 execute.after event fields this hook reads. */
interface ToolAfterEvent {
  tool?: string
  sessionID?: string
  input?: unknown
  status: "completed" | "error"
  result?: { content?: string | ReadonlyArray<unknown>; output?: unknown; metadata?: Record<string, unknown> }
}

export function makeFullInjectHook() {
  const log = makeLogger("auto-advisor-mode")

  return async (e: ToolAfterEvent): Promise<void> => {
    // Fail-open: never crash the session over advisor post-processing.
    try {
      const mode = getMode()
      if (!isDispatchTool(e)) return
      if (!isAdvisorDispatch(e.input) && !isAdvisorDispatch(e.result)) return

      // An errored tool call has no model-facing result to shape.
      if (e.status !== "completed") {
        await log("warn", "advisor: dispatch failed (tool error) — falling back to lite flow, NO auto-execute")
        return
      }

      const output = e.result
      const text = extractResponseText(output)
      const questionText = extractQuestionText(e.input)

      const failureReason = getAdvisorFailureReason(output)
      if (failureReason) {
        await log("warn", `advisor: dispatch failed (${failureReason}) — falling back to lite flow, NO auto-execute`)
        const ok = appendDirective(output, advisorFailureWarning(failureReason))
        if (!ok) await log("warn", "advisor failure warning FAILED to inject")
        return
      }

      if (isRedTeamOutput(text)) {
        await log("info", "red-team output — directives suppressed")
        return
      }

      const confidence = parseConfidence(text)
      const fallback = isModelFallback(output)
      let questionClass = detectQuestionClass(text)
      if (
        questionClass === "FACTUAL" &&
        (containsPreferenceMarker(questionText) || containsIrreversibilityMarker(questionText))
      ) {
        await log("warn", "advisor: PREFERENCE/irreversibility marker detected in question text — forcing lite flow")
        questionClass = "PREFERENCE"
      }
      const factual = questionClass === "FACTUAL"
      const sessionId = typeof e.sessionID === "string" && e.sessionID ? e.sessionID : "default"

      if (confidence === 0) {
        await log("warn", "confidence score not parsed — check advisor output format")
      }
      if (questionClass === null) {
        await log("warn", "question class not found — check advisor output format")
      }

      await log(
        "info",
        `advisor: confidence=${confidence}/${CONFIDENCE_THRESHOLD}, class=${questionClass ?? "UNKNOWN"}, fallback=${fallback}, session=${sessionId}`,
      )

      if (fallback) {
        const ok = appendDirective(output, fallbackWarning())
        if (!ok) await log("warn", "fallback warning FAILED to inject")
      }

      const shouldAuto =
        mode === "full" &&
        confidence >= CONFIDENCE_THRESHOLD &&
        factual &&
        !fallback &&
        !autoAnswerQuotaReached(sessionId)

      if (shouldAuto) {
        const ok = appendDirective(output, fullDirective(confidence))
        if (ok) {
          setAutoAnswer(sessionId)
          const count = recordAutoAnswer(sessionId)
          await log(
            "info",
            `auto-answer armed [${count}/${MAX_AUTO_ANSWERS}] — confidence=${confidence}, class=FACTUAL, session=${sessionId}`,
          )
        } else {
          await log("warn", "full directive FAILED to inject — output structure unrecognized")
        }
      } else if (mode === "full" && confidence >= CONFIDENCE_THRESHOLD && factual && !fallback) {
        await log("warn", `auto-answer skipped — quota reached (${MAX_AUTO_ANSWERS}/${MAX_AUTO_ANSWERS})`)
      }
    } catch {
      // Fail-open: advisor post-processing must never crash the session.
    }
  }
}
