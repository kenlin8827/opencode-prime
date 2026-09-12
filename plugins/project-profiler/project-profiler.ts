/**
 * Hook: experimental.chat.system.transform — advertises the runtime
 * backend capabilities (CodeGraph / GitNexus / Serena / tgrep) to the
 * LLM via a single `[PROJECT CAPABILITIES]` block appended to the
 * system prompt.
 *
 * Opencode runtime note (verified 2026-09-11, see ADR 0002): the
 * runtime rebuilds `output.system` per chat request — output.system
 * never contains fragments injected on a previous step. That means:
 *
 *   - A "skip on same profile" optimization would leave the LLM
 *     without the capabilities block after the first turn, so we
 *     always inject.
 *   - Provider-side prompt-cache stays warm because the injected
 *     block is byte-identical across turns (profile unchanged → same
 *     rendered text → same final system prompt → provider cache hit).
 *   - Per-turn cost is dominated by `renderProfileBlock` (~µs). Cache
 *     the rendered block per (cwd, profile-key) to avoid re-rendering
 *     on every chat. Profile rarely changes, so the cache hits almost
 *     every call.
 *
 * The per-cwd key handles the "user cd'd to a different project"
 * case — each cwd's profile is independently cached. A profile change
 * (e.g. `opencode.jsonc` edited mid-session, tgrep watcher died)
 * changes the key and forces a re-render.
 *
 * Same fragment-cache + always-inject pattern as auto-advisor /
 * adr-guard / e2e-guard / project-manager.
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { Plugin } from "@opencode-ai/plugin"
import { scoped } from "../shared/plugin-scope"
import { appendBlock, escapeRegExp, stripBlockByLine } from "../shared/system-block"
import { loadTgrepOptions } from "../tgrep/tgrep-config"
import { ensureServer, ensureWatcher, resolveTgrepCapability, type TgrepCapabilityState } from "../tgrep/tgrep-service"

/** Line marker for the injected capabilities block. `stripBlockByLine`'s
 * regex is derived from this constant via `escapeRegExp` — single
 * source of truth for the marker text and the line-start match. */
export const MARKER = "[PROJECT CAPABILITIES]"

/** Per-backend capability states. The non-tgrep backends only ever
 * return `ready` or `unavailable`; tgrep widens to the full
 * `TgrepCapabilityState` set so the [PROJECT CAPABILITIES] block the
 * model reads shows exactly the same state names as the TUI sidebar
 * (single source of truth: `resolveTgrepCapability` in
 * `plugins/tgrep/tgrep-service.ts`). */
type Capability = "ready" | "unavailable" | TgrepCapabilityState

export interface ProjectProfile {
  readonly codegraph: Capability
  readonly gitnexus: Capability
  readonly serena: Capability
  readonly tgrep: Capability
}

export function mcpEnabledFrom(text: string, name: string): boolean {
  try {
    const json = text.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n")
    const config = JSON.parse(json) as { mcp?: Record<string, { enabled?: boolean }> }
    return config.mcp?.[name]?.enabled === true
  } catch {
    return false
  }
}

function mcpEnabled(name: string): boolean {
  try {
    const configPath = join(homedir(), ".config", "opencode", "opencode.jsonc")
    return mcpEnabledFrom(readFileSync(configPath, "utf8"), name)
  } catch {
    return false
  }
}

function indexedCapability(root: string, directory: string, mcp: string): Capability {
  return existsSync(join(root, directory)) && mcpEnabled(mcp) ? "ready" : "unavailable"
}

export function buildProfile(root: string = process.cwd()): ProjectProfile {
  // Tgrep goes through the shared resolver so the model-visible state
  // here matches the sidebar's `tgrep` badge exactly. Switch-off is
  // represented as `unavailable` for the system-prompt block (the
  // sidebar additionally folds it under OFF + hides the row, but the
  // block is meant for the model, not the user, so the omission is
  // not useful — `unavailable` is the unambiguous fallback).
  let tgrep: Capability = "unavailable"
  try {
    const options = loadTgrepOptions(root)
    if (options.enabled) tgrep = resolveTgrepCapability(root, options)
  } catch { /* optional backend stays unavailable */ }
  return {
    codegraph: indexedCapability(root, ".codegraph", "codegraph"),
    gitnexus: indexedCapability(root, ".gitnexus", "gitnexus"),
    serena: mcpEnabled("serena") ? "ready" : "unavailable",
    tgrep,
  }
}

/** Render the capabilities block. Byte-stable for the same profile —
 * the hook's cache uses the rendered text as a constant on profile
 * change. */
export function renderProfileBlock(profile: ProjectProfile): string {
  return [
    "",
    "---",
    MARKER,
    `Code intelligence: CodeGraph=${profile.codegraph}; GitNexus=${profile.gitnexus}; Serena=${profile.serena}; Text index: tgrep=${profile.tgrep}`,
    "",
  ].join("\n")
}

/** Stable, content-derived cache key for a `ProjectProfile`.
 *
 * `ProjectProfile` fields are all string literals of a closed union
 * (the `Capability` type), so `JSON.stringify` produces a deterministic
 * serialization that does not depend on engine-specific key ordering.
 * SHA-256 keeps the resulting key bounded and makes per-lookup equality
 * an O(string-length) comparison instead of a structural deep-equal.
 *
 * Pure function — exported for unit tests, no I/O, no module state. */
export function profileKey(profile: ProjectProfile): string {
  return createHash("sha256").update(JSON.stringify(profile), "utf8").digest("hex")
}

