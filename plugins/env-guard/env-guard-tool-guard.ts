/**
 * Hook: tool.execute.before — the secret-file gate.
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
 * NOT wrapped in safeHook — throws are the blocking mechanism and must
 * propagate. All predicates are null-safe, so unexpected errors are
 * unlikely.
 */

import type { PluginInput } from "@opencode-ai/plugin"
import { extractBashCommand } from "../adr/adr-runtime"
import { isEnabled } from "./env-guard-config"
import {
  bashLeaksEnv,
  blockMessage,
  extractFilePath,
  isSensitiveEnvPath,
} from "./env-guard-runtime"

const FILE_TOOLS = new Set(["read", "edit", "write", "patch", "multiedit"])

export function makeToolGuardHook(client: PluginInput["client"]) {
  const log = (level: "info" | "warn", message: string) =>
    client.app.log({ body: { service: "env-guard", level, message } })

  // NOT wrapped in safeHook — intentional throws must propagate to block
  // tool execution. safeHook would swallow them and defeat the guard.
  return async (input: { tool?: string }, output: { args?: unknown }) => {
    if (!isEnabled()) return

    const tool = String(input?.tool ?? "").toLowerCase()

    if (FILE_TOOLS.has(tool) || tool === "grep") {
      const path = extractFilePath(output?.args)
      if (path && isSensitiveEnvPath(path)) {
        await log("warn", `blocked ${tool} on secret file: ${path}`)
        throw new Error(blockMessage(`${tool} on ${path}`))
      }
      return
    }

    if (tool === "bash" || tool === "shell") {
      const command = extractBashCommand(output?.args)
      if (command && bashLeaksEnv(command)) {
        await log("warn", `blocked bash leaking secret file: "${command}"`)
        throw new Error(blockMessage("shell command reading/copying a secret .env file"))
      }
    }
  }
}
