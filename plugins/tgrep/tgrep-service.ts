import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tgrepIndexArgs, type TgrepOptions } from "./tgrep-config"
import { isTgrepPolicyCurrent, readTgrepIndexState, tgrepPolicyFingerprint, writeTgrepIndexState } from "./tgrep-state"

export type TgrepReadiness = "unavailable" | "building" | "disk-index" | "server" | "stale"

export function tgrepIndexCommand(options: TgrepOptions): string[] { return ["index", ".", ...tgrepIndexArgs(options)] }
export function tgrepServeCommand(options: TgrepOptions): string[] { return ["serve", ".", ...tgrepIndexArgs(options)] }
/** tgrep status accepts --index-path/--max-filesize/--no-require-git but
 * REJECTS --exclude (index/serve only — verified against tgrep 1.0.5), so the
 * status probe carries the status-safe subset; a rejected flag here would fail
 * every probe and permanently degrade searches to rg. */
export function tgrepStatusCommand(options: TgrepOptions): string[] {
  const args: string[] = []
  if (options.indexPath) args.push("--index-path", options.indexPath)
  if (options.maxFileSize) args.push("--max-filesize", options.maxFileSize)
  if (options.noRequireGit) args.push("--no-require-git")
  return ["status", ".", ...args]
}
export function hasTgrepIndex(root: string, options: TgrepOptions): boolean { return existsSync(join(root, options.indexPath ?? ".tgrep")) }

export function tgrepVersion(root: string): string | null {
  const result = spawnSync("tgrep", ["--version"], { cwd: root, encoding: "utf8", timeout: 5000, windowsHide: true })
  return result.status === 0 ? String(result.stdout).trim() || null : null
}

/** CLI-on-PATH probe — bool form of tgrepVersion(). Same spawn contract
 * (windowsHide on Win32, 5s timeout, utf8 stdout). Used by sidebar-status
 * to distinguish "binary missing" (→ NO CLI badge) from "binary present,
 * no index yet" (→ NO INDEX badge) without paying for a second probe —
 * tgrepVersion is already cheap. Exported so other callers can short-
 * circuit on missing CLI without parsing version strings. */
export function hasTgrepCli(root: string): boolean {
  return tgrepVersion(root) !== null
}

/**
 * Tgrep user-facing capability state — the single source of truth shared
 * by the TUI sidebar (buildProjectBadges) AND the [PROJECT CAPABILITIES]
 * system-prompt block (project-profiler buildProfile). UI text and
 * model-visible state MUST stay in sync, or the model will reach for
 * `tgrep_search` when the sidebar shows NO CLI / NO INDEX and the call
 * will silently fail / fall back to rg.
 *
 * State set (same names in sidebar badge, project-profiler marker, and
 * tool description):
 *   ready       — watcher up, index current; `freshness: "indexed"` is cheap + accurate
 *   no-watcher  — index on disk but no live serve; indexed mode falls back to rg
 *   stale       — index built under different policy; do not trust indexed mode
 *   building    — index build in progress; wait or use rg
 *   no-index    — CLI present, no `.tgrep/` yet; run /project index
 *   no-cli      — switch on, binary missing; install tgrep
 *
 * Cross-platform invariant: state names are kebab-case ASCII (no path
 * or platform-specific text), so the same set renders identically on
 * Windows, macOS, and Linux — both in the sidebar and in the system prompt.
 */
export type TgrepCapabilityState = "ready" | "no-watcher" | "stale" | "building" | "no-index" | "no-cli"

/** Internal mapping from raw probe readiness + disk truth to the user-
 * facing state set above. Pure function so tests cover the matrix
 * without spawning a real CLI. */
function readinessToCapability(readiness: TgrepReadiness, hasIndex: boolean): TgrepCapabilityState {
  if (readiness === "server") return "ready"
  if (readiness === "building") return "building"
  if (readiness === "stale") return "stale"
  if (readiness === "disk-index") return "no-watcher"
  // readiness === "unavailable" — CLI is present (caller checked).
  return hasIndex ? "no-watcher" : "no-index"
}

/** Resolve the current tgrep capability for a project root. Used by both
 * the sidebar (for badge rendering) and the project profiler (for the
 * [PROJECT CAPABILITIES] block in the system prompt) so the two stay
 * aligned. Runs two spawnSyncs (`tgrep --version` + `tgrep status`) on
 * the happy path; both use windowsHide so the call is safe on Win32.
 *
 * The "switch off" branch (`tools.tgrep === false`) is the caller's
 * responsibility — see resolveTgrep() in sidebar-status.ts for the
 * example wrapper that folds it in. */
export function resolveTgrepCapability(root: string, options: TgrepOptions): TgrepCapabilityState {
  const key = `${root}\n${JSON.stringify(options)}`
  const hit = capabilityCache.get(key)
  if (hit && Date.now() - hit.at < CAPABILITY_CACHE_TTL_MS) return hit.state
  const state = probeTgrepCapability(root, options)
  capabilityCache.set(key, { at: Date.now(), state })
  return state
}

