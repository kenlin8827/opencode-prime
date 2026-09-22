/**
 * Shared last-good cache — per-project truthful fallback on `.ocp/ocp.json` corruption.
 *
 * Problem: `readProjectConfig()` returns `null` both when the file is absent
 * (legit zero-config — defaults are correct) and when it exists but is
 * unparseable (hand-edit typo — defaults would LIE about the project's real
 * config). ADR's config table was the first place this lie became visible:
 * a corrupt `snake` project's table would silently flip to `madr`/`kebab`.
 *
 * Solution pattern (Phase 7.9, now shared):
 *   1. Single-IO transparent corruption check — one `readFileSync+JSON.parse(stripJsonc)`
 *      pass; `corrupt=true` only when the file exists and that parse throws.
 *      An absent file is NOT corrupt — defaults are legitimately correct.
 *   2. Per-project sharding — keyed by `getProjectDir()` (which `ocpConfigFile()`
 *      resolves against). A single process may serve multiple project dirs
 *      (IDE workspace, test harness); a global singleton would let a corrupt
 *      file in project A poison the value served to project B.
 *   3. Fresh-vs-corrupt decision:
 *        corrupt & has memo → serve memo (stale but truthful)
 *        corrupt & no memo  → degrade to defaults (cold-start), never memoize
 *        not corrupt        → render/load fresh and memoize (healing)
 *   4. Map-miss history fallback (low-frequency, restart-only):
 *        When the in-memory Map has no entry (e.g. process restart before any
 *        good read) and the file is corrupt, optionally try to load the last
 *        good fragment/value from the conversational/system history via a
 *        caller-supplied `loadFromHistory` callback. This path is expected to
 *        be rare; it runs at most once per corrupt session until healed.
 *        Failure is always fail-open to defaults — never throw.
 *
 * This module provides the shared primitives so any plugin can opt into the
 * same contract without duplicating Map/corrupt/history logic:
 *   - `isProjectConfigCorrupt()` — single source for the existence+parse check.
 *   - `createProjectScopedMemo<T>()` — per-project Map wrapper.
 *   - `createFragmentLastGoodCache()` / `createStateLastGoodCache()` — higher-level
 *     helpers for string fragments (ADR table) and switch states (plugin-switch).
 *   - `extractLastMarkerBlock()` / `loadLastMarkerFromHistory()` — history-scan helpers.
 *
 * Keep the history loader caller-supplied: server plugins use `client.session.*`,
 * TUI plugins use `api.client.session.*`, tests use a stub. This module never
 * imports plugin-specific channel types.
 */

import { existsSync, readFileSync } from "node:fs"
import { getProjectDir, ocpConfigFile, stripJsonc } from "./opencode-prime"

// ─── Corruption check (single source) ───────────────────────────────

/** True only when `.ocp/ocp.json` EXISTS but cannot be parsed as JSONC.
 *  An absent file is NOT corruption — defaults are legitimately correct.
 *  One file read, same `JSON.parse(stripJsonc(...))` semantics as
 *  `parseConfigFile` in `opencode-prime`. */
export function isProjectConfigCorrupt(): boolean {
  const file = ocpConfigFile()
  if (!existsSync(file)) return false
  try {
    JSON.parse(stripJsonc(readFileSync(file, "utf-8")))
    return false
  } catch {
    return true
  }
}

// ─── Per-project Map primitive ──────────────────────────────────────

/** Per-project memo keyed by `getProjectDir()`. Module-level Map — one
 *  instance per call to `createProjectScopedMemo`; each plugin owns its
 *  own instance so fragments/switch states never collide. */
export interface ProjectScopedMemo<T> {
  /** Key for the current project dir (test helpers may pass explicit dir). */
  key(): string
  keyFor(dir: string): string
  get(): T | undefined
  getFor(dir: string): T | undefined
  has(): boolean
  hasFor(dir: string): boolean
  set(value: T): void
  setFor(dir: string, value: T): void
  delete(dir?: string): void
  clear(): void
  size(): number
}

