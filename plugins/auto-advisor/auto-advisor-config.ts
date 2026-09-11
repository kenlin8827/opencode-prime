/**
 * Shared auto-advisor config — read/write the mode via opencode.jsonc.
 * Single source of truth for reading, writing, and normalizing the mode.
 *
 * No hidden state file and no env var: the mode lives in the
 * `autoAdvisorMode` field of the project-level opencode.jsonc:
 *   - "lite" → both opinions returned to user
 *   - "full" → full (auto-execute when confidence ≥ 8)
 *   - "off"  → off (no auto-dispatch; manual @advisor still works)
 *
 * Resolution: project config autoAdvisorMode field → "off" (default).
 *   (<project>/.opencode/opencode.jsonc or <project>/opencode.jsonc, then
 *   the .json variants). Purely project-level — no global fallback.
 *
 * /auto-advisor <mode> ALWAYS writes to the project-level config only:
 * the first existing project config file, or <project>/.opencode/opencode.jsonc
 * if none exists (the same location /project init scaffolds). Comments
 * and other fields are preserved (targeted field upsert, never a full
 * reserialize).
 *
 * The project directory is injected by the plugin entry via
 * setProjectDir() (PluginInput.directory); until then we fall back to
 * process.cwd().
 *
 * Config-file plumbing (project dir resolution, JSONC parsing, field
 * upsert, never-throw write) is shared with adr-guard, env-guard and
 * e2e-guard via ../shared/opencode-prime; this file delegates the
 * mode semantics to ../shared/plugin-switch.
 */

import {
  getProjectDir,
  projectConfigFiles,
  setConfigField,
  setProjectDir,
  stripJsonc,
} from "../shared/opencode-prime"
import { createPluginSwitch, normalizeSwitchState } from "../shared/plugin-switch"

// Re-export the shared plumbing so existing importers (plugin entry, runtime)
// keep their current import paths.
export { getProjectDir, setProjectDir, stripJsonc }

const VALID_MODES = ["off", "lite", "full"] as const
export type AdvisorMode = (typeof VALID_MODES)[number]

// Default is OFF: no auto-dispatch unless a project opencode.jsonc explicitly
// opts in. Manual @advisor still works in all modes.
const DEFAULT_MODE: AdvisorMode = "off"

const MODE_FIELD = "autoAdvisorMode"

// Aliases mirror the field — `off` / `lite` / `full` plus short forms.
// The shared `normalizeSwitchState` reads through this map; both
// `getMode()` and `parseModeArg()` use the same normalization, so
// "/auto-advisor L" and `autoAdvisorMode: "L"` both resolve to "lite".
const MODE_ALIASES: Record<string, AdvisorMode> = {
  off: "off", o: "off", false: "off", disabled: "off",
  lite: "lite", l: "lite",
  full: "full", f: "full",
}

const advisorSwitch = createPluginSwitch<AdvisorMode>({
  field: MODE_FIELD,
  aliases: MODE_ALIASES,
  defaultState: DEFAULT_MODE,
  onStates: ["lite", "full"],
})

export function normalizeMode(mode: unknown): AdvisorMode | null {
  return normalizeSwitchState(mode, MODE_ALIASES)
}

// ─── Reading ──────────────────────────────────────────────────────────
// Project config is the single source of truth — per-project opt-in
// committed with the repo. No global fallback: the switch is project-level.

export function getMode(): AdvisorMode {
  return advisorSwitch.getState()
}

// NOTE: isOn() is no longer used for hard dispatch blocking. OFF mode relies on
// the system prompt's soft guard ("Do NOT auto-dispatch") instead of a
// tool.execute.before hard block. Manual @advisor is allowed in all modes.

// ─── Writing ──────────────────────────────────────────────────────────
// /auto-advisor <mode> targets the project-level config only. Targeted
// field upsert (shared): replace the existing autoAdvisorMode value, or
// insert the field right after the root `{`. Comments and all other
// fields stay untouched.

export function setMode(mode: AdvisorMode): boolean {
  return advisorSwitch.setState(mode)
}

export const COMMAND_NAME = "auto-advisor"

/**
 * Parse the first argument of an `/auto-advisor <mode>` call. Returns null if the
 * argument is missing or not a valid mode.
 *
 *   /auto-advisor      → null (no-op)
 *   /auto-advisor off  → "off"
 *   /auto-advisor lite → "lite"
 *   /auto-advisor full → "full"
 */
export function parseModeArg(args: unknown): AdvisorMode | null {
  return advisorSwitch.parseArg(args)
}