/**
 * Shared project-memory config — switch + file locations.
 *
 * State is PROJECT-LEVEL in the `projectMemory` field of the project's
 * opencode.jsonc (via `plugins/shared/plugin-switch.ts`):
 *   - absent or "on"  → on (default — memory.md is injected when non-empty;
 *                       opt out with an explicit "off", see sidebar "memory" row)
 *   - "off"           → never injected (explicit opt-out)
 *
 * Files live OUTSIDE the project, under the ocp user-level config root
 * (dirname of `ocpConfigPath()` — ~/.config/opencode by default, honors
 * OCP_CONFIG_PATH / XDG_CONFIG_HOME):
 *   <root>/memory/<projectKey>/memory.md   — curated lessons, injected when on
 *   <root>/memory/<projectKey>/draft.md    — fresh /memory captures, pending review
 * <projectKey> = sanitized project dir basename + "-" + sha256(path)[0:8],
 * so renamed/moved projects get a fresh key instead of silently adopting a
 * stranger's memory. Rationale (user call 2026-09-11): project memory is
 * heavy — it must not live or die with the project checkout.
 *
 * Phase 1 (this plugin): capture + inject. The review/promotion tool is
 * Phase 2 — until then promotion from draft to memory.md is a manual edit.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { getProjectDir, setProjectDir, writableProjectConfigFile } from "../shared/opencode-prime"
import { ocpConfigPath } from "../shared/ocp-config"
import { createPluginSwitch, normalizeSwitchState } from "../shared/plugin-switch"

// Re-export the shared plumbing so importers keep one import path.
export { getProjectDir, setProjectDir, writableProjectConfigFile }

export type MemoryState = "on" | "off"

const memorySwitch = createPluginSwitch<MemoryState>({
  field: "projectMemory",
  aliases: {
    on: "on", enabled: "on", true: "on",
    off: "off", disabled: "off", false: "off",
  },
  defaultState: "on",
  onStates: ["on"],
})

/** Normalize a raw config value to canonical MemoryState. Pure — for tests. */
export function normalizeState(state: unknown): MemoryState | null {
  return normalizeSwitchState(state, memorySwitch.spec.aliases)
}

export function getState(): MemoryState {
  return memorySwitch.getState()
}

export function isEnabled(): boolean {
  return memorySwitch.isOn()
}

/** Persist `state` to project config. Returns false on read-only fs. */
export function setState(state: MemoryState): boolean {
  return memorySwitch.setState(state)
}

// ─── Files ───────────────────────────────────────────────────────────

/** Stable identity of the current project: readable basename + path hash.
 * Pure — exported for tests.
 *
 * Windows note: the basename is derived from the case-normalized path so
 * `C:\Foo` and `c:\foo` produce the same key (the hash is case-insensitive
 * on Windows by file-system convention; the readable prefix must agree too,
 * otherwise the same project on disk ends up with two memory dirs). */
export function projectKey(dir = getProjectDir()): string {
  const norm = dir.replace(/\\/g, "/").replace(/\/+$/, "")
  const lowered = process.platform === "win32" ? norm.toLowerCase() : norm
  const base = lowered.split("/").pop() ?? "project"
  const san = base.replace(/[^a-zA-Z0-9._-]/g, "-")
  const hash = createHash("sha256").update(lowered).digest("hex").slice(0, 8)
  return `${san}-${hash}`
}

/** Memory dir for the current project, under the ocp user-level config root. */
export function memoryBaseDir(): string {
  return join(dirname(ocpConfigPath()), "memory", projectKey())
}

export function memoryPath(): string {
  return join(memoryBaseDir(), "memory.md")
}

export function draftPath(): string {
  return join(memoryBaseDir(), "draft.md")
}

/** Curated memory content (trimmed), or null when file missing/empty. */
export function readMemory(): string | null {
  try {
    const content = readFileSync(memoryPath(), "utf-8").trim()
    return content === "" ? null : content
  } catch {
    return null
  }
}

/** One draft entry: `- [YYYY-MM-DD] <lesson>`. Pure — exported for tests. */
export function formatDraftEntry(lesson: string, date = new Date()): string {
  return `- [${date.toISOString().slice(0, 10)}] ${lesson}\n`
}

const DRAFT_HEADER = "# Project memory — drafts (pending review)\n\n"

/** Append a lesson to the draft file (creates dir + header when missing).
 * Returns the resolved draft path. Throws only on unrecoverable fs errors —
 * callers surface those as a user-visible failure line.
 *
 * Concurrency: the create-with-header step uses `wx` (exclusive create) so
 * two simultaneous `/memory capture` invocations can never both win the
 * `existsSync` race and duplicate the header. The first writer's combined
 * (header + entry) write is atomic from the others' perspective; losers
 * fall through to a plain appendFileSync against the now-existing file. */
export function appendDraft(lesson: string): string {
  const path = draftPath()
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(path, DRAFT_HEADER + formatDraftEntry(lesson), {
      flag: "wx",
      encoding: "utf-8",
    })
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err
    appendFileSync(path, formatDraftEntry(lesson), "utf-8")
  }
  return path
}

/** Count of entries (lines starting with "- ["). Contract: promoted
 * entries keep the dated-bullet form (promotion = move, not rewrite);
 * free-form markdown in memory.md is injected as-is but not counted. */
export function countEntries(content: string): number {
  return content.split(/\r?\n/).filter((line) => line.startsWith("- [")).length
}
