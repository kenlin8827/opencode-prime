/// <reference types="bun" />
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"

/**
 * Profile Wizard — TUI dialog-based profile switching.
 *
 * Dialog replacement of the former server-side profile-switcher plugin.
 * Registered via `tui.template.jsonc` → `plugin` array (TUI plugins have no
 * directory auto-discovery — they must be listed there).
 *
 * Entry points:
 *   /profile                — slash command (opens the picker)
 *   /profile reset          — subcommand: remove every model ref the wizard
 *                             wrote (root model, small_model, agent.*.model)
 *                             and deactivate the profile (confirm dialog;
 *                             opencode falls back to its model picker)
 *   command palette (ctrl+p) — "Switch model profile"
 *
 * Main menu entry points (most frequent first):
 *
 *   1. Select: Profile     — pick a profile, review its tier→model
 *      mapping, then confirm to apply (profile list → confirm)
 *
 *   2. Edit: Agent→Tier   — reassign which tier an agent belongs to
 *      (writes tiers.json; agent list → tier picker → Apply/Cancel)
 *
 *   3. Edit: Tier→Model   — change the live tier→model mapping directly
 *      (tier list → pick provider → pick model → Apply; syncs the
 *      active profile file if present; no profile required)
 *
 *   4. Manage: Profile→Models — edit a profile's tier→model mapping
 *      (profile list → tier list with model refs → pick provider →
 *      pick model → Apply/Cancel; add profile from the list, delete
 *      it from its tier review screen with a confirm dialog)
 *
 *   5. Reset: Model refs   — remove every model ref from opencode.jsonc
 *      and deactivate the profile (confirm dialog; profile files and
 *      tiers.json are kept)
 *
 *   "Add: Profile" also lives in the Actions group (low-frequency —
 *   not pinned on top like the provider wizard's ➕ Add custom provider).
 *
 * Every dialog level uses Esc as the only back navigation (via
 * dialog.replace onClose callback + navigated flag): Esc goes back
 * one level instead of closing the entire dialog stack. No explicit
 * back items exist in the option lists.
 *
 * Profiles are JSON files in ~/.config/opencode/profiles/ with shape:
 *   { "description": ..., "tiers": { "<tier>": "<provider>/<model_id>" } }
 *
 * Note: this is a TUI-only module — a single module cannot export both
 * `server` and `tui`. It only runs inside the TUI; headless sessions
 * have no /profile equivalent.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
  type Dirent,
} from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { tr, initI18n, languageOption, switchLanguage, SWITCH_LANG } from "./i18n"
import { resolveSuffixModelRef, type VariantConfig } from "../shared/model-variants"

const CONFIG_DIR = join(homedir(), ".config", "opencode")
const CONFIG_FILE = join(CONFIG_DIR, "opencode.jsonc")
const AUTH_FILE = join(homedir(), ".local", "share", "opencode", "auth.json")
const TIERS_FILE = join(CONFIG_DIR, "tiers.json")
const STATE_FILE = join(CONFIG_DIR, ".active-profile")
const PROFILE_STATE_FILE = join(CONFIG_DIR, ".profile-state.json")
const PROFILES_DIR = join(CONFIG_DIR, "profiles")
const PLUGIN_ID = "opencode-prime.profile"
const APPLY = "__apply__"
const CANCEL = "__cancel__"
const TYPE_CUSTOM = "__type_custom__"
const TIER_PREFIX = "tier:"
const ADD_PROFILE = "__add_profile__"
const DELETE_PROFILE = "__delete_profile__"
const EDIT_TIERS = "__edit_tiers__"
const EDIT_TIER_MODELS = "__edit_tier_models__"
const MANAGE_MODELS = "__manage_models__"
const SELECT_PROFILE = "__select_profile__"
const RESET_MODELS = "__reset_models__"

const VALID_TIERS = ["flash", "standard", "pro", "max", "vision"] as const

// ─── Types ───────────────────────────────────────────────────────────

interface Profile {
  description?: string
  tiers: Record<string, string> // tier name → "provider/model_id"
}

interface ProfileState {
  version: 1
  custom: string[]
  recent: string[]
}

interface Agent {
  tier?: string
  model?: string
  variant?: string
  [key: string]: unknown
}

interface ModelDef {
  name?: string
  id?: string
  [key: string]: unknown
}

// Catalog entry served to the pickers — built from the SDK provider
// list when reachable, otherwise from opencode.jsonc definitions.
interface CatalogModel {
  name?: string
  status?: string
}

interface CatalogProvider {
  id?: string
  name?: string
  source?: string
  connected?: boolean
  models: Record<string, CatalogModel>
}

type Catalog = Record<string, CatalogProvider>

interface ProviderDef {
  name?: string
  options?: Record<string, unknown>
  models?: Record<string, ModelDef>
  [key: string]: unknown
}

interface OpenCodeConfig {
  model?: string
  agent?: Record<string, Agent>
  provider?: Record<string, ProviderDef>
  [key: string]: unknown
}

// ─── JSONC stripping (same implementation as provider-wizard.ts) ────

function stripJsonc(raw: string): string {
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

function readConfig(path: string): OpenCodeConfig {
  if (!existsSync(path)) throw new Error(`config not found: ${path}`)
  return JSON.parse(stripJsonc(readFileSync(path, "utf-8"))) as OpenCodeConfig
}

function writeConfigAtomic(path: string, data: OpenCodeConfig): void {
  if (existsSync(path)) {
    writeFileSync(path + ".bak", readFileSync(path))
  }
  writeFileSync(path + ".tmp", JSON.stringify(data, null, 2), "utf-8")
  renameSync(path + ".tmp", path)
}

// ─── Profile loading + state ─────────────────────────────────────────

type ProfileKind = "custom" | "preset"

interface ProfileListEntry {
  name: string
  profile: Profile
  kind: ProfileKind
  active: boolean
  recent: boolean
}

interface AuthEntry {
  type?: string
  key?: string
}

function loadProfiles(): Map<string, Profile> {
  const profiles = new Map<string, Profile>()
  if (!existsSync(PROFILES_DIR)) return profiles
  collectProfiles(PROFILES_DIR, "", profiles)
  return profiles
}

// Walk PROFILES_DIR recursively so profiles may be grouped into
// subdirectories (e.g. profiles/opencode-go/deepseek.json). Profile keys
// are subdir-relative names using "/" separators.
function collectProfiles(dir: string, prefix: string, out: Map<string, Profile>): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      collectProfiles(join(dir, entry.name), rel, out)
    } else if (entry.name.endsWith(".json")) {
      try {
        const data = JSON.parse(
          readFileSync(join(dir, entry.name), "utf-8"),
        ) as Profile
        if (data.tiers && typeof data.tiers === "object") {
          out.set(rel.replace(/\.json$/, ""), data)
        }
      } catch {
        // skip invalid profiles silently
      }
    }
  }
}

function getActiveProfile(): string | null {
  if (!existsSync(STATE_FILE)) return null
  const name = readFileSync(STATE_FILE, "utf-8").trim()
  return name || null
}

function setActiveProfile(name: string): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(STATE_FILE, name, "utf-8")
}

function uniqueNames(names: string[]): string[] {
  return [...new Set(names.filter((name) => name.trim().length > 0))]
}

function readProfileState(): ProfileState {
  if (existsSync(PROFILE_STATE_FILE)) {
    try {
      const data = JSON.parse(readFileSync(PROFILE_STATE_FILE, "utf-8")) as Partial<ProfileState>
      return {
        version: 1,
        custom: uniqueNames(Array.isArray(data.custom) ? data.custom.filter((name): name is string => typeof name === "string") : []),
        recent: uniqueNames(Array.isArray(data.recent) ? data.recent.filter((name): name is string => typeof name === "string") : []),
      }
    } catch {
      return { version: 1, custom: [], recent: [] }
    }
  }
  return { version: 1, custom: [], recent: [] }
}

function writeProfileState(state: ProfileState): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
  const normalized: ProfileState = {
    version: 1,
    custom: uniqueNames(state.custom),
    recent: uniqueNames(state.recent).filter((name) => !state.custom.includes(name)).slice(0, 12),
  }
  writeFileSync(PROFILE_STATE_FILE + ".tmp", JSON.stringify(normalized, null, 2) + "\n", "utf-8")
  renameSync(PROFILE_STATE_FILE + ".tmp", PROFILE_STATE_FILE)
}

function markCustomProfile(name: string): void {
  const state = readProfileState()
  writeProfileState({ ...state, custom: [name, ...state.custom], recent: state.recent.filter((item) => item !== name) })
}

function forgetProfileState(name: string): void {
  const state = readProfileState()
  writeProfileState({
    ...state,
    custom: state.custom.filter((item) => item !== name),
    recent: state.recent.filter((item) => item !== name),
  })
}

function recordRecentProfile(name: string): void {
  const state = readProfileState()
  if (state.custom.includes(name)) return
  writeProfileState({ ...state, recent: [name, ...state.recent.filter((item) => item !== name)] })
}

function profileKind(name: string, state: ProfileState): ProfileKind {
  return state.custom.includes(name) ? "custom" : "preset"
}

function profileGroup(name: string): string {
  return name.includes("/") ? name.split("/")[0] ?? name : "general"
}

function profileCategory(entry: ProfileListEntry): string {
  if (entry.active) return tr("profile.activeProfilesHeader")
  if (entry.kind === "custom") return tr("profile.customProfilesHeader")
  if (entry.recent) return tr("profile.recentProfilesHeader")
  return tr("profile.presetProfilesHeader", { group: profileGroup(entry.name) })
}

function profileTitle(entry: ProfileListEntry): string {
  return entry.active ? `${entry.name}  ← active` : entry.name
}

function sortedProfileEntries(profiles: Map<string, Profile>): ProfileListEntry[] {
  const state = readProfileState()
  const active = getActiveProfile()
  const recentRank = new Map(state.recent.map((name, index) => [name, index]))
  return Array.from(profiles.entries())
    .map(([name, profile]) => {
      const kind = profileKind(name, state)
      return {
        name,
        profile,
        kind,
        active: name === active,
        recent: kind !== "custom" && recentRank.has(name),
      }
    })
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1
      if (a.kind !== b.kind) return a.kind === "custom" ? -1 : 1
      if (a.recent !== b.recent) return a.recent ? -1 : 1
      if (a.recent && b.recent) return (recentRank.get(a.name) ?? 0) - (recentRank.get(b.name) ?? 0)
      const group = profileGroup(a.name).localeCompare(profileGroup(b.name))
      return group || a.name.localeCompare(b.name)
    })
}

function providerNameCmp(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
}

interface ProviderConnectionRanks {
  auth: Map<string, number>
  config: Set<string>
}

function connectedProviderRanks(): ProviderConnectionRanks {
  const auth = new Map<string, number>()
  for (const [id, entry] of Object.entries(readAuth())) {
    if (entry && typeof entry === "object" && (entry.type === "api" || entry.type === "oauth")) auth.set(id, auth.size)
  }
  const config = new Set<string>()
  try {
    const data = readConfig(CONFIG_FILE)
    for (const [id, provider] of Object.entries(data.provider ?? {})) {
      if (provider?.options?.apiKey !== undefined) config.add(id)
    }
  } catch {
    // auth.json is enough for official /connect providers; config apiKey is best-effort.
  }
  return { auth, config }
}

function isProviderConnectedByRank(id: string, connected: ProviderConnectionRanks): boolean {
  return connected.auth.has(id) || connected.config.has(id)
}

function providerCategory(id: string, connected: ProviderConnectionRanks): string {
  return isProviderConnectedByRank(id, connected) ? tr("profile.connectedProvidersHeader") : tr("profile.providersHeader")
}

function providerDescription(id: string, provider: CatalogProvider, connected: ProviderConnectionRanks): string {
  const tags = [
    tr("common.modelCount", { count: Object.keys(provider.models).length }),
    provider.source === "config" ? tr("common.config") : tr("common.builtin"),
  ]
  if (isProviderConnectedByRank(id, connected)) tags.push(tr("common.connected"))
  return tags.join(" · ")
}

function sortedProviderIds(catalog: Catalog): string[] {
  const connected = connectedProviderRanks()
  return Object.keys(catalog).sort((a, b) => {
    const authA = connected.auth.get(a)
    const authB = connected.auth.get(b)
    if (authA !== undefined || authB !== undefined) {
      if (authA !== undefined && authB !== undefined) return authA - authB
      return authA !== undefined ? -1 : 1
    }
    const cfgA = connected.config.has(a)
    const cfgB = connected.config.has(b)
    if (cfgA !== cfgB) return cfgA ? -1 : 1
    return providerNameCmp(a, b)
  })
}

function readAuth(): Record<string, AuthEntry> {
  try {
    return JSON.parse(readFileSync(AUTH_FILE, "utf-8")) as Record<string, AuthEntry>
  } catch {
    return {}
  }
}

function profilePath(name: string): string {
  // Nested names ("opencode-go/deepseek") map to subdirectory paths.
  return join(PROFILES_DIR, ...name.split("/")) + ".json"
}

function writeProfileAtomic(name: string, profile: Profile): void {
  const path = profilePath(name)
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  if (existsSync(path)) writeFileSync(path + ".bak", readFileSync(path))
  writeFileSync(path + ".tmp", JSON.stringify(profile, null, 2) + "\n", "utf-8")
  renameSync(path + ".tmp", path)
}

function deleteProfile(name: string): void {
  const path = profilePath(name)
  if (existsSync(path)) {
    writeFileSync(path + ".bak", readFileSync(path))
    unlinkSync(path)
  }
}

// Agent → tier mapping lives in tiers.json, NOT in the agent block of
// opencode.jsonc: opencode forwards every unknown agent field to the
// provider as a model option, and strict upstream gateways reject it
// ("Extra inputs are not permitted, field: 'tier'").
function loadTierMap(): Record<string, string> {
  if (!existsSync(TIERS_FILE)) return {}
  try {
    const data = JSON.parse(readFileSync(TIERS_FILE, "utf-8")) as Record<string, unknown>
    const map: Record<string, string> = {}
    for (const [agent, tier] of Object.entries(data)) {
      if (agent.startsWith("$")) continue
      if (typeof tier === "string") map[agent] = tier
    }
    return map
  } catch {
    return {}
  }
}

// ─── Model-ref reset (inverse of profile application) ───────────────
// Removes everything the wizard can write into opencode.jsonc: root
// `model`, `small_model`, and every `agent.<name>.model`. Profile files
// and tiers.json are untouched — reset clears the applied state, not the
// library. Exported for unit tests.

/** Read-only: list the model refs a reset would remove ("field → ref"). */
export function listModelRefs(config: OpenCodeConfig): string[] {
  const refs: string[] = []
  if (typeof config.model === "string") refs.push(`model → ${config.model}`)
  if (typeof config.small_model === "string") refs.push(`small_model → ${config.small_model as string}`)
  if (config.agent) {
    for (const [name, agent] of Object.entries(config.agent)) {
      if (agent && typeof agent.model === "string") refs.push(`agent.${name} → ${agent.model}`)
    }
  }
  return refs
}

