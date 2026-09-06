/**
 * Shared e2e-guard runtime — E2E command detection and the one-shot session
 * approval store. Pure functions + module state only; the tool guard
 * composes them.
 *
 * Design stance (same as adr-guard / env-guard): fail-safe on detection
 * (recognized E2E shapes are blocked), fail-open on ambiguity (unrecognized
 * command shapes pass through). The tokenizer is reused from
 * adr-guard-runtime, so quoted arguments survive parsing exactly like the
 * other guards see them.
 *
 * Detection is intentionally heuristic, covering the common shapes:
 *   - package-manager run scripts whose name contains "e2e"
 *       npm|pnpm|yarn|bun [run] test:e2e / e2e / e2e:smoke ...
 *   - dedicated runner CLIs
 *       playwright test, cypress run, nightwatch, codeceptjs run
 *   - Python runners, gated only when the invocation itself says e2e
 *       pytest tests/e2e/..., pytest -m e2e, python -m pytest ...,
 *       uv|poetry|pdm|pipenv run pytest ..., tox -e e2e
 *       (bare `pytest` fails open — it is usually the unit suite)
 * Chained commands (&&, ;, |) are judged per segment — one E2E segment
 * gates the whole command, at the HIGHEST risk level present.
 *
 * Risk levels (graded control):
 *   - full     — a suite run with no explicit target (slow, expensive):
 *                every run needs a fresh one-shot `/e2e-guard allow` pass.
 *   - targeted — a run scoped to an explicit spec/test file argument
 *                (cheap re-run after a fix): passes automatically once the
 *                session has ANY user-confirmed approval, logged each time.
 *
 * Known mechanical boundary (same posture as the other guards): shell
 * wrappers (`bash -c '...'`, `$(...)`) are not inspected; the guard is a
 * hard wall on the common paths, not a formal sandbox.
 *
 * The approval store is in-memory by design: an approval is the user's
 * live confirmation for THIS session, one-shot, consumed on first use and
 * revoked when the session is deleted. It must never survive a restart —
 * a stale persisted approval would let a future session run E2E silently.
 * The sticky "unlocked" mark (enables targeted re-runs) shares the same
 * in-memory lifecycle.
 */

import { tokenize } from "../adr-guard/adr-guard-runtime"
import { PACKAGE_MANAGERS } from "../shared/package-manager"

// ─── Session approval store (two tiers) ─────────────────────────────

const approvals = new Set<string>()
// Sticky "this session holds a user-confirmed E2E intent": lets targeted
// single-spec re-runs through without taxing the user for every retry,
// while full suites still pay the one-shot cost each time.
const unlocked = new Set<string>()

/** Grant one E2E pass to a session (`/e2e-guard allow`). */
export function approveSession(sessionID: string): void {
  if (sessionID === "") return
  approvals.add(sessionID)
  unlocked.add(sessionID)
}

/**
 * Unlock targeted re-runs WITHOUT a one-shot full pass
 * (`/e2e-guard allow targeted`) — the "affected specs only" choice:
 * targeted runs flow for the rest of the session, full suites stay gated.
 */
export function unlockSession(sessionID: string): void {
  if (sessionID === "") return
  unlocked.add(sessionID)
}

/** True when the session holds an unused approval (does NOT consume it). */
export function isApproved(sessionID: string): boolean {
  return sessionID !== "" && approvals.has(sessionID)
}

/** Consume the session's one-shot approval; true exactly once per grant. */
export function consumeApproval(sessionID: string): boolean {
  if (sessionID === "") return false
  return approvals.delete(sessionID)
}

/** True once the session has EVER held a user-confirmed approval. */
export function isUnlocked(sessionID: string): boolean {
  return sessionID !== "" && unlocked.has(sessionID)
}

/** Revoke everything for a session (session.deleted, switch off). */
export function revokeApproval(sessionID: string): void {
  approvals.delete(sessionID)
  unlocked.delete(sessionID)
}

/** Drop every approval and unlock mark (used when the switch flips off). */
export function clearApprovals(): void {
  approvals.clear()
  unlocked.clear()
}

// ─── E2E command detection ───────────────────────────────────────────

const SEPARATORS = new Set(["&&", "||", ";", "|", "&"])

const PACKAGE_MANAGER_EXECUTABLES = new Set([
  ...PACKAGE_MANAGERS,
  "npx",
  "bunx",
  "pnpx",
])

// Runner CLI → the verb that actually executes tests. `null` means any
// invocation of the binary counts (nightwatch has no separate verb).
const RUNNERS: Record<string, string | null> = {
  playwright: "test",
  cypress: "run",
  nightwatch: null,
  codeceptjs: "run",
}

