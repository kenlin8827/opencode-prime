/**
 * Hook: tool.execute.before — the E2E gate, graded by risk level.
 *
 * Intercepts bash/shell tool calls that run an E2E suite. When the guard
 * is on for this project (project-level switch) and the command contains
 * at least one E2E execution — a package-manager run script whose name
 * says e2e, a dedicated runner CLI (playwright test, cypress run,
 * nightwatch, codeceptjs run), or a Python runner invocation that says
 * e2e (pytest/tox) — the risk level decides the gate:
 *
 *   full     — suite run with no explicit target: needs a fresh one-shot
 *              approval (`/e2e-guard allow`) for EVERY run.
 *   targeted — explicit spec/test file argument: passes automatically once
 *              the session has ANY user-confirmed approval (cheap re-runs
 *              after a fix must not re-tax the user); blocked before that.
 *
 * Chained segments are judged independently; the HIGHEST risk level wins.
 * On pass-through a pending one-shot approval is CONSUMED.
 *
 * Fail-open decisions (never block on ambiguity):
 *   - Unrecognized command shapes → allow; the system-prompt test-scope
 *     policy still instructs the agent to confirm before E2E.
 *   - Non-executing runner verbs (playwright install, cypress open) → allow.
 *   - Ambiguous target detection degrades to the HIGHER `full` level.
 *
 * NOT wrapped in safeHook — throws are the blocking mechanism and must
 * propagate. All predicates are null-safe, so unexpected errors are
 * unlikely.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import { extractBashCommand, makeLogger } from "../adr/adr-runtime"
import { isEnabled } from "./e2e-guard-config"
import {
  blockMessageFull,
  blockMessageTargeted,
  classifyE2e,
  consumeApproval,
  isUnlocked,
} from "./e2e-guard-runtime"

type Log = ReturnType<typeof makeLogger>

export function makeToolGuardHook(client: PluginInput["client"]) {
  const log: Log = makeLogger(client, "e2e-guard")

  // NOT wrapped in safeHook — intentional throws must propagate to block
  // tool execution. safeHook would swallow them and defeat the guard.
  return async (
    input: { tool?: string; sessionID?: string },
    output: { args?: unknown },
  ) => {
    if (!isEnabled()) return

    const tool = String(input?.tool ?? "").toLowerCase()
    if (tool !== "bash" && tool !== "shell") return

    const command = extractBashCommand(output?.args)
    if (!command) return
    const risk = classifyE2e(command)
    if (!risk) return

    const sessionID = String(input?.sessionID ?? "")

    if (risk === "targeted") {
      // Low risk: a pending one-shot pass covers it, and once the session
      // has ANY confirmed approval, targeted re-runs flow with a log line.
      if (consumeApproval(sessionID)) {
        await log("info", `targeted E2E run approved via /e2e-guard allow: "${command}"`)
        return
      }
      if (isUnlocked(sessionID)) {
        await log("info", `targeted E2E re-run passes (session unlocked): "${command}"`)
        return
      }
      await log(
        "warn",
        `blocked targeted E2E run — session has no confirmed E2E yet: "${command.split(/\r?\n/)[0]}"`,
      )
      throw new Error(blockMessageTargeted())
    }

    // Full suite: every run pays the one-shot cost.
    if (consumeApproval(sessionID)) {
      await log("info", `full-suite E2E run approved by /e2e-guard allow (one-shot consumed): "${command}"`)
      return
    }

    await log(
      "warn",
      `blocked full-suite E2E run without user confirmation: "${command.split(/\r?\n/)[0]}"`,
    )
    throw new Error(blockMessageFull())
  }
}
