import { createHash } from "node:crypto"
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TgrepOptions } from "./tgrep-config"

const STATE_NAME = ".ocp-tgrep-state.json"

export interface TgrepIndexState { fingerprint: string; version: string; createdAt: string }

export function tgrepPolicyFingerprint(options: TgrepOptions, version = "unknown"): string {
  // Normalize exclusions so configuration formatting/order cannot cause a
  // needless rebuild; binary version remains part of the compatibility key.
  const payload = JSON.stringify({
    version,
    indexPath: options.indexPath ?? ".tgrep",
    maxFileSize: options.maxFileSize ?? null,
    exclude: [...(options.exclude ?? [])].sort(),
    noRequireGit: options.noRequireGit === true,
  })
  return createHash("sha256").update(payload).digest("hex")
}

function statePath(root: string, options: TgrepOptions): string { return join(root, options.indexPath ?? ".tgrep", STATE_NAME) }

export function readTgrepIndexState(root: string, options: TgrepOptions): TgrepIndexState | null {
  try {
    const parsed = JSON.parse(readFileSync(statePath(root, options), "utf8")) as Partial<TgrepIndexState>
    return typeof parsed.fingerprint === "string" && typeof parsed.version === "string" && typeof parsed.createdAt === "string"
      ? parsed as TgrepIndexState : null
  } catch { return null }
}

export function isTgrepPolicyCurrent(root: string, options: TgrepOptions, version = "unknown"): boolean {
  const state = readTgrepIndexState(root, options)
  return state?.fingerprint === tgrepPolicyFingerprint(options, version)
}

/** Called only after a successful index build; uses rename for an atomic
 * metadata update and never modifies tgrep's own index files. */
export function writeTgrepIndexState(root: string, options: TgrepOptions, version = "unknown"): void {
  const target = statePath(root, options)
  if (!existsSync(join(root, options.indexPath ?? ".tgrep"))) return
  const state: TgrepIndexState = { fingerprint: tgrepPolicyFingerprint(options, version), version, createdAt: new Date().toISOString() }
  const temporary = `${target}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, "utf8")
  try { renameSync(temporary, target) } catch { try { unlinkSync(temporary) } catch { /* best effort */ } }
}