/** Uncached probe behind resolveTgrepCapability — exported for tests so the
 * probe matrix stays verifiable without fighting the TTL cache. */
export function probeTgrepCapability(root: string, options: TgrepOptions): TgrepCapabilityState {
  if (!hasTgrepCli(root)) return "no-cli"
  const hasIndex = hasTgrepIndex(root, options)
  const readiness = probeTgrepStatus(root, options)
  return readinessToCapability(readiness, hasIndex)
}

// ponytail: single global TTL cache — capability probes are per-root cheap
// and monotonic within a TTL window; a Map keyed by root+options is enough,
// no per-root invalidation channel needed. A hung tgrep binary would still
// block one event-loop turn per TTL window (up to 2×5s), not per tick.
const CAPABILITY_CACHE_TTL_MS = 30_000
const capabilityCache = new Map<string, { at: number; state: TgrepCapabilityState }>()

/** Pure parser for `tgrep status` output. Extracted from probeTgrepStatus()
 * so the field-by-field mapping is unit-testable without spawning a real
 * CLI and without touching the filesystem. Cross-platform rules:
 *   - line endings can be LF or CRLF (Windows spawnSync sometimes returns
 *     \r\n even with encoding:"utf8"); we split on /\r?\n/ and trim.
 *   - the "Index status for <path>" header path is platform-specific
 *     (Windows emits "\\\\?\\D:\\…" verbatim, Unix uses "/home/…"); we
 *     never parse it — only field labels matter.
 *   - field labels (`Watcher:` for the watcher state, plus `Indexing:`,
 *     `Files:`, `Trigrams:`, `Created:`, `Updated:`) are the stable
 *     contract across tgrep versions; vocabulary under each label is
 *     version-dependent and we intentionally stay narrow on the "down"
 *     indicators and broad on "up" indicators so future versions
 *     (e.g. host:port strings) keep working without code changes.
 *     `Watcher:` is the field name in tgrep 1.0.5 (the version
 *     install/tools.jsonc pins).
 *
 * Policy gating (server vs stale) lives here too so a single call decides
 * both halves of the readiness decision; `hasIndex` is passed in so the
 * caller controls the disk-truth check (and tests can swap it).
 *
 * Exported for tests; not part of the public plugin API. */
export function parseTgrepStatusOutput(
  output: string,
  root: string,
  options: TgrepOptions,
  hasIndex: boolean,
): TgrepReadiness {
  if (!output) return hasIndex ? "disk-index" : "unavailable"
  // Split → trim → drop blanks so CRLF and stray whitespace don't merge
  // field labels across lines (e.g. a future tgrep version that wraps a
  // long value would otherwise shift "Server: not running" into a single
  // line containing both "Server:" and the value of the next field).
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
  const matchLine = (re: RegExp): boolean => lines.some((line) => re.test(line))

  // "Indexing: building" / "Indexing: in progress" is the only signal for
  // an in-flight build across all observed tgrep versions. It wins over
  // the Server: field — a freshly started watcher reports building before
  // it reports running, and we want to wait, not start a second probe.
  if (matchLine(/^Indexing:\s*(building|in progress)\b/i)) return "building"

  // Watcher signal — `Watcher: <value>` is the field tgrep 1.0.5 emits
  // (verified against the installed binary). Any non-"down" value
  // ("active", "running", pid, etc.) means a watcher is up. Missing
  // field defaults to "down".
  const watcherLine = lines.find((line) => /^Watcher:/i.test(line))
  const watcherDown = !watcherLine
    || /^\s*(not running|none|stopped|down|off)\b/i.test(watcherLine.slice(watcherLine.indexOf(":") + 1))
  if (!watcherDown) {
    // Policy fingerprint gates correctness — an index built under a
    // different exclude/size profile must not be trusted by OCP even if
    // the watcher is healthy. /project index rebuilds it.
    return isTgrepPolicyCurrent(root, options) ? "server" : "stale"
  }

  // No live watcher: whatever is on disk is a snapshot, not a live view.
  // The probe distinguishes "snapshot exists" from "no index at all" via
  // the caller-supplied hasIndex so the same parser works for both
  // pre-index (CLI present, no `.tgrep/`) and post-index (CLI present,
  // `.tgrep/` exists, no watcher) shapes.
  return hasIndex ? "disk-index" : "unavailable"
}

/** A safe, argv-only status probe. Failure is intentionally unavailable.
 * A healthy server whose index metadata does not match the current policy is
 * reported as "stale": indexed searches must not trust that index (results
 * could violate the configured exclude/size policy) until /project index
 * rebuilds it.
 *
 * The parser (parseTgrepStatusOutput) is pure and tested without IO;
 * this wrapper only handles spawning the CLI and the pre-parser
 * fallback for non-zero exits (no / corrupt output). The disk-truth
 * check (`hasTgrepIndex`) is captured once and threaded through both
 * branches so a TOCTOU race inside the same probe cycle can't flip
 * the readiness between exit-failed and parsed-success paths. */
