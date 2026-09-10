import { createHash } from "node:crypto"
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TgrepOptions } from "./tgrep-config"

const STATE_NAME = ".ocp-tgrep-state.json"

export interface TgrepIndexState { fingerprint: string; version: string; createdAt: string }

/** Policy-only fingerprint: configuration formatting/order can never cause a
 * needless rebuild, and the search path can check currency with a plain file
 * read instead of spawning the CLI. The binary version is stored beside the
 * fingerprint and compared only where a rebuild decision is actually made
 * (/project index via tgrepNeedsRebuild). */
export function tgrepPolicyFingerprint(options: TgrepOptions): string {
  const payload = JSON.stringify({
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

/** True only when the on-disk index metadata matches the CURRENT policy.
 * Indexes built outside OCP (no metadata) are intentionally reported as not
 * current until /project index establishes the baseline. */
export function isTgrepPolicyCurrent(root: string, options: TgrepOptions): boolean {
  const state = readTgrepIndexState(root, options)
  return state?.fingerprint === tgrepPolicyFingerprint(options)
}

/** Called only after a successful index build; uses rename for an atomic
 * metadata update and never modifies tgrep's own index files. */
export function writeTgrepIndexState(root: string, options: TgrepOptions, version = "unknown"): void {
  const target = statePath(root, options)
  if (!existsSync(join(root, options.indexPath ?? ".tgrep"))) return
  const state: TgrepIndexState = { fingerprint: tgrepPolicyFingerprint(options), version, createdAt: new Date().toISOString() }
  const temporary = `${target}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, "utf8")
  try { renameSync(temporary, target) } catch { try { unlinkSync(temporary) } catch { /* best effort */ } }
}
