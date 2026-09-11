/**
 * Hook: event — announce the e2e-guard state to the user.
 *
 * The switch persists as the `e2eGuard` field of the project's
 * opencode.jsonc and silently survives across sessions; without a visible
 * signal the user can forget the gate is on — and E2E runs may get blocked
 * unexpectedly. Also keeps the in-memory approval store tidy: approvals die
 * with their session (session.deleted).
 *
 * Two surfaces, one message builder:
 *   - /e2e-guard <state|allow|status> → the command hook reuses the
 *     announce helpers for switch confirmation, approval confirmation and
 *     status reports.
 *
 * Toast-only strategy:
 *   tui.showToast is the sole surface — non-intrusive, no chat-transcript
 *   pollution, and degrades to a log line in headless/older-server
 *   environments. Never fatal.
 *
 * Note: The session.created announce was replaced by the TUI sidebar-status
 * slot plugin (plugins/sidebar-status.ts) which shows a persistent badge. Only
 * the session.deleted cleanup hook remains here.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import { refreshLocale, tr } from "../tui/i18n"
import { getState, type GuardState } from "./e2e-guard-config"
import { revokeApproval } from "./e2e-guard-runtime"
import { makeLogger } from "../adr-guard/adr-guard-runtime"

type Client = PluginInput["client"]

/** Minimal shape we rely on; the SDK's Event union is broader. */
type SessionEvent = {
  type: string
  properties?: { info?: { parentID?: string; id?: string } }
}

/** One user-visible line per state. ON MUST name the enforcement surface. */
export function announceMessage(state: GuardState): string {
  refreshLocale()
  return state === "on" ? tr("guard.e2e.announceOn") : tr("guard.e2e.announceOff")
}

/** Read-only status report for `/e2e-guard` without a state argument. */
export function statusMessage(): string {
  refreshLocale()
  return tr("guard.e2e.statusMsg", { state: getState().toUpperCase() })
}

/** Confirmation for `/e2e-guard allow [targeted]` — names the grant scope. */
export function allowMessage(scope: "full" | "targeted" = "full"): string {
  refreshLocale()
  return scope === "targeted" ? tr("guard.e2e.allowTargeted") : tr("guard.e2e.allowFull")
}

/**
 * Best-effort toast + log. Toast failure (headless run, older server without
 * /tui/show-toast) degrades to the log line — announcing must never break a
 * session start or a switch.
 */
async function showToast(client: Client, message: string, variant: "warning" | "info"): Promise<void> {
  const log = makeLogger(client, "e2e-guard")
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
async function announce(
  client: Client,
  message: string,
  variant: "warning" | "info",
  _sessionID?: string,
): Promise<void> {
  await showToast(client, message, variant)
}

export function makeEventHook(_client: Client) {
  return async (input: { event: SessionEvent }) => {
    const event = input.event
    if (event.type === "session.deleted") {
      // Approvals are session-scoped — never let one outlive its session.
      const id = event.properties?.info?.id
      if (id) revokeApproval(id)
    }
  }
}

/** Immediate user-visible confirmation for `/e2e-guard on|off` switches. */
export async function announceSwitch(
  client: Client,
  state: GuardState,
  sessionID?: string,
): Promise<void> {
  await announce(client, announceMessage(state), state === "on" ? "warning" : "info", sessionID)
}

/** Immediate user-visible confirmation for `/e2e-guard allow [targeted]`. */
export async function announceAllow(
  client: Client,
  sessionID?: string,
  scope: "full" | "targeted" = "full",
): Promise<void> {
  await announce(client, allowMessage(scope), "info", sessionID)
}

/** Immediate user-visible status report for bare `/e2e-guard`. */
export async function announceStatus(client: Client, sessionID?: string): Promise<void> {
  await announce(client, statusMessage(), "info", sessionID)
}
