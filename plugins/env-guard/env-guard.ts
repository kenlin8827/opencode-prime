/**
 * Env Guard (env-guard) — project-level switch blocking agent access to
 * secret-bearing .env* files (.env, .env.local, .env.production, …).
 * `.env.example` stays fully accessible as the sanctioned scaffold.
 *
 *   on  — file tools / grep / bash reads or copies of sensitive .env files
 *         are hard-blocked at tool.execute.before.
 *   off — default; the plugin is a complete no-op.
 *
 * File layout: one entry + one job per file.
 *   env-guard-config.ts    — state normalize, project .ocp/ocp.json field IO
 *   env-guard-runtime.ts   — path classification, bash leak detection,
 *                              block message
 *   env-guard-tool-guard.ts — tool.before hook: blocks sensitive access
 *
 * Switch: `envGuard` field in the project-level .ocp/ocp.json (no state file).
 */

import type { Plugin } from "@opencode-ai/plugin"
import { setProjectDir } from "./env-guard-config"
import { makeToolGuardHook } from "./env-guard-tool-guard"

export const EnvGuardPlugin: Plugin = async ({ client, directory }) => {
  // Switch is project-level: pin state/config paths to this project's directory.
  setProjectDir(directory)
  return {
    "tool.execute.before": makeToolGuardHook(client),
  }
}
