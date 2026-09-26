/**
 * E2E Adopt (/e2e-adopt) — scaffolds the E2E red-line policy into the
 * project's own documentation. The runtime-plugin-free successor of the
 * retired e2e-guard plugin (owner decision 2026-09-22): E2E discipline
 * lives in project docs (AGENTS.md red-line row + docs/e2e-redline.md),
 * governed by the project, not by a runtime switch.
 *
 * User-invoked only — the command IS the consent (same philosophy as
 * /adr init and /project init): detection pre-selects template values,
 * nothing is applied silently, and every write is reported. A `dry`
 * subcommand previews without writing.
 *
 * Subcommands:
 *   /e2e-adopt        detect → render → write docs/e2e-redline.md +
 *                     AGENTS.md section → full report
 *   /e2e-adopt dry    same, nothing written
 *   /e2e-adopt status is the policy adopted? (doc + AGENTS.md section)
 *   anything else     help
 *
 * Uninstall = delete docs/e2e-redline.md + the marked AGENTS.md section
 * (documented in the command output; no reverse subcommand by design).
 *
 * V2 MAPPING NOTE (v1 → v2): v1 registered `/e2e-adopt` via the `config`
 * hook (empty template) + `command.execute.before` writing the report into
 * `output.parts` (model-visible). The command is plugin-OWNED, so v2
 * registers it through `ctx.command.transform(editor.add)`. The report
 * reaches the model as an ordinary prompt turn: `session.prompt` (v1's
 * `output.parts` injection had the same "agent acts on the report"
 * semantics).
 */

import type { Plugin } from "@opencode/plugin"
import { commandArgumentText, injectReply, type V2Session } from "../shared/agent-scope"
import { getProjectDir, setProjectDir } from "../shared/opencode-prime"
import { refreshLocale, tr } from "../tui/i18n"
import { applyAdoption, adoptionStatus, E2E_REDLINE_DOC_REL } from "./e2e-adopt-apply"
import { detectE2eSetup, templateValuesFrom } from "./e2e-adopt-detect"
import {
  renderAgentsSection,
  renderRedlineDoc,
  unfilledPlaceholders,
} from "./e2e-adopt-template"

export const E2E_ADOPT_COMMAND = "e2e-adopt"

function helpText(): string {
  return tr("guard.e2eadopt.help")
}

function detectionLine(d: ReturnType<typeof detectE2eSetup>): string {
  const fmt = (v: string | null) => v ?? "—"
  return tr("guard.e2eadopt.detect", {
    dir: fmt(d.e2eDir),
    runner: fmt(d.runnerConfig),
  })
}

/** The command is never guessed (stack-agnostic by design) — always point
 * at the agent-fill / hand-fill path for the {{E2E_COMMAND}} placeholder. */
function fillHint(): string {
  return "\n" + tr("guard.e2eadopt.fillHint") + "\n"
}

function placeholderHint(...texts: string[]): string {
  const unfilled = unfilledPlaceholders(...texts)
  if (unfilled.length === 0) return ""
  return "\n" + tr("guard.e2eadopt.placeholders", { list: unfilled.join(", ") }) + "\n"
}

function uninstallHint(): string {
  return tr("guard.e2eadopt.uninstall")
}

/** Build the /e2e-adopt report. V2 command handler (registered via
 *  ctx.command.transform in the entry): the returned text is delivered to
 *  the model through session.prompt — v1 equivalent: mutating
 *  `output.parts` in `command.execute.before`. */
export function makeCommandHandler() {
  return async (
    input: { arguments?: string; sessionID?: string },
  ): Promise<string> => {
    refreshLocale()
    const root = getProjectDir()
    const sub = (input.arguments ?? "").trim().toLowerCase()

    let text: string
    if (sub === "status") {
      try {
        const st = adoptionStatus(root)
        text =
          tr("guard.e2eadopt.status", {
            doc: st.docExists ? "docs/e2e-redline.md ✓" : `${E2E_REDLINE_DOC_REL} ✗`,
            section: st.agentsHasSection ? "✓" : st.agentsExists ? "✗" : "✗ (no AGENTS.md)",
          }) + "\n" + uninstallHint()
      } catch (err) {
        // Unreadable AGENTS.md (EISDIR / permissions) — degrade to the
        // localized failure line instead of crashing the hook.
        text = tr("guard.e2eadopt.writeFail", { error: err instanceof Error ? err.message : String(err) })
      }
    } else if (sub === "" || sub === "dry") {
      const dry = sub === "dry"
      const detection = detectE2eSetup(root)
      const values = templateValuesFrom(detection)
      const doc = renderRedlineDoc(values)
      const section = renderAgentsSection(values)

      if (dry) {
        text =
          tr("guard.e2eadopt.dry") +
          "\n" +
          detectionLine(detection) +
          fillHint() +
          placeholderHint(doc, section) +
          uninstallHint()
      } else {
        try {
          const r = applyAdoption(root, doc, section)
          const lines: string[] = []
          lines.push(r.docWritten ? `+ ${E2E_REDLINE_DOC_REL}` : `= ${E2E_REDLINE_DOC_REL} (already exists — not overwritten)`)
          if (r.agentsMissing) {
            lines.push(tr("guard.e2eadopt.agentsMissing"))
          } else if (r.agentsMalformed) {
            lines.push(tr("guard.e2eadopt.agentsMalformed"))
          } else if (r.agentsSectionIdentical) {
            lines.push("= AGENTS.md section (already up to date)")
          } else {
            lines.push(r.agentsSectionWritten ? "+ AGENTS.md (red-line section inserted)" : "~ AGENTS.md (red-line section updated)")
          }
          text =
            tr("guard.e2eadopt.applied") +
            "\n" +
            detectionLine(detection) +
            fillHint() +
            "\n" +
            lines.map((l) => `  ${l}`).join("\n") +
            placeholderHint(doc, section) +
            uninstallHint()
        } catch (err) {
          text = tr("guard.e2eadopt.writeFail", { error: err instanceof Error ? err.message : String(err) })
        }
      }
    } else {
      text = helpText()
    }

    return text
  }
}

export const E2eAdoptPlugin: Plugin.Plugin = {
  id: "opencode-prime.e2e-adopt",
  async setup(ctx) {
    setProjectDir(ctx.location.directory)
    const handler = makeCommandHandler()
    const commands = await ctx.command.transform((editor) => {
      editor.add({
        name: E2E_ADOPT_COMMAND,
        description:
          "Adopt the E2E red-line policy into project docs — /e2e-adopt writes docs/e2e-redline.md + an AGENTS.md section (detection pre-fills, placeholders reported); /e2e-adopt dry previews; /e2e-adopt status reports adoption",
        execute: async (invocation) => {
          const text = await handler({
            arguments: commandArgumentText(invocation.prompt?.text, E2E_ADOPT_COMMAND),
            sessionID: invocation.sessionID,
          })
          // v1 delivered the report to the model via output.parts injection;
          // v2: an ordinary prompt turn. Without a session there is no
          // conversation to inform — fall back to the synthetic/log path.
          if (invocation.sessionID) {
            const prompt = ctx.session as unknown as V2Session
            if (typeof prompt.prompt === "function") {
              await prompt.prompt({ sessionID: invocation.sessionID, text })
              return
            }
          }
          await injectReply(undefined, invocation.sessionID, text).catch(() => {})
        },
      })
    })
    return async () => {
      await commands.dispose()
    }
  },
}

export default E2eAdoptPlugin
