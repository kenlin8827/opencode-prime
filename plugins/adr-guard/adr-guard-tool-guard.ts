/**
 * Hook: tool.execute.before — the commit gates.
 *
 * TWO independent gates (§6.4), each with its own switch:
 *
 *   1. Strict governance gate (`adr.governance: strict`, §11/§13 Phase 6):
 *      - Any staged ADR diff flipping status to `accepted` whose ID has no
 *        entry in the append-only ledger (`.ocp/adr-decisions.log`, written
 *        only by user-run `/adr decide`) → block. The agent can never
 *        self-accept; this is checked on EVERY commit.
 *      - A feat/fix/refactor commit that ships no decided accept flip at
 *        all → block. Strict is documented as subsuming the legacy
 *        presence gate: migrating means turning `adrGuard` off.
 *   2. Legacy iron-law gate (`adrGuard: on`, unchanged): feat/refactor
 *      commits require ANY ADR change in the working tree. Independent of
 *      governance — it keeps working exactly as today.
 *
 * Intercepts bash/shell tool calls that run `git commit`. When ALL of the
 * following hold, the legacy gate blocks with an actionable error:
 *
 *   1. The iron law is on for this project (project-level switch).
 *   2. The command contains at least one `git commit` invocation that is
 *      not `--amend` — chained commits are each judged independently, so an
 *      earlier `--amend` never exempts a later fresh commit.
 *   3. One of those invocations carries an inline commit message
 *      (-m / --message) whose conventional-commit type is feat or refactor
 *      (scoped/breaking variants included).
 *   4. No file under the ADR directory (default docs/adr/) appears in the
 *      working-tree change set (staged, unstaged, or untracked).
 *
 * Fail-open decisions (never block on ambiguity):
 *   - No inline message (editor/heredoc commit) → allow; the system-prompt
 *     protocol still instructs the agent to include an ADR.
 *   - Non-feat/refactor type (fix, docs, chore, …) → allow.
 *   - git status errors (not a repo, binary missing) → allow.
 *
 * NOT wrapped in safeHook — throws are the blocking mechanism and must
 * propagate. All predicates are null-safe, so unexpected errors are
 * unlikely.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import { refreshLocale, tr } from "../tui/i18n"
import { getAdrConfig, getAdrDir, getAdrLayout, getProjectDir, isEnabled } from "./adr-guard-config"
import { discoverAdrDirectories } from "./adr-engine"
import { readDecidedIds, stagedAcceptFlips } from "./adr-governance"
import {
  commitMessageOfSegment,
  extractBashCommand,
  gitCommitSegments,
  hasAdrChanges,
  makeLogger,
  requiresAdr,
  segmentCommitsAll,
} from "./adr-guard-runtime"

type Log = ReturnType<typeof makeLogger>

function blockMessage(adrDir: string): string {
  return (
    `[ADR-GUARD] Blocked: feat/refactor commit without an ADR change.\n` +
    `This project enforces the ADR iron law (MADR convention). ` +
    `Every feat/refactor commit MUST include a new or updated ADR.\n` +
    `Fix before re-running the commit:\n` +
    `1. New decision → create ${adrDir}/NNNN-slug.md (next sequential number) ` +
    `from the MADR template: frontmatter status: accepted, date: <today>, ` +
    `then "## Context and Problem Statement" + "## Decision Outcome".\n` +
    `   Changed decision → write a NEW ADR and set the old one's frontmatter ` +
    `status to "superseded by NNNN".\n` +
    `2. Stage the ADR file (git add ${adrDir}/...) so it ships in the SAME commit.\n` +
    `3. Update ${adrDir}/INDEX.md (flat list by number).\n` +
    `Never bypass by relabeling the commit type.`
  )
}

// ─── Strict governance gate (§11/§13 Phase 6) ────────────────────────
// Independent of the legacy adrGuard switch (§6.4): strict SUBSUMES the
// legacy presence gate, so migrating means turning adrGuard off to avoid
// double-gating — until then both apply independently.

/** feat/fix/refactor commits must ship a decided ADR status flip (strict). */
const REQUIRES_DECISION_RE = /^\s*(feat|fix|refactor)(\([^)]*\))?!?\s*:/i

function requiresStrictDecision(message: string): boolean {
  const firstLine = String(message || "").split(/\r?\n/)[0]
  return REQUIRES_DECISION_RE.test(firstLine)
}

function undecidedFlipMessage(ids: string[]): string {
  return (
    `[ADR-GOVERNANCE] Blocked: ADR ${ids.join(", ")} flipped to accepted without a decision record.\n` +
    `Strict governance red line: the agent can NEVER flip status to accepted — ` +
    `only the user-run \`/adr decide <ADR-ID> [note]\` writes the flip plus an ` +
    `append-only ledger entry (.ocp/adr-decisions.log).\n` +
    `Fix before re-running the commit:\n` +
    `1. If the flip was a hand-edit → revert it (git restore), then ask the user to run \`/adr decide ${ids[0]}\`.\n` +
    `2. Stage the ADR file so the ledger-backed flip ships in the SAME commit.`
  )
}