/** Mutating: strip all model refs from the config; returns removed count. */
export function stripModelRefs(config: OpenCodeConfig): number {
  let removed = 0
  if (typeof config.model === "string") {
    delete config.model
    removed++
  }
  if (typeof config.small_model === "string") {
    delete config.small_model
    removed++
  }
  if (config.agent) {
    for (const agent of Object.values(config.agent)) {
      if (agent && typeof agent.model === "string") {
        delete agent.model
        removed++
      }
    }
  }
  return removed
}

// ─── Profile application (same semantics as the former plugin) ──────
// Validates tier ref format, then rewrites every agent whose tier
// matches. Mixed providers are allowed. Root `model` tracks tier.standard;
// root `small_model` tracks tier.flash so opencode's native title pipeline
// and other utility calls run on the cheap tier.
// Also emits a merge patch (agent names → model) so the live path can
// go through the server's global config API instead of a raw rewrite.
// Exported for unit tests.

interface ApplyResult {
  updated: number
  details: string[]
  patch: OpenCodeConfig
}

export function applyProfile(
  config: OpenCodeConfig,
  profile: Profile,
  tierMap: Record<string, string>,
): ApplyResult {
  const details: string[] = []
  let updated = 0
  const patch: OpenCodeConfig = { agent: {} }

  if (!config.agent) {
    throw new Error("opencode config has no agent section")
  }
  if (Object.keys(tierMap).length === 0) {
    throw new Error(`tiers.json missing or empty: ${TIERS_FILE}`)
  }

  for (const [tier, ref] of Object.entries(profile.tiers)) {
    if (!ref.includes("/") || ref.startsWith("/") || ref.endsWith("/")) {
      throw new Error(
        `tier ${tier}: value '${ref}' must be '<provider>/<model_id>'`,
      )
    }
  }

  for (const [tier, ref] of Object.entries(profile.tiers)) {
    let count = 0
    for (const [name, agent] of Object.entries(config.agent)) {
      const agentTier = tierMap[name]
      if (agentTier === tier) {
        const resolved = resolveSuffixModelRef(config as VariantConfig, ref, agent.variant)
        agent.model = resolved
        patch.agent![name] = { model: resolved }
        count++
      }
    }
    // Reserved tiers with no agent mapped yet are kept in the profile but
    // skipped on apply instead of failing the whole profile.
    if (count === 0) {
      details.push(`tier.${tier} → ${ref} (reserved — no agent assigned)`)
      continue
    }
    if (tier === "standard") {
      config.model = ref
      patch.model = ref
    }
      details.push(`tier.${tier} → ${ref} (${count} agent${count > 1 ? "s" : ""})`)
    updated += count
  }

  // Anchor opencode's utility model (small_model) to the flash tier — the
  // host's native title pipeline (built-in `title` agent) and other small
  // tasks then run on the cheapest configured model instead of the
  // session's large one.
  const smallRef = profile.tiers.flash
  if (typeof smallRef === "string" && smallRef.includes("/")) {
    config.small_model = smallRef
    patch.small_model = smallRef
    details.push(`small_model → ${smallRef} (tier.flash)`)
  }

  return { updated, details, patch }
}

