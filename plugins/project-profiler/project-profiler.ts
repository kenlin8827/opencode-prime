/**
 * Hook: `ctx.session.hook("context")` — advertises the runtime
 * backend capabilities (CodeGraph / GitNexus / Serena / tgrep) to the
 * LLM via a single `[PROJECT CAPABILITIES]` block appended to the
 * system prompt.
 *
 * V2 hook mapping (v1 → v2): `experimental.chat.system.transform` →
 * `ctx.session.hook("context")`; `e.system` is the mutable `SystemPart[]`
 * the shared system-block helpers already accept. `client.app.log` has no
 * v2 equivalent → structured `console` line (server log), as in
 * ai-slop-scanner / auto-format.
 *
 * Opencode runtime note (verified 2026-09-11, see ADR 0002): the
 * runtime rebuilds `e.system` per chat request — e.system
 * never contains fragments injected on a previous step. That means:
 *
 *   - A "skip on same profile" optimization would leave the LLM
 *     without the capabilities block after the first turn, so we
 *     always inject.
 *   - Provider-side prompt-cache stays warm because the injected
 *     block is byte-identical across turns (profile unchanged → same
 *     rendered text → same final system prompt → provider cache hit).
 *   - Per-turn cost is dominated by `renderProfileBlock` (~µs). Cache
 *     the rendered block per (project root, profile-key) to avoid
 *     re-rendering on every chat. Profile rarely changes, so the cache
 *     hits almost every call.
 *
 * The per-root key handles the "session opened in another project" case —
 * each project root's profile is independently cached. A profile change
 * (e.g. `opencode.jsonc` edited mid-session, tgrep watcher died)
 * changes the key and forces a re-render.
 *
 * Same fragment-cache + always-inject pattern as auto-advisor /
 * adr / project-manager.
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { Plugin } from "@opencode/plugin"
import { scopedForAgent, type V2Session } from "../shared/agent-scope"
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

/** Server enablement from the effective v2 config: servers live under
 *  `mcp.servers`, the flag is `disabled` (no `enabled` field in v2 — docs:
 *  /v2/docs/mcp-servers), and only an explicit `disabled: true` turns one
 *  off. Absent server entry = unavailable.
 *
 *  Why the config file and not `ctx.mcp.list()`: measured on opencode v2.0.15
 *  (throwaway probe plugin, 2026-09-24), the plugin-side MCP domain returns
 *  `{ data: [] }` for every call shape available to a plugin — no argument,
 *  `{ directory }`, and 5 s after setup — while `GET /api/mcp` from the CLI
 *  on the same running service lists all six configured servers. Building
 *  capability reporting on that empty snapshot would pin every backend to
 *  `unavailable`, i.e. trade a fixed bug for a worse one. Revisit when the
 *  plugin context exposes per-location MCP state. */
export function mcpEnabledFrom(text: string, name: string): boolean {
  try {
    const json = text.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n")
    const config = JSON.parse(json) as { mcp?: { servers?: Record<string, { disabled?: boolean }> } }
    const server = config.mcp?.servers?.[name]
    return server !== undefined && server.disabled !== true
  } catch {
    return false
  }
}

/** Cached read of the global config's enablement. One file read per TTL
 *  window per backend, not one per capability per model request. */
const MCP_CONFIG_TTL_MS = 15_000
let mcpConfigAt = 0
let mcpConfigText: string | null = null

function mcpEnabled(name: string): boolean {
  try {
    const now = Date.now()
    if (now - mcpConfigAt > MCP_CONFIG_TTL_MS) {
      mcpConfigText = readFileSync(join(homedir(), ".config", "opencode", "opencode.jsonc"), "utf8")
      mcpConfigAt = now
    }
    return mcpConfigText === null ? false : mcpEnabledFrom(mcpConfigText, name)
  } catch {
    return false
  }
}

function indexedCapability(
  root: string,
  indexDir: string,
  server: string,
  isEnabled: (name: string) => boolean,
): Capability {
  return existsSync(join(root, indexDir)) && isEnabled(server) ? "ready" : "unavailable"
}

