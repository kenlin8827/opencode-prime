/**
 * Project-level plugin switch — shared abstraction over a project
 * OCP config field (`.ocp/ocp.json`) with aliases and a default. Used by every
 * plugin whose "on/off" state is per-project (auto-advisor, adr,
 * env-guard).
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

import { existsSync, readFileSync } from "node:fs"
import {
  clearConfigField,
  ocpConfigFile,
  readProjectConfig,
  setConfigField,
  stripJsonc,
} from "./opencode-prime"
import {
  createProjectScopedMemo,
  loadLastMarkerFromHistory,
} from "./last-good"

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
/** Single-IO helper: read one field and detect corruption in one file read.
 *  Returns `{ corrupt, raw }`; `corrupt=true` only when the file exists and
 *  `JSON.parse(stripJsonc(...))` throws. An absent file is NOT corrupt
 *  (defaults are correct there). On success `raw` is the field value or
 *  `undefined` when absent/unrecognized. */
function loadFieldOnce(field: string): { corrupt: boolean; raw: unknown } {
  const file = ocpConfigFile()
  if (!existsSync(file)) return { corrupt: false, raw: undefined }
  try {
    const parsed = JSON.parse(stripJsonc(readFileSync(file, "utf-8"))) as Record<string, unknown>
    return { corrupt: false, raw: parsed[field] }
  } catch {
    return { corrupt: true, raw: undefined }
  }
}

/** Build a plugin switch from its spec. Each plugin's config file
 * declares a `PluginSwitch<TState>` once at module load and exposes
 * named wrappers (`isEnabled`, `getState`, ...) so existing callers
 * keep their import paths.
 *
 * Last-good extension (shared/last-good): when `.ocp/ocp.json` is
 * corrupt (`isProjectConfigCorrupt()==true`) `getState()` serves the
 * last successfully normalized state for that project instead of lying
 * with `defaultState`. Cold-start corrupt (no memo) still falls back to
 * `defaultState` — fail-open, never throw. The memo is per-switch and
 * per-project (`Map<projectDir, TState>` via `createProjectScopedMemo`),
 * so project A's corruption never poisons project B.
 * `setState()`/`clear()` keep the memo coherent. See ADR instructions
 * for the fragment-level analogue of this contract.
 *
 * History fallback (Map miss on restart) is available via the separate
 * `getStateWithHistory(client, sessionID)` path on the returned object
 * (kept off the `PluginSwitch` interface so sync callers are unaffected;
 * system-transform hooks that already have `client`/`sessionID` can opt
 * in when the per-plugin marker parser is ready). For now the sync
 * `getState()` covers the common case (process has seen a good value
 * before corruption); restart-miss stays fail-open to default — same
 * pre-migration behaviour, just documented. */
export function createPluginSwitch<TState extends string>(
  spec: PluginSwitchSpec<TState>,
): PluginSwitch<TState> & {
  /** Per-project last-good memo (exposed for tests / history opt-in). */
  readonly _lastGood: ReturnType<typeof createProjectScopedMemo<TState>>
  /** Clear the memo for the current project or a specific dir (test helper). */
  clearMemo(dir?: string): void
  /** Async variant that also tries history on corrupt+miss (low-frequency restart). */
  getStateWithHistory(client?: unknown, sessionID?: string, historyMarker?: string, parseMarker?: (block: string) => TState | null): Promise<TState>
} {
  const lastGood = createProjectScopedMemo<TState>()

  const sw: PluginSwitch<TState> & {
    readonly _lastGood: ReturnType<typeof createProjectScopedMemo<TState>>
    clearMemo(dir?: string): void
    getStateWithHistory(client?: unknown, sessionID?: string, historyMarker?: string, parseMarker?: (block: string) => TState | null): Promise<TState>
  } = {
    spec,
    _lastGood: lastGood,
    clearMemo(dir?: string): void {
      if (typeof dir === "string" && dir.trim() !== "") lastGood.delete(dir)
      else lastGood.delete()
    },
    isOn(): boolean {
      return spec.onStates.includes(this.getState())
    },
    getState(): TState {
      const { corrupt, raw } = loadFieldOnce(spec.field)
      if (corrupt) {
        const hit = lastGood.get()
        if (hit !== undefined) return hit
        return spec.defaultState
      }
      const normalized = normalizeSwitchState(raw, spec.aliases)
      if (normalized !== null) {
        lastGood.set(normalized)
        return normalized
      }
      return spec.defaultState
    },
    getStateSource(): "config" | "default" {
      const { corrupt, raw } = loadFieldOnce(spec.field)
      if (corrupt) {
        return lastGood.get() !== undefined ? "config" : "default"
      }
      return normalizeSwitchState(raw, spec.aliases) ? "config" : "default"
    },
    setState(state: TState): boolean {
      const res = setConfigField(spec.field, state)
      if (res.ok) lastGood.set(state)
      return toBool(res)
    },
    clear(): boolean {
      const res = clearConfigField(spec.field)
      if (res.ok) lastGood.delete()
      return toBool(res)
    },
    parseArg(args: unknown): TState | null {
      if (typeof args !== "string") return null
      const first = args.trim().split(/\s+/)[0]
      return normalizeSwitchState(first, spec.aliases)
    },
    async getStateWithHistory(
      client?: unknown,
      sessionID?: string,
      historyMarker?: string,
      parseMarker?: (block: string) => TState | null,
    ): Promise<TState> {
      const { corrupt, raw } = loadFieldOnce(spec.field)
      if (corrupt) {
        const hit = lastGood.get()
        if (hit !== undefined) return hit
        if (client && sessionID && historyMarker && parseMarker) {
          try {
            const block = await loadLastMarkerFromHistory(client, sessionID, historyMarker)
            if (typeof block === "string") {
              const parsed = parseMarker(block)
              if (parsed !== null) {
                lastGood.set(parsed)
                return parsed
              }
            }
          } catch { /* fail open */ }
        }
        return spec.defaultState
      }
      const normalized = normalizeSwitchState(raw, spec.aliases)
      if (normalized !== null) {
        lastGood.set(normalized)
        return normalized
      }
      return spec.defaultState
    },
  }
  return sw
}