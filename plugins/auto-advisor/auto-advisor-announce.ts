/**
 * Toast helpers for the auto-advisor mode.
 *
 * The mode is persisted as `autoAdvisorMode` in the project's .ocp/ocp.json
 * and silently survives across sessions; without a visible signal the user
 * can forget full mode is on — and full mode auto-answers on their behalf.
 *
 * The session.created announce was replaced by the TUI sidebar-status slot
 * plugin (plugins/sidebar-status.ts) which shows a persistent badge.
 * This file now only provides toast feedback for /auto-advisor switches.
 *
 * Announce-only strategy:
 *   v1 used tui.showToast as the sole surface (non-intrusive, no
 *   chat-transcript pollution). OCP-V2-GAP: the v2 plugin Context has no
 *   TUI surface — announce() routes through shared/notify (server-log
 *   line). Never fatal.
 */

import { notify } from "../shared/notify"
import { type AdvisorMode } from "./auto-advisor-config"
import { CONFIDENCE_THRESHOLD, MAX_AUTO_ANSWERS } from "./auto-advisor-runtime"

/** One user-visible line per mode. Full MUST name the auto-answer risk. */
export function announceMessage(mode: AdvisorMode): string {
  if (mode === "full") {
    return (
      `[auto-advisor] Mode: FULL — advisor may answer blocking questions on your ` +
      `behalf (FACTUAL, confidence ≥ ${CONFIDENCE_THRESHOLD}, max ${MAX_AUTO_ANSWERS}/session). /auto-advisor lite to require sign-off.`
    )
  }
  if (mode === "off") {
    return "[auto-advisor] Mode: OFF — no auto-dispatch of @advisor; manual @advisor still works. Orchestrator decides alone."
  }
  return (
    "[auto-advisor] Mode: LITE — both opinions returned to you; nothing auto-executes."
  )
}

function toastVariant(mode: AdvisorMode): "warning" | "info" {
  return mode === "full" ? "warning" : "info"
}

/** Best-effort announce (v1: toast; v2: server-log line via shared/notify).
 *  Never fatal — announcing must not break a session start or a switch. */
async function announce(mode: AdvisorMode): Promise<void> {
  await notify(announceMessage(mode), toastVariant(mode) === "warning" ? "warning" : "info")
}

/** Immediate user-visible confirmation for `/auto-advisor <mode>` switches. */
export async function announceSwitch(mode: AdvisorMode): Promise<void> {
  await announce(mode)
}
