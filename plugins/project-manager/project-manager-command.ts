/**
 * Command handler — `/project <subcommand>`.
 * V2: registered through ctx.command.transform in project-manager.ts
 * (v1 equivalent: the `config` hook + command.execute.before).
 *
 *   /project init   → run the one-shot legacy migration (moves OCP state out
 *                     of .opencode/ into .ocp/, ADR 0004), then scaffold
 *                     missing baseline files (never overwrites),
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
 *   /project sync   → the legacy migration alone, on demand (no scaffolding,
 *                     no backends) — escape hatch for users who skipped the
 *                     wizard after upgrading
 *   /project        → show help (no subcommand given)
 *
 * Every invocation gets user-visible feedback via the synthetic-message
 * channel (v1 equivalent: session.prompt({noReply, ignored})) in the main
 * chat UI — visible to the user, invisible to the LLM (no context pollution).
 */

import { injectReply, type V2Session } from "../shared/agent-scope"
import type { MigrationReport } from "../shared/opencode-prime"
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
function initReport(results: ScaffoldResult[], backends: BackendResult[], hooks: HookResult[], migration: MigrationReport): string {
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
  return `${tr("guard.pm.initHead", { dir: getProjectDir(), created, updated, invalid, skipped: results.length - created - updated - invalid })}\n${migrationLines(migration)}${lines.join("\n")}\n${backends.map(backendLine).join("\n")}\n${hooks.map(hookLine).join("\n")}`
}

/**
 * One "migrated N switch(es), moved M file(s)" line when the §3 pass did
 * anything, plus one raw line per warning (paths — not localizable). Silent
 * on a no-op run so normal inits stay clean.
 */
export function migrationLines(migration: MigrationReport): string {
  const moved = migration.movedFiles.length
  const switched = migration.switchedKeys.length
  const out: string[] = []
  if (switched > 0 || moved > 0) {
    out.push(tr("guard.pm.migratedLine", { switches: switched, files: moved }))
  }
  for (const warning of migration.warnings) {
    out.push(`  ⚠️ ${warning}`)
  }
  return out.length > 0 ? `${out.join("\n")}\n` : ""
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

/** `/project sync` report: what the on-demand migration moved — plus any
 * per-item failure, on EVERY outcome (a run whose items all failed must not
 * read "up-to-date" without saying so). */
function syncReport(r: SyncResult): string {
  refreshLocale()
  const dir = getProjectDir()
  const warnings = migrationWarningLines(r.migration)
  if (r.status === "missing") return tr("guard.pm.syncMissing", { dir, cfg: CONFIG_REL }) + warnings
  if (r.status === "up-to-date") return tr("guard.pm.syncUptodate", { dir, cfg: CONFIG_REL }) + warnings
  return `${tr("guard.pm.syncAppended", { dir, count: r.added.length, cfg: CONFIG_REL })}\n${r.added.map((k) => `  + ${k}`).join("\n")}${warnings}`
}

/** Raw ⚠️ lines for migration warnings (paths — not localizable). Sync
 * reports already carry their own counts, so this is warnings-only. */
function migrationWarningLines(migration: MigrationReport): string {
  return migration.warnings.length > 0
    ? `\n${migration.warnings.map((w) => `  ⚠️ ${w}`).join("\n")}`
    : ""
}

/** V2 command handler (registered via ctx.command.transform in the entry).
 *  Reports ride the synthetic-message channel (v1 equivalent:
 *  session.prompt({noReply, ignored})); returning consumes the command
 *  (v1's handled()/empty-204 throw — the LLM never sees a turn). */
export function makeCommandHandler(session: V2Session | undefined) {
  const reply = (sessionID: string | undefined, text: string) =>
    injectReply(session, sessionID, text)

  return async (input: { arguments?: string; sessionID?: string }): Promise<void> => {
    const sub = parseSubcommand(input.arguments)

    // No subcommand or unknown subcommand → help.
    if (sub !== SUBCOMMAND_INIT && sub !== SUBCOMMAND_SETUP && sub !== SUBCOMMAND_INDEX && sub !== SUBCOMMAND_SYNC) {
      await reply(input.sessionID, sub ? `${tr("guard.pm.unknown", { sub })}\n\n${helpText()}` : helpText())
      return
    }

    try {
      if (sub === SUBCOMMAND_SETUP) {
        await reply(input.sessionID, setupReport())
      } else if (sub === SUBCOMMAND_INIT) {
        const result = await initProject({ root: getProjectDir() })
        await reply(input.sessionID, initReport(result.files, result.backends, result.hooks, result.migration))
      } else if (sub === SUBCOMMAND_SYNC) {
        await reply(input.sessionID, syncReport(syncProject(getProjectDir())))
      } else {
        const results = await indexProject(getProjectDir())
        await reply(input.sessionID, indexReport(results))
      }
    } catch (err) {
      await reply(input.sessionID, tr("guard.pm.failed", { sub, err: String(err) }))
    }
  }
}
