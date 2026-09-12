/**
 * Shared env-guard config — project opencode.jsonc switch field.
 *
 * State is PROJECT-LEVEL and lives in the `envGuard` field of the
 * project's opencode.json/opencode.jsonc — there is NO separate state
 * file.
 *   - absent or "off" → off (default — no enforcement)
 *   - "on"            → on (secret-bearing .env* access is hard-blocked)
 *
 * Resolution: project config `envGuard` field → "off". Scanned in
 * order via `readProjectConfig()` which iterates the candidate paths
 * (`.opencode/opencode.jsonc`, `opencode.jsonc`, `.json` variants).
 *
 * Setting the switch writes the field into the project-level config
 * only (targeted upsert; comments preserved). `/env-guard on|off`
 * flows through `setState`; `/env-guard reset` flows through `clear`.
 *
 * The switch itself is delegated to `plugins/shared/plugin-switch.ts`
 * — this file keeps only env-guard-specific concerns (the type
 * alias and re-exports of plumbing).
 */

import {
  clearConfigField,
  readProjectConfig,
  setConfigField,
  setProjectDir,
} from "../shared/opencode-prime"
import { createPluginSwitch, normalizeSwitchState } from "../shared/plugin-switch"

// Re-export the shared plumbing so the plugin entry keeps its import path.
export { setProjectDir }

export type GuardState = "on" | "off"
export type GuardStateSource = "config" | "default"

const envSwitch = createPluginSwitch<GuardState>({
  field: "envGuard",
  aliases: {
    on: "on", enabled: "on", true: "on",
    off: "off", disabled: "off", false: "off",
  },
  defaultState: "off",
  onStates: ["on"],
})

/** Normalize a raw config value (boolean or string) to a canonical
 * GuardState. Pure — exported for unit tests. */
export function normalizeState(raw: unknown): GuardState | null {
  return normalizeSwitchState(raw, envSwitch.spec.aliases)
}

/** Current canonical state. Falls back to defaultState when the field
 * is absent or unrecognized. */
export function getState(): GuardState {
  return envSwitch.getState()
}

/** Whether the current state came from project config or the default. */
export function getStateSource(): GuardStateSource {
  return envSwitch.getStateSource()
}

/** Persist `state` to project config. Returns false on read-only fs. */
export function setState(state: GuardState): boolean {
  return envSwitch.setState(state)
}

/** Remove the field so state reverts to default. */
export function clearState(): boolean {
  return envSwitch.clear()
}

/** Whether the switch is currently on. */
export function isEnabled(): boolean {
  return envSwitch.isOn()
}