export const ProjectProfilerPlugin: Plugin = async ({ client }) => {
  ensureTgrepWatchdog()
  return {
  "experimental.chat.system.transform": async (
    input: { sessionID?: string } | undefined,
    output: { system: string[] },
  ) => {
    const log = (level: "info" | "warn", message: string) =>
      client.app.log({ body: { service: "project-profiler", level, message } })
    try {
      if (!await scoped(input, output.system, "project-profiler", client)) return

      const cwd = process.cwd()
      let profile = buildProfile(cwd)
      // Warm the watcher before rendering the capabilities block: a
      // live serve is the only way `tgrep=ready` becomes honest, and
      // this hook is the only place that runs on every chat turn (the
      // tool runs only on search). Gating on `no-watcher` keeps the
      // unready states (stale/building/no-index/no-cli) from paying for
      // a wasted probe — ensureServer itself short-circuits on them,
      // but the gating avoids the spawn attempt entirely. After ensure,
      // invalidate this hook's rendered-block cache so the block re-renders
      // with the new `ready` state on the next turn; ensureServer
      // invalidates the shared capability cache, so the re-build below
      // sees the live watcher without paying a second stale probe.
      if (profile.tgrep === "no-watcher") {
        await ensureServer(cwd, loadTgrepOptions(cwd))
        renderedBlocks.delete(cwd)
        profile = buildProfile(cwd)
      }
      const key = profileKey(profile)

      // Cache check: same key as last injection in this cwd → use the
      // cached rendered block (no re-render). Keyed on profile CONTENT
      // (SHA-256 of the profile JSON), not on cwd alone — a mid-session
      // edit to opencode.jsonc / .codegraph / .gitnexus changes the
      // profile and correctly invalidates the cache. See ADR 0002.
      const cache = renderedBlocks.get(cwd)
      const block = cache?.key === key
        ? cache.text
        : (() => {
            const text = renderProfileBlock(profile)
            renderedBlocks.set(cwd, { key, text })
            return text
          })()

      // Defensive strip — correct under Scenario B (hypothetical
      // prompt-persistence), no-op under Scenario A (verified current
      // runtime, see ADR 0002). Line-start match via the shared
      // helper. Cheap regex test.
      stripBlockByLine(output.system, MARKER)

      const beforeLen = output.system.length
      appendBlock(output.system, block)
      // Distinguish happy-path append from the no-string-entry fallback so
      // future regressions (e.g. a runtime change that drops string entries)
      // show up in the log immediately rather than as a silent missing block.
      const pushed =
        output.system.length === beforeLen + 1 &&
        output.system[output.system.length - 1] === block
      if (pushed) {
        await log(
          "warn",
          `system prompt: pushed capabilities block as new entry (system.length was ${beforeLen}, no string entry found)`,
        )
      } else {
        await log("info", "system prompt: capabilities block refreshed (profile content unchanged)")
      }
    } catch (err) {
      // Was: silent `catch { return }` — made the failure mode invisible.
      // Now: warn-level log so a regression in buildProfile / scoped / etc.
      // surfaces immediately instead of producing a silently missing block.
      await log("warn", `hook error (suppressed): ${String(err)}`)
    }
  },
  }
}

/** Per-cwd fragment cache: `cwd` → { key, text }. Tracks the last
 * rendered block per cwd so subsequent hook calls skip the
 * `renderProfileBlock` call when the profile is unchanged. The cache
 * holds the rendered text directly (not just a key), which is what
 * makes the always-inject path efficient: profile-key equality
 * → cache hit → no re-render.
 *
 * Sized by the number of cwds the user has visited this session;
 * eviction is automatic (Map frees entries when the process exits).
 *
 * Concurrency note: Node/Bun's event loop serializes Map operations,
 * so two concurrent sessions in the same cwd would share the slot
 * — that is the pre-existing behavior; the per-cwd identity model
 * stays consistent. The hook is idempotent under the cache key
 * (same profile → cache hit → no re-render), so even an interleaved
 * update is safe. */
const renderedBlocks = new Map<string, { key: string; text: string }>()

/** Watchdog cadence. Matches the shared capability-cache TTL in
 * tgrep-service so a healthy watcher returns from the cache on every
 * tick and costs only one `tgrep status` spawn. A crashed watcher
 * drops out of cache the next time ensureServer invalidates it, so
 * the worst-case detection latency is one interval. */
const TGREP_POLL_INTERVAL_MS = 30_000
let pollTimer: ReturnType<typeof setInterval> | null = null

/** Fire-and-forget watcher for tgrep state. A watcher that dies
 * between chat transforms is detected and restarted without waiting
 * for the next user message — the transform hook only re-checks on
 * user activity, so a long idle period would otherwise leave a dead
 * watcher undiscovered until the next prompt. Skipped when the state
 * is anything other than `no-watcher`: stale / building / no-index /
 * no-cli / unavailable / ready all short-circuit at the gate, so
 * disabled or non-tgrep users pay nothing. unref() so the timer
 * never keeps the host process alive on shutdown. */
function ensureTgrepWatchdog(): void {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    const cwd = process.cwd()
    if (buildProfile(cwd).tgrep !== "no-watcher") return
    ensureWatcher(cwd, loadTgrepOptions(cwd))
      .then(() => { renderedBlocks.delete(cwd) })
      // best-effort: the next tick retries if state is still no-watcher;
      // surfacing a log here would spam the channel on transient probe
      // failures (timeout, permission race during cwd change, …).
      .catch(() => { /* noop */ })
  }, TGREP_POLL_INTERVAL_MS)
  pollTimer.unref?.()
}