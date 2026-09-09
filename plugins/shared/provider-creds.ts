/// <reference types="bun" />
/**
 * provider-creds — single source of truth for provider credentials.
 *
 * Extracted from provider-wizard.ts so the TUI wizard (hosted by both
 * opencode and the standalone OpenTUI CLI) and the
 * standalone /disconnect server plugin operate on the same stores with
 * the same semantics:
 *
 *   · auth store — opencode's auth.json (Global.Path.data), the very file
 *     the official /connect command writes; holds official built-ins and
 *     custom providers alike, `api` and `oauth` entries
 *   · opencode.jsonc `provider` node — custom provider definitions whose
 *     `options.apiKey` may carry a literal key or a {env:VAR} ref
 *
 * "Connected" is the union of both sides (listConnections); disconnect
 * clears both sides of an id while keeping the provider definition and
 * its models (planDisconnect / disconnectProvider).
 *
 * Pure functions take state as arguments so unit tests stay off the
 * real credential files; the I/O wrappers (readAuth/writeAuth/
 * disconnectProvider/readConnections) are the only ones touching disk.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"

const CONFIG_DIR = join(homedir(), ".config", "opencode")
export const CONFIG_FILE = join(CONFIG_DIR, "opencode.jsonc")
// Literal API keys live here — the same file the official /connect command
// writes (opencode's Global.Path.data/auth.json), so both share one store.
export const AUTH_FILE = join(homedir(), ".local", "share", "opencode", "auth.json")

// ─── Types ───────────────────────────────────────────────────────────

export interface ModelDef {
  name?: string
  id?: string
  status?: string
  attachment?: boolean
  temperature?: boolean
  reasoning?: boolean
  tool_call?: boolean
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; output?: number }
  [key: string]: unknown
}

export interface ProviderDef {
  npm?: string
  name?: string
  options?: Record<string, unknown>
  models?: Record<string, ModelDef>
  /** legacy: keys imported by old fetch versions; no longer written */
  presetModels?: Record<string, true>
  [key: string]: unknown
}

export interface OpenCodeConfig {
  model?: string
  provider?: Record<string, ProviderDef>
  [key: string]: unknown
}

// ─── JSONC stripping (same implementation the TUI wizard ships) ──────

export function stripJsonc(raw: string): string {
  let result = ""
  let i = 0
  const len = raw.length
  let state: "normal" | "string" | "lineComment" | "blockComment" = "normal"

  while (i < len) {
    const c = raw[i]
    const next = i + 1 < len ? raw[i + 1] : ""

    switch (state) {
      case "normal":
        if (c === '"') {
          result += c
          state = "string"
        } else if (c === "/" && next === "/") {
          state = "lineComment"
          i++
        } else if (c === "/" && next === "*") {
          state = "blockComment"
          i++
        } else {
          result += c
        }
        break
      case "string":
        result += c
        if (c === "\\") {
          i++
          if (i < len) result += raw[i]
        } else if (c === '"') {
          state = "normal"
        }
        break
      case "lineComment":
        if (c === "\n") {
          result += c
          state = "normal"
        }
        break
      case "blockComment":
        if (c === "*" && next === "/") {
          state = "normal"
          i++
        }
        break
    }
    i++
  }

  return result.replace(/,(\s*[}\]])/g, "$1")
}

export function readConfig(path: string): OpenCodeConfig {
  if (!existsSync(path)) throw new Error(`config not found: ${path}`)
  return JSON.parse(stripJsonc(readFileSync(path, "utf-8"))) as OpenCodeConfig
}

export function writeConfigAtomic(path: string, data: OpenCodeConfig): void {
  if (existsSync(path)) {
    writeFileSync(path + ".bak", readFileSync(path))
  }
  writeFileSync(path + ".tmp", JSON.stringify(data, null, 2), "utf-8")
  renameSync(path + ".tmp", path)
}

// ─── Auth store (shared with official /connect) ─────────────────────

export interface AuthEntry {
  type?: string
  key?: string
}

/** Read the credential store; missing/unreadable file yields {}. */
export function readAuth(): Record<string, AuthEntry> {
  try {
    return JSON.parse(readFileSync(AUTH_FILE, "utf-8")) as Record<string, AuthEntry>
  } catch {
    return {}
  }
}

/** api-type credential for a provider, as written by /connect or 💾. */
export function authKey(id: string): string | undefined {
  const entry = readAuth()[id]
  return entry?.type === "api" && entry.key ? entry.key : undefined
}