// Live apply via the server's global config API (PATCH /global/config):
// the server patches opencode.jsonc (comments preserved), invalidates
// its config cache and rebuilds instances — no restart needed. Returns
// false when the request fails, so the caller can use a raw file rewrite.
async function applyLive(
  api: TuiPluginApi,
  patch: OpenCodeConfig,
): Promise<boolean> {
  try {
    const res = await api.client.global.config.update({ config: patch })
    return res.error === undefined
  } catch {
    return false
  }
}

// Reads the first agent's model per tier (all agents of a tier share one
// ref — rewritten in lockstep on apply).
function getCurrentTierMapping(
  config: OpenCodeConfig,
  tierMap: Record<string, string>,
): Record<string, string> {
  const map: Record<string, string> = {}
  if (!config.agent) return map
  for (const [name, agent] of Object.entries(config.agent)) {
    const tier = tierMap[name]
    if (tier && agent.model && !(tier in map)) {
      map[tier] = agent.model
    }
  }
  return map
}

// ─── tiers.json write (atomic: backup .bak + tmp + rename) ──────────

function writeTiersFileAtomic(map: Record<string, string>): void {
  let comment: string | undefined
  if (existsSync(TIERS_FILE)) {
    try {
      const data = JSON.parse(readFileSync(TIERS_FILE, "utf-8")) as Record<string, unknown>
      if (typeof data.$comment === "string") comment = data.$comment
    } catch {
      // ignore
    }
    writeFileSync(TIERS_FILE + ".bak", readFileSync(TIERS_FILE))
  }
  const result: Record<string, string> = {}
  if (comment) result["$comment"] = comment
  for (const [k, v] of Object.entries(map)) result[k] = v
  writeFileSync(TIERS_FILE + ".tmp", JSON.stringify(result, null, 2) + "\n", "utf-8")
  renameSync(TIERS_FILE + ".tmp", TIERS_FILE)
}

// ─── Toast helper ────────────────────────────────────────────────────

function toast(
  api: TuiPluginApi,
  message: string,
  variant: "info" | "success" | "warning" | "error" = "info",
) {
  api.ui.toast({ title: tr("profile.cmdTitle"), message, variant })
}

function tierDescription(tier: string): string {
  switch (tier) {
    case "flash":     return tr("profile.tierFlash")
    case "standard":  return tr("profile.tierStandard")
    case "pro":       return tr("profile.tierPro")
    case "max":       return tr("profile.tierMax")
    case "vision":    return tr("profile.tierVision")
    default:          return ""
  }
}

// ════════════════════════════════════════════════════════════════════
// ┌─ Level 1: Main menu — four entry points ──────────────────────────────
// ════════════════════════════════════════════════════════════════════

function startWizard(api: TuiPluginApi): void {
  const active = getActiveProfile()

  const selectionCat = tr("profile.selectionHeader")
  const editCat = tr("profile.editHeader")
  const manageCat = tr("profile.manageHeader")
  const actionsCat = tr("profile.actionsHeader")
  const interfaceCat = tr("common.interfaceHeader")

  api.ui.dialog.replace(() =>
    api.ui.DialogSelect<string>({
      title: tr("profile.mainTitle"),
      placeholder: tr("profile.mainPlaceholder"),
      options: [
        // ── Selection: pick a profile to apply
        {
          title: active ? tr("profile.selectProfileActive", { active }) : tr("profile.selectProfile"),
          value: SELECT_PROFILE,
          description: tr("profile.selectProfileDesc"),
          category: selectionCat,
        },
        // ── Edit: change tier/model mappings
        {
          title: tr("profile.editAgentTier"),
          value: EDIT_TIERS,
          description: tr("profile.editAgentTierDesc"),
          category: editCat,
        },
        {
          title: tr("profile.editTierModels"),
          value: EDIT_TIER_MODELS,
          description: tr("profile.editTierModelsDesc"),
          category: editCat,
        },
        {
          title: tr("profile.manageModels"),
          value: MANAGE_MODELS,
          description: tr("profile.manageModelsDesc"),
          category: editCat,
        },
        // ── Manage: add a new profile
        {
          title: tr("profile.addProfile"),
          value: ADD_PROFILE,
          description: tr("profile.addProfileDesc"),
          category: manageCat,
        },
        // ── Actions: destructive / low-frequency
        {
          title: tr("profile.resetModels"),
          value: RESET_MODELS,
          description: tr("profile.resetModelsDesc"),
          category: actionsCat,
        },
        { ...languageOption(api), category: interfaceCat },
      ],
      onSelect: (option) => {
        if (option.value === SWITCH_LANG) {
          switchLanguage(api, () => startWizard(api))
          return
        }
        if (option.value === EDIT_TIERS) {
          editAgentTier(api, loadTierMap(), {})
          return
        }
        if (option.value === EDIT_TIER_MODELS) {
          editTierModels(api, {})
          return
        }
        if (option.value === MANAGE_MODELS) {
          manageProfileModels(api)
          return
        }
        if (option.value === SELECT_PROFILE) {
          selectProfile(api)
          return
        }
        if (option.value === ADD_PROFILE) {
          promptAddProfile(api, () => startWizard(api))
          return
        }
        if (option.value === RESET_MODELS) {
          resetModels(api)
          return
        }
      },
    }),
  )
}

