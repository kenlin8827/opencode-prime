/**
 * Project-level plugin switch — shared abstraction over a project
 * OCP config field (`.ocp/ocp.json`) with aliases and a default. Used by every
 * plugin whose "on/off" state is per-project (auto-advisor, adr-guard,
 * e2e-guard, env-guard).
 *
 * Why this lives in `shared/` rather than duplicated per-plugin:
 * each plugin was carrying a near-identical
 *   - alias table
 *   - normalize(raw) function (string→canonical, with boolean support)
 *   - isEnabled/isOn wrapper
 *   - setState wrapper around setConfigField
 *   - parseArg helper for slash commands
 *   - getStateSource for diagnostics
 * pattern. Centralizing the plumbing lets each plugin declare only
 * what makes it different: the field name, the alias table, the
 * default state, and which canonical states count as "on".
 *
 * Plugin-specific concerns (command parsing for reset, ADR directory,
 * env-guard's pattern matching, auto-advisor's mode display) stay in
 * the plugin's config file as thin wrappers.
 */

import {
  clearConfigField,
  readProjectConfig,
  setConfigField,
} from "./opencode-prime"

/** Coerce the rich SetConfigResult down to the historical boolean contract.
 *  Existing plugin hooks that only need pass/fail (e.g. project-memory's
 *  `setState`) keep working unchanged; new callers can opt into the rich
 *  envelope by calling `setConfigField` directly. */
function toBool(result: { ok: boolean }): boolean {
  return result.ok
}

/** Normalize a raw config value (boolean or string) to a canonical
 * switch state via the plugin's alias table. Boolean true/false
 * support requires `"true"` / `"false"` keys in the alias table —
 * the convention every plugin already follows.
 *
 * Returns null when the raw value is unrecognized (caller falls back
 * to defaultState).
 *
 * Pure function — exported for unit tests, no I/O, no module state. */
export function normalizeSwitchState<TState extends string>(
  raw: unknown,
  aliases: Record<string, TState>,
): TState | null {
  if (typeof raw === "boolean") return aliases[String(raw)] ?? null
  if (typeof raw !== "string") return null
  return aliases[raw.trim().toLowerCase()] ?? null
}

/** Configuration for `createPluginSwitch`. The plugin declares only
 * what makes its switch different — every other concern (project
 * config IO, JSONC parsing, never-throw writes, comment-preserving
 * field upsert) is already shared via `../shared/opencode-prime`. */
export interface PluginSwitchSpec<TState extends string> {
  /** Field name in the project OCP config (`.ocp/ocp.json`). */
  readonly field: string
  /** Raw config value (boolean or string) → canonical state. */
  readonly aliases: Record<string, TState>
  /** Canonical state to return when the field is absent or unrecognized. */
  readonly defaultState: TState
  /** Which canonical states count as "on" for `isOn()`. Default `["on"]`
   * for on/off plugins; auto-advisor uses `["lite", "full"]` because
   * both of those mean "advisor protocol is active". */
  readonly onStates: readonly TState[]
}

/** Project-level plugin switch. Methods are pure (besides I/O for
 * read/write, which is delegated to `../shared/opencode-prime`). */
export interface PluginSwitch<TState extends string> {
  readonly spec: PluginSwitchSpec<TState>
  /** True when current state is in `onStates`. */
  isOn(): boolean
  /** Current canonical state. Falls back to `defaultState` when
   * the field is absent or unrecognized. */
  getState(): TState
  /** Whether the state came from project config or the default
   * (useful for diagnostics and tests). */
  getStateSource(): "config" | "default"
  /** Persist `state` to project config. Returns false on read-only
   * fs or unrecoverable parse failure — never throws. */
  setState(state: TState): boolean
  /** Remove the field so state reverts to default. Returns false on
   * read-only fs — never throws. */
  clear(): boolean
  /** Parse a slash-command argument string. Returns canonical state
   * or null (caller treats null as "no argument / show status"). */
  parseArg(args: unknown): TState | null
}

/** Build a plugin switch from its spec. Each plugin's config file
 * declares a `PluginSwitch<TState>` once at module load and exposes
 * named wrappers (`isEnabled`, `getState`, ...) so existing callers
 * keep their import paths. */
export function createPluginSwitch<TState extends string>(
  spec: PluginSwitchSpec<TState>,
): PluginSwitch<TState> {
  return {
    spec,
    isOn(): boolean {
      return spec.onStates.includes(this.getState())
    },
    getState(): TState {
      const cfg = readProjectConfig()
      const normalized = normalizeSwitchState(cfg?.[spec.field], spec.aliases)
      return normalized ?? spec.defaultState
    },
    getStateSource(): "config" | "default" {
      const cfg = readProjectConfig()
      return normalizeSwitchState(cfg?.[spec.field], spec.aliases)
        ? "config"
        : "default"
    },
    setState(state: TState): boolean {
      return toBool(setConfigField(spec.field, state))
    },
    clear(): boolean {
      return toBool(clearConfigField(spec.field))
    },
    parseArg(args: unknown): TState | null {
      if (typeof args !== "string") return null
      const first = args.trim().split(/\s+/)[0]
      return normalizeSwitchState(first, spec.aliases)
    },
  }
}