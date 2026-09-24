/**
 * Env Guard (env-guard) — project-level switch blocking agent access to
 * secret-bearing .env* files (.env, .env.local, .env.production, …).
 * `.env.example` stays fully accessible as the sanctioned scaffold.
 *
 *   on  — file tools / grep / bash reads or copies of sensitive .env files
 *         are hard-blocked at the tool execute.before hook.
 *   off — default; the plugin is a complete no-op.
 *
 * File layout: one entry + one job per file.
 *   env-guard-config.ts    — state normalize, project .ocp/ocp.json field IO
 *   env-guard-runtime.ts   — path classification, bash leak detection,
 *                              block message
 *   env-guard-tool-guard.ts — execute.before hook: blocks sensitive access
 *
 * Switch: `envGuard` field in the project-level .ocp/ocp.json (no state file).
 *
 * v2 plugin contract: default-export { id, setup } with zero runtime SDK
 * imports (the proven dependency-free load shape — a value import of
 * "@opencode/plugin" without a reachable node_modules fails the load).
 */

import type { Plugin } from "@opencode/plugin"
import { setProjectDir } from "./env-guard-config"
import { makeToolGuardHook } from "./env-guard-tool-guard"

const plugin: Plugin.Plugin = {
  id: "env-guard",
  async setup(ctx) {
    // Switch is project-level: pin state/config paths to this project's directory.
    setProjectDir(ctx.location.directory)
    await ctx.tool.hook("execute.before", makeToolGuardHook())
  },
}

export default plugin
