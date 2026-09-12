/**
 * Shared project-memory config — switch + file locations.
 *
 * State is PROJECT-LEVEL in the `projectMemory` field of the project's
 * opencode.jsonc (via `plugins/shared/plugin-switch.ts`):
 *   - absent or "on"  → on (default — injected when at least one file is non-empty;
 *                       opt out with an explicit "off", see sidebar "memory" row)
 *   - "off"           → never injected (explicit opt-out)
 *
 * Two scopes, both PROJECT-LEVEL inside `<projectDir>/.opencode/memory/`,
 * file names self-describe visibility (no ambiguity when scanning the dir):
 *
 *   public  → public.md   — committed to git, follows the checkout, same
 *                            authority tier as AGENTS.md. PR review is the
 *                            gate.
 *   private → private.md  — gitignored, only the current user sees it
 *                            (auto-gitignored on first capture via
 *                            `.opencode/.gitignore`).
 *
 * Naming: `public.md` / `private.md` instead of the more abstract
 * `memory.md` / `personal.md` so the visibility of any file you spot in
 * `.opencode/memory/` is unambiguous without reading docs.
 *
 * AGENTS.md wins on conflict against both. The `projectMemory` gate
 * controls injection of both files together under a single `[PROJECT
 * MEMORY]` marker with `=== Public ===` / `=== Private ===` sections.
 *
 * Both scopes project-level — this plugin is project-scoped, so personal
 * notes ride along with the project (gitignored, not in user home). The
 * top-tier references (Cursor Settings, Aider ~/.aider.conf.yml, Copilot
 * VS Code settings) keep personal settings in the user home because those
 * plugins are NOT project-scoped; the same pattern doesn't apply here.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { getProjectDir, setProjectDir, writableProjectConfigFile } from "../shared/opencode-prime"
import { createPluginSwitch, normalizeSwitchState } from "../shared/plugin-switch"

// Re-export the shared plumbing so importers keep one import path.
export { getProjectDir, setProjectDir, writableProjectConfigFile }

export type MemoryState = "on" | "off"
export type LessonScope = "public" | "private"

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

/** Project-level memory dir: `<projectDir>/.opencode/memory`. */
export function memoryBaseDir(): string {
  return join(getProjectDir(), ".opencode", "memory")
}

/** Public scope: committed, team-visible. */
export function publicPath(): string {
  return join(memoryBaseDir(), "public.md")
}

/** Private scope: gitignored, current-user-only. */
export function privatePath(): string {
  return join(memoryBaseDir(), "private.md")
}

/** Read a memory file (trimmed), or null when missing/empty. */
function readIfPresent(path: string): string | null {
  try {
    const content = readFileSync(path, "utf-8").trim()
    return content === "" ? null : content
  } catch {
    return null
  }
}

/** Public (team) memory content (trimmed), or null when file missing/empty. */
export function readPublic(): string | null {
  return readIfPresent(publicPath())
}

/** Private (current-user-only) memory content (trimmed), or null when missing/empty. */
export function readPrivate(): string | null {
  return readIfPresent(privatePath())
}

/** One memory entry: `- [YYYY-MM-DD] <lesson>`. Pure — exported for tests.
 *  The dated-bullet form is the unit both `countEntries` and human review
 *  recognize; do not break it without updating both.
 *
 *  Sanitizes LLM-supplied input at the shared root (both the tool and the
 *  command path append through here): collapse all whitespace so embedded
 *  newlines can never escape the single-bullet contract, cap length, and
 *  throw on empty-after-clean (the command path keeps its own earlier
 *  empty pre-check for nicer UX). */
export function formatMemoryEntry(lesson: string, date = new Date()): string {
  const clean = lesson.replace(/\s+/g, " ").trim().slice(0, 1000)
  if (clean === "") throw new Error("memory lesson is empty after sanitize")
  return `- [${date.toISOString().slice(0, 10)}] ${clean}\n`
}

/** Format a mtime value as `YYYY-MM-DD HH:MM` in local time. The system
 *  transform injects this so the model can see when memory was last
 *  touched; "stale" notes (older than 30 days) get a separate flag.
 * Pure — exported for tests. */
