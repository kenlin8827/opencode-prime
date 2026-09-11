/**
 * Hook: command.execute.before — `/memory <subcommand>` user controls.
 *
 *   /memory capture <lesson>  → append one dated entry to the project's draft
 *                               file (<ocp config root>/memory/<projectKey>/draft.md)
 *   /memory on | off          → flip the `projectMemory` project-config switch
 *   /memory status            → gate state + memory/draft entry counts
 *   /memory                   → help
 *
 * Capture is an explicit user trigger — no auto-capture (noise graveyard →
 * LLM trust erosion, see docs/plan/project-memory-phase1.md). Replies use
 * session.prompt({ noReply, ignored }) — visible to the user, invisible to
 * the LLM: capturing a lesson must not start a conversation.
 */

import { readFileSync } from "node:fs"
import type { PluginInput } from "@opencode-ai/plugin"
import { refreshLocale, tr } from "../tui/i18n"
import {
  countEntries,
  draftPath,
  getState,
  memoryPath,
  appendDraft,
  readMemory,
  setState,
  writableProjectConfigFile,
} from "./project-memory-config"

export const COMMAND_NAME = "memory"

export const SUBCOMMAND_CAPTURE = "capture"
export const SUBCOMMAND_STATUS = "status"
export const SUBCOMMAND_ON = "on"
export const SUBCOMMAND_OFF = "off"

/** HELP built at call time — locale from ocp config/env, paths per project. */
function helpText(): string {
  refreshLocale()
  return tr("guard.memory.help", { memory: memoryPath(), draft: draftPath() })
}

/** Parse `/memory ...` arguments into { sub, rest }. Pure — exported for tests. */
export function parseCaptureArgs(args: unknown): { sub: string; rest: string } {
  const trimmed = (typeof args === "string" ? args : "").trim()
  const [sub = "", ...rest] = trimmed.split(/\s+/)
  return { sub: sub.toLowerCase(), rest: rest.join(" ").trim() }
}

/** Strip one layer of matching surrounding quotes a user may have typed. */
function unquote(text: string): string {
  return text.replace(/^"([^"]*)"$/s, "$1").replace(/^'([^']*)'$/s, "$1")
}

export function statusText(): string {
  refreshLocale()
  const gate = getState()
  const memory = readMemory()
  let draft = 0
  try {
    draft = countEntries(readFileSync(draftPath(), "utf-8"))
  } catch {
    /* no draft file yet */
  }
  const injected = gate === "on" && memory !== null
  return tr("guard.memory.status", {
    gate,
    memory: memory === null ? tr("guard.memory.missing") : tr("guard.memory.entries", { count: countEntries(memory) }),
    draft,
    flag: injected ? "ACTIVE" : "INACTIVE",
  })
}

async function reply(client: PluginInput["client"], sessionID: string | undefined, text: string): Promise<void> {
  if (!sessionID) return
  await client.session.prompt({
    path: { id: sessionID },
    body: {
      parts: [{ type: "text", text, ignored: true }],
      noReply: true,
    },
  })
}

export function makeCommandHook(client: PluginInput["client"], handled: () => never) {
  return async (input: { command?: string; arguments?: string; sessionID?: string }) => {
    if (input.command !== COMMAND_NAME) return

    const { sub, rest } = parseCaptureArgs(input.arguments)

    let text: string
    if (sub === SUBCOMMAND_CAPTURE) {
      const lesson = unquote(rest)
      if (lesson === "") {
        refreshLocale()
        text = `${tr("guard.memory.nothing")}\n\n${helpText()}`
      } else {
        try {
          const path = appendDraft(lesson)
          refreshLocale()
          text = tr("guard.memory.captured", { draft: path, memory: memoryPath() })
        } catch (err) {
          text = `[project-memory] capture failed: ${String(err)}`
        }
      }
    } else if (sub === SUBCOMMAND_STATUS) {
      text = statusText()
    } else if (sub === SUBCOMMAND_ON || sub === SUBCOMMAND_OFF) {
      refreshLocale()
      text = setState(sub)
        ? tr("guard.memory.set", {
            state: sub,
            STATE: sub.toUpperCase(),
            zhState: sub === "on" ? "启用" : "关闭",
            path: writableProjectConfigFile(),
          })
        : tr("guard.memory.setFail", { field: "projectMemory" })
    } else {
      refreshLocale()
      text = sub ? `${tr("guard.memory.unknown", { sub })}\n\n${helpText()}` : helpText()
    }

    await reply(client, input.sessionID, text)
    return handled()
  }
}