export function createProjectScopedMemo<T>(): ProjectScopedMemo<T> {
  const map = new Map<string, T>()
  const normalize = (dir: string): string => dir.trim() || getProjectDir()
  return {
    key(): string { return getProjectDir() },
    keyFor(dir: string): string { return normalize(dir) },
    get(): T | undefined { return map.get(getProjectDir()) },
    getFor(dir: string): T | undefined { return map.get(normalize(dir)) },
    has(): boolean { return map.has(getProjectDir()) },
    hasFor(dir: string): boolean { return map.has(normalize(dir)) },
    set(value: T): void { map.set(getProjectDir(), value) },
    setFor(dir: string, value: T): void { map.set(normalize(dir), value) },
    delete(dir?: string): void {
      if (typeof dir === "string" && dir.trim() !== "") map.delete(normalize(dir))
      else map.delete(getProjectDir())
    },
    clear(): void { map.clear() },
    size(): number { return map.size },
  }
}

// ─── History extraction helpers ─────────────────────────────────────

/** Extract the last occurrence of a marker block from an array of system-fragment
 *  strings or a single concatenated string. Returns the substring starting at the
 *  last marker occurrence (trimmed on the leading edge), or null when absent.
 *  Pure — no I/O, suitable for tests. */
export function extractLastMarkerBlock(
  haystacks: string[] | string,
  marker: string,
): string | null {
  const sources: string[] = Array.isArray(haystacks) ? haystacks : [haystacks]
  let best: { idx: number; source: string; pos: number } | null = null
  // We want the *last* marker occurrence across all sources; track global order by
  // source index then position within source.
  for (let si = 0; si < sources.length; si++) {
    const src = sources[si]
    if (typeof src !== "string") continue
    let from = 0
    for (;;) {
      const pos = src.indexOf(marker, from)
      if (pos === -1) break
      best = { idx: si, source: src, pos }
      from = pos + marker.length
    }
  }
  if (!best) return null
  // Return from the last marker occurrence onward, with leading whitespace/newlines preserved
  // as originally injected (fragments are injected verbatim). Trim only leading/trailing
  // excess so the cache hit stays byte-identical to the original render.
  // Find the start of the enclosing fragment: walk back to the nearest `\n` before pos or 0.
  // For ADR fragments the block starts at the marker's prefix newlines already.
  // Returning from pos keeps it minimal and still matches `hasAnyMarker` detection.
  const fragment = best.source.slice(best.pos)
  // If source had multiple marker blocks, the last occurrence's tail may contain earlier content
  // before it — we want just from marker onward, which is exactly slice(pos).
  // Normalize leading: keep marker as anchor, ensure it starts at marker.
  return fragment
}

/** Scan an opencode session's messages for the last text part containing `marker`.
 *  The message shape varies between server and TUI clients; this helper duck-types
 *  over `info/parts`, `parts[].text`, `parts[].type`, and plain string content.
 *  Returns the last matching block (from marker onward) or null. Pure. */
export function extractLastMarkerFromMessages(messages: unknown, marker: string): string | null {
  if (!Array.isArray(messages)) return null
  const candidates: string[] = []
  for (const entry of messages as any[]) {
    // TUI/Server shape: { info, parts } or { role, content } or plain message
    let parts: unknown = null
    if (entry && typeof entry === "object") {
      if (Array.isArray((entry as any).parts)) parts = (entry as any).parts
      else if (Array.isArray((entry as any).content)) parts = (entry as any).content
      else if (typeof (entry as any).text === "string") candidates.push((entry as any).text)
      else if (typeof (entry as any).content === "string") candidates.push((entry as any).content)
    }
    if (Array.isArray(parts)) {
      for (const p of parts as any[]) {
        if (!p || typeof p !== "object") continue
        // text parts: { type:"text", text:"..." } or { text:"..." }
        const text = typeof p.text === "string"
          ? p.text
          : typeof (p as any).content === "string" ? (p as any).content : null
        if (text) candidates.push(text)
      }
    }
  }
  if (candidates.length === 0) return null
  // Find last candidate containing marker, return from last occurrence onward
  for (let i = candidates.length - 1; i >= 0; i--) {
    const idx = candidates[i].indexOf(marker)
    if (idx !== -1) return candidates[i].slice(idx)
  }
  return null
}

