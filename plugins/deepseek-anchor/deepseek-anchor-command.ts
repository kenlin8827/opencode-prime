/**
 * Hook: command.execute.before — handle `/deepseek-anchor <mode>`.
 * The command is registered programmatically via the `config` hook in
 * index.ts — no commands/deepseek-anchor.md file is needed.
 * One command file, argument selects mode (on/off).
 *
 *   /deepseek-anchor on   → ~/.config/opencode/ocp.json deepSeekAnchor = "on"
 *   /deepseek-anchor off  → ~/.config/opencode/ocp.json deepSeekAnchor = "off"
 *   /deepseek-anchor      → show help (no mode given)
 *
 * Writes target the GLOBAL config — deepseek-anchor is a user preference
 * (follows the user across projects), not a project convention. There is
 * no project fallback. Every successful switch gets user-visible feedback
 * via session.prompt({ noReply, ignored }) in the main chat UI.
 * setMode() never throws; a `!ok` result is surfaced to the user as a
 * single failure line with the target path so they can diagnose file
 * permissions.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import { ocpConfigPath } from "../shared/ocp-config"
import { getMode, setMode, COMMAND_NAME, parseModeArg, type AnchorMode } from "./deepseek-anchor-config"

/** One user-visible line per mode. */
function switchMessage(mode: AnchorMode): string {
  const emoji = mode === "on" ? "✅" : "❌"
  const text = mode === "on" ? "ENABLED" : "DISABLED"
  return `${emoji} DeepSeek Anchor ${text}. DeepSeek models will now ${mode === "on" ? "use reasoning anchor and block first tool call" : "behave normally"}.`
}

export function makeCommandHook(client: PluginInput["client"], handled: () => never) {
  return async (input: { command?: string; arguments?: string; sessionID?: string }) => {
    if (input.command !== COMMAND_NAME) return

    const currentMode = getMode()
    const newMode = parseModeArg(input.arguments)

    const send = async (text: string) => {
      if (!input.sessionID) return
      await client.session.prompt({
        path: { id: input.sessionID },
        body: {
          parts: [{ type: "text", text, ignored: true }],
          noReply: true,
        },
      })
    }

    // If no valid argument provided or argument is invalid, show help
    if (!newMode) {
      await send(`[deepseek-anchor] Current status: ${currentMode === "on" ? "✅ ENABLED" : "❌ DISABLED"}

Usage: /deepseek-anchor <on|off>
- on  → ~/.config/opencode/ocp.json deepSeekAnchor = "on"
- off → ~/.config/opencode/ocp.json deepSeekAnchor = "off"`)
      return handled()
    }

    // If already in target state, show a message
    if (newMode === currentMode) {
      await send(`[deepseek-anchor] Already ${newMode === "on" ? "enabled" : "disabled"}`)
      return handled()
    }

    // Switch to new state — surface failure to user instead of swallowing it.
    const ok = setMode(newMode)
    if (!ok) {
      await send(`[deepseek-anchor] Could not write ${ocpConfigPath()}; check file permissions`)
      return handled()
    }

    await send(switchMessage(newMode))
    return handled()
  }
}