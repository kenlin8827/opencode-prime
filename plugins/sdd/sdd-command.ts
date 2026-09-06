/**
 * Hook: command.execute.before — handle `/sdd`, `/prd`, `/plan`, `/impl`.
 *
 * SDD lifecycle:
 *   /prd  → Product Requirements Document (docs/prd/<topic>.md)
 *   /adr  → Architecture Decision Record (docs/adr/...)
 *   /plan → Implementation Plan (docs/plan/<topic>.md)
 *   /impl → Code Implementation & Verification
 *   /sdd  → Lifecycle status, artifact discovery, and workflow navigation
 */

import type { PluginInput } from "@opencode-ai/plugin"
import {
  listSddArtifacts,
  scaffoldPlan,
  scaffoldPrd,
} from "./sdd-engine"

export const SDD_COMMAND = "sdd"
export const PRD_COMMAND = "prd"
export const PLAN_COMMAND = "plan"
export const IMPL_COMMAND = "impl"

const HELP_TEXT = `[SDD] Specification-Driven Development

Lifecycle: /prd → /adr → /plan → /impl
(You can start from ANY phase and jump to any phase!)

Commands:
- /prd [topic]       → Draft Product Requirements Document in docs/prd/
- /adr [title]       → Record Architecture Decision in docs/adr/
- /plan [topic]      → Create phased Implementation Plan in docs/plan/
- /impl [task]       → Execute code implementation & test verification
- /sdd status        → Inspect existing PRDs, ADRs, and Plans
- /sdd handoff [msg] → Compact current SDD state and pause for next session
- /sdd help          → Show this help guide`

export function makeSddCommandHook(client: PluginInput["client"]) {
  return async (input: { command?: string; arguments?: string; sessionID?: string }) => {
    const cwd = process.cwd()
    const args = (input.arguments || "").trim()

    // 1. /sdd command handler
    if (input.command === SDD_COMMAND) {
      if (!args || args === "help" || args === "--help" || args === "-h") {
        if (client?.session?.prompt && input.sessionID) {
          await client.session.prompt({
            path: { id: input.sessionID },
            body: {
              parts: [{ type: "text", text: HELP_TEXT, ignored: true }],
              noReply: true,
            },
          })
          return
        }
      }

      if (args === "status") {
        const artifacts = listSddArtifacts(cwd)
        const report = `[SDD Status]
Project: ${cwd}
- PRDs (${artifacts.prds.length}): ${artifacts.prds.length > 0 ? artifacts.prds.join(", ") : "none"}
- ADRs (${artifacts.adrs.length}): ${artifacts.adrs.length > 0 ? artifacts.adrs.join(", ") : "none"}
- Plans (${artifacts.plans.length}): ${artifacts.plans.length > 0 ? artifacts.plans.join(", ") : "none"}

Lifecycle: /prd → /adr → /plan → /impl`

        if (client?.session?.prompt && input.sessionID) {
          await client.session.prompt({
            path: { id: input.sessionID },
            body: {
              parts: [{ type: "text", text: report, ignored: true }],
              noReply: true,
            },
          })
          return
        }
      }

      if (args === "handoff" || args.startsWith("handoff ")) {
        if (client?.session?.prompt && input.sessionID) {
          await client.session.prompt({
            path: { id: input.sessionID },
            body: {
              parts: [{ type: "text", text: `[SDD] 📦 Generating SDD Handoff Package... Compacting active stage, artifacts, and next steps into .opencode/handoffs/.`, ignored: true }],
              noReply: true,
            },
          })
        }
      }
    }

    // 2. /prd command handler (scaffold file if topic provided, then let LLM draft)
    if (input.command === PRD_COMMAND && args) {
      const { relPath, created } = scaffoldPrd(cwd, args)
      if (created && client?.session?.prompt && input.sessionID) {
        await client.session.prompt({
          path: { id: input.sessionID },
          body: {
            parts: [{ type: "text", text: `[SDD] 📄 Scaffolding PRD template at ${relPath}...`, ignored: true }],
            noReply: true,
          },
        })
      }
    }

    // 3. /plan command handler (scaffold file if topic provided, then let LLM draft)
    if (input.command === PLAN_COMMAND && args) {
      const { relPath, created } = scaffoldPlan(cwd, args)
      if (created && client?.session?.prompt && input.sessionID) {
        await client.session.prompt({
          path: { id: input.sessionID },
          body: {
            parts: [{ type: "text", text: `[SDD] 📋 Scaffolding Implementation Plan at ${relPath}...`, ignored: true }],
            noReply: true,
          },
        })
      }
    }

    // All SDD phase commands continue to LLM agent for execution and interactive transition prompts
  }
}
