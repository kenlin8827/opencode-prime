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

const HELP = `[project-manager] Project scaffolding & configuration manager.

Usage:
- /project-wizard → open interactive two-tier setup wizard (TUI mode)
- /project        → show available subcommands & options (CLI mode)
- /project init   → scaffold baseline files & bootstrap indexes (headless / non-TUI):
                    create baseline files if missing (never overwrites):
                    .opencode/opencode.jsonc, docs/git-commits.md, AGENTS.md
                    An EXISTING project config gets an append-only top-up:
                    switch lines the template gained since init are added,
                    existing content is never changed.
                    Then run every first-time backend init step — each only
                    when its CLI is installed and enabled:
                      codegraph init    one-time; watcher keeps it fresh
                      gitnexus analyze  initial index build (index missing)
                      dbhub.toml        scaffolded when the dbhub MCP is
                                        enabled and its CLI is installed
                      gitnexus hooks    post-commit/post-merge/post-checkout
                                        auto-refresh the GitNexus index when
                                        gitnexus is enabled; removed when not
- /project setup  → inspect current project switches & setup options (CLI mode)
- /project index  → manual rebuild/refresh for EXISTING indexes
- /project sync   → top up an EXISTING ${CONFIG_REL} with template switches`

/** One report line per target: ✅ created / ♻️ updated / ⏭️ skipped / ⚠️ invalid. */
function initReport(results: ScaffoldResult[], backends: BackendResult[], hooks: HookResult[]): string {
  const lines = results.map((r) => {
    if (r.status === "created") return `  ✅ created ${r.relPath}`
    if (r.status === "updated") return `  ♻️ updated ${r.relPath} (appended new template switches; existing content untouched)`
    if (r.status === "invalid") return `  ⚠️ ${r.relPath} is malformed (no proper closing brace) — left untouched, fix it manually`
    return `  ⏭️ skipped ${r.relPath} (already exists)`
  })
  const created = results.filter((r) => r.status === "created").length
  const updated = results.filter((r) => r.status === "updated").length
  const invalid = results.filter((r) => r.status === "invalid").length
  return `[project-manager] init done in ${getProjectDir()} — ${created} created, ${updated} updated, ${invalid} invalid, ${results.length - created - updated - invalid} skipped\n${lines.join("\n")}\n${backends.map(backendLine).join("\n")}\n${hooks.map(hookLine).join("\n")}`
}

/** `/project setup` report (CLI / headless inspection). */
function setupReport(): string {
  return `[project-manager] Project setup status in ${getProjectDir()}:
- Interactive TUI: run /project-wizard (or Ctrl+P → "Project: Setup Wizard") to open the interactive dialog.
- Headless / CLI: run /project init to scaffold baseline files and bootstrap indexes.
- Config sync: run /project sync to append newly added template switches.`
}

/** ✅ ran / ⏭️ skipped / ❌ failed — one line per backend result. */
function backendLine(r: BackendResult): string {
  if (r.status === "ran") return `  ✅ ${r.backend}: ${r.detail}`
  if (r.status === "failed") return `  ❌ ${r.backend}: ${r.detail}`
  return `  ⏭️ ${r.backend}: skipped — ${r.detail}`
}

/** ✅ registered / ♻️ updated / ⏭️ skipped / ❌ failed — one line per hook result. */
function hookLine(r: HookResult): string {
  if (r.status === "registered") return `  ✅ ${r.hook}: ${r.detail}`
  if (r.status === "updated") return `  ♻️ ${r.hook}: ${r.detail}`
  if (r.status === "failed") return `  ❌ ${r.hook}: ${r.detail}`
  return `  ⏭️ ${r.hook}: skipped — ${r.detail}`
}

/** `/project index` report: rebuild results only. */
function indexReport(results: BackendResult[]): string {
  return `[project-manager] index done in ${getProjectDir()}\n${results.map(backendLine).join("\n")}`
}

/** `/project sync` report: which template switches were appended. */
function syncReport(r: SyncResult): string {
  const head = `[project-manager] sync in ${getProjectDir()}`
  if (r.status === "missing") return `${head}: ${CONFIG_REL} does not exist — run /project init first`
  if (r.status === "invalid") return `${head}: ${CONFIG_REL} is malformed (no proper closing brace) — left untouched, fix it manually`
  if (r.status === "up-to-date") return `${head}: ${CONFIG_REL} already has every template switch — nothing to add`
  return `${head}: appended ${r.added.length} new switch line(s) to ${CONFIG_REL} (existing content untouched):\n${r.added.map((k) => `  + ${k}`).join("\n")}`
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
      await reply(client, input.sessionID, sub ? `[project-manager] Unknown subcommand "${sub}".\n\n${HELP}` : HELP)
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
      await reply(client, input.sessionID, `[project-manager] ${sub} failed: ${String(err)}`)
    }
    return handled()
  }
}
