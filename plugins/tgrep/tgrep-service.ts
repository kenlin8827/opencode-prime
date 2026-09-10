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

/** A safe, argv-only status probe. Failure is intentionally unavailable.
 * A healthy server whose index metadata does not match the current policy is
 * reported as "stale": indexed searches must not trust that index (results
 * could violate the configured exclude/size policy) until /project index
 * rebuilds it. */
export function probeTgrepStatus(root: string, options: TgrepOptions): TgrepReadiness {
  const status = spawnSync("tgrep", tgrepStatusCommand(options), { cwd: root, encoding: "utf8", timeout: 5000, windowsHide: true })
  if (status.error || status.status !== 0) return hasTgrepIndex(root, options) ? "disk-index" : "unavailable"
  const output = `${status.stdout}\n${status.stderr}`
  if (/Indexing:\s*(building|in progress)/i.test(output)) return "building"
  if (/Indexing:\s*complete/i.test(output)) return isTgrepPolicyCurrent(root, options) ? "server" : "stale"
  // status exits 0 both with an index but no server ("Server: not running")
  // and with no index at all ("No index found") — only the former is disk-index.
  return hasTgrepIndex(root, options) ? "disk-index" : "unavailable"
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
