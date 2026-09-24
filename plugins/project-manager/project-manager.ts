/**
 * Project Manager — lightweight project scaffolding + code-index bootstrap
 * via the `/project` slash command.
 *
 *   /project init  — create baseline files in the current project, but ONLY
 *                    when they don't already exist (never overwrites):
 *                      .ocp/ocp.json               (project-level config)
 *                      docs/git-commits.md         (commit convention)
 *                      AGENTS.md                   (agent instructions stub)
 *                    a one-shot legacy migration moves OCP state out of
 *                    .opencode/ into .ocp/ before any target is checked
 *                    then run every first-time backend init step, each only
 *                    when its CLI is installed + enabled:
 *                      `codegraph init`    one-time; watcher keeps it fresh
 *                      `gitnexus analyze`  initial build when index missing
 *                    and sync GitNexus git hooks (post-commit, post-merge,
 *                    post-checkout) so later commits auto-refresh the index.
 *                    Hooks are removed when gitnexus is disabled or missing.
 *   /project index — manual rebuild/refresh for existing indexes:
 *                    `codegraph sync` (incremental catch-up) and
 *                    `gitnexus analyze` when the index is stale (a first
 *                    index is init's job, never created here).
 *
 * File layout: one entry + one job per file (same pattern as adr).
 *   project-manager-config.ts        — command name, project dir, target list
 *   project-manager-scaffold.ts      — exists-check-then-write init; template
 *                                      bodies live in templates/ (read once)
 *   templates/                       — ocp.json, git-commits.md,
 *                                      AGENTS.md, dbhub.toml scaffold bodies
 *   project-manager-index.ts         — backend probes + plan + run
 *                                      (codegraph init / gitnexus analyze)
 *   project-manager-command.ts       — command hook (/project init|index, help)
 *   project-manager-system-inject.ts — system-transform hook: injects a
 *                                      progressive-disclosure pointer to
 *                                      docs/git-commits.md (~50 tokens; the
 *                                      file itself is read on demand)
 *   project-manager-tool-guard.ts    — tool.before hook: blocks git commits
 *                                      whose message violates the structural
 *                                      rules (type format, ≤72-char first line)
 *   project-manager-announce.ts      — event hook: on a new top-level session
 *                                      in an uninitialized project, suggest
 *                                      `/project init` (once per server run,
 *                                      user-visible only, no LLM context)
 *
 * File-as-switch: while docs/git-commits.md exists the project gets BOTH
 * the soft layer (pointer injected into the system prompt — agents read
 * the file before committing) and the hard layer (non-conforming commit
 * messages blocked at git commit); delete the file and both deactivate.
 * No separate state file, no on/off command.
 *
 * V2 MAPPING NOTES (v1 → v2):
 *   • v1 `config` hook + `command.execute.before` → v2 `ctx.command.
 *     transform(editor.add)`: /project is plugin-OWNED (empty template,
 *     programmatic handling only); returning from execute() consumes the
 *     command (v1's handled()/empty-204 throw).
 *   • v1 `experimental.chat.system.transform` → v2 "context" hook.
 *   • v1 `tool.execute.before` → v2 `ctx.tool.hook("execute.before")`
 *     (the ONLY hook allowed to reject via throw — the commit gate is a
 *     deliberate rejection, not a fail-open path).
 *   • v1 `event` (session.created announce) → v2 `ctx.event.subscribe`
 *     for-await loop started in setup, aborted in cleanup.
 *   • v1 announce toast (`client.tui.showToast`) → shared/notify console
 *     fallback (OCP-V2-GAP: v2 Context exposes no TUI surface).
 */

import { Plugin } from "@opencode/plugin"
import { commandArgumentText, type V2Session } from "../shared/agent-scope"
import { makeAnnounceHandler } from "./project-manager-announce"
import { makeCommandHandler } from "./project-manager-command"
import { COMMAND_NAME, setProjectDir } from "./project-manager-config"
import { makeSystemHook } from "./project-manager-system-inject"
import { makeToolGuardHook } from "./project-manager-tool-guard"

export const ProjectManagerPlugin = Plugin.define({
  id: "project-manager",
  async setup(ctx) {
    // Scaffolding is project-level: pin target paths to this project's directory.
    setProjectDir(ctx.location.directory)
    const session = ctx.session as unknown as V2Session
    const abort = new AbortController()

    const context = await ctx.session.hook("context", (e) => makeSystemHook(session)(e))
    const guard = makeToolGuardHook()
    const toolGuard = await ctx.tool.hook("execute.before", (e) => guard({ tool: e.tool, input: e.input }))
    const commands = await ctx.command.transform((editor) => {
      editor.add({
        name: COMMAND_NAME,
        description:
          "Project scaffolding + index bootstrap — /project init runs the one-shot legacy migration (.opencode/ OCP state into .ocp/), creates missing baseline files (never overwrites) and runs first-time backend init (codegraph init, gitnexus analyze) when each CLI is installed + enabled; /project index manually refreshes existing indexes; /project sync re-runs the legacy migration alone, on demand",
        execute: async (invocation) => {
          await makeCommandHandler(session)({
            arguments: commandArgumentText(invocation.prompt?.text, COMMAND_NAME),
            sessionID: invocation.sessionID,
          })
        },
      })
    })

    // session.created announce → event subscription loop.
    const announce = makeAnnounceHandler()
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: abort.signal })) {
          await announce(ev)
        }
      } catch {
        // Subscription died with the server — announce state is per-run.
      }
    })()

    return async () => {
      abort.abort()
      await Promise.allSettled([context.dispose(), toolGuard.dispose(), commands.dispose()])
    }
  },
})

export default ProjectManagerPlugin