export function formatMtimeLocal(mtime: Date | null): string {
  if (!mtime) return "unknown"
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${mtime.getFullYear()}-${pad(mtime.getMonth() + 1)}-${pad(mtime.getDate())} ${pad(mtime.getHours())}:${pad(mtime.getMinutes())}`
}

/** Most recent mtime across the two memory files (whichever is newer).
 * Returns null when neither file exists. Pure wrapper around statSync —
 * exported for tests. */
export function memoryMtime(): Date | null {
  const candidates: number[] = []
  for (const p of [publicPath(), privatePath()]) {
    try {
      candidates.push(statSync(p).mtimeMs)
    } catch {
      // file missing — skip
    }
  }
  if (candidates.length === 0) return null
  return new Date(Math.max(...candidates))
}

/** File mtime in ms, or null when missing. Exported so the system-inject
 * hook doesn't need its own duplicate `try { statSync } catch { null }`. */
export function fileMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

const PUBLIC_HEADER = "# Project memory — public lessons (committed)\n\n"
const PRIVATE_HEADER = "# Project memory — private notes (gitignored)\n\n"

/** Resolve which `(dir, header, ensureIgnored)` tuple to use for a scope.
 * Pure — extracted so tests can pin both without driving the full append. */
export function scopeTargets(scope: LessonScope): { dir: string; path: string; header: string; ensureIgnored: boolean } {
  if (scope === "public") {
    return { dir: memoryBaseDir(), path: publicPath(), header: PUBLIC_HEADER, ensureIgnored: false }
  }
  return { dir: memoryBaseDir(), path: privatePath(), header: PRIVATE_HEADER, ensureIgnored: true }
}

/** Ensure `.opencode/.gitignore` contains `memory/private.md` so private
 * notes never leak into commits. The public file is intentionally NOT
 * ignored. Errors swallowed — a missing gitignore line is recoverable; a
 * failed `.opencode/` write should not block a capture. */
function ensurePrivateIgnored(): void {
  const path = join(getProjectDir(), ".opencode", ".gitignore")
  try {
    if (!existsSync(path)) {
      const dir = join(getProjectDir(), ".opencode")
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      // Mirrors shared defaultIgnore (plugins/shared/opencode-prime.ts) — includes the guard line.
      writeFileSync(path, "node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore\nlogs/\n*.log\nhandoffs/\nmemory/private.md\n", "utf-8")
      return
    }
    const content = readFileSync(path, "utf-8")
    if (content.includes("memory/private.md")) return
    writeFileSync(path, content.trimEnd() + "\nmemory/private.md\n", "utf-8")
  } catch {
    /* best-effort */
  }
}

/** Append a lesson to the chosen scope's file. Returns the resolved path.
 * Throws only on unrecoverable fs errors.
 *
 * Concurrency: the create-with-header step uses `wx` (exclusive create) so
 * two simultaneous captures can never both win the `existsSync` race and
 * duplicate the header. The first writer's combined (header + entry)
 * write is atomic from the others' perspective; losers fall through to a
 * plain appendFileSync against the now-existing file.
 *
 * `private` scope additionally calls `ensurePrivateIgnored()` so the first
 * capture in a fresh checkout auto-creates the gitignore line. */
export function appendLesson(scope: LessonScope, lesson: string): string {
  const { dir, path, header, ensureIgnored } = scopeTargets(scope)
  if (ensureIgnored) ensurePrivateIgnored()
  mkdirSync(dir, { recursive: true })
  try {
    writeFileSync(path, header + formatMemoryEntry(lesson), {
      flag: "wx",
      encoding: "utf-8",
    })
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err
    appendFileSync(path, formatMemoryEntry(lesson), "utf-8")
  }
  return path
}

/** Count of entries (lines starting with "- ["). `countEntries(content)`
 * is the canonical lesson count surfaced in `/memory status` and the
 * sidebar. */
export function countEntries(content: string): number {
  return content.split(/\r?\n/).filter((line) => line.startsWith("- [")).length
}