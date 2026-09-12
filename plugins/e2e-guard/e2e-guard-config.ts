/**
 * Shared e2e-guard config — project OCP config switch field.
 *
 * State is PROJECT-LEVEL and lives in the `e2eGuard` field of
 * `.ocp/ocp.json`. The `/e2e-guard on|off` command flips it by
 * writing that field (targeted upsert; comments and unrelated fields
 * survive); it can also be flipped by hand.
 *   - absent or "off" → off (default — no enforcement, complete no-op)
 *   - "on"            → on (E2E runs are gated behind a user confirmation)
 *
 * Resolution: the `e2eGuard` field of `.ocp/ocp.json` → "off" (default).
 * Single runtime source via `readProjectConfig()` (ADR 0004 v2) — legacy
 * state moves once at project-init migration; no read fallback.
 *
 * The switch itself is delegated to `plugins/shared/plugin-switch.ts`;
 * this file keeps only e2e-guard-specific re-exports.
 */

import {
  getProjectDir,
  readProjectConfig,
  setConfigField,
  setProjectDir,
  writableProjectConfigFile,
} from "../shared/opencode-prime"
import { createPluginSwitch, normalizeSwitchState } from "../shared/plugin-switch"

// Re-export the shared plumbing so importers (plugin entry, tool guard,
// command, tests) keep one import path.
export { getProjectDir, readProjectConfig, setProjectDir, writableProjectConfigFile }

export type GuardState = "on" | "off"

const e2eSwitch = createPluginSwitch<GuardState>({
  field: "e2eGuard",
  aliases: {
    on: "on", enabled: "on", true: "on",
    off: "off", disabled: "off", false: "off",
  },
  defaultState: "off",
  onStates: ["on"],
})

/** Normalize a raw config value (boolean or string) to a canonical
 * GuardState. Pure — exported for unit tests. */
export function normalizeState(state: unknown): GuardState | null {
  return normalizeSwitchState(state, e2eSwitch.spec.aliases)
}

/** Current canonical state. Falls back to defaultState when the field
 * is absent or unrecognized. */
export function getState(): GuardState {
  return e2eSwitch.getState()
}

/** Whether the switch is currently on. */
export function isEnabled(): boolean {
  return e2eSwitch.isOn()
}

/** Persist `state` to project config. Returns false on read-only fs. */
export function setState(state: GuardState): boolean {
  return e2eSwitch.setState(state)
}