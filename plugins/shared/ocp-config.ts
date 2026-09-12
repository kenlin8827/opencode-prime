/**
 * Shared user-level config for ocp plugins — ~/.config/opencode/ocp.json.
 *
 * One file holds every cross-session user preference for the ocp plugin
 * suite (currently: TUI language via i18n.ts). Plugins read/write
 * individual top-level keys via readOcpField/writeOcpField; unknown keys
 * are preserved, so any plugin can add its own namespaced key (e.g.
 * "queue.toastDurationMs") without a schema migration.
 *
 * No runtime compatibility (ADR 0004 v2): `ocp.json` is the ONLY source.
 * The legacy `ocp.jsonc` rename is a one-shot performed by the installer;
 * after upgrading OCP without re-running the installer, preferences read
 * as defaults until then. Writes are pure JSON (editor-valid); reads stay
 * JSONC-tolerant so hand-edited comments keep working.
 *
 * Override the location with OCP_CONFIG_PATH (tests, sandboxes); falls
 * back to XDG_CONFIG_HOME, then ~/.config.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { stripJsonc } from "./opencode-prime"

/** Config file location; OCP_CONFIG_PATH overrides (tests, sandboxes). */
export function ocpConfigPath(): string {
  if (process.env.OCP_CONFIG_PATH) return process.env.OCP_CONFIG_PATH
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(base, "opencode", "ocp.json")
}

/** Tolerant JSONC parse via the shared stripper (comments, trailing commas); never throws. */
export function parseJsonc(text: string): Record<string, unknown> {
  try {
    return JSON.parse(stripJsonc(text)) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Read the whole config; missing or corrupt file → {} (fail-open). */
export function readOcpConfig(): Record<string, unknown> {
  try {
    const path = ocpConfigPath()
    if (!existsSync(path)) return {}
    return parseJsonc(readFileSync(path, "utf8"))
  } catch {
    return {}
  }
}

export function readOcpField<T>(key: string): T | undefined {
  return readOcpConfig()[key] as T | undefined
}

/**
 * Read-modify-write one key; preserves all other keys. Creates parent dirs.
 * Returns false on IO failure. Pure JSON — no generated header, so the
 * file stays editor-valid.
 */
export function writeOcpField(key: string, value: unknown): boolean {
  try {
    const path = ocpConfigPath()
    const cfg = readOcpConfig()
    cfg[key] = value
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf8")
    return true
  } catch {
    return false
  }
}