export function probeTgrepStatus(root: string, options: TgrepOptions): TgrepReadiness {
  const status = spawnSync("tgrep", tgrepStatusCommand(options), { cwd: root, encoding: "utf8", timeout: 5000, windowsHide: true })
  const onDisk = hasTgrepIndex(root, options)
  if (status.error || status.status !== 0) return onDisk ? "disk-index" : "unavailable"
  const stdout = typeof status.stdout === "string" ? status.stdout : ""
  const stderr = typeof status.stderr === "string" ? status.stderr : ""
  return parseTgrepStatusOutput(`${stdout}\n${stderr}`, root, options, onDisk)
}

export function tgrepNeedsRebuild(root: string, options: TgrepOptions): boolean {
  if (!hasTgrepIndex(root, options)) return false
  const state = readTgrepIndexState(root, options)
  // Old indexes without OCP metadata are intentionally treated as stale once;
  // this establishes a reproducible policy/version baseline.
  if (!state) return true
  if (state.fingerprint !== tgrepPolicyFingerprint(options)) return true
  return state.version !== (tgrepVersion(root) ?? "unknown")
}

export function recordSuccessfulIndex(root: string, options: TgrepOptions): void {
  writeTgrepIndexState(root, options, tgrepVersion(root) ?? "unknown")
}

export interface TgrepLease { root: string; pid?: number; startedAt: number; args: string[]; child: ChildProcess; lockPath: string }
const leases = new Map<string, TgrepLease>()

function leaseLockPath(root: string, options: TgrepOptions): string { return join(root, options.indexPath ?? ".tgrep", ".ocp-tgrep-serve.lock") }

function isPidAlive(pid: number): boolean {
  // pid <= 0 has signal-group semantics (kill(0) hits the whole group) and is
  // never a valid lock owner.
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" }
}

function readLeaseOwnerPid(lockPath: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown }
    return typeof parsed.pid === "number" ? parsed.pid : null
  } catch { return null }
}

/** Exclusive-create the lease lock. A lock left behind by a dead owner
 * (crashed session, reboot) is detected via its PID and cleared, so a stale
 * lock can never permanently degrade tgrep to rg fallbacks. Exported for
 * tests. */
export function acquireLeaseLock(root: string, options: TgrepOptions): string | null {
  const lockPath = leaseLockPath(root, options)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx")
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, root, startedAt: new Date().toISOString() })}\n`, "utf8")
      closeSync(fd)
      return lockPath
    } catch {
      const owner = readLeaseOwnerPid(lockPath)
      if (owner !== null && isPidAlive(owner)) return null // genuinely held by a live process
      try { unlinkSync(lockPath) } catch { return null } // cannot clear → never race an unknown owner
    }
  }
  return null
}

function releaseLeaseLock(path: string): void { try { unlinkSync(path) } catch { /* only best-effort cleanup */ } }

/** Start at most one OCP-owned watcher per root. Existing user watchers are
 * deliberately reused and never recorded as a lease that OCP could kill. */
export async function ensureServer(root: string, options: TgrepOptions, timeoutMs = 15_000): Promise<TgrepReadiness> {
  const before = probeTgrepStatus(root, options)
  if (before !== "disk-index") return before
  // Never babysit an index built under a different policy: the watcher would
  // mix old-policy content with new-policy updates. /project index rebuilds
  // it, and searches fall back to full scans meanwhile.
  if (!isTgrepPolicyCurrent(root, options)) return "stale"
  const active = leases.get(root)
  if (!active) {
    const lockPath = acquireLeaseLock(root, options)
    // Another OCP instance may be starting it; never race it with a duplicate.
    if (!lockPath) return "disk-index"
    const args = tgrepServeCommand(options)
    const child = spawn("tgrep", args, { cwd: root, detached: true, stdio: "ignore", windowsHide: true })
    child.unref()
    const lease: TgrepLease = { root, pid: child.pid, startedAt: Date.now(), args, child, lockPath }
    leases.set(root, lease)
    const clear = () => { if (leases.get(root) === lease) leases.delete(root); releaseLeaseLock(lockPath) }
    child.once("exit", clear)
    child.once("error", clear)
  }
  const deadline = Date.now() + timeoutMs
  do {
    const readiness = probeTgrepStatus(root, options)
    if (readiness !== "building" && readiness !== "disk-index") return readiness
    await new Promise((resolve) => setTimeout(resolve, 250))
  } while (Date.now() < deadline)
  return probeTgrepStatus(root, options)
}

/** Only stop a process we spawned and still own. The child's exit handler
 * clears the lease and lock; if kill itself fails we clean up so a later
 * ensureServer can retry instead of finding a lock with no server behind it. */
export function releaseServer(root: string): boolean {
  const lease = leases.get(root)
  if (!lease) return false
  try { lease.child.kill(); return true } catch {
    if (leases.get(root) === lease) leases.delete(root)
    releaseLeaseLock(lease.lockPath)
    return false
  }
}

export function activeServerLease(root: string): TgrepLease | undefined { return leases.get(root) }
