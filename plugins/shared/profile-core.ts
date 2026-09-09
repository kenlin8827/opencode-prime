/**
 * Profile wizard core: profile state, application, reset, and catalog logic.
 * Exports are the shared contract for the TUI wizard and the future CLI wizard;
 * filesystem helpers are injectable only through their explicit path arguments.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, unlinkSync, type Dirent } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { tr } from "../tui/i18n"
import { resolveSuffixModelRef, type VariantConfig } from "./model-variants"
import { CONFIG_FILE, readAuth, readConfig, writeConfigAtomic, type OpenCodeConfig, type ModelDef, type ProviderDef } from "./provider-creds"

const CONFIG_DIR = join(homedir(), ".config", "opencode")
const TIERS_FILE = join(CONFIG_DIR, "tiers.json")
const STATE_FILE = join(CONFIG_DIR, ".active-profile")
const PROFILE_STATE_FILE = join(CONFIG_DIR, ".profile-state.json")
const PROFILES_DIR = join(CONFIG_DIR, "profiles")

export interface Profile { description?: string; tiers: Record<string, string> }
export interface ProfileState { version: 1; custom: string[]; recent: string[] }
export interface Agent { tier?: string; model?: string; variant?: string; [key: string]: unknown }
export interface ProfileListEntry { name: string; profile: Profile; kind: "custom" | "preset"; active: boolean; recent: boolean }
export interface CatalogModel { name?: string; status?: string }
export interface CatalogProvider { id?: string; name?: string; source?: string; connected?: boolean; models: Record<string, CatalogModel> }
export type Catalog = Record<string, CatalogProvider>
export interface ApplyResult { updated: number; details: string[]; patch: OpenCodeConfig }

export function uniqueNames(names: string[]): string[] { return [...new Set(names.filter((name) => name.trim().length > 0))] }

export function readProfileState(path = PROFILE_STATE_FILE): ProfileState {
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as Partial<ProfileState>
    return { version: 1, custom: uniqueNames(Array.isArray(data.custom) ? data.custom.filter((x): x is string => typeof x === "string") : []), recent: uniqueNames(Array.isArray(data.recent) ? data.recent.filter((x): x is string => typeof x === "string") : []) }
  } catch { return { version: 1, custom: [], recent: [] } }
}

export function writeProfileState(state: ProfileState, path = PROFILE_STATE_FILE): void {
  mkdirSync(dirname(path), { recursive: true })
  const normalized = { version: 1 as const, custom: uniqueNames(state.custom), recent: uniqueNames(state.recent).filter((name) => !state.custom.includes(name)).slice(0, 12) }
  writeFileSync(path + ".tmp", JSON.stringify(normalized, null, 2) + "\n", "utf-8")
  renameSync(path + ".tmp", path)
}

export function markCustomProfile(name: string): void { const state = readProfileState(); writeProfileState({ ...state, custom: [name, ...state.custom], recent: state.recent.filter((x) => x !== name) }) }
export function forgetProfileState(name: string): void { const state = readProfileState(); writeProfileState({ ...state, custom: state.custom.filter((x) => x !== name), recent: state.recent.filter((x) => x !== name) }) }
export function recordRecentProfile(name: string): void { const state = readProfileState(); if (!state.custom.includes(name)) writeProfileState({ ...state, recent: [name, ...state.recent.filter((x) => x !== name)] }) }
export function getActiveProfile(path = STATE_FILE): string | null { try { const value = readFileSync(path, "utf-8").trim(); return value || null } catch { return null } }
export function setActiveProfile(name: string, path = STATE_FILE): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, name, "utf-8") }
export function profileKind(name: string, state: ProfileState): "custom" | "preset" { return state.custom.includes(name) ? "custom" : "preset" }
export function profileGroup(name: string): string { return name.includes("/") ? name.split("/")[0] ?? name : "general" }
export function profileCategory(entry: ProfileListEntry): string { if (entry.active) return tr("profile.activeProfilesHeader"); if (entry.kind === "custom") return tr("profile.customProfilesHeader"); if (entry.recent) return tr("profile.recentProfilesHeader"); return tr("profile.presetProfilesHeader", { group: profileGroup(entry.name) }) }
export function profileTitle(entry: ProfileListEntry): string { return entry.active ? `${entry.name}  ← active` : entry.name }

export function collectProfiles(dir: string, prefix: string, out: Map<string, Profile>): void {
  let entries: Dirent[]
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) { const rel = prefix ? `${prefix}/${entry.name}` : entry.name; if (entry.isDirectory()) collectProfiles(join(dir, entry.name), rel, out); else if (entry.name.endsWith(".json")) { try { const data = JSON.parse(readFileSync(join(dir, entry.name), "utf-8")) as Profile; if (data.tiers && typeof data.tiers === "object") out.set(rel.replace(/\.json$/, ""), data) } catch { /* skip invalid profiles */ } } }
}
export function loadProfiles(dir = PROFILES_DIR): Map<string, Profile> { const result = new Map<string, Profile>(); if (existsSync(dir)) collectProfiles(dir, "", result); return result }
export function sortedProfileEntries(profiles: Map<string, Profile>): ProfileListEntry[] { const state = readProfileState(); const active = getActiveProfile(); const rank = new Map(state.recent.map((name, index) => [name, index])); return [...profiles].map(([name, profile]) => ({ name, profile, kind: profileKind(name, state), active: name === active, recent: !state.custom.includes(name) && rank.has(name) })).sort((a, b) => Number(b.active) - Number(a.active) || Number(a.kind !== "custom") - Number(b.kind !== "custom") || Number(b.recent) - Number(a.recent) || (rank.get(a.name) ?? 0) - (rank.get(b.name) ?? 0) || profileGroup(a.name).localeCompare(profileGroup(b.name)) || a.name.localeCompare(b.name)) }
export function profilePath(name: string, dir = PROFILES_DIR): string { return join(dir, ...name.split("/")) + ".json" }
export function writeProfileAtomic(name: string, profile: Profile, dir = PROFILES_DIR): void { const path = profilePath(name, dir); mkdirSync(dirname(path), { recursive: true }); if (existsSync(path)) writeFileSync(path + ".bak", readFileSync(path)); writeFileSync(path + ".tmp", JSON.stringify(profile, null, 2) + "\n", "utf-8"); renameSync(path + ".tmp", path) }
export function deleteProfile(name: string, dir = PROFILES_DIR): void { const path = profilePath(name, dir); if (existsSync(path)) { writeFileSync(path + ".bak", readFileSync(path)); unlinkSync(path) } }
export function loadTierMap(path = TIERS_FILE): Record<string, string> { try { const data = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>; return Object.fromEntries(Object.entries(data).filter(([key, value]) => !key.startsWith("$") && typeof value === "string")) as Record<string, string> } catch { return {} } }

