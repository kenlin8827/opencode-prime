/**
 * Hook: tool.execute.before — the mechanical commit-convention gate.
 *
 * File-as-switch: active exactly while docs/git-commits.md exists in the
 * project (same predicate as the system-prompt injection — no separate
 * state file, no on/off command). The file guides semantics (LLM reads it);
 * this gate enforces the mechanically checkable subset:
 *
 *   - first line matches `type(scope)?!?: summary` with a known type
 *   - first line ≤ 72 characters
 *
 * Intercepts bash/shell tool calls that run `git commit`. Every invocation
 * in a chained command is judged independently. The commit is blocked with
 * an actionable error when the message violates the structural rules.
 *
 * Exemptions / fail-open (never block on ambiguity, same stance as
 * adr):
 *   - `--amend` re-commits (rewriting history, not new work) — per invocation
 *   - Merge/revert/fixup/squash messages (git-generated forms)
 *   - No inline message (editor/heredoc commit) → allow; the injected
 *     convention still instructs the agent.
 *   - Non-bash tools, non-commit commands → allow.
 *
 * NOT wrapped in safeHook — throws are the blocking mechanism and must
 * propagate.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import {
  commitMessageOfSegment,
  extractBashCommand,
  gitCommitSegments,
  makeLogger,
} from "../adr/adr-runtime"
import { GIT_COMMITS_REL, hasConventionFile } from "./project-manager-config"

// Structural subset of Conventional Commits the gate can check mechanically.
// Superset of the template's type table (build/style/revert included) so
// standard commits are never blocked even if the file's table is shorter.
const ALLOWED_TYPES = "feat|fix|refactor|docs|test|chore|perf|ci|build|style|revert"
const FIRST_LINE_RE = new RegExp(`^(${ALLOWED_TYPES})(\\([^)]*\\))?!?: .+`)
const MAX_FIRST_LINE = 72

// Git-generated message forms are exempt — they are not authored work.
const EXEMPT_PREFIX_RE = /^(Merge |Revert |fixup!|squash!)/

/** null when compliant; otherwise a one-line reason for the block. */
export function validateMessage(message: string): string | null {
  const firstLine = String(message || "").split(/\r?\n/)[0]
  if (EXEMPT_PREFIX_RE.test(firstLine)) return null
  if (!FIRST_LINE_RE.test(firstLine)) {
    return `first line must match "type(scope): summary" with a known type — got "${firstLine}"`
  }
  if (firstLine.length > MAX_FIRST_LINE) {
    return `first line is ${firstLine.length} chars — max is ${MAX_FIRST_LINE}`
  }
  return null
}

function blockMessage(reason: string): string {
  return (
    `[project-manager] Blocked: commit message violates the project commit convention.\n` +
    `Problem: ${reason}\n` +
    `This project defines ${GIT_COMMITS_REL} — the gate is active while that file exists.\n` +
    `Fix the message and re-run the commit:\n` +
    `1. First line: "<type>(<optional scope>): <summary>" — imperative mood, ≤ ${MAX_FIRST_LINE} chars.\n` +
    `2. Allowed types: feat, fix, refactor, docs, test, chore, perf, ci, build, style, revert.\n` +
    `Never bypass by relabeling the commit type.`
  )
}

export function makeToolGuardHook(client: PluginInput["client"]) {
  const log = makeLogger(client, "project-manager")

  // NOT wrapped in safeHook — intentional throws must propagate to block
  // tool execution. safeHook would swallow them and defeat the guard.
  return async (input: { tool?: string }, output: { args?: unknown }) => {
    // File-as-switch: no convention file → complete no-op.
    if (!hasConventionFile()) return

    const tool = String(input?.tool ?? "").toLowerCase()
    if (tool !== "bash" && tool !== "shell") return

    const command = extractBashCommand(output?.args)
    if (!command) return

    // One argument-token segment per `git commit` invocation — chained
    // commits are judged independently.
    const segments = gitCommitSegments(command)
    if (segments.length === 0) return

    // --amend re-commits are exempt, but ONLY for their own invocation:
    // `git commit --amend && git commit -m "bad"` still gates the latter.
    const candidates = segments.filter((seg) => !seg.includes("--amend"))
    if (candidates.length === 0) return

    const messages = candidates.map(commitMessageOfSegment)
    const violating = messages
      .filter((m): m is string => m !== null)
      .map((m) => ({ message: m, reason: validateMessage(m) }))
      .find((r) => r.reason !== null)

    if (!violating) {
      if (messages.every((m) => m === null)) {
        // Editor/heredoc commit — message unknown, fail open (the injected
        // convention still applies).
        await log("info", "git commit without inline message — not gated")
      }
      return
    }

    await log(
      "warn",
      `blocked commit — convention violation (${violating.reason}): "${violating.message.split(/\r?\n/)[0]}"`,
    )
    throw new Error(blockMessage(violating.reason!))
  }
}
