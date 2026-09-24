/**
 * Prompt-hook handler — side effects for `/sdd`, `/prd`, `/plan`, `/impl`.
 *
 * V2 MAPPING NOTE (v1 → v2): v1 used `command.execute.before`. These four
 * commands are template-defined (commands/*.md launchers, owned outside
 * this plugin), and the v1 handler NEVER cancelled them — it only announced
 * scaffolding via noReply synthetic messages and let the template proceed.
 * The faithful v2 equivalent is therefore the "prompt" hook matching the
 * leading "/<name>" text (ctx.command.transform would REPLACE the template
 * command — wrong intent). Prompt hook callbacks fire before durable
 * admission, like the v1 before-hook.
 *
 * SDD lifecycle:
 *   /prd  → Product Requirements Document (docs/prd/<topic>.md)
 *   /adr  → Architecture Decision Record (docs/adr/...)
 *   /plan → Implementation Plan (docs/plan/<topic>.md)
 *   /impl → Code Implementation & Verification
 *   /sdd  → Lifecycle status, artifact discovery, and workflow navigation
 */

import { injectReply, type V2Session } from "../shared/agent-scope"
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

/** V2 prompt-hook handler. Announcements go through the synthetic-message
 *  channel (v1 equivalent: session.prompt({noReply, ignored})). The
 *  directory is injected so the handler does not depend on the plugin
 *  host's process.cwd() (v1 behavior — preserved: same value source). */
export function makeSddCommandHook(session: V2Session | undefined) {
  return async (input: { command?: string; arguments?: string; sessionID?: string }) => {
    const cwd = process.cwd()
    const args = (input.arguments || "").trim()

    // 1. /sdd command handler
    if (input.command === SDD_COMMAND) {
      if (!args || args === "help" || args === "--help" || args === "-h") {
        if (input.sessionID) {
          await injectReply(session, input.sessionID, HELP_TEXT)
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

        if (input.sessionID) {
          await injectReply(session, input.sessionID, report)
          return
        }
      }

      if (args === "handoff" || args.startsWith("handoff ")) {
        await injectReply(session, input.sessionID, `[SDD] 📦 Generating SDD Handoff Package... Compacting active stage, artifacts, and next steps into .ocp/handoffs/.`)
      }
    }

    // 2. /prd command handler (scaffold file if topic provided, then let LLM draft)
    if (input.command === PRD_COMMAND && args) {
      const { relPath, created } = scaffoldPrd(cwd, args)
      if (created) {
        await injectReply(session, input.sessionID, `[SDD] 📄 Scaffolding PRD template at ${relPath}...`)
      }
    }

    // 3. /plan command handler (scaffold file if topic provided, then let LLM draft)
    if (input.command === PLAN_COMMAND && args) {
      const { relPath, created } = scaffoldPlan(cwd, args)
      if (created) {
        await injectReply(session, input.sessionID, `[SDD] 📋 Scaffolding Implementation Plan at ${relPath}...`)
      }
    }

    // All SDD phase commands continue to LLM agent for execution and interactive transition prompts
  }
}
