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
 * Toast-only strategy:
 *   tui.showToast is the sole surface — non-intrusive, no chat-transcript
 *   pollution, and degrades to a log line in headless/older-server
 *   environments. Never fatal.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import { getMode, type AdvisorMode } from "./auto-advisor-config"
import { CONFIDENCE_THRESHOLD, makeLogger, MAX_AUTO_ANSWERS } from "./auto-advisor-runtime"

type Client = PluginInput["client"]

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

/**
 * Best-effort toast + log. Toast failure (headless run, older server without
 * /tui/show-toast) degrades to the log line — announcing must never break a
 * session start or a mode switch.
 */
async function showToast(client: Client, mode: AdvisorMode): Promise<void> {
  const log = makeLogger(client, "auto-advisor-mode")
  try {
    await client.tui.showToast({
      body: { message: announceMessage(mode), variant: toastVariant(mode) },
    })
    await log("info", `announce: mode=${mode} toast shown`)
  } catch {
    await log("info", `announce: mode=${mode} (no TUI — log only)`)
  }
}

/**
 * Show the message as a toast notification — non-intrusive, no
 * chat-transcript pollution. Degrades to a log line if the TUI is
 * unavailable. Never fatal.
 */
async function announce(client: Client, mode: AdvisorMode, _sessionID?: string): Promise<void> {
  await showToast(client, mode)
}

/** Immediate user-visible confirmation for `/auto-advisor <mode>` switches. */
export async function announceSwitch(
  client: Client,
  mode: AdvisorMode,
  sessionID?: string,
): Promise<void> {
  await announce(client, mode, sessionID)
}