export function listModelRefs(config: OpenCodeConfig): string[] { const refs: string[] = []; if (typeof config.model === "string") refs.push(`model → ${config.model}`); if (typeof config.small_model === "string") refs.push(`small_model → ${config.small_model}`); for (const [name, agent] of Object.entries(config.agent ?? {})) if (typeof agent?.model === "string") refs.push(`agent.${name} → ${agent.model}`); return refs }
export function stripModelRefs(config: OpenCodeConfig): number { let count = 0; if (typeof config.model === "string") { delete config.model; count++ }; if (typeof config.small_model === "string") { delete config.small_model; count++ }; for (const agent of Object.values(config.agent ?? {})) if (typeof agent?.model === "string") { delete agent.model; count++ }; return count }

export function applyProfile(config: OpenCodeConfig, profile: Profile, tierMap: Record<string, string>): ApplyResult {
  if (!config.agent) throw new Error("opencode config has no agent section")
  if (!Object.keys(tierMap).length) throw new Error(`tiers.json missing or empty: ${TIERS_FILE}`)
  for (const [tier, ref] of Object.entries(profile.tiers)) if (!ref.includes("/") || ref.startsWith("/") || ref.endsWith("/")) throw new Error(`tier ${tier}: value '${ref}' must be '<provider>/<model_id>'`)
  const patch: OpenCodeConfig = { agent: {} }; const details: string[] = []; let updated = 0
  const agents = config.agent as Record<string, Agent>
  const patchAgents = patch.agent as Record<string, Agent>
  for (const [tier, ref] of Object.entries(profile.tiers)) { let count = 0; for (const [name, agent] of Object.entries(agents)) if (tierMap[name] === tier) { const resolved = resolveSuffixModelRef(config as VariantConfig, ref, agent.variant); agent.model = resolved; patchAgents[name] = { model: resolved }; count++ }; if (!count) details.push(`tier.${tier} → ${ref} (reserved — no agent assigned)`); else { if (tier === "standard") { config.model = ref; patch.model = ref }; details.push(`tier.${tier} → ${ref} (${count} agent${count > 1 ? "s" : ""})`); updated += count } }
  if (profile.tiers.flash?.includes("/")) { config.small_model = profile.tiers.flash; patch.small_model = profile.tiers.flash; details.push(`small_model → ${profile.tiers.flash} (tier.flash)`) }
  return { updated, details, patch }
}

