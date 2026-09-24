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
 * This file now only provides toast feedback for /adr guard switches (and its /adr-guard alias) and
 * status reports.
 *
 * Announce strategy (v2): OCP-V2-GAP — the v2 plugin Context exposes no
 *   TUI notification surface, so the former tui.showToast path degrades to
 *   a server-log line via shared/notify. Non-intrusive (no chat-transcript
 *   pollution either way). Never fatal.
 */

import { notify } from "../shared/notify"
import { refreshLocale, tr } from "../tui/i18n"
import { getAdrDir, getState, type GuardState } from "./adr-config"

/** One user-visible line per state. ON MUST name the enforcement surface. */
export function announceMessage(state: GuardState): string {
  refreshLocale()
  return state === "on"
    ? tr("guard.adr.announceOn", { dir: getAdrDir() })
    : tr("guard.adr.announceOff")
}

/** Read-only status report for `/adr guard` without a state argument. */
export function statusMessage(): string {
  refreshLocale()
  return tr("guard.adr.statusMsg", { state: getState().toUpperCase(), dir: getAdrDir() })
}

/**
 * Best-effort announce (v1: toast; v2: shared/notify server-log line).
 * Never fatal — announcing must not break a session or a switch.
 */
export async function announce(
  message: string,
  variant: "warning" | "info" = "info",
  _sessionID?: string,
): Promise<void> {
  await notify(message, variant)
}

/** Immediate user-visible confirmation for `/adr guard on|off` switches. */
export async function announceSwitch(state: GuardState, sessionID?: string): Promise<void> {
  await announce(announceMessage(state), state === "on" ? "warning" : "info", sessionID)
}

/** Immediate user-visible status report for bare `/adr guard`. */
export async function announceStatus(sessionID?: string): Promise<void> {
  await announce(statusMessage(), "info", sessionID)
}
