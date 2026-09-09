import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { closeSync, existsSync, openSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tgrepIndexArgs, type TgrepOptions } from "./tgrep-config"
import { isTgrepPolicyCurrent, writeTgrepIndexState } from "./tgrep-state"

export type TgrepReadiness = "unavailable" | "building" | "disk-index" | "server"

export function tgrepIndexCommand(options: TgrepOptions): string[] { return ["index", ".", ...tgrepIndexArgs(options)] }
export function tgrepServeCommand(options: TgrepOptions): string[] { return ["serve", ".", ...tgrepIndexArgs(options)] }
export function tgrepStatusCommand(options: TgrepOptions): string[] { return ["status", ".", ...tgrepIndexArgs(options)] }
export function hasTgrepIndex(root: string, options: TgrepOptions): boolean { return existsSync(join(root, options.indexPath ?? ".tgrep")) }

export function tgrepVersion(root: string): string | null {
  const result = spawnSync("tgrep", ["--version"], { cwd: root, encoding: "utf8", timeout: 5000, windowsHide: true })
  return result.status === 0 ? String(result.stdout).trim() || null : null
}

/** A safe, argv-only status probe. Failure is intentionally unavailable. */
export function probeTgrepStatus(root: string, options: TgrepOptions): TgrepReadiness {
  const status = spawnSync("tgrep", tgrepStatusCommand(options), { cwd: root, encoding: "utf8", timeout: 5000, windowsHide: true })
  if (status.error || status.status !== 0) return hasTgrepIndex(root, options) ? "disk-index" : "unavailable"
  const output = `${status.stdout}\n${status.stderr}`
  if (/Indexing:\s*(building|in progress)/i.test(output)) return "building"
  return /Indexing:\s*complete/i.test(output) ? "server" : "disk-index"
}

export function tgrepNeedsRebuild(root: string, options: TgrepOptions): boolean {
  if (!hasTgrepIndex(root, options)) return false
  const version = tgrepVersion(root)
  // Old indexes without OCP metadata are intentionally treated as stale once;
  // this establishes a reproducible policy/version baseline.
  return !isTgrepPolicyCurrent(root, options, version ?? "unknown")
}

export function recordSuccessfulIndex(root: string, options: TgrepOptions): void {
  writeTgrepIndexState(root, options, tgrepVersion(root) ?? "unknown")
}

export interface TgrepLease { root: string; pid?: number; startedAt: number; args: string[]; child: ChildProcess; lockPath: string }
const leases = new Map<string, TgrepLease>()

function leaseLockPath(root: string, options: TgrepOptions): string { return join(root, options.indexPath ?? ".tgrep", ".ocp-tgrep-serve.lock") }

function acquireLeaseLock(root: string, options: TgrepOptions): string | null {
  const lockPath = leaseLockPath(root, options)
  try {
    const fd = openSync(lockPath, "wx")
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, root, startedAt: new Date().toISOString() })}\n`, "utf8")
    closeSync(fd)
    return lockPath
  } catch { return null }
}

function releaseLeaseLock(path: string): void { try { unlinkSync(path) } catch { /* only best-effort cleanup */ } }

/** Start at most one OCP-owned watcher per root. Existing user watchers are
 * deliberately reused and never recorded as a lease that OCP could kill. */
export async function ensureServer(root: string, options: TgrepOptions, timeoutMs = 15_000): Promise<TgrepReadiness> {
  const before = probeTgrepStatus(root, options)
  if (before === "server" || before === "building" || !hasTgrepIndex(root, options)) return before
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
    if (readiness === "server" || readiness === "unavailable") return readiness
    await new Promise((resolve) => setTimeout(resolve, 250))
  } while (Date.now() < deadline)
  return probeTgrepStatus(root, options)
}

/** Only stop a process we spawned and still own. */
export function releaseServer(root: string): boolean {
  const lease = leases.get(root)
  if (!lease) return false
  leases.delete(root)
  releaseLeaseLock(lease.lockPath)
  try { lease.child.kill(); return true } catch { return false }
}

export function activeServerLease(root: string): TgrepLease | undefined { return leases.get(root) }