/** Try to load the last marker block from session history via `client`.
 *  Duck-types both server (`client.session.get/messages`) and TUI
 *  (`api.client.session.messages`) signatures. Never throws — returns null
 *  on any failure (wrong client, missing session, not found). Low-frequency
 *  path: only called when the in-memory Map missed on a corrupt file,
 *  e.g. immediately after a process restart. */
export async function loadLastMarkerFromHistory(
  client: unknown,
  sessionID: string | undefined,
  marker: string,
): Promise<string | null> {
  if (!sessionID || !client || typeof (client as any).session !== "object") return null
  const session = (client as any).session
  try {
    // Try messages() with both signature styles — whichever exists wins
    let raw: unknown = null
    if (typeof session.messages === "function") {
      try {
        // TUI style: messages({ sessionID })
        const res = await session.messages({ sessionID })
        raw = (res as any)?.data ?? res
      } catch { /* try alternate style */ }
      if (!raw || (Array.isArray(raw) && raw.length === 0)) {
        try {
          // Server style: messages({ path: { id: sessionID } })
          const res2 = await session.messages({ path: { id: sessionID } })
          raw = (res2 as any)?.data ?? res2
        } catch { /* ignore */ }
      }
      if (!raw || (Array.isArray(raw) && raw.length === 0)) {
        try {
          // Alternate: messages(sessionID)
          const res3 = await session.messages(sessionID)
          raw = (res3 as any)?.data ?? res3
        } catch { /* ignore */ }
      }
    }
    if (Array.isArray(raw) && raw.length > 0) {
      return extractLastMarkerFromMessages(raw, marker)
    }
    // Also try session.get which may return a single session with embedded messages/context
    if (typeof session.get === "function" && !raw) {
      try {
        const res = await session.get({ path: { id: sessionID } })
        const data: any = (res as any)?.data ?? res
        // Some servers embed recent system blocks in session data — scan string fields
        const scanTargets: string[] = []
        if (data) {
          for (const v of Object.values(data)) if (typeof v === "string") scanTargets.push(v)
          if (Array.isArray((data as any).messages)) {
            const hit = extractLastMarkerFromMessages((data as any).messages, marker)
            if (hit) return hit
          }
        }
        if (scanTargets.length) {
          return extractLastMarkerBlock(scanTargets, marker)
        }
      } catch { /* ignore */ }
    }
  } catch { /* never throw — fail open */ }
  return null
}

// ─── Fragment cache (ADR config table pattern) ──────────────────────

/** Options for a per-project string-fragment last-good cache (e.g. ADR
 *  `[ADR-CONFIG-RUNTIME]` markdown table). */
export interface FragmentLastGoodOptions {
  /** Marker string that identifies the fragment (e.g. `[ADR-CONFIG-RUNTIME]`).
   *  Used for history extraction. */
  marker: string
  /** Render a fresh fragment from the current on-disk/config state (sync).
   *  Called only on the not-corrupt path; should be single-IO when possible. */
  renderFresh: () => string
  /** Render the default fragment when no memo and no history is available
   *  (sync). Defaults to `renderFresh` (which for ADR falls back to defaults
   *  when the file is absent/unparsable). */
  renderDefault?: () => string
}

export interface FragmentLastGoodCache {
  readonly memo: ProjectScopedMemo<string>
  readonly marker: string
  /** Synchronous truthful fragment: stale-but-true on corrupt+hit, defaults on
   *  corrupt+miss, fresh+memorized otherwise. No history. */
  getSync(): string
  /** Async variant that also tries history on corrupt+miss (restart recovery).
   *  Pass the opencode client and sessionID when available; omitting them
   *  degrades to the sync behavior (still truthful, just without history). */
  getWithHistory(client?: unknown, sessionID?: string): Promise<string>
  /** Clear memo for the current project (no-arg) or for a specific project dir. */
  clear(dir?: string): void
  /** Test helper: corrupt check used by this cache (re-exported). */
  isCorrupt(): boolean
}