// ════════════════════════════════════════════════════════════════════
// ┌─ Branch 1: Edit: Agent→Tier ───────────────────────────────────────
// ════════════════════════════════════════════════════════════════════

// Level 2: Agent list
function editAgentTier(
  api: TuiPluginApi,
  tierMap: Record<string, string>,
  changed: Record<string, string>,
): void {
  let config: OpenCodeConfig
  try {
    config = readConfig(CONFIG_FILE)
  } catch (err) {
    toast(api, tr("profile.readConfigFailed", { err: (err as Error).message }), "error")
    startWizard(api)
    return
  }

  const agents = config.agent
  if (!agents || Object.keys(agents).length === 0) {
    toast(api, tr("profile.noAgents"), "warning")
    startWizard(api)
    return
  }

  const sorted = Object.keys(agents).sort()
  const hasChanges = Object.keys(changed).length > 0

  let navigated = false
  api.ui.dialog.replace(
    () =>
      api.ui.DialogSelect<string>({
        title: hasChanges
          ? tr("profile.editTierTitlePending", { count: Object.keys(changed).length })
          : tr("profile.editTierTitle"),
        placeholder: tr("profile.editTierPlaceholder"),
        // The host DialogSelect renders `category` as bold accent section
        // headers that are NOT focusable options — real grouping, no fake rows.
        options: [
          ...sorted.map((name) => {
            const tier = changed[name] ?? tierMap[name] ?? "standard"
            const isChanged = changed[name] !== undefined
            const oldTier = tierMap[name] ?? "standard"
            return {
              title: isChanged ? `${name}  (${oldTier} → ${tier})` : `${name}  (${tier})`,
              value: name,
              description: tr("profile.tierModelDesc", { tier, model: agents[name].model ?? tr("common.unset") }),
              category: tr("profile.agentsHeader"),
            }
          }),
          ...(hasChanges
            ? [{
                title: tr("common.applyChanges"),
                value: APPLY,
                description: tr("profile.applyChangesDesc", { count: Object.keys(changed).length, s: Object.keys(changed).length > 1 ? "s" : "" }),
                category: tr("profile.actionsHeader"),
              }]
            : []),
        ],
        onSelect: (option) => {
          navigated = true
          if (option.value === APPLY) {
            void applyAgentTierChanges(api, tierMap, changed)
            return
          }
          const currentTier = changed[option.value] ?? tierMap[option.value] ?? agents[option.value].tier ?? "standard"
          pickAgentTier(api, option.value, currentTier, tierMap, changed)
        },
      }),
    () => {
      if (!navigated) setTimeout(() => startWizard(api), 0)
    },
  )
}

// Level 3: Tier picker (per agent)
function pickAgentTier(
  api: TuiPluginApi,
  agentName: string,
  currentTier: string,
  tierMap: Record<string, string>,
  changed: Record<string, string>,
): void {
  let navigated = false
  api.ui.dialog.replace(
    () =>
      api.ui.DialogSelect<string>({
        title: tr("profile.pickTierTitle", { agent: agentName, tier: currentTier }),
        placeholder: tr("profile.pickTierPlaceholder"),
        options: VALID_TIERS.map((t) => ({
          title: t === currentTier ? `${t}  ${tr("common.currentMarker")}` : t,
          value: t,
          description: tierDescription(t),
        })),
        onSelect: (option) => {
          navigated = true
          const newTier = option.value
          if (newTier !== currentTier) {
            changed[agentName] = newTier
            toast(api, tr("profile.tierChanged", { agent: agentName, old: currentTier, new: newTier }), "info")
          }
          editAgentTier(api, tierMap, changed)
        },
      }),
    () => {
      if (!navigated) setTimeout(() => editAgentTier(api, tierMap, changed), 0)
    },
  )
}

async function applyAgentTierChanges(
  api: TuiPluginApi,
  originalMap: Record<string, string>,
  changed: Record<string, string>,
): Promise<void> {
  const changeCount = Object.keys(changed).length
  if (changeCount === 0) {
    startWizard(api)
    return
  }

  // 1. Build new tier map and write tiers.json
  const newMap: Record<string, string> = { ...originalMap }
  for (const [agent, tier] of Object.entries(changed)) newMap[agent] = tier

  try {
    writeTiersFileAtomic(newMap)
  } catch (err) {
    api.ui.dialog.clear()
    toast(api, tr("profile.writeTiersFailed", { err: (err as Error).message }), "error")
    return
  }

  // 2. Live-apply: rewrite changed agents' models to the new tier's ref
  let config: OpenCodeConfig
  try {
    config = readConfig(CONFIG_FILE)
  } catch (err) {
    api.ui.dialog.clear()
    toast(api, tr("profile.tiersUpdatedConfigFailed", { err: (err as Error).message }), "warning")
    return
  }

  const activeName = getActiveProfile()
  const profiles = loadProfiles()
  const activeProfile = activeName ? profiles.get(activeName) ?? null : null
  const tierModels = getCurrentTierMapping(config, newMap)

  const patch: OpenCodeConfig = { agent: {} }
  const details: string[] = []
  let appliedCount = 0

  for (const [agentName, newTier] of Object.entries(changed)) {
    if (!config.agent?.[agentName]) continue
    const ref = activeProfile?.tiers?.[newTier] ?? tierModels[newTier] ?? null
    if (ref) {
      config.agent[agentName].model = ref
      patch.agent![agentName] = { model: ref }
      details.push(`${agentName} → ${newTier} (${ref})`)
      appliedCount++
    } else {
      details.push(tr("profile.noModelRef", { agent: agentName, tier: newTier }))
    }
  }

  // 3. Try live apply, fall back to direct write
  let live = false
  if (appliedCount > 0) {
    live = await applyLive(api, patch)
    if (!live) {
      try {
        writeConfigAtomic(CONFIG_FILE, config)
      } catch (err) {
        api.ui.dialog.clear()
        toast(api, tr("profile.writeOpencodeFailed", { err: (err as Error).message }), "error")
        return
      }
    }
  }

  api.ui.dialog.clear()
  toast(api, tr("profile.tierChangesApplied", { count: changeCount, s: changeCount > 1 ? "s" : "", details: details.join("; "), live: live ? tr("profile.liveNoRestart") : tr("profile.restartToApply") }), "success")
}

// ════════════════════════════════════════════════════════════════════
// ┌─ Branch 2: Edit: Tier→Model (live config, no profile) ───────────
// ════════════════════════════════════════════════════════════════════