function strictGateMessage(): string {
  return (
    `[ADR-GOVERNANCE] Blocked: strict governance requires a DECIDED ADR status flip ` +
    `in every feat/fix/refactor commit.\n` +
    `Fix before re-running the commit:\n` +
    `1. Record the decision: \`/adr new [layer] <title>\` (scaffolds proposed).\n` +
    `2. Ask the user to run \`/adr decide <ADR-ID>\` — the only proposed → accepted path.\n` +
    `3. Stage the ADR file so the decided flip ships in the SAME commit.\n` +
    `Never bypass by relabeling the commit type.`
  )
}

export function makeToolGuardHook(client: PluginInput["client"]) {
  const log: Log = makeLogger(client, "adr-guard")

  // NOT wrapped in safeHook — intentional throws must propagate to block
  // tool execution. safeHook would swallow them and defeat the guard.
  return async (input: { tool?: string }, output: { args?: unknown }) => {
    const tool = String(input?.tool ?? "").toLowerCase()
    if (tool !== "bash" && tool !== "shell") return

    const command = extractBashCommand(output?.args)
    if (!command) return

    // One argument-token segment per `git commit` invocation — chained
    // commits are judged independently.
    const segments = gitCommitSegments(command)
    if (segments.length === 0) return

    // --amend re-commits are exempt from the POSITIVE decision requirement
    // only: an amend must NEVER launder a hand-flipped accept into the
    // tree, so the undecided-flip audit below runs for EVERY invocation
    // including --amend. The exemption is also per-invocation: `git commit
    // --amend && git commit -m "feat: x"` still gates the latter.
    const candidates = segments.filter((seg) => !seg.includes("--amend"))
    const messages = candidates.map(commitMessageOfSegment)

    // ── Strict governance gate (§11) — runs regardless of the legacy
    //    adrGuard switch; both gates stay independent (§6.4).
    if (getAdrConfig().governance === "strict") {
      const projectDir = getProjectDir()
      // Hierarchical/nested ADR dirs are first-class: the engine discovers
      // them via discoverAdrDirectories, so the gate must scan ALL of them
      // — a nested undecided flip would otherwise pass silently, and a
      // legitimately decided nested flip would falsely block.
      const adrDirs = discoverAdrDirectories(projectDir, getAdrDir(), getAdrLayout())
      // `git commit -a` (incl. combined `-am`/`-qa`) also ships TRACKED
      // UNSTAGED modifications — invisible to `git diff --cached`. Probe
      // the working diff too whenever a segment commits-all, else a
      // hand-flip left unstaged bypasses the audit via `git commit -am`.
      // Scanned across ALL segments (not just non-amend candidates):
      // `git commit -a --amend` stages working-tree changes as well.
      const commitsAll = segments.some(segmentCommitsAll)
      const flips = stagedAcceptFlips(projectDir, adrDirs, commitsAll)
      const decided = readDecidedIds(projectDir)
      const undecided = flips.filter((f) => !decided.has(f.id))
      if (undecided.length > 0) {
        await log(
          "warn",
          `blocked commit — undecided ADR accept flip(s): ${undecided.map((f) => `${f.id} (${f.relPath})`).join(", ")}`,
        )
        throw new Error(undecidedFlipMessage(undecided.map((f) => f.id)))
      }
      if (candidates.length === 0) return
      const gatedIdx = messages.findIndex((m) => m !== null && requiresStrictDecision(m))
      if (gatedIdx >= 0) {
        // `git commit ... -- <path>` ships only the named working-tree
        // paths, ignoring the rest of the index the gate just validated:
        // a decided flip would land in a LATER non-gated commit, breaking
        // the SAME-commit invariant. Refuse pathspec commits outright.
        if (candidates[gatedIdx]?.includes("--")) {
          await log("warn", "blocked pathspec commit — bypasses the staged-index gate")
          refreshLocale()
          throw new Error(tr("guard.adr.pathspecBlock"))
        }
        if (flips.length === 0) {
          const gated = messages[gatedIdx] ?? ""
          await log("warn", `blocked ${gated.split(/\r?\n/)[0]} commit — strict governance requires a decided ADR flip`)
          throw new Error(strictGateMessage())
        }
      }
    }

    if (candidates.length === 0) return

    // ── Legacy iron-law gate (unchanged, §6.4): presence of ANY ADR
    //    change in the working tree for feat/refactor commits.
    if (!isEnabled()) return

    const gated = messages.find((m) => m !== null && requiresAdr(m))
    if (!gated) {
      if (messages.every((m) => m === null)) {
        // Editor/heredoc commit — type unknown, fail open (protocol still applies).
        await log("info", "git commit without inline message — not gated")
      }
      return
    }

    const projectDir = getProjectDir()
    const adrDir = getAdrDir()
    if (hasAdrChanges(projectDir, adrDir)) return

    await log(
      "warn",
      `blocked feat/refactor commit — no ADR change under ${adrDir}/: "${gated.split(/\r?\n/)[0]}"`,
    )
    throw new Error(blockMessage(adrDir))
  }
}
