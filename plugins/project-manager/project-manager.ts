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
 * File layout: one entry + one job per file (same pattern as adr-guard).
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
 */

import type { Plugin } from "@opencode-ai/plugin"
import { HttpServerResponse } from "effect/unstable/http"
import { makeAnnounceHook } from "./project-manager-announce"
import { makeCommandHook } from "./project-manager-command"
import { COMMAND_NAME, setProjectDir } from "./project-manager-config"
import { makeSystemHook } from "./project-manager-system-inject"
import { makeToolGuardHook } from "./project-manager-tool-guard"

// OpenCode's command hook has no cancel/noReply output. Throwing a raw
// Effect response is handled by OpenCode's HTTP layer as an empty
// successful command — the LLM never sees an empty prompt.
const handled = (): never => {
  throw HttpServerResponse.empty({ status: 204 })
}

export const ProjectManagerPlugin: Plugin = async ({ client, directory }) => {
  // Scaffolding is project-level: pin target paths to this project's directory.
  setProjectDir(directory)
  return {
    config: async (cfg) => {
      cfg.command ??= {}
      cfg.command[COMMAND_NAME] = {
        template: "",
        description:
          "Project scaffolding + index bootstrap — /project init runs the one-shot legacy migration (.opencode/ OCP state into .ocp/), creates missing baseline files (never overwrites) and runs first-time backend init (codegraph init, gitnexus analyze) when each CLI is installed + enabled; /project index manually refreshes existing indexes; /project sync re-runs the legacy migration alone, on demand",
      }
    },
    "command.execute.before": makeCommandHook(client, handled),
    "experimental.chat.system.transform": makeSystemHook(client),
    "tool.execute.before": makeToolGuardHook(client),
    event: makeAnnounceHook(client) as any,
  }
}