// Level 2: Tier list with live model refs
function editTierModels(api: TuiPluginApi, overrides: Record<string, string>): void {
  let config: OpenCodeConfig
  try {
    config = readConfig(CONFIG_FILE)
  } catch (err) {
    toast(api, tr("profile.readConfigFailed", { err: (err as Error).message }), "error")
    startWizard(api)
    return
  }

  const tierMap = loadTierMap()
  const current = getCurrentTierMapping(config, tierMap)

  // Tiers worth listing: those in use by agents, plus tiers defined by
  // the active profile (so a ref can be prepared before any agent uses it).
  const activeName = getActiveProfile()
  const activeProfile = activeName ? loadProfiles().get(activeName) ?? null : null
  const tierSet = new Set<string>(Object.keys(current))
  if (activeProfile) {
    for (const tier of Object.keys(activeProfile.tiers)) tierSet.add(tier)
  }
  const extras = Array.from(tierSet).filter((t) => !VALID_TIERS.includes(t as (typeof VALID_TIERS)[number])).sort()
  const tiers = [...VALID_TIERS.filter((t) => tierSet.has(t)), ...extras]

  if (tiers.length === 0) {
    toast(api, tr("profile.noTierModels"), "warning")
    startWizard(api)
    return
  }

  const hasChanges = Object.keys(overrides).length > 0

  let navigated = false
  api.ui.dialog.replace(
    () =>
      api.ui.DialogSelect<string>({
        title: hasChanges
          ? tr("profile.editTierModelsTitlePending", { count: Object.keys(overrides).length })
          : tr("profile.editTierModelsTitle"),
        placeholder: tr("profile.editTierModelsPlaceholder"),
        options: [
          ...tiers.map((tier) => {
            const ref = overrides[tier] ?? current[tier] ?? tr("common.unset")
            return {
              title: tier,
              value: `${TIER_PREFIX}${tier}`,
              description:
                overrides[tier] !== undefined && current[tier] !== undefined
                  ? tr("profile.customized", { override: overrides[tier], ref: current[tier] })
                  : ref,
              category: tr("profile.tiersHeader"),
            }
          }),
          ...(hasChanges
            ? [{
                title: tr("common.applyChanges"),
                value: APPLY,
                description: tr("profile.applyTierModelsDesc", { count: Object.keys(overrides).length, s: Object.keys(overrides).length > 1 ? "s" : "" }),
                category: tr("profile.actionsHeader"),
              }]
            : []),
        ],
        onSelect: (option) => {
          navigated = true
          if (option.value === APPLY) {
            void applyTierModelChanges(api, overrides)
            return
          }
          const tier = option.value.slice(TIER_PREFIX.length)
          void pickLiveTierProvider(api, overrides, tier)
        },
      }),
    () => {
      if (!navigated) setTimeout(() => startWizard(api), 0)
    },
  )
}

// Level 3: Provider picker (live tier edit)
async function pickLiveTierProvider(
  api: TuiPluginApi,
  overrides: Record<string, string>,
  tier: string,
): Promise<void> {
  const catalog = await loadCatalog(api)
  const connected = connectedProviderRanks()
  const ids = sortedProviderIds(catalog)
  if (ids.length === 0) {
    promptLiveTierRef(api, overrides, tier)
    return
  }

  let navigated = false
  api.ui.dialog.replace(
    () =>
      api.ui.DialogSelect<string>({
        title: tr("profile.pickTierModelProviderTitle", { tier }),
        placeholder: tr("profile.pickProviderPlaceholder"),
        options: [
          ...ids.map((id) => {
            const p = catalog[id]
            return {
              title: id,
              value: id,
              description: providerDescription(id, p, connected),
              category: providerCategory(id, connected),
            }
          }),
          {
            title: tr("profile.typeCustomRef"),
            value: TYPE_CUSTOM,
            description: tr("profile.typeCustomRefDesc"),
            category: tr("profile.actionsHeader"),
          },
        ],
        onSelect: (option) => {
          navigated = true
          if (option.value === TYPE_CUSTOM) {
            promptLiveTierRef(api, overrides, tier)
            return
          }
          const provider = catalog[option.value]
          if (provider) {
            pickLiveTierModel(api, overrides, tier, option.value, provider.models)
          }
        },
      }),
    () => {
      if (!navigated) setTimeout(() => editTierModels(api, overrides), 0)
    },
  )
}

// Level 4: Model picker (live tier edit)
function pickLiveTierModel(
  api: TuiPluginApi,
  overrides: Record<string, string>,
  tier: string,
  providerId: string,
  models: Record<string, CatalogModel>,
): void {
  const entries = Object.entries(models)
  let navigated = false
  api.ui.dialog.replace(
    () =>
      api.ui.DialogSelect<string>({
        title: tr("profile.pickTierModelModelTitle", { tier, provider: providerId }),
        placeholder: tr("profile.pickModelPlaceholder", { count: entries.length }),
        options: entries.map(([key, m]) => ({
          title: key,
          value: key,
          description: m.name && m.name !== key ? m.name : undefined,
        })),
        onSelect: (option) => {
          navigated = true
          overrides[tier] = `${providerId}/${option.value}`
          toast(api, tr("profile.liveTierModelChanged", { tier, provider: providerId, model: option.value }), "info")
          editTierModels(api, overrides)
        },
      }),
    () => {
      if (!navigated) setTimeout(() => void pickLiveTierProvider(api, overrides, tier), 0)
    },
  )
}

// Manual entry fallback (live tier edit)
function promptLiveTierRef(
  api: TuiPluginApi,
  overrides: Record<string, string>,
  tier: string,
): void {
  const current = overrides[tier] ?? ""
  let navigated = false
  api.ui.dialog.replace(
    () =>
      api.ui.DialogPrompt({
        title: tr("profile.promptTierModelRefTitle", { tier }),
        placeholder: tr("profile.promptTierRefPlaceholder"),
        value: current,
        onConfirm: (value) => {
          navigated = true
          const v = value.trim()
          if (v && v !== current) {
            if (!v.includes("/") || v.startsWith("/") || v.endsWith("/")) {
              toast(api, tr("profile.invalidRef", { ref: v }), "error")
            } else {
              overrides[tier] = v
              toast(api, tr("profile.liveTierModelChanged", { tier, provider: v.split("/")[0] ?? "", model: v.split("/")[1] ?? v }), "info")
            }
          }
          editTierModels(api, overrides)
        },
        onCancel: () => {
          navigated = true
          setTimeout(() => editTierModels(api, overrides), 0)
        },
      }),
    () => {
      if (!navigated) setTimeout(() => editTierModels(api, overrides), 0)
    },
  )
}

