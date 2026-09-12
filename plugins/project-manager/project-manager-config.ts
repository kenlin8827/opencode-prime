/**
 * Shared project-manager config — command name and project directory.
 *
 * The plugin is PROJECT-LEVEL: every scaffold target is resolved relative to
 * the project directory injected by the plugin entry via setProjectDir()
 * (PluginInput.directory); until then we fall back to process.cwd().
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import { OCP_CONFIG_REL, ocpConfigFile } from "../shared/opencode-prime"

// ─── Project directory ───────────────────────────────────────────────
// Injected by the plugin entry (project-manager.ts) from PluginInput.directory.

let projectDir = process.cwd()

export function setProjectDir(dir: string): void {
  if (typeof dir === "string" && dir.trim() !== "") projectDir = dir
}

export function getProjectDir(): string {
  return projectDir
}

// ─── Command ─────────────────────────────────────────────────────────

export const COMMAND_NAME = "project"

/** Subcommands accepted by `/project <subcommand>`. */
export const SUBCOMMAND_INIT = "init"
export const SUBCOMMAND_SETUP = "setup"
export const SUBCOMMAND_INDEX = "index"
export const SUBCOMMAND_SYNC = "sync"

/**
 * Parse the first argument of a `/project <subcommand>` call.
 * Returns null when the argument is missing (caller treats null as help).
 *
 *   /project       → null (help)
 *   /project init  → "init"
 *   /project index → "index"
 *   /project sync  → "sync"
 */
export function parseSubcommand(args: unknown): string | null {
  if (typeof args !== "string") return null
  const first = args.trim().split(/\s+/)[0]?.toLowerCase()
  return first && first !== "" ? first : null
}

// ─── Scaffold targets ────────────────────────────────────────────────
// Relative paths (POSIX separators) of every file `/project init` manages.
// Order matters only for the user-visible report.

export const GIT_COMMITS_REL = "docs/git-commits.md"

/** Project-level OpenCode Prime config — scaffolded by init; `/project sync`
 *  runs the one-shot legacy migration (ADR 0004 v2 §3) on demand. */
export const CONFIG_REL = OCP_CONFIG_REL

export const SCAFFOLD_TARGETS = [
  CONFIG_REL,
  GIT_COMMITS_REL,
  "AGENTS.md",
] as const

export type ScaffoldTarget = (typeof SCAFFOLD_TARGETS)[number]

/** Absolutize a scaffold target. The config file resolves through the
 * shared `ocpConfigFile()` choke (honors `OCP_CONFIG_REL`'s env override
 * via `ocpDir()`); `CONFIG_REL` itself stays the display rel-path. */
export function resolveTarget(relPath: ScaffoldTarget): string {
  if (relPath === CONFIG_REL) return ocpConfigFile(projectDir)
  return join(projectDir, ...relPath.split("/"))
}

/**
 * File-as-switch: the commit discipline (system-prompt injection AND the
 * mechanical commit gate) is active exactly while docs/git-commits.md
 * exists in the project. No separate state file, no /project on|off.
 */
export function hasConventionFile(): boolean {
  return existsSync(resolveTarget(GIT_COMMITS_REL))
}
