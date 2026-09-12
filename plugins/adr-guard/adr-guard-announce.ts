/**
 * Toast helpers for the ADR iron-law state.
 *
 * The switch is persisted as the `adrGuard` field of the project's
 * .ocp/ocp.json and silently survives across sessions; without a visible
 * signal the user can forget the iron law is on — and commits may get
 * blocked unexpectedly.
 *
 * The session.created announce was replaced by the TUI sidebar-status slot
 * plugin (plugins/sidebar-status.ts) which shows a persistent badge.
 * This file now only provides toast feedback for /adr-guard switches and
 * status reports.
 *
 * Toast-only strategy:
 *   tui.showToast is the sole surface — non-intrusive, no chat-transcript
 *   pollution, and degrades to a log line in headless/older-server
 *   environments. Never fatal.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import { refreshLocale, tr } from "../tui/i18n"
import { getAdrDir, getState, type GuardState } from "./adr-guard-config"
import { makeLogger } from "./adr-guard-runtime"

type Client = PluginInput["client"]

/** One user-visible line per state. ON MUST name the enforcement surface. */
export function announceMessage(state: GuardState): string {
  refreshLocale()
  return state === "on"
    ? tr("guard.adr.announceOn", { dir: getAdrDir() })
    : tr("guard.adr.announceOff")
}

/** Read-only status report for `/adr-guard` without a state argument. */
export function statusMessage(): string {
  refreshLocale()
  return tr("guard.adr.statusMsg", { state: getState().toUpperCase(), dir: getAdrDir() })
}

/**
 * Best-effort toast + log. Toast failure (headless run, older server without
 * /tui/show-toast) degrades to the log line — announcing must never break a
 * session start or a switch.
 */
async function showToast(client: Client, message: string, variant: "warning" | "info"): Promise<void> {
  const log = makeLogger(client, "adr-guard")
  try {
    await client.tui.showToast({ body: { message, variant } })
    await log("info", `announce: toast shown — ${message}`)
  } catch {
    await log("info", `announce (no TUI — log only): ${message}`)
  }
}

/**
 * Show the message as a toast notification — non-intrusive, no
 * chat-transcript pollution. Degrades to a log line if the TUI is
 * unavailable. Never fatal.
 */
export async function announce(
  client: Client,
  message: string,
  variant: "warning" | "info" = "info",
  _sessionID?: string,
): Promise<void> {
  await showToast(client, message, variant)
}

/** Immediate user-visible confirmation for `/adr-guard on|off` switches. */
export async function announceSwitch(
  client: Client,
  state: GuardState,
  sessionID?: string,
): Promise<void> {
  await announce(client, announceMessage(state), state === "on" ? "warning" : "info", sessionID)
}

/** Immediate user-visible status report for bare `/adr-guard`. */
export async function announceStatus(client: Client, sessionID?: string): Promise<void> {
  await announce(client, statusMessage(), "info", sessionID)
}
