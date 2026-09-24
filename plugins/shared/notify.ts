/**
 * User-facing announce surface — v2 bridge.
 *
 * OCP-V2-GAP: the v2 plugin Context exposes no TUI domain; v1's
 * `client.tui.showToast` has no plugin-reachable replacement (the
 * `tui.toast.show` event exists in the schema but nothing in the v2
 * plugin API can publish it). Announcements degrade to a console line,
 * which lands in the server log (same sink as v1 `client.app.log`).
 * The upgrade path is a future ctx TUI/notification domain — when it
 * lands, only this file changes; every announce call site keeps its
 * message text and semantics.
 *
 * Fail-open by design: announce must never break a session or command.
 */

export type NotifyVariant = "info" | "success" | "warning" | "error"

export async function notify(message: string, variant: NotifyVariant = "info"): Promise<void> {
  try {
    const line = `[ocp:notify][${variant}] ${message}`
    if (variant === "warning" || variant === "error") console.warn(line)
    else console.log(line)
  } catch {
    // A failed announce is a lost notification, not a failed session.
  }
}

/** v1-compatible logger sink. V2 Context has no app.log domain; console
 *  output from an in-process plugin reaches the same server log. */
export function makeRuntimeLogger(service: string) {
  return async (level: "info" | "warn" | "error", message: string): Promise<void> => {
    try {
      const line = `[ocp:${service}][${level}] ${message}`
      if (level === "warn" || level === "error") console.warn(line)
      else console.log(line)
    } catch {
      // Logging must never fail a hook.
    }
  }
}
