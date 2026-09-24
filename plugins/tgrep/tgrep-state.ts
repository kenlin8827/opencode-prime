import { createHash } from "node:crypto"
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ensureOcpGitignore, ocpDir } from "../shared/opencode-prime"
import type { TgrepOptions } from "./tgrep-config"

const STATE_NAME = "tgrep-state.json"
// Legacy layout (before relocation to `.ocp/`): inside the tgrep-owned dir.
const LEGACY_STATE_NAME = ".ocp-tgrep-state.json"

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

/** Machine-local index metadata sits under `.ocp/` (path contract: tool dirs
 * stay tool-pure; `ocpDir` honors OCP_PROJECT_DIR) and is gitignored via
 * `.ocp/.gitignore` — binary version/timestamp are per-machine values. */
function statePath(root: string): string { return join(ocpDir(root), STATE_NAME) }

function parseStateJson(text: string): TgrepIndexState | null {
  try {
    const parsed = JSON.parse(text) as Partial<TgrepIndexState>
    return typeof parsed.fingerprint === "string" && typeof parsed.version === "string" && typeof parsed.createdAt === "string"
      ? parsed as TgrepIndexState : null
  } catch { return null }
}

export function readTgrepIndexState(root: string, options: TgrepOptions): TgrepIndexState | null {
  try {
    const state = parseStateJson(readFileSync(statePath(root), "utf8"))
    if (state) return state
  } catch { /* absent → try the legacy location once */ }
  return migrateLegacyTgrepState(root, options)
}

/** One-way relocation from the legacy `.tgrep/.ocp-tgrep-state.json` layout so
 * upgrades do not force an index rebuild. Bytes are copied VERBATIM — never
 * re-fingerprinted, so a policy change predating the move still reports
 * `stale` honestly. A failed relocation just retries on the next read. */
function migrateLegacyTgrepState(root: string, options: TgrepOptions): TgrepIndexState | null {
  const legacyPath = join(root, options.indexPath ?? ".tgrep", LEGACY_STATE_NAME)
  let legacy: TgrepIndexState | null = null
  try { legacy = parseStateJson(readFileSync(legacyPath, "utf8")) } catch { return null }
  if (!legacy) return null
  try {
    ensureOcpGitignore(root)
    writeFileSync(statePath(root), `${JSON.stringify(legacy)}\n`, "utf8")
    unlinkSync(legacyPath)
  } catch { /* next read retries; state validity does not depend on relocation */ }
  return legacy
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
  if (!existsSync(join(root, options.indexPath ?? ".tgrep"))) return
  // Creates `.ocp/` on demand and heals `.ocp/.gitignore`, so this
  // machine-local state is covered from its very first write.
  ensureOcpGitignore(root)
  const target = statePath(root)
  const state: TgrepIndexState = { fingerprint: tgrepPolicyFingerprint(options), version, createdAt: new Date().toISOString() }
  const temporary = `${target}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, "utf8")
  try { renameSync(temporary, target) } catch { try { unlinkSync(temporary) } catch { /* best effort */ } }
}
