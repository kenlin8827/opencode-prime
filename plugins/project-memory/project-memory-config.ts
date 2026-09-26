/**
 * Shared project-memory config — switch + file locations.
 *
 * State is PROJECT-LEVEL in the `projectMemory` field of `.ocp/ocp.json`
 * (via `plugins/shared/plugin-switch.ts`):
 *   - absent or "on"  → on (default — injected when at least one file is non-empty;
 *                       opt out with an explicit "off", see sidebar "memory" row)
 *   - "off"           → never injected (explicit opt-out)
 *
 * Two scopes, both PROJECT-LEVEL inside `<projectDir>/.ocp/memory/`,
 * file names self-describe visibility (no ambiguity when scanning the dir):
 *
 *   public  → public.md   — committed to git, follows the checkout, same
 *                            authority tier as AGENTS.md. PR review is the
 *                            gate.
 *   private → private.md  — gitignored, only the current user sees it
 *                            (auto-gitignored on first capture via
 *                            `.ocp/.gitignore`).
 *
 * Migration (ADR 0004 v2): legacy `.opencode/memory/*.md` files are moved
 * here by the one-shot init migration (`migrateLegacyProjectArtifacts`,
 * merge-append if the target exists). Runtime reads are single-path only —
 * no dual-era logic.
 *
 * Naming: `public.md` / `private.md` instead of the more abstract
 * `memory.md` / `personal.md` so the visibility of any file you spot in
 * `.ocp/memory/` is unambiguous without reading docs.
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

import { spawnSync } from "node:child_process"
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { relative, sep } from "node:path"
import {
  ensureOcpGitignore,
  getProjectDir,
  ocpArtifactPath,
  setProjectDir,
  writableProjectConfigFile,
} from "../shared/opencode-prime"
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

/** Project-level memory dir: `<projectDir>/.ocp/memory` (write root). */
export function memoryBaseDir(): string {
  return ocpArtifactPath("memory")
}

/** Public scope: committed, team-visible. */
export function publicPath(): string {
  return ocpArtifactPath("memory/public.md")
}

/** Private scope: gitignored, current-user-only. */
export function privatePath(): string {
  return ocpArtifactPath("memory/private.md")
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
  const clean = lesson
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000)
    // `slice` counts UTF-16 units, so the cap can land between a surrogate
    // pair and orphan the high half — which serializes as U+FFFD. Public
    // entries are committed repo content now (ADR-2.0.2), so a mojibake
    // character is the team's file, not a local note. Drop the orphan; one
    // code point of headroom is not worth a broken glyph.
    .replace(/[\uD800-\uDBFF]$/, "")
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

/** Append a lesson to the chosen scope's file. Returns the resolved path.
 * Throws only on unrecoverable fs errors.
 *
 * Concurrency: the create-with-header step uses `wx` (exclusive create) so
 * two simultaneous captures can never both win the `existsSync` race and
 * duplicate the header. The first writer's combined (header + entry)
 * write is atomic from the others' perspective; losers fall through to a
 * plain appendFileSync against the now-existing file.
 *
 * `private` scope additionally calls `ensureOcpGitignore()` (the single
 * shared bootstrap — closes the drift-watch item of two hand-synced
 * ignore strings; the public file is intentionally NOT ignored) so the
 * first capture in a fresh checkout auto-creates the gitignore line. */
export function appendLesson(scope: LessonScope, lesson: string): string {
  const { dir, path, header, ensureIgnored } = scopeTargets(scope)
  if (ensureIgnored) ensureOcpGitignore()
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

/** How far a public-scope entry actually travels. The predicate is
 *  "will a teammate receive this", not "is a rule matching it" — an
 *  untracked-but-unignored file passes every ignore check and still never
 *  leaves the machine, which is exactly the state ADR-2.0.2#02 was written
 *  for (this repo's own `public.md` had never been tracked). */
export type PublicScopeReach = "tracked" | "untracked" | "ignored" | "unknown"

/** `git ls-files --error-unmatch` verdict. Pure — exported for tests.
 *    0 → tracked   1 → not tracked
 *    anything else (128 fatal "not a git repository", 129 usage, null when
 *    the child was killed or timed out) → unknown (null) */
export function classifyLsFiles(status: number | null, error?: unknown): boolean | null {
  if (error) return null
  if (status === 0) return true
  if (status === 1) return false
  return null
}

/** `git check-ignore -q` verdict. Pure — exported for tests.
 *    0 → ignored   1 → not ignored
 *    anything else → unknown (null)
 *
 *  The "anything else" arm is load-bearing, not defensive padding: a fatal
 *  128 also arrives as a non-zero status, so a naive `status !== 0` would
 *  read as "clean" precisely when git could not answer at all. */
export function classifyIsIgnored(status: number | null, error?: unknown): boolean | null {
  if (error) return null
  if (status === 0) return true
  if (status === 1) return false
  return null
}

/** Compose both verdicts into the four states callers act on. Pure —
 *  exported for tests.
 *    tracked   — in the index: it is in the repo, whatever ignore rules say
 *    ignored   — matched by an ignore rule AND unindexed, so it silently
 *                never ships. The usual cause is a broad root-ignore of the
 *                whole `.ocp/` tree.
 *    untracked — unindexed but not ignored: it ships the moment somebody
 *                runs `git add`; today it is still local-only.
 *    unknown   — git could not answer; callers stay silent, never cry wolf */
export function classifyPublicScope(
  tracked: boolean | null,
  ignored: boolean | null,
): PublicScopeReach {
  if (tracked === true) return "tracked"
  // check-ignore consults the index, so "ignored" already implies untracked.
  if (ignored === true) return "ignored"
  if (tracked === false && ignored === false) return "untracked"
  return "unknown"
}

/** Git pathspec for the public file, repo-relative with POSIX separators.
 *  A cwd-relative POSIX path is what git's own docs and error messages are
 *  written against; a native absolute path (`D:\…`) is at best tolerated and
 *  at worst parsed as a pathspec with a drive-letter component, and that
 *  failure would surface only as exit 128 → "unknown" → silence. `ocpDir()`
 *  only ever nests under the project dir, so the relative path always
 *  resolves. */
function publicPathspec(): string {
  return relative(getProjectDir(), publicPath()).split(sep).join("/")
}

/** How far public-scope entries actually reach. One subprocess in the healthy
 *  (tracked) case, two when the file is absent from the index.
 *
 *  `check-ignore` runs WITHOUT `--no-index` on purpose: it consults the
 *  index, so a tracked file under a stale ignore rule is not misreported.
 *
 *  Hard timeout, errors swallowed: `/memory status` is a read-only report and
 *  must never fail because git is unavailable. This is a SYNCHRONOUS spawn on
 *  the shared plugin process — hence the 5s ceiling and the fail-soft shape,
 *  not a 30s one. */
export function publicScopeReach(): PublicScopeReach {
  const root = getProjectDir()
  const spec = publicPathspec()
  const run = (args: string[]) => {
    try {
      return spawnSync("git", args, { cwd: root, windowsHide: true, timeout: 5000, stdio: "ignore" })
    } catch {
      return null
    }
  }
  const ls = run(["ls-files", "--error-unmatch", "-z", "--", spec])
  const tracked = classifyLsFiles(ls?.status ?? null, ls?.error)
  if (tracked === true) return "tracked"
  const ci = run(["check-ignore", "-q", "--", spec])
  return classifyPublicScope(tracked, classifyIsIgnored(ci?.status ?? null, ci?.error))
}