export type E2eRisk = "full" | "targeted"

function isFlag(t: string): boolean {
  return t.startsWith("-")
}

/** Script names that plausibly run an E2E suite: test:e2e, e2e, e2e-smoke ... */
function scriptLooksE2e(name: string): boolean {
  return /(^|[^a-z0-9])e2e([^a-z0-9]|$)/.test(name.toLowerCase())
}

/** True when the token itself, or any of its path segments, names e2e. */
function pathSaysE2e(tok: string): boolean {
  return tok.split(/[\\/]/).some(scriptLooksE2e)
}

// Tools that launch pytest via an environment: `uv run pytest`, `poetry run
// pytest`, etc.
const PY_ENV_TOOLS = new Set(["uv", "poetry", "pdm", "pipenv"])

const TEST_FILE_EXT = /\.(py|js|jsx|ts|tsx|mjs|cjs|rb|java|go|cs|feature)$/i

// nightwatch has no separate verb — informational invocations must still
// fail open, same stance as `playwright install` / `cypress open`.
const NIGHTWATCH_INFO_FLAGS = new Set(["--help", "-h", "--version", "-v", "--init", "--list"])

/**
 * Risk of a pytest invocation's argument list, or null when nothing says
 * e2e (bare `pytest` / `pytest tests/unit/` fail open). Marker selection
 * (`-m e2e`) and e2e DIRECTORIES are full-suite runs; an explicit e2e test
 * FILE — including node IDs like `test_a.py::test_x` — is targeted.
 */
function pytestRisk(args: string[]): E2eRisk | null {
  if (args.includes("--collect-only") || args.includes("--co")) return null
  for (let k = 0; k < args.length; k++) {
    const tok = args[k]
    if (tok === "-m" || tok === "--marker" || tok === "-k") {
      const val = (args[k + 1] ?? "").toLowerCase()
      // `not e2e` EXCLUDES e2e tests — not e2e evidence.
      if (!/\bnot\s+e2e\b/.test(val) && scriptLooksE2e(val)) return "full"
      k++
      continue
    }
    if (isFlag(tok)) continue
    if (pathSaysE2e(tok)) {
      const pathPart = tok.split("::")[0]
      return TEST_FILE_EXT.test(pathPart) ? "targeted" : "full"
    }
  }
  return null
}

/**
 * Path-like token = an explicit spec/test target. Conservative on purpose:
 * flag VALUES like `--browser chrome` must NOT classify as targets, so a
 * bare word fails; a target must carry a path separator or a test-file
 * extension. Ambiguity degrades to the higher-risk `full` level.
 */
function looksLikeTarget(t: string): boolean {
  if (t.startsWith("-")) return false
  const s = t.toLowerCase()
  return (
    s.includes("/") ||
    s.includes("\\") ||
    /\.(spec|test|e2e|feature)\./.test(s) ||
    /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|java|cs)$/.test(s)
  )
}

/**
 * Judge one token segment (no separators). Two shapes:
 *   1. <pm> [run] <script>        → gated when the script name says e2e;
 *      a path-like argument after the script (incl. `--` passthrough)
 *      downgrades the run to `targeted`.
 *   2. [pm/dl-exec] <runner> <verb> → gated for known runner CLIs; a
 *      path-like argument (or `--spec`) after the verb means `targeted`.
 */
function segmentE2eRisk(tokens: string[]): E2eRisk | null {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].toLowerCase()

    if (t === "pytest") {
      const risk = pytestRisk(tokens.slice(i + 1))
      if (risk) return risk
      continue
    }
    if ((t === "python" || t === "python3") && tokens[i + 1] === "-m" && tokens[i + 2] === "pytest") {
      const risk = pytestRisk(tokens.slice(i + 3))
      if (risk) return risk
      continue
    }
    if (PY_ENV_TOOLS.has(t)) {
      let j = i + 1
      if (j < tokens.length && tokens[j].toLowerCase() === "run") j++
      if (j < tokens.length && tokens[j].toLowerCase() === "pytest") {
        const risk = pytestRisk(tokens.slice(j + 1))
        if (risk) return risk
      }
      continue
    }
    if (t === "tox") {
      // `tox -e e2e` — an e2e-named environment is a suite run.
      for (let k = i + 1; k < tokens.length; k++) {
        if ((tokens[k] === "-e" || tokens[k] === "--env") && pathSaysE2e(tokens[k + 1] ?? "")) {
          return "full"
        }
      }
      continue
    }

    if (PACKAGE_MANAGER_EXECUTABLES.has(t)) {
      // First non-flag tokens after the PM: optional "run", then the script.
      let j = i + 1
      if (j < tokens.length && tokens[j].toLowerCase() === "run") j++
      while (j < tokens.length && isFlag(tokens[j])) j++
      if (j < tokens.length && scriptLooksE2e(tokens[j])) {
        const targeted = tokens.slice(j + 1).some(looksLikeTarget)
        return targeted ? "targeted" : "full"
      }
      // `npx playwright test` — the runner check below also sees the
      // runner token, so nothing extra needed here.
      continue
    }

    const verb = RUNNERS[t]
    if (verb !== undefined) {
      if (verb === null) {
        // nightwatch — any invocation runs tests unless it is purely
        // informational; path-like args = targeted.
        const rest = tokens.slice(i + 1)
        if (rest.some((tok) => NIGHTWATCH_INFO_FLAGS.has(tok.toLowerCase()))) return null
        return rest.some(looksLikeTarget) ? "targeted" : "full"
      }
      // Next non-flag token must be the executing verb: `playwright test`
      // gates, `playwright install` / `cypress open` (interactive) don't.
      let j = i + 1
      while (j < tokens.length && isFlag(tokens[j])) j++
      if (j < tokens.length && tokens[j].toLowerCase() === verb) {
        const rest = tokens.slice(j + 1)
        const targeted = rest.some((tok) => tok === "--spec" || looksLikeTarget(tok))
        return targeted ? "targeted" : "full"
      }
    }
  }
  return null
}