// Apply live tier→model changes: rewrite opencode.jsonc agent models per
// tier (root model tracks standard), then sync the active profile file
// when present so a later profile re-apply does not revert the change.
async function applyTierModelChanges(
  api: TuiPluginApi,
  overrides: Record<string, string>,
): Promise<void> {
  const changeCount = Object.keys(overrides).length
  if (changeCount === 0) {
    startWizard(api)
    return
  }

  let config: OpenCodeConfig
  try {
    config = readConfig(CONFIG_FILE)
  } catch (err) {
    api.ui.dialog.clear()
    toast(api, tr("profile.readConfigFailed", { err: (err as Error).message }), "error")
    return
  }

  const tierMap = loadTierMap()
  const tiersInUse = new Set(Object.values(tierMap))
  const merged: Record<string, string> = {}
  for (const [tier, ref] of Object.entries({ ...getCurrentTierMapping(config, tierMap), ...overrides })) {
    // Tiers no agent uses yet have nowhere to land in the live config;
    // they persist via the active-profile sync above instead.
    if (tiersInUse.has(tier)) merged[tier] = ref
  }
  if (Object.keys(merged).length === 0) {
    api.ui.dialog.clear()
    toast(api, tr("profile.noTierModels"), "warning")
    return
  }

  // Keep the active profile file in sync so it stays a faithful source
  // of truth for the live config.
  const activeName = getActiveProfile()
  const activeProfile = activeName ? loadProfiles().get(activeName) ?? null : null
  if (activeName && activeProfile) {
    const synced: Record<string, string> = {}
    for (const [tier, ref] of Object.entries(overrides)) {
      if (tier in activeProfile.tiers && activeProfile.tiers[tier] !== ref) synced[tier] = ref
    }
    if (Object.keys(synced).length > 0) {
      try {
        writeProfileAtomic(activeName, { ...activeProfile, tiers: { ...activeProfile.tiers, ...synced } })
      } catch {
        // non-fatal: live apply still proceeds; profile drifts until next sync
      }
    }
  }

  try {
    const { updated, details, patch } = applyProfile(config, { tiers: merged }, tierMap)
    const live = await applyLive(api, patch)
    if (!live) {
      writeConfigAtomic(CONFIG_FILE, config)
    }
    api.ui.dialog.clear()
    toast(
      api,
      tr("profile.tierModelsApplied", { count: updated, details: details.join("; "), live: live ? tr("profile.liveNoRestart") : tr("profile.restartToApply") }),
      "success",
    )
  } catch (err) {
    api.ui.dialog.clear()
    toast(api, tr("profile.applyFailed", { name: "tier→model", err: (err as Error).message }), "error")
  }
}

// ════════════════════════════════════════════════════════════════════
// ┌─ Branch 3: Manage: Profile→Models ─────────────────────────────────
// ════════════════════════════════════════════════════════════════════

// Level 2: Profile list (for managing models)
function manageProfileModels(api: TuiPluginApi): void {
  const profiles = loadProfiles()
  const sorted = sortedProfileEntries(profiles)

  let navigated = false
  api.ui.dialog.replace(
    () =>
      api.ui.DialogSelect<string>({
        title: tr("profile.manageTitle"),
        placeholder: tr("profile.managePlaceholder"),
        options: [
          ...sorted.map((entry) => ({
            title: profileTitle(entry),
            value: entry.name,
            description: entry.profile.description?.slice(0, 100),
            category: profileCategory(entry),
          })),
          {
            title: tr("profile.addProfile"),
            value: ADD_PROFILE,
            description: tr("profile.addProfileDesc"),
            category: tr("profile.actionsHeader"),
          },
        ],
        onSelect: (option) => {
          navigated = true
          if (option.value === ADD_PROFILE) {
            promptAddProfile(api)
            return
          }
          const profile = profiles.get(option.value)
          if (!profile) {
            toast(api, tr("profile.profileVanished", { name: option.value }), "error")
            manageProfileModels(api)
            return
          }
          reviewProfileTiers(api, option.value, profile, {})
        },
      }),
    () => {
      if (!navigated) setTimeout(() => startWizard(api), 0)
    },
  )
}

// Level 3: Tier review (per profile — edit tier→model, then Apply/Cancel)
function reviewProfileTiers(
  api: TuiPluginApi,
  name: string,
  profile: Profile,
  overrides: Record<string, string>,
): void {
  let navigated = false
  api.ui.dialog.replace(
    () =>
      api.ui.DialogSelect<string>({
        title: tr("profile.reviewTiersTitle", { name }),
        placeholder: tr("profile.reviewTiersPlaceholder"),
        options: [
          ...Object.entries(profile.tiers).map(([tier, ref]) => ({
            title: tier,
            value: `${TIER_PREFIX}${tier}`,
            description:
              overrides[tier] !== undefined
                ? tr("profile.customized", { override: overrides[tier], ref })
                : ref,
            category: tr("profile.tiersHeader"),
          })),
          {
            title: tr("common.applyChanges"),
            value: APPLY,
            description: tr("profile.applyChangesModelDesc"),
            category: tr("profile.actionsHeader"),
          },
          {
            title: tr("common.cancel"),
            value: CANCEL,
            description: tr("profile.cancelDiscard"),
            category: tr("profile.actionsHeader"),
          },
          {
            title: tr("profile.deleteProfile"),
            value: DELETE_PROFILE,
            description: tr("profile.deleteProfileDesc"),
            category: tr("profile.actionsHeader"),
          },
        ],
        onSelect: (option) => {
          navigated = true
          if (option.value === APPLY) {
            void applyProfileModelChanges(api, name, profile, overrides)
            return
          }
          if (option.value === CANCEL) {
            manageProfileModels(api)
            return
          }
          if (option.value === DELETE_PROFILE) {
            confirmDeleteProfile(api, name, profile, overrides)
            return
          }
          const tier = option.value.slice(TIER_PREFIX.length)
          if (tier in profile.tiers) {
            void pickProvider(api, name, profile, overrides, tier)
          }
        },
      }),
    () => {
      if (!navigated) setTimeout(() => manageProfileModels(api), 0)
    },
  )
}

// Level 4: Provider picker
async function pickProvider(
  api: TuiPluginApi,
  name: string,
  profile: Profile,
  overrides: Record<string, string>,
  tier: string,
): Promise<void> {
  const catalog = await loadCatalog(api)
  const connected = connectedProviderRanks()
  const ids = sortedProviderIds(catalog)
  if (ids.length === 0) {
    promptTierRef(api, name, profile, overrides, tier)
    return
  }

  let navigated = false
  api.ui.dialog.replace(
    () =>
      api.ui.DialogSelect<string>({
        title: tr("profile.pickProviderTitle", { name, tier }),
        placeholder: tr("profile.pickProviderPlaceholder"),
        options: [
          ...ids.map((id) => {
            const p = catalog[id]
            return {
              title: id,
              value: id,
              description: providerDescription(id, p, connected),
              category: providerCategory(id, connected),
            }
          }),
          {
            title: tr("profile.typeCustomRef"),
            value: TYPE_CUSTOM,
            description: tr("profile.typeCustomRefDesc"),
            category: tr("profile.actionsHeader"),
          },
        ],
        onSelect: (option) => {
          navigated = true
          if (option.value === TYPE_CUSTOM) {
            promptTierRef(api, name, profile, overrides, tier)
            return
          }
          const provider = catalog[option.value]
          if (provider) {
            pickModel(api, name, profile, overrides, tier, option.value, provider.models)
          }
        },
      }),
    () => {
      if (!navigated) setTimeout(() => reviewProfileTiers(api, name, profile, overrides), 0)
    },
  )
}

// Level 5: Model picker
function pickModel(
  api: TuiPluginApi,
  name: string,
  profile: Profile,
  overrides: Record<string, string>,
  tier: string,
  providerId: string,
  models: Record<string, CatalogModel>,
): void {
  const entries = Object.entries(models)
  let navigated = false
  api.ui.dialog.replace(
    () =>
      api.ui.DialogSelect<string>({
        title: tr("profile.pickModelTitle", { name, tier, provider: providerId }),
        placeholder: tr("profile.pickModelPlaceholder", { count: entries.length }),
        options: entries.map(([key, m]) => ({
          title: key,
          value: key,
          description: m.name && m.name !== key ? m.name : undefined,
        })),
        onSelect: (option) => {
          navigated = true
          overrides[tier] = `${providerId}/${option.value}`
          toast(api, tr("profile.modelChanged", { name, tier, provider: providerId, model: option.value }), "info")
          reviewProfileTiers(api, name, profile, overrides)
        },
      }),
    () => {
      if (!navigated) setTimeout(() => void pickProvider(api, name, profile, overrides, tier), 0)
    },
  )
}