export function buildProfile(
  root: string,
  isEnabled: (name: string) => boolean = mcpEnabled,
): ProjectProfile {
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
    codegraph: indexedCapability(root, ".codegraph", "codegraph", isEnabled),
    gitnexus: indexedCapability(root, ".gitnexus", "gitnexus", isEnabled),
    serena: isEnabled("serena") ? "ready" : "unavailable",
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

export const ProjectProfilerPlugin = Plugin.define({
  id: "project-profiler",
  async setup(ctx) {
    const session = ctx.session as unknown as V2Session
    ensureTgrepWatchdog(async () => {
      for (const root of [...renderedBlocks.keys()]) {
        if (buildProfile(root).tgrep !== "no-watcher") continue
        ensureWatcher(root, loadTgrepOptions(root))
          .then(() => { renderedBlocks.delete(root) })
          // best-effort: the next tick retries; logging transient probe
          // failures would spam the channel.
          .catch(() => { /* noop */ })
      }
    })

    const context = await ctx.session.hook("context", async (e) => {
      // v2 dropped the v1 `client.app.log` API — structured console lines are
      // the repo's server-log channel (same pattern as ai-slop-scanner).
      const log = (level: "info" | "warn", message: string) =>
        console[level === "warn" ? "warn" : "log"](
          JSON.stringify({ service: "project-profiler", level, message }),
        )
      const system = Array.isArray(e.system) ? e.system : []
      try {
        if (!(await scopedForAgent(e, "project-profiler", session))) return

        // The session's own project root — a shared background server hosts
        // many locations, so `process.cwd()` is the service launch directory,
        // not this session's project (the old read advertised another repo's
        // `CodeGraph=ready` here). Falls back to the plugin instance's
        // location, then cwd, so the block is never silently dropped.
        const root =
          (await sessionDirectory(session, e.sessionID)) ?? ctx.location.directory ?? process.cwd()
        let profile = buildProfile(root)
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
          await ensureServer(root, loadTgrepOptions(root))
          renderedBlocks.delete(root)
          profile = buildProfile(root)
        }
        const key = profileKey(profile)

        // Cache check: same key as last injection in this root → use the
        // cached rendered block (no re-render). Keyed on profile CONTENT
        // (SHA-256 of the profile JSON), not on the root alone — a mid-session
        // edit to opencode.jsonc / .codegraph / .gitnexus changes the
        // profile and correctly invalidates the cache. See ADR 0002.
        const cache = renderedBlocks.get(root)
        const block = cache?.key === key
          ? cache.text
          : (() => {
              const text = renderProfileBlock(profile)
              renderedBlocks.set(root, { key, text })
              return text
            })()

        // Defensive strip — correct under Scenario B (hypothetical
        // prompt-persistence), no-op under Scenario A (verified current
        // runtime, see ADR 0002). Line-start match via the shared
        // helper. Cheap regex test.
        stripBlockByLine(system, MARKER)

        const beforeLen = system.length
        appendBlock(system, block)
        // Distinguish happy-path append (block merged into an existing text
        // part) from the no-text-part fallback: `appendBlock` only pushes a
        // new entry when the array carried no text part at all, so a push
        // here means the platform handed us a shape with nowhere to append.
        // Future regressions must show up in the log immediately rather than
        // as a silently missing block.
        const last = system[system.length - 1] as { text?: string } | string | undefined
        const lastText = typeof last === "string" ? last : last?.text
        const pushed = system.length === beforeLen + 1 && lastText === block
        if (pushed) {
          log(
            "warn",
            `system prompt: pushed capabilities block as new entry (system.length was ${beforeLen}, no text part found)`,
          )
        } else {
          log("info", "system prompt: capabilities block refreshed (profile content unchanged)")
        }
      } catch (err) {
        // Was: silent `catch { return }` — made the failure mode invisible.
        // Now: warn-level log so a regression in buildProfile / scopedForAgent
        // surfaces immediately instead of producing a silently missing block.
        log("warn", `hook error (suppressed): ${String(err)}`)
      }
    })

    return async () => {
      await context.dispose()
    }
  },
})

export default ProjectProfilerPlugin

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

/** Fire-and-forget cadence for the probes that must keep running while no
 * prompt is in flight: the live MCP snapshot refresh, and the per-project
 * tgrep watcher restart (a watcher that dies between context-hook passes
 * would otherwise stay undiscovered until the next user message). Roots come
 * from `renderedBlocks`, so only projects this server actually served are
 * probed, and each restart is gated on `no-watcher` — disabled or non-tgrep
 * users pay nothing. unref() so the timer never keeps the host process alive
 * on shutdown. */
function ensureTgrepWatchdog(tick: () => Promise<void>): void {
  if (pollTimer) return
  pollTimer = setInterval(() => { void tick() }, TGREP_POLL_INTERVAL_MS)
  pollTimer.unref?.()
}

/** Session project roots, cached per session — a session outlives the many
 *  hook passes that need its root, and the lookup is one session.get. A
 *  mid-session `session.move` is rare enough to be absorbed by the next
 *  profile-key change. Bounded and cleared wholesale, like the subagent
 *  cache in agent-scope. */
const dirBySession = new Map<string, string>()

/** Resolve a session's own project root (`Session.Info.location.directory`).
 *  Accepts both the wrapped `{ data: Session }` envelope and a bare session
 *  object, so the reader does not depend on which client layer unwraps it.
 *  Returns null when the id, the method, or the field is missing — the
 *  caller then falls back to the plugin instance's location. */
async function sessionDirectory(
  session: V2Session,
  sessionID: string | null | undefined,
): Promise<string | null> {
  if (!sessionID || typeof session.get !== "function") return null
  const hit = dirBySession.get(sessionID)
  if (hit) return hit
  try {
    const raw = (await session.get({ sessionID })) as { data?: unknown } | unknown
    const info = (raw && typeof raw === "object" && "data" in raw
      ? (raw as { data: unknown }).data
      : raw) as { location?: { directory?: unknown } } | undefined
    const directory = info?.location?.directory
    if (typeof directory !== "string" || directory === "") return null
    if (dirBySession.size >= 512) dirBySession.clear()
    dirBySession.set(sessionID, directory)
    return directory
  } catch {
    return null
  }
}