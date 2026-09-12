/**
 * Hook: command.execute.before — handle `/project <subcommand>`.
 * The command is registered programmatically via the `config` hook in
 * project-manager.ts — no commands/project.md file is needed.
 *
 *   /project init   → scaffold missing baseline files (never overwrites;
 *                     an EXISTING project config gets an append-only top-up
 *                     with switch lines the template gained since init),
 *                     then run every FIRST-TIME backend init step, each only
 *                     when its CLI is installed + enabled:
 *                     `codegraph init`, `gitnexus analyze` (initial build),
 *                     dbhub.toml scaffold (only when the dbhub MCP is
 *                     enabled AND its CLI is installed),
 *                     and sync project git hooks (post-commit, post-merge,
 *                     post-checkout) so later commits auto-refresh the index.
 *                     Hooks are removed when the backend is disabled or missing.
 *   /project index  → manual rebuild/refresh for existing indexes:
 *                     `codegraph sync` (incremental catch-up) and
 *                     `gitnexus analyze` when the index is stale
 *   /project sync   → the config top-up alone (no scaffolding, no backends)
 *   /project        → show help (no subcommand given)
 *
 * Every invocation gets user-visible feedback via
 * session.prompt({ noReply, ignored }) in the main chat UI — visible to the
 * user, invisible to the LLM (no context pollution).
 */

import type { PluginInput } from "@opencode-ai/plugin"
import { refreshLocale, tr } from "../tui/i18n"
import {
  COMMAND_NAME,
  CONFIG_REL,
  getProjectDir,
  parseSubcommand,
  SUBCOMMAND_INDEX,
  SUBCOMMAND_INIT,
  SUBCOMMAND_SETUP,
  SUBCOMMAND_SYNC,
} from "./project-manager-config"
import type { BackendResult } from "./project-manager-index"
import type { HookResult } from "./project-manager-hooks"
import { indexProject, initProject, syncProject } from "./project-manager-operations"
import type { ScaffoldResult, SyncResult } from "./project-manager-scaffold"

/** HELP built at call time — localized, embeds the config target path. */
function helpText(): string {
  refreshLocale()
  return tr("guard.pm.help", { cfg: CONFIG_REL })
}

/** One report line per target: ✅ created / ♻️ updated / ⏭️ skipped / ⚠️ invalid. */
function initReport(results: ScaffoldResult[], backends: BackendResult[], hooks: HookResult[]): string {
  refreshLocale()
  const lines = results.map((r) => {
    if (r.status === "created") return tr("guard.pm.created", { rel: r.relPath })
    if (r.status === "updated") return tr("guard.pm.updated", { rel: r.relPath })
    if (r.status === "invalid") return tr("guard.pm.invalid", { rel: r.relPath })
    return tr("guard.pm.skippedFile", { rel: r.relPath })
  })
  const created = results.filter((r) => r.status === "created").length
  const updated = results.filter((r) => r.status === "updated").length
  const invalid = results.filter((r) => r.status === "invalid").length
  return `${tr("guard.pm.initHead", { dir: getProjectDir(), created, updated, invalid, skipped: results.length - created - updated - invalid })}\n${lines.join("\n")}\n${backends.map(backendLine).join("\n")}\n${hooks.map(hookLine).join("\n")}`
}

/** `/project setup` report (CLI / headless inspection). */
function setupReport(): string {
  refreshLocale()
  return tr("guard.pm.setup", { dir: getProjectDir() })
}

/** ✅ ran / ⏭️ skipped / ❌ failed — one line per backend result. */
function backendLine(r: BackendResult): string {
  if (r.status === "ran") return tr("guard.pm.lineOk", { name: r.backend, detail: r.detail })
  if (r.status === "failed") return tr("guard.pm.lineFail", { name: r.backend, detail: r.detail })
  return tr("guard.pm.lineSkip", { name: r.backend, detail: r.detail })
}

/** ✅ registered / ♻️ updated / ⏭️ skipped / ❌ failed — one line per hook result. */
function hookLine(r: HookResult): string {
  if (r.status === "registered") return tr("guard.pm.lineOk", { name: r.hook, detail: r.detail })
  if (r.status === "updated") return tr("guard.pm.lineUpdated", { name: r.hook, detail: r.detail })
  if (r.status === "failed") return tr("guard.pm.lineFail", { name: r.hook, detail: r.detail })
  return tr("guard.pm.lineSkip", { name: r.hook, detail: r.detail })
}

/** `/project index` report: rebuild results only. */
function indexReport(results: BackendResult[]): string {
  refreshLocale()
  return `${tr("guard.pm.indexHead", { dir: getProjectDir() })}\n${results.map(backendLine).join("\n")}`
}

/** `/project sync` report: which template switches were appended. */
function syncReport(r: SyncResult): string {
  refreshLocale()
  const dir = getProjectDir()
  if (r.status === "missing") return tr("guard.pm.syncMissing", { dir, cfg: CONFIG_REL })
  if (r.status === "invalid") return tr("guard.pm.syncInvalid", { dir, cfg: CONFIG_REL })
  if (r.status === "up-to-date") return tr("guard.pm.syncUptodate", { dir, cfg: CONFIG_REL })
  return `${tr("guard.pm.syncAppended", { dir, count: r.added.length, cfg: CONFIG_REL })}\n${r.added.map((k) => `  + ${k}`).join("\n")}`
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

async function executeInit(client: PluginInput["client"], sessionID?: string): Promise<void> {
  const result = await initProject({ root: getProjectDir() })
  await reply(client, sessionID, initReport(result.files, result.backends, result.hooks))
}

export function makeCommandHook(client: PluginInput["client"], handled: () => never) {
  return async (input: { command?: string; arguments?: string; sessionID?: string }) => {
    if (input.command !== COMMAND_NAME) return

    const sub = parseSubcommand(input.arguments)

    // No subcommand or unknown subcommand → help.
    if (sub !== SUBCOMMAND_INIT && sub !== SUBCOMMAND_SETUP && sub !== SUBCOMMAND_INDEX && sub !== SUBCOMMAND_SYNC) {
      await reply(client, input.sessionID, sub ? `${tr("guard.pm.unknown", { sub })}\n\n${helpText()}` : helpText())
      return handled()
    }

    try {
      if (sub === SUBCOMMAND_SETUP) {
        await reply(client, input.sessionID, setupReport())
      } else if (sub === SUBCOMMAND_INIT) {
        await executeInit(client, input.sessionID)
      } else if (sub === SUBCOMMAND_SYNC) {
        await reply(client, input.sessionID, syncReport(syncProject(getProjectDir())))
      } else {
        const results = await indexProject(getProjectDir())
        await reply(client, input.sessionID, indexReport(results))
      }
    } catch (err) {
      await reply(client, input.sessionID, tr("guard.pm.failed", { sub, err: String(err) }))
    }
    return handled()
  }
}