export function getCurrentTierMapping(config: OpenCodeConfig, tierMap: Record<string, string>): Record<string, string> { const result: Record<string, string> = {}; for (const [name, agent] of Object.entries(config.agent ?? {})) { const tier = tierMap[name]; if (tier && agent.model && !(tier in result)) result[tier] = agent.model }; return result }
export function configCatalog(configPath = CONFIG_FILE): Catalog { const result: Catalog = {}; try { const config = readConfig(configPath); for (const [id, provider] of Object.entries(config.provider ?? {})) if (provider.models && Object.keys(provider.models).length) result[id] = { name: provider.name, source: "config", models: provider.models as Record<string, CatalogModel> } } catch { /* config is optional */ } return result }

export const PROFILE_TIERS = ["flash", "standard", "pro", "max", "vision"] as const

export function planAgentTierChange(
  current: Record<string, string>,
  changes: Record<string, string>,
): { map: Record<string, string>; changed: string[] } {
  const map = { ...current }
  const changed: string[] = []
  for (const [agent, tier] of Object.entries(changes)) {
    if (!PROFILE_TIERS.includes(tier as typeof PROFILE_TIERS[number])) throw new Error(`invalid tier: ${tier}`)
    if (map[agent] !== tier) { map[agent] = tier; changed.push(agent) }
  }
  return { map, changed }
}

export function planTierModelChange(
  current: Record<string, string>,
  tier: string,
  ref: string,
): { mapping: Record<string, string>; changed: boolean } {
  if (!PROFILE_TIERS.includes(tier as typeof PROFILE_TIERS[number])) throw new Error(`invalid tier: ${tier}`)
  if (!ref.includes("/") || ref.startsWith("/") || ref.endsWith("/")) throw new Error(`invalid model ref: ${ref}`)
  return { mapping: { ...current, [tier]: ref }, changed: current[tier] !== ref }
}

export function createCustomProfile(tiers: Record<string, string>): Profile {
  return { description: "Custom profile", tiers: Object.fromEntries(PROFILE_TIERS.map((tier) => [tier, tiers[tier] ?? ""])) }
}

const commandTokens = new Set(["profile.switch", "profile", "/profile"])
export function parseProfileSubcommand(ctx: unknown): string | null { if (!ctx || typeof ctx !== "object") return null; const c = ctx as { input?: unknown; payload?: unknown; data?: { args?: unknown } }; for (const raw of [c.data?.args, c.payload, c.input]) for (const item of Array.isArray(raw) ? raw : [raw]) if (typeof item === "string") { const tokens = item.trim().split(/\s+/).map((x) => x.toLowerCase()); let i = 0; while (commandTokens.has(tokens[i] ?? "")) i++; if (tokens[i]) return tokens[i] }; return null }