export function createFragmentLastGoodCache(
  opts: FragmentLastGoodOptions,
): FragmentLastGoodCache {
  const memo = createProjectScopedMemo<string>()
  const renderDefault = opts.renderDefault ?? opts.renderFresh
  return {
    memo,
    marker: opts.marker,
    isCorrupt: isProjectConfigCorrupt,
    getSync(): string {
      if (isProjectConfigCorrupt()) {
        const hit = memo.get()
        if (hit !== undefined) return hit
        // Cold-start corrupt — degrade to defaults, never memoize so healing works
        return renderDefault()
      }
      const fresh = opts.renderFresh()
      memo.set(fresh)
      return fresh
    },
    async getWithHistory(client?: unknown, sessionID?: string): Promise<string> {
      if (isProjectConfigCorrupt()) {
        const hit = memo.get()
        if (hit !== undefined) return hit
        // Low-frequency restart recovery: try history before falling back to lies
        if (client && sessionID) {
          try {
            const fromHistory = await loadLastMarkerFromHistory(client, sessionID, opts.marker)
            if (typeof fromHistory === "string" && fromHistory.includes(opts.marker)) {
              memo.set(fromHistory)
              return fromHistory
            }
          } catch { /* fail open */ }
        }
        return renderDefault()
      }
      const fresh = opts.renderFresh()
      memo.set(fresh)
      return fresh
    },
    clear(dir?: string): void { memo.delete(dir) },
  }
}

// ─── Switch-state cache (plugin-switch pattern) ─────────────────────

/** Options for a per-project typed switch-state last-good cache (e.g.
 *  `adrGuard` / `autoAdvisorMode` / `e2eGuard`). Caches the last normalized
 *  state value; serves it on corrupt instead of lying with the default. */
export interface StateLastGoodOptions<TState extends string> {
  field: string
  defaultState: TState
  normalize: (raw: unknown, aliases: Record<string, TState>) => TState | null
  aliases: Record<string, TState>
  readRaw: () => unknown // typically: () => readProjectConfig()?.[field]
  marker?: string // optional marker for history scan; when absent, history is skipped
  extractFromHistoryText?: (text: string) => TState | null // optional parser for history blocks
}

export interface StateLastGoodCache<TState extends string> {
  readonly memo: ProjectScopedMemo<TState>
  getState(): TState
  getStateWithHistory(client?: unknown, sessionID?: string): Promise<TState>
  setState(state: TState): void // memoize explicitly (call after a successful write)
  clear(dir?: string): void
  isCorrupt(): boolean
}

export function createStateLastGoodCache<TState extends string>(
  opts: StateLastGoodOptions<TState>,
): StateLastGoodCache<TState> {
  const memo = createProjectScopedMemo<TState>()
  return {
    memo,
    isCorrupt: isProjectConfigCorrupt,
    getState(): TState {
      if (isProjectConfigCorrupt()) {
        const hit = memo.get()
        if (hit !== undefined) return hit
        return opts.defaultState // cold-start corrupt — fail-open to default
      }
      const raw = opts.readRaw()
      const normalized = opts.normalize(raw, opts.aliases)
      if (normalized !== null) {
        memo.set(normalized)
        return normalized
      }
      // Absent/unrecognized is NOT corruption — default is correct; don't memoize the default
      // as "truth" (it would mask a future real value). Only memoized values are those that
      // came from a successful parse of a present field.
      return opts.defaultState
    },
    async getStateWithHistory(client?: unknown, sessionID?: string): Promise<TState> {
      if (isProjectConfigCorrupt()) {
        const hit = memo.get()
        if (hit !== undefined) return hit
        if (client && sessionID && opts.marker && opts.extractFromHistoryText) {
          try {
            const block = await loadLastMarkerFromHistory(client, sessionID, opts.marker)
            if (typeof block === "string") {
              const parsed = opts.extractFromHistoryText(block)
              if (parsed !== null) {
                memo.set(parsed)
                return parsed
              }
            }
          } catch { /* fail open */ }
        }
        return opts.defaultState
      }
      const raw = opts.readRaw()
      const normalized = opts.normalize(raw, opts.aliases)
      if (normalized !== null) {
        memo.set(normalized)
        return normalized
      }
      return opts.defaultState
    },
    setState(state: TState): void { memo.set(state) },
    clear(dir?: string): void { memo.delete(dir) },
  }
}
