/**
 * Hook: command.execute.before — `/e2e-guard <subcommand>` user controls.
 *
 * Provides control over the project-level switch:
 *   /e2e-guard on|off  → flips the `e2eGuard` field in .ocp/ocp.json
 *   /e2e-guard status  → reports the current project gate state
 */

import { refreshLocale, tr } from "../tui/i18n"
import { getState, setState, writableProjectConfigFile } from "./e2e-guard-config"

export const COMMAND_NAME = "e2e-guard"

export const SUBCOMMAND_STATUS = "status"
export const SUBCOMMAND_ON = "on"
export const SUBCOMMAND_OFF = "off"

function helpText(): string {
  refreshLocale()
  return tr("guard.e2e.help")
}

/** One-line gate report for `/e2e-guard status`. */
export function statusText(): string {
  refreshLocale()
  const gate = getState() === "on" ? "on" : "off"
  return tr("guard.e2e.status", { gate, flag: gate === "on" ? "ACTIVE" : "INACTIVE" })
}

export function makeCommandHook() {
  return async (
    input: { command?: string; arguments?: string; sessionID?: string },
    output: { parts?: unknown },
  ) => {
    if (input.command !== COMMAND_NAME) return

    const tokens = (input.arguments ?? "").trim().split(/\s+/).filter(Boolean)
    const sub = (tokens[0] ?? "").toLowerCase()

    let text: string
    if (sub === SUBCOMMAND_STATUS) {
      text = statusText()
    } else if (sub === SUBCOMMAND_ON || sub === SUBCOMMAND_OFF) {
      refreshLocale()
      text = setState(sub)
        ? tr("guard.e2e.set", {
            state: sub,
            STATE: sub.toUpperCase(),
            zhState: sub === "on" ? "启用" : "关闭",
            path: writableProjectConfigFile(),
          })
        : tr("guard.e2e.setFail")
    } else {
      refreshLocale()
      text = sub ? `${tr("guard.e2e.unknown", { sub })}\n\n${helpText()}` : helpText()
    }

    output.parts = [{ type: "text", text }]
  }
}
