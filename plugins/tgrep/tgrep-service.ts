import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { tgrepIndexArgs, type TgrepOptions } from "./tgrep-config"

export type TgrepReadiness = "unavailable" | "building" | "disk-index" | "server"

export function tgrepIndexCommand(options: TgrepOptions): string[] { return ["index", ".", ...tgrepIndexArgs(options)] }
export function tgrepServeCommand(options: TgrepOptions): string[] { return ["serve", ".", ...tgrepIndexArgs(options)] }
export function tgrepStatusCommand(options: TgrepOptions): string[] { return ["status", ".", ...tgrepIndexArgs(options)] }
export function hasTgrepIndex(root: string, options: TgrepOptions): boolean { return existsSync(join(root, options.indexPath ?? ".tgrep")) }

/** A safe, argv-only status probe. Failure is intentionally unavailable. */
export function probeTgrepStatus(root: string, options: TgrepOptions): TgrepReadiness {
  const status = spawnSync("tgrep", tgrepStatusCommand(options), { cwd: root, encoding: "utf8", timeout: 5000, windowsHide: true })
  if (status.error || status.status !== 0) return hasTgrepIndex(root, options) ? "disk-index" : "unavailable"
  const output = `${status.stdout}\n${status.stderr}`
  if (/Indexing:\s*(building|in progress)/i.test(output)) return "building"
  return /Indexing:\s*complete/i.test(output) ? "server" : "disk-index"
}

export interface TgrepLease { root: string; pid?: number; startedAt: number; args: string[]; child: ChildProcess }
const leases = new Map<string, TgrepLease>()

/** Start at most one OCP-owned watcher per root. Existing user watchers are
 * deliberately reused and never recorded as a lease that OCP could kill. */
export async function ensureServer(root: string, options: TgrepOptions, timeoutMs = 15_000): Promise<TgrepReadiness> {
  const before = probeTgrepStatus(root, options)
  if (before === "server" || before === "building" || !hasTgrepIndex(root, options)) return before
  const active = leases.get(root)
  if (!active) {
    const args = tgrepServeCommand(options)
    const child = spawn("tgrep", args, { cwd: root, detached: true, stdio: "ignore", windowsHide: true })
    child.unref()
    const lease: TgrepLease = { root, pid: child.pid, startedAt: Date.now(), args, child }
    leases.set(root, lease)
    child.once("exit", () => { if (leases.get(root) === lease) leases.delete(root) })
    child.once("error", () => { if (leases.get(root) === lease) leases.delete(root) })
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
  try { lease.child.kill(); return true } catch { return false }
}

export function activeServerLease(root: string): TgrepLease | undefined { return leases.get(root) }
