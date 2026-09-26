/**
 * Shell Guard — turn configured high-risk shell commands into permission asks.
 * This is a prompt gate, not an execution sandbox or a complete command analyzer.
 */

import type { Plugin } from "@opencode/plugin"
import { isSubagentSession, type V2Session } from "../shared/agent-scope"
import policy from "./shell-guard-policy.json"

type GuardRule = { pattern: string; reason: string }
type GuardPolicy = {
  agents?: { include?: unknown; exclude?: unknown }
  rules?: unknown
}

const config = policy as GuardPolicy

function globMatch(pattern: string, value: string): boolean {
  if (pattern.endsWith(" *") && value === pattern.slice(0, -2)) return true
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`, "i").test(value)
}

function stringPatterns(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function guardApplies(agent: string | undefined): boolean {
  const include = stringPatterns(config.agents?.include)
  const exclude = stringPatterns(config.agents?.exclude)
  if (agent && exclude.some((pattern) => globMatch(pattern, agent))) return false
  if (!agent) return true
  if (!Array.isArray(config.agents?.include)) return true
  return include.some((pattern) => globMatch(pattern, agent))
}

function commandForMatch(resource: string): string {
  let command = resource.trim().replace(/^\$\s*/, "").replace(/^&\s*/, "").replace(/\s+/g, " ")
  if (/^rtk\s+/i.test(command)) command = command.replace(/^rtk\s+/i, "")
  if (/^git\.exe\s+/i.test(command)) command = command.replace(/^git\.exe\s+/i, "git ")
  return command
}

function matchingRule(resources: readonly string[]): GuardRule | undefined {
  const rules = Array.isArray(config.rules) ? config.rules as GuardRule[] : []
  for (const resource of resources) {
    if (typeof resource !== "string") continue
    const command = commandForMatch(resource)
    const rule = rules.find((candidate) =>
      candidate && typeof candidate.pattern === "string" && typeof candidate.reason === "string"
      && globMatch(candidate.pattern, command),
    )
    if (rule) return rule
  }
  return undefined
}

const plugin: Plugin.Plugin = {
  id: "opencode-prime.shell-guard",
  async setup(ctx) {
    const permission = await ctx.permission.hook("evaluate", async (event) => {
      if (event.action !== "shell" || event.effect === "deny" || !guardApplies(event.agent)) return
      const session = ctx.session as unknown as V2Session
      if (!(await isSubagentSession(event.sessionID, session))) return
      const rule = matchingRule(event.resources)
      if (!rule) return
      event.effect = "ask"
      event.message = `Shell Guard: ${rule.reason} Review the command and confirm before continuing.`
    })

    return async () => permission.dispose()
  },
}

export default plugin
