import { spawnSync } from "node:child_process"
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
