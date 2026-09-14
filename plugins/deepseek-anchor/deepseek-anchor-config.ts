/**
 * DeepSeek Anchor Plugin configuration and state management.
 *
 * Resolution chain (single source):
 *   1. Global config  — `~/.config/opencode/ocp.json` `deepSeekAnchor`
 *   2. Default        — "off" (opt-in)
 *
 * deepseek-anchor is a USER preference (model behavior, follows the user)
 * rather than a PROJECT behavior (commit convention, env file protection)
 * — it sits next to `i18n`, not `auto-advisor` / `adr-guard`. Reads and
 * writes both target the global `ocp.json` exclusively; the plugin entry
 * no longer pins a project dir and the command never touches
 * `<cwd>/.ocp/ocp.json`.
 *
 * Opt-in: the anchor forces DeepSeek V4 Pro through a reasoning checklist
 * before any tool call, paying a first-turn latency cost. Users who don't
 * run DeepSeek V4 Pro (or who actively want the original behavior) should
 * never need to think about it.
 */

import { normalizeOnOff, readOcpField, writeOcpField } from "../shared/ocp-config"

const VALID_MODES = ["on", "off"] as const
export type AnchorMode = (typeof VALID_MODES)[number]

const FIELD = "deepSeekAnchor"
const DEFAULT_MODE: AnchorMode = "off"

export function normalizeMode(mode: unknown): AnchorMode | null {
  return normalizeOnOff(mode)
}

/**
 * Resolve the active mode. Reads the global `~/.config/opencode/ocp.json`
 * `deepSeekAnchor` key only — falls back to the declared default ("off")
 * when the key is absent or holds an unrecognized value.
 */
export function getMode(): AnchorMode {
  const raw = readOcpField<unknown>(FIELD)
  const m = normalizeMode(raw)
  return m ?? DEFAULT_MODE
}

/**
 * Write the mode to the global `~/.config/opencode/ocp.json`. Returns
 * true on success, false on IO failure (read-only fs, permission denied).
 * The command hook surfaces a `!ok` to the user; we never throw — the
 * TUI keeps running on a permission error.
 */
export function setMode(mode: AnchorMode): boolean {
  return writeOcpField(FIELD, mode)
}

export function isEnabled(): boolean {
  return getMode() === "on"
}

export const COMMAND_NAME = "deepseek-anchor"

/**
 * Parse the first argument of the `/deepseek-anchor <mode>` command.
 * Returns null if the argument is missing or not a valid mode.
 *
 *   /deepseek-anchor        → null (show help)
 *   /deepseek-anchor on     → "on"
 *   /deepseek-anchor off    → "off"
 */
export function parseModeArg(args: unknown): AnchorMode | null {
  if (typeof args !== "string") return null
  const first = args.trim().split(/\s+/)[0]
  return normalizeMode(first)
}