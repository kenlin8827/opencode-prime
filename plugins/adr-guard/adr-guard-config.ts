/**
 * Shared adr-guard config — project .ocp/ocp.json switch field + ADR
 * directory + ADR layout. Single source of truth for reading,
 * writing, and normalizing each.
 *
 * State is PROJECT-LEVEL and lives in:
 *   - `adrGuard` — the on/off switch (default off; `/adr-guard on|off`)
 *   - `adrDir` — ADR directory (default "docs/adr")
 *   - `adrLayout` — hierarchy mode (auto / flat / hierarchical, default auto)
 *
 * The switch is delegated to `plugins/shared/plugin-switch.ts`. The
 * ADR-directory and hierarchy-mode helpers below are plugin-specific
 * (no other plugin shares them).
 *
 * /adr-guard on|off writes the field into the project-level config
 * only (targeted upsert via ../shared/opencode-prime — comments and
 * unrelated fields survive); /adr-guard reset removes the field,
 * reverting to the default off.
 *
 * The project directory is injected by the plugin entry via
 * setProjectDir() (PluginInput.directory); until then we fall back to
 * process.cwd().
 */

import {
  clearConfigField,
  getProjectDir,
  readProjectConfig,
  setConfigField,
  setProjectDir,
  stripJsonc,
} from "../shared/opencode-prime"
import { createPluginSwitch, normalizeSwitchState } from "../shared/plugin-switch"

// Re-export the shared plumbing so existing importers (plugin entry, tool
// guard, tests) keep their current import paths.
export { getProjectDir, readProjectConfig, setProjectDir, stripJsonc }

export type GuardState = "on" | "off"
export type GuardStateSource = "config" | "default"

const adrSwitch = createPluginSwitch<GuardState>({
  field: "adrGuard",
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
  return normalizeSwitchState(state, adrSwitch.spec.aliases)
}

// ─── Switch state ────────────────────────────────────────────────────

export function getState(): GuardState {
  return adrSwitch.getState()
}

/** Where the current state came from (shown in `/adr-guard` status). */
export function getStateSource(): GuardStateSource {
  return adrSwitch.getStateSource()
}

/** Write the switch into the project-level .ocp/ocp.json.
 * Project-scoped and never throws: a read-only project dir degrades
 * to a false return instead of crashing a plugin hook. */
export function setState(state: GuardState): boolean {
  return adrSwitch.setState(state)
}

/** Remove the `adrGuard` field from the project config so the state
 * reverts to the default off. Used by `/adr-guard reset`. */
export function clearState(): boolean {
  return adrSwitch.clear()
}

export function isEnabled(): boolean {
  return adrSwitch.isOn()
}

// ─── ADR directory ────────────────────────────────────────────────────

export const DEFAULT_ADR_DIR = "docs/adr"

export function getAdrDir(): string {
  const cfg = readProjectConfig()
  const v = cfg?.adrDir
  if (typeof v === "string" && v.trim() !== "") {
    return v.trim().replace(/\\/g, "/").replace(/\/+$/, "")
  }
  return DEFAULT_ADR_DIR
}

// ─── Hierarchy Mode (auto / flat / hierarchical) ─────────────────────
//
// Distinct from the on/off switch above — three modes with real
// behavioral differences, so it stays as its own state machine.

export type AdrLayout = "auto" | "flat" | "hierarchical"

const VALID_MODES = new Set<string>(["auto", "flat", "hierarchical"])
const MODE_FIELD = "adrLayout"
const DEFAULT_LAYOUT: AdrLayout = "auto"

const LAYOUT_ALIASES: Record<string, AdrLayout> = {
  // auto
  auto: "auto",
  a: "auto",
  smart: "auto",
  default: "auto",

  // flat
  flat: "flat",
  f: "flat",
  single: "flat",
  s: "flat",
  linear: "flat",

  // hierarchical
  hierarchical: "hierarchical",
  hierarchy: "hierarchical",
  h: "hierarchical",
  tree: "hierarchical",
  t: "hierarchical",
  nested: "hierarchical",
  multi: "hierarchical",
  levels: "hierarchical",
  l: "hierarchical",
}

export function normalizeAdrLayout(layout: unknown): AdrLayout | null {
  if (typeof layout !== "string") return null
  const s = layout.trim().toLowerCase()
  return LAYOUT_ALIASES[s] ?? null
}

export function getAdrLayout(): AdrLayout {
  const cfg = readProjectConfig()
  const normalized = normalizeAdrLayout(cfg?.adrLayout)
  return normalized ?? DEFAULT_LAYOUT
}

export function setAdrLayout(layout: AdrLayout): boolean {
  const normalized = normalizeAdrLayout(layout)
  if (!normalized) return false
  return setConfigField(MODE_FIELD, normalized).ok
}

export function clearAdrLayout(): boolean {
  return clearConfigField(MODE_FIELD).ok
}

// ─── Slash command parsing ────────────────────────────────────────────

export const COMMAND_NAME = "adr-guard"
export const ADR_COMMAND = "adr"

/**
 * Parse the first argument of an `/adr-guard <state>` call. Returns
 * null if the argument is missing or not a valid state (caller treats
 * null as status).
 *
 *   /adr-guard      → null (status)
 *   /adr-guard on   → "on"
 *   /adr-guard off  → "off"
 */
export function parseStateArg(args: unknown): GuardState | null {
  return adrSwitch.parseArg(args)
}

const RESET_ALIASES = ["reset", "default", "clear"]

/** True when the first argument asks to reset the switch to the default off. */
export function parseResetArg(args: unknown): boolean {
  if (typeof args !== "string") return false
  const first = args.trim().split(/\s+/)[0]?.toLowerCase()
  return RESET_ALIASES.includes(first)
}