export function writeAuth(data: Record<string, AuthEntry>): void {
  mkdirSync(dirname(AUTH_FILE), { recursive: true })
  writeFileSync(AUTH_FILE + ".tmp", JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 })
  renameSync(AUTH_FILE + ".tmp", AUTH_FILE)
}

// ─── Connections (credential store ∪ config apiKeys) ────────────────

/** Natural order: 'router-2' sorts before 'router-10'. */
export const naturalCmp = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })

export interface ConnectionInfo {
  id: string
  /** auth.json entry type when the credential store holds one */
  authType?: string
  /** the provider node in opencode.jsonc carries an apiKey field */
  inConfig: boolean
  /** config apiKey value — env refs read differently from literals */
  configKey?: unknown
}

/**
 * Every live credential, both sides: auth.json entries (official
 * built-ins connected via /connect AND custom providers — the store
 * does not distinguish) plus custom providers whose key sits in
 * opencode.jsonc (literal or env ref). The union is what "connected"
 * means; disconnect clears both sides of an id.
 * `auth` is injectable so unit tests stay deterministic.
 */
export function listConnections(
  config: OpenCodeConfig,
  auth: Record<string, AuthEntry> = readAuth(),
): ConnectionInfo[] {
  const map = new Map<string, ConnectionInfo>()
  for (const [id, entry] of Object.entries(auth)) {
    if (entry && typeof entry === "object" && (entry.type === "api" || entry.type === "oauth")) {
      map.set(id, { id, authType: entry.type, inConfig: false })
    }
  }
  for (const [id, provider] of Object.entries(config.provider ?? {})) {
    const key = provider?.options?.apiKey
    if (key === undefined) continue
    const existing = map.get(id)
    if (existing) {
      existing.inConfig = true
      existing.configKey = key
    } else {
      map.set(id, { id, inConfig: true, configKey: key })
    }
  }
  return [...map.values()].sort((a, b) => naturalCmp(a.id, b.id))
}

// ─── Disconnect ──────────────────────────────────────────────────────

export interface DisconnectPlan {
  /** an auth store entry existed and was removed */
  authRemoved: boolean
  /** the opencode.jsonc provider node carried apiKey and was cleared */
  configChanged: boolean
}

/**
 * Pure: apply a disconnect to in-memory auth + config. Removes the
 * credential store entry and clears the config apiKey field (literal or
 * env ref); the provider definition and its models stay untouched, so
 * reconnecting is one form away. Never writes to disk.
 */
export function planDisconnect(
  id: string,
  auth: Record<string, AuthEntry>,
  config: OpenCodeConfig,
): DisconnectPlan {
  const authRemoved = auth[id] !== undefined
  if (authRemoved) delete auth[id]
  let configChanged = false
  const provider = config.provider?.[id]
  if (provider?.options && provider.options.apiKey !== undefined) {
    delete provider.options.apiKey
    if (Object.keys(provider.options).length === 0) delete provider.options
    configChanged = true
  }
  return { authRemoved, configChanged }
}

export interface DisconnectOutcome extends DisconnectPlan {
  ok: boolean
  error?: string
}

/**
 * I/O wrapper over planDisconnect — the ONLY disconnect path both the
 * TUI wizard and the /disconnect command use. Each store is written
 * only when it actually changed; a failure on one side is reported and
 * does not roll back the other (the remaining entry is what a retry
 * would target anyway).
 */
export function disconnectProvider(id: string): DisconnectOutcome {
  let config: OpenCodeConfig
  try {
    config = readConfig(CONFIG_FILE)
  } catch (err) {
    return { ok: false, authRemoved: false, configChanged: false, error: (err as Error).message }
  }
  const auth = readAuth()
  const plan = planDisconnect(id, auth, config)
  if (!plan.authRemoved && !plan.configChanged) {
    return { ok: true, ...plan }
  }
  try {
    if (plan.authRemoved) writeAuth(auth)
  } catch (err) {
    return { ok: false, ...plan, error: `credential store: ${(err as Error).message}` }
  }
  try {
    if (plan.configChanged) writeConfigAtomic(CONFIG_FILE, config)
  } catch (err) {
    return { ok: false, ...plan, error: `config: ${(err as Error).message}` }
  }
  return { ok: true, ...plan }
}

/** Fresh connection list off disk; an unreadable config still yields the store side. */
export function readConnections(): ConnectionInfo[] {
  let config: OpenCodeConfig = {}
  try {
    config = readConfig(CONFIG_FILE)
  } catch {
    // config unreadable — the credential store side is still listed
  }
  return listConnections(config, readAuth())
}