// Manual entry fallback for providers missing from every catalog source.
function promptTierRef(
  api: TuiPluginApi,
  name: string,
  profile: Profile,
  overrides: Record<string, string>,
  tier: string,
): void {
  const current = overrides[tier] ?? profile.tiers[tier]
  let navigated = false
  api.ui.dialog.replace(
    () =>
      api.ui.DialogPrompt({
        title: tr("profile.promptTierRefTitle", { name, tier }),
        placeholder: tr("profile.promptTierRefPlaceholder"),
        value: current,
        onConfirm: (value) => {
          navigated = true
          const v = value.trim()
        if (v && v !== current) {
          if (!v.includes("/") || v.startsWith("/") || v.endsWith("/")) {
            toast(
              api,
              tr("profile.invalidRef", { ref: v }),
              "error",
            )
          } else {
            overrides[tier] = v
            toast(api, tr("profile.modelChanged", { name, tier, provider: v.split("/")[0] ?? "", model: v.split("/")[1] ?? v }), "info")
          }
        }
        reviewProfileTiers(api, name, profile, overrides)
        },
        onCancel: () => {
          navigated = true
          setTimeout(() => reviewProfileTiers(api, name, profile, overrides), 0)
        },
      }),
    () => {
      if (!navigated) setTimeout(() => reviewProfileTiers(api, name, profile, overrides), 0)
    },
  )
}

// Apply profile model changes: write profile JSON, then apply to opencode.jsonc
async function applyProfileModelChanges(
  api: TuiPluginApi,
  name: string,
  profile: Profile,
  overrides: Record<string, string>,
): Promise<void> {
  const hasOverrides = Object.keys(overrides).length > 0
  if (!hasOverrides) {
    reviewProfileTiers(api, name, profile, overrides)
    return
  }

  // Build updated profile
  const updatedProfile: Profile = {
    ...profile,
    tiers: { ...profile.tiers, ...overrides },
  }

  // Write profile JSON atomically
  try {
    writeProfileAtomic(name, updatedProfile)
  } catch (err) {
    api.ui.dialog.clear()
    toast(api, tr("profile.writeProfileFailed", { name, err: (err as Error).message }), "error")
    return
  }

  // Apply the profile to opencode.jsonc (rewrite agent models per tier)
  try {
    const config = readConfig(CONFIG_FILE)
    const { updated, details, patch } = applyProfile(config, updatedProfile, loadTierMap())
    const live = await applyLive(api, patch)
    if (!live) {
      writeConfigAtomic(CONFIG_FILE, config)
    }
    setActiveProfile(name)
    recordRecentProfile(name)
    api.ui.dialog.clear()
    toast(
      api,
      tr("profile.profileUpdatedApplied", { name, updated, details: details.join("; "), live: live ? tr("profile.liveNoRestart") : tr("profile.restartToApply2") }),
      "success",
    )
  } catch (err) {
    api.ui.dialog.clear()
    toast(api, tr("profile.profileSavedApplyFailed", { err: (err as Error).message }), "warning")
  }
}

// ─── Add / Delete profile ────────────────────────────────────────────

// `back` decides where Esc/cancel returns — the main menu (top-level
// ➕ entry) or the manage list (nested entry).
function promptAddProfile(api: TuiPluginApi, back: () => void = () => manageProfileModels(api)): void {
  let navigated = false
  api.ui.dialog.replace(
    () =>
      api.ui.DialogPrompt({
        title: tr("profile.addProfileTitle"),
        placeholder: tr("profile.addProfilePlaceholder"),
        onConfirm: (value) => {
          navigated = true
          const name = value.trim()
        if (!name) {
          back()
          return
        }
        if (existsSync(profilePath(name))) {
          toast(api, tr("profile.profileExists", { name }), "error")
          promptAddProfile(api, back)
          return
        }
        const blankProfile: Profile = {
          description: tr("profile.customProfile"),
          tiers: {
            flash: "",
            standard: "",
            pro: "",
            max: "",
            vision: "",
          },
        }
        try {
          writeProfileAtomic(name, blankProfile)
          markCustomProfile(name)
          toast(api, tr("profile.profileCreated", { name }), "success")
          reviewProfileTiers(api, name, blankProfile, {})
        } catch (err) {
          toast(api, tr("profile.createProfileFailed", { err: (err as Error).message }), "error")
          back()
        }
      },
        onCancel: () => {
          navigated = true
          setTimeout(back, 0)
        },
      }),
    () => {
      if (!navigated) setTimeout(back, 0)
    },
  )
}

function confirmDeleteProfile(
  api: TuiPluginApi,
  name: string,
  profile: Profile,
  overrides: Record<string, string>,
): void {
  let navigated = false
  api.ui.dialog.replace(
    () =>
      api.ui.DialogConfirm({
        title: tr("profile.deleteProfileTitle"),
        message: tr("profile.confirmDeleteMsg", { name, path: profilePath(name) }),
        onConfirm: () => {
          navigated = true
          try {
            deleteProfile(name)
            forgetProfileState(name)
            toast(api, tr("profile.profileDeleted", { name }), "success")
          } catch (err) {
            toast(api, tr("profile.deleteFailed", { err: (err as Error).message }), "error")
          }
          // defer: the host runs dialog.clear() after this callback returns
          setTimeout(() => manageProfileModels(api), 0)
        },
        onCancel: () => {
          navigated = true
          setTimeout(() => reviewProfileTiers(api, name, profile, overrides), 0)
        },
      }),
    () => {
      if (!navigated) setTimeout(() => reviewProfileTiers(api, name, profile, overrides), 0)
    },
  )
}

// ════════════════════════════════════════════════════════════════════
// ┌─ Branch 4: Select: Profile — pick, review mapping, confirm & apply ─
// ════════════════════════════════════════════════════════════════════

function selectProfile(api: TuiPluginApi): void {
  const profiles = loadProfiles()
  if (profiles.size === 0) {
    toast(api, tr("profile.noProfiles", { dir: PROFILES_DIR }), "warning")
    startWizard(api)
    return
  }

  const sorted = sortedProfileEntries(profiles)

  let navigated = false
  api.ui.dialog.replace(
    () =>
      api.ui.DialogSelect<string>({
        title: tr("profile.selectTitle"),
        placeholder: tr("profile.selectPlaceholder"),
        options: sorted.map((entry) => ({
          title: profileTitle(entry),
          value: entry.name,
          description: entry.profile.description?.slice(0, 100),
          category: profileCategory(entry),
        })),
        onSelect: (option) => {
          navigated = true
          const profile = profiles.get(option.value)
          if (!profile) {
            toast(api, tr("profile.profileVanished", { name: option.value }), "error")
            selectProfile(api)
            return
          }
          confirmApplyProfile(api, option.value, profile)
        },
      }),
    () => {
      if (!navigated) setTimeout(() => startWizard(api), 0)
    },
  )
}

// Confirmation gate: show the profile's full tier→model mapping in a
// plain confirm dialog (message = preview, only confirm/cancel exist),
// so the user can cancel instead of applying blind.
function confirmApplyProfile(
  api: TuiPluginApi,
  name: string,
  profile: Profile,
): void {
  const mapping = Object.entries(profile.tiers)
    .map(([tier, ref]) => `  ${tier} → ${ref || tr("common.unset")}`)
    .join("\n")
  let navigated = false
  api.ui.dialog.replace(
    () =>
      api.ui.DialogConfirm({
        title: tr("profile.confirmApplyTitle", { name }),
        message: tr("profile.confirmApplyMsg", { mapping }),
        onConfirm: () => {
          navigated = true
          void applySelection(api, name, profile)
        },
        onCancel: () => {
          navigated = true
          setTimeout(() => selectProfile(api), 0)
        },
      }),
    () => {
      if (!navigated) setTimeout(() => selectProfile(api), 0)
    },
  )
}