/**
 * The risk level of a command, or null when it runs no E2E. Segments are
 * judged independently and the HIGHEST risk wins, so
 * `npm run build && playwright test` gates as `full` even though the first
 * segment is harmless.
 *
 * The tokenizer only splits on whitespace/quotes, so separator characters
 * glued to a token (`test;`, `build&&x`) are isolated with a padding pass
 * first.
 */
export function classifyE2e(command: string): E2eRisk | null {
  const padded = command.replace(/(\|\||&&|[;&|])/g, " $1 ")
  const tokens = tokenize(padded)
  let worst: E2eRisk | null = null
  let segment: string[] = []
  const judge = () => {
    const r = segmentE2eRisk(segment)
    if (r === "full") worst = "full"
    else if (r === "targeted" && worst === null) worst = "targeted"
  }
  for (const tok of tokens) {
    if (SEPARATORS.has(tok)) {
      judge()
      segment = []
      continue
    }
    segment.push(tok)
  }
  judge()
  return worst
}

// ─── Block messages (one per risk level) ─────────────────────────────

export function blockMessageFull(): string {
  return (
    `[E2E-GUARD] Blocked: FULL-SUITE E2E run without user confirmation.\n` +
    `This project gates E2E suites — they are slow, flaky, expensive, and a ` +
    `last resort. PREFER A TARGETED RUN OF ONLY THE AFFECTED SPECS:\n` +
    `1. Identify the spec/test files covering the paths touched by the current ` +
    `diff (impact analysis), then offer the user an interactive choice: ` +
    `(a) RECOMMENDED — run only those affected specs (targeted); ` +
    `(b) run the full suite anyway; ` +
    `(c) skip E2E — verify with lightweight tiers (unit tests, type-check, ` +
    `compile) instead, which is the right answer when the user only asked ` +
    `for a code change (no commit/push, no explicit E2E request).\n` +
    `2. User chose (a) → run \`/e2e-guard allow targeted\`, then run the ` +
    `targeted command (explicit spec/test file argument). User chose (b) → ` +
    `run \`/e2e-guard allow\`, then retry the exact full-suite command.\n` +
    `Grants: \`allow targeted\` unlocks targeted re-runs for this session ` +
    `(full suites stay gated); \`allow\` additionally passes ONE full-suite ` +
    `run — every later full-suite run needs a fresh user confirmation. ` +
    `Never bypass by renaming the script or splitting the command.`
  )
}

export function blockMessageTargeted(): string {
  return (
    `[E2E-GUARD] Blocked: E2E run in a session with no confirmed E2E yet.\n` +
    `This is a TARGETED run (explicit spec/test file) — low risk — but the ` +
    `first E2E of a session always needs user confirmation. Targeted ` +
    `re-runs will then pass automatically for the rest of this session.\n` +
    `1. Confirm with the user via an interactive question: state why this ` +
    `run is justified and what it costs. If the user only asked for a code ` +
    `change (no commit/push, no explicit E2E request), do NOT run E2E — ` +
    `verify with lightweight tiers instead (unit tests, type-check, compile).\n` +
    `2. User confirmed → run \`/e2e-guard allow targeted\` (or \`allow\` ` +
    `if a full-suite run was also confirmed), then retry.`
  )
}

/** Kept for callers/tests that want a single generic message. */
export function blockMessage(): string {
  return blockMessageFull()
}
