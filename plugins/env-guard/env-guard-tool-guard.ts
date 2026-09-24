/**
 * Hook: tool execute.before — the secret-file gate (v2 plugin API).
 *
 * When the guard is on for this project, blocks tool calls that would put
 * secret-bearing .env* contents into the LLM context:
 *
 *   1. File tools (read/edit/write/patch/multiedit) targeting a sensitive
 *      .env path — read surfaces values; edit/write lets the agent handle
 *      secrets it should never see (scaffolding goes through bash copy).
 *   2. Grep tool with a path argument pointing at a sensitive .env file.
 *   3. bash/shell commands that read a sensitive .env file into output
 *      (cat/grep/Get-Content/…), redirect one into stdin, or copy one out
 *      to another path.
 *
 * `.env.example` is always allowed — it is the sanctioned scaffold.
 *
 * v2 failure contract: only execute.before may reject, and only with a
 * Tool.Error-shaped throw (the deny path). Everything else — a guard
 * defect, a broken predicate — must fail open silently-with-log, because
 * a hook defect aborts the whole request flow, not just the one call.
 */

import { extractBashCommand } from "../adr/adr-runtime"
import { isEnabled } from "./env-guard-config"
import {
  bashLeaksEnv,
  blockMessage,
  extractFilePath,
  isSensitiveEnvPath,
} from "./env-guard-runtime"

const FILE_TOOLS = new Set(["read", "edit", "write", "patch", "multiedit"])

/**
 * The v2 deny shape: a Tool.Error-tagged rejection (mirrors
 * @opencode/schema/tool Tool.Error: message + optional metadata). Thrown
 * from execute.before the tool never runs; the message is what the model
 * sees as the failed call.
 */
export class ToolRejection extends Error {
  readonly _tag = "Tool.Error" as const
  readonly metadata: Record<string, unknown> | undefined

  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message)
    this.metadata = metadata
  }
}

/** Structural slice of the v2 execute.before event the guard consumes. */
export interface ToolBeforeEvent {
  readonly tool: string
  readonly input: unknown
}

/**
 * The block reason for one tool call, or null to let it through.
 * Pure decision — the hook wraps this so an unexpected defect can only
 * fail open, never masquerade as a deny.
 */
function classify(event: ToolBeforeEvent): string | null {
  const tool = String(event.tool ?? "").toLowerCase()

  if (FILE_TOOLS.has(tool) || tool === "grep") {
    const path = extractFilePath(event.input)
    if (path && isSensitiveEnvPath(path)) return `${tool} on secret file: ${path}`
    return null
  }

  if (tool === "bash" || tool === "shell") {
    const command = extractBashCommand(event.input)
    if (command && bashLeaksEnv(command)) return "shell command reading/copying a secret .env file"
  }

  return null
}

export function makeToolGuardHook() {
  // v2 has no structured plugin log API (v1 client.app.log is gone);
  // server-side console is the documented replacement.
  return async (event: ToolBeforeEvent): Promise<void> => {
    if (!isEnabled()) return

    let reason: string | null
    try {
      reason = classify(event)
    } catch (err) {
      console.warn(`[env-guard] check failed open: ${String(err)}`)
      return
    }
    if (!reason) return

    console.warn(`[env-guard] blocked ${reason}`)
    throw new ToolRejection(blockMessage(reason))
  }
}