async function applySelection(
  api: TuiPluginApi,
  name: string,
  profile: Profile,
): Promise<void> {
  try {
    const config = readConfig(CONFIG_FILE)
    const { updated, details, patch } = applyProfile(config, profile, loadTierMap())
    const live = await applyLive(api, patch)
    if (!live) {
      writeConfigAtomic(CONFIG_FILE, config)
    }
    setActiveProfile(name)
    recordRecentProfile(name)
    api.ui.dialog.clear()
    toast(
      api,
      tr("profile.switchedTo", { name, updated, details: details.join("; "), live: live ? tr("profile.appliedLive") : tr("profile.restartToApply2") }),
      "success",
    )
  } catch (err) {
    api.ui.dialog.clear()
    toast(api, tr("profile.applyFailed", { name, err: (err as Error).message }), "error")
  }
}

// ════════════════════════════════════════════════════════════════════
// ┌─ Branch 5: Reset: Model refs ──────────────────────────────────────
// ════════════════════════════════════════════════════════════════════

function resetModels(api: TuiPluginApi): void {
  let config: OpenCodeConfig
  try {
    config = readConfig(CONFIG_FILE)
  } catch (err) {
    toast(api, tr("profile.readConfigFailed", { err: (err as Error).message }), "error")
    startWizard(api)
    return
  }
  const refs = listModelRefs(config)
  if (refs.length === 0) {
    toast(api, tr("profile.resetNothing"), "info")
    startWizard(api)
    return
  }
  confirmReset(api, refs)
}

// Destructive — same confirm-gate pattern as confirmApplyProfile /
// confirmDeleteProfile. The message lists exactly what will be removed
// and what is kept, so "reset" cannot be misread as restore-defaults.
function confirmReset(api: TuiPluginApi, refs: string[]): void {
  let navigated = false
  api.ui.dialog.replace(
    () =>
      api.ui.DialogConfirm({
        title: tr("profile.resetTitle"),
        message: tr("profile.resetMsg", { refs: refs.map((r) => `  ${r}`).join("\n") }),
        onConfirm: () => {
          navigated = true
          performReset(api)
        },
        onCancel: () => {
          navigated = true
          setTimeout(() => startWizard(api), 0)
        },
      }),
    () => {
      if (!navigated) setTimeout(() => startWizard(api), 0)
    },
  )
}

// File rewrite only — the live PATCH /global/config merge cannot delete
// keys, so a restart is required (writeConfigAtomic keeps a .bak).
function performReset(api: TuiPluginApi): void {
  try {
    const config = readConfig(CONFIG_FILE)
    const removed = stripModelRefs(config)
    writeConfigAtomic(CONFIG_FILE, config)
    // Deactivate the profile so the sidebar badge clears too.
    if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE)
    api.ui.dialog.clear()
    toast(api, tr("profile.resetDone", { count: removed }), "success")
  } catch (err) {
    api.ui.dialog.clear()
    toast(api, tr("profile.resetFailed", { err: (err as Error).message }), "error")
  }
}

// ════════════════════════════════════════════════════════════════════
// ┌─ Catalog (provider/model list for pickers) ─────────────────────────
// ════════════════════════════════════════════════════════════════════

// Reads provider models from opencode.jsonc — reflects custom models
// added via /provider without a restart (the live server catalog still
// holds the pre-edit snapshot).
function configCatalog(): Catalog {
  const catalog: Catalog = {}
  try {
    const config = readConfig(CONFIG_FILE)
    for (const [id, def] of Object.entries(config.provider ?? {})) {
      if (def?.models && Object.keys(def.models).length > 0) {
        catalog[id] = { name: def.name, source: "config", models: def.models }
      }
    }
  } catch {
    // empty catalog — the custom-ref fallback still works
  }
  return catalog
}

// The server catalog is static for the session's lifetime (providers are
// registered at startup), so the round-trip is memoized; only the cheap
// config-file merge re-runs per call so models added via /provider still
// show up without a restart. Keeps provider/model pickers snappy on
// every entry and on Esc-back navigation.
let serverCatalogPromise: Promise<Catalog> | null = null
function serverCatalog(api: TuiPluginApi): Promise<Catalog> {
  serverCatalogPromise ??= (async () => {
    const catalog: Catalog = {}
    try {
      const res = await api.client.provider.list()
      const all = (res as { data?: { all?: CatalogProvider[] } }).data?.all
      if (res.error === undefined && Array.isArray(all) && all.length > 0) {
        for (const p of all) {
          if (!p?.id || !p.models || Object.keys(p.models).length === 0) continue
          catalog[p.id] = p
        }
      }
    } catch {
      // fall through to the config-file catalog
    }
    return catalog
  })()
  return serverCatalogPromise
}

async function loadCatalog(api: TuiPluginApi): Promise<Catalog> {
  const catalog: Catalog = { ...(await serverCatalog(api)) }

  // Merge the opencode.jsonc definitions on top: models added via
  // /provider after launch are missing from the server catalog until
  // restart, so they must not be shadowed by it.
  for (const [id, cfgProvider] of Object.entries(configCatalog())) {
    const existing = catalog[id]
    if (!existing) {
      catalog[id] = cfgProvider
      continue
    }
    catalog[id] = {
      ...existing,
      models: { ...existing.models, ...cfgProvider.models },
    }
  }
  return catalog
}

// ════════════════════════════════════════════════════════════════════
// ┌─ Plugin entry ──────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════

// Tokens that identify the command itself, not a subcommand. Slash dispatch
// puts the command NAME ("profile.switch") into ctx.input, so leading name
// tokens must be skipped when extracting the user's trailing argument
// (same shape as usage.ts's parseSubcommand).
const COMMAND_TOKENS = new Set(["profile.switch", "profile", "/profile"])

/** Extract the subcommand arg from the keymap command context — check
 * data.args and payload first, ctx.input last; skip leading command-name
 * tokens in every source. Exported for unit tests. */
export function parseProfileSubcommand(ctx: unknown): string | null {
  if (typeof ctx !== "object" || ctx === null) return null
  const c = ctx as { input?: unknown; payload?: unknown; data?: { args?: unknown } }
  const sources = [c.data?.args, c.payload, c.input]
  for (const raw of sources) {
    const parts = Array.isArray(raw) ? raw : [raw]
    for (const item of parts) {
      if (typeof item !== "string" || item.trim() === "") continue
      const tokens = item.trim().split(/\s+/).map((t) => t.toLowerCase())
      let i = 0
      while (i < tokens.length && COMMAND_TOKENS.has(tokens[i])) i++
      if (i < tokens.length) return tokens[i]
    }
  }
  return null
}

const tui: TuiPlugin = async (api) => {
  initI18n(api)
  api.keymap.registerLayer({
    commands: [
      {
        name: "profile.switch",
        title: tr("profile.cmdTitle"),
        desc: tr("profile.cmdDesc"),
        category: "Profile",
        namespace: "palette",
        slashName: "profile",
        run(ctx: unknown) {
          const sub = parseProfileSubcommand(ctx)
          if (sub === "reset") {
            resetModels(api)
            return
          }
          if (sub) {
            api.ui.toast({ title: tr("profile.cmdTitle"), message: tr("profile.unknownSub", { sub }), variant: "warning" })
            return
          }
          startWizard(api)
        },
      },
    ],
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui,
}

export default plugin
