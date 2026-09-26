/// <reference types="bun" />
import type { Context } from "@opencode/plugin/tui/context"
import type { Plugin } from "@opencode/plugin/tui"
import { appKeymapLayer } from "../_keymap-app"

/**
 * Profile Wizard — TUI dialog-based profile switching.
 *
 * v2 migration: promise-based dialogs, async-loop menu levels. The profile
 * data layer (loading, state files, apply/reset logic, catalog merge) lives
 * in `plugins/shared/profile-core` — the single source of truth shared
 * with the CLI wizard; this module owns only the dialog UX. The live apply
 * path changed: v2 has no PATCH-global-config endpoint, so the wizard
 * always writes opencode.jsonc atomically and then asks the server to
 * reload the location so the new refs take effect without a restart.
 *
 * Registered as a CLI-only plugin in `cli.json` (v2 TUI plugin list).
 *
 * Entry points:
 *   /profile                — slash command (opens the picker)
 *   /profile reset          — subcommand: remove every model ref the wizard
 *                             wrote (root model, agents.*.model — legacy
 *                             small_model / agent.*.model too) and
 *                             deactivate the profile (confirm dialog;
 *                             opencode falls back to its model picker)
 *   command palette         — "Switch model profile"
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
 * Every dialog level uses Esc as the only back navigation: an unresolved
 * promise-dialog selection returns to the parent loop one level up. No
 * explicit back items exist in the option lists.
 *
 * Profiles are JSON files in ~/.config/opencode/profiles/ with shape:
 *   { "description": ..., "tiers": { "<tier>": "<provider>/<model_id>" } }
 *
 * Note: this is a TUI-only module. It only runs inside the TUI; headless
 * sessions have no /profile equivalent.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { tr, initI18n, refreshLocale, languageOption, switchLanguage, SWITCH_LANG } from "../i18n"
import {
  CONFIG_FILE,
  readConfig,
  writeConfigAtomic,
  readAuth,
  type OpenCodeConfig,
} from "../../shared/provider-creds"
import {
  agentsRead,
  applyProfile,
  deleteProfile,
  ensureNativeAgents,
  getActiveProfile,
  getCurrentTierMapping,
  loadProfiles,
  loadTierMap,
  markCustomProfile,
  forgetProfileState,
  profileCategory,
  profilePath,
  profileTitle,
  recordRecentProfile,
  setActiveProfile,
  sortedProfileEntries,
  writeProfileAtomic,
  createCustomProfile,
  parseProfileSubcommand as parseProfileSubcommandCore,
  PROFILE_TIERS,
  type Catalog,
  type CatalogModel,
  type CatalogProvider,
  type Profile,
  type ProfileListEntry,
  listModelRefs,
  stripModelRefs,
} from "../../shared/profile-core"

// Test/CLI surface: the reset + apply unit tests import these through the
// wizard module — keep them re-exported from the shared core (single source).
export { applyProfile, listModelRefs, stripModelRefs }
export type { Catalog } from "../../shared/profile-core"

/**
 * Extract the subcommand from the slash command's raw input (v2 passes the
 * trailing prompt text to run(input)). Accepts a string or a legacy ctx
 * object shape (delegated to the shared core parser). Exported for unit tests.
 */
export function parseProfileSubcommand(input: string | unknown): string | null {
  if (typeof input === "string") return parseProfileSubcommandCore({ input })
  return parseProfileSubcommandCore(input)
}

// ─── Plugin-level path constants (tiers.json write is wizard-only) ─────

const CONFIG_DIR = join(homedir(), ".config", "opencode")
const TIERS_FILE = join(CONFIG_DIR, "tiers.json")
const STATE_FILE = join(CONFIG_DIR, ".active-profile")
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

// Live refresh after a config write: v2 has no PATCH-global-config
// endpoint (v1's applyLive client.global.config.update is dead), so the
// flow is "write opencode.jsonc, then ask the server to reload the
// location". Returns false when the reload failed — the user is told a
// restart is required, matching v1's fallback wording.
async function reloadLive(ctx: Context): Promise<boolean> {
  try {
    await ctx.client.location.reload()
    return true
  } catch {
    return false
  }
}

// ─── Provider ranking (picker presentation — wizard-only) ─────────────

const VALID_TIERS = PROFILE_TIERS

interface ProviderConnectionRanks {
  auth: Map<string, number>
  config: Set<string>
}

function providerNameCmp(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
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

// tiers.json write (atomic: backup .bak + tmp + rename) — the read side
// lives in the shared core; this file is the only writer.
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
  ctx: Context,
  message: string,
  variant: "info" | "success" | "warning" | "error" = "info",
) {
  ctx.ui.toast.show({ title: tr("profile.cmdTitle"), message, variant })
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

async function startWizard(ctx: Context): Promise<void> {
  // Cross-window language sync: another window's switch lives only in
  // ocp.json (initI18n ran once behind its `initialized` guard) — re-read
  // the shared config before composing any menu text.
  refreshLocale()

  // Branch results: true = the branch applied/attempted a terminal action
  // and closed the wizard (v1's dialog.clear + toast); false/Esc = the
  // main menu re-presents itself.
  for (;;) {
    // Rebuilt per iteration: an in-wizard switchLanguage updates the
    // module locale directly, so headers must re-run tr() to follow it.
    const selectionCat = tr("profile.selectionHeader")
    const editCat = tr("profile.editHeader")
    const manageCat = tr("profile.manageHeader")
    const actionsCat = tr("profile.actionsHeader")
    const interfaceCat = tr("common.interfaceHeader")
    const active = getActiveProfile()
    const pick = await ctx.ui.dialog.select<string>({
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
        { ...languageOption(), category: interfaceCat },
      ],
    })
    if (pick === undefined) return
    if (pick === SWITCH_LANG) {
      await switchLanguage(ctx)
      continue
    }
    let close = false
    if (pick === EDIT_TIERS) close = await editAgentTier(ctx, loadTierMap(), {})
    else if (pick === EDIT_TIER_MODELS) close = await editTierModels(ctx, {})
    else if (pick === MANAGE_MODELS) await manageProfileModels(ctx)
    else if (pick === SELECT_PROFILE) close = await selectProfile(ctx)
    else if (pick === ADD_PROFILE) await promptAddProfile(ctx)
    else if (pick === RESET_MODELS) close = await resetModels(ctx)
    if (close) return
  }
}

// ════════════════════════════════════════════════════════════════════
// ┌─ Branch 1: Edit: Agent→Tier ───────────────────────────────────────
// ════════════════════════════════════════════════════════════════════

""// Level 2: Agent list (loop until Esc/Apply). Resolves true when Apply
// ran (the wizard closes — v1 clear+toast), false when Esc'd back.
async function editAgentTier(
  ctx: Context,
  tierMap: Record<string, string>,
  changed: Record<string, string>,
): Promise<boolean> {
  let config: OpenCodeConfig
  try {
    config = readConfig(CONFIG_FILE)
  } catch (err) {
    toast(ctx, tr("profile.readConfigFailed", { err: (err as Error).message }), "error")
    return false
  }

  const agents = agentsRead(config)
  if (!agents || Object.keys(agents).length === 0) {
    toast(ctx, tr("profile.noAgents"), "warning")
    return false
  }

  const sorted = Object.keys(agents).sort()

  for (;;) {
    const hasChanges = Object.keys(changed).length > 0
    const pick = await ctx.ui.dialog.select<string>({
      title: hasChanges
        ? tr("profile.editTierTitlePending", { count: Object.keys(changed).length })
        : tr("profile.editTierTitle"),
      placeholder: tr("profile.editTierPlaceholder"),
      // The host select dialog renders `category` as bold accent section
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
    })
    if (pick === undefined) return false // Esc → main menu loop
    if (pick === APPLY) {
      await applyAgentTierChanges(ctx, tierMap, changed)
      return true
    }
    const currentTier = changed[pick] ?? tierMap[pick] ?? agents[pick].tier ?? "standard"
    const newTier = await pickAgentTier(ctx, pick, currentTier)
    if (newTier === undefined) continue
    if (newTier !== currentTier) {
      changed[pick] = newTier
      toast(ctx, tr("profile.tierChanged", { agent: pick, old: currentTier, new: newTier }), "info")
    }
  }
}

// Level 3: Tier picker (per agent) — returns the new tier, or undefined on Esc.
async function pickAgentTier(
  ctx: Context,
  agentName: string,
  currentTier: string,
): Promise<string | undefined> {
  return ctx.ui.dialog.select<string>({
    title: tr("profile.pickTierTitle", { agent: agentName, tier: currentTier }),
    placeholder: tr("profile.pickTierPlaceholder"),
    options: VALID_TIERS.map((t) => ({
      title: t === currentTier ? `${t}  ${tr("common.currentMarker")}` : t,
      value: t,
      description: tierDescription(t),
    })),
  })
}

async function applyAgentTierChanges(
  ctx: Context,
  originalMap: Record<string, string>,
  changed: Record<string, string>,
): Promise<void> {
  const changeCount = Object.keys(changed).length
  if (changeCount === 0) return

  // 1. Build new tier map and write tiers.json
  const newMap: Record<string, string> = { ...originalMap }
  for (const [agent, tier] of Object.entries(changed)) newMap[agent] = tier

  try {
    writeTiersFileAtomic(newMap)
  } catch (err) {
    toast(ctx, tr("profile.writeTiersFailed", { err: (err as Error).message }), "error")
    return
  }

  // 2. Live-apply: rewrite changed agents' models to the new tier's ref
  let config: OpenCodeConfig
  try {
    config = readConfig(CONFIG_FILE)
  } catch (err) {
    toast(ctx, tr("profile.tiersUpdatedConfigFailed", { err: (err as Error).message }), "warning")
    return
  }

  const activeName = getActiveProfile()
  const profiles = loadProfiles()
  const activeProfile = activeName ? profiles.get(activeName) ?? null : null
  const tierModels = getCurrentTierMapping(config, newMap)

  const details: string[] = []
  let appliedCount = 0

  // Native-key write: a legacy `agent` map migrates to `agents` on first
  // touch, so the rewrite always lands where the v2 runtime looks.
  const agents = ensureNativeAgents(config)
  for (const [agentName, newTier] of Object.entries(changed)) {
    const agentEntry = agents[agentName]
    if (!agentEntry) continue
    const ref = activeProfile?.tiers?.[newTier] ?? tierModels[newTier] ?? null
    if (ref) {
      agentEntry.model = ref
      details.push(`${agentName} → ${newTier} (${ref})`)
      appliedCount++
    } else {
      details.push(tr("profile.noModelRef", { agent: agentName, tier: newTier }))
    }
  }

  // 3. Write the config, then attempt a live location reload (v2).
  let live = false
  if (appliedCount > 0) {
    try {
      writeConfigAtomic(CONFIG_FILE, config)
    } catch (err) {
      toast(ctx, tr("profile.writeOpencodeFailed", { err: (err as Error).message }), "error")
      return
    }
    live = await reloadLive(ctx)
  }

  toast(ctx, tr("profile.tierChangesApplied", { count: changeCount, s: changeCount > 1 ? "s" : "", details: details.join("; "), live: live ? tr("profile.liveNoRestart") : tr("profile.restartToApply") }), "success")
}

// ════════════════════════════════════════════════════════════════════
// ┌─ Branch 2: Edit: Tier→Model (live config, no profile) ───────────
// ════════════════════════════════════════════════════════════════════

// Level 2: Tier list with live model refs. Resolves true when Apply ran.
async function editTierModels(ctx: Context, overrides: Record<string, string>): Promise<boolean> {
  let config: OpenCodeConfig
  try {
    config = readConfig(CONFIG_FILE)
  } catch (err) {
    toast(ctx, tr("profile.readConfigFailed", { err: (err as Error).message }), "error")
    return false
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
    toast(ctx, tr("profile.noTierModels"), "warning")
    return false
  }

  for (;;) {
    const hasChanges = Object.keys(overrides).length > 0
    const pick = await ctx.ui.dialog.select<string>({
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
    })
    if (pick === undefined) return false // Esc → main menu
    if (pick === APPLY) {
      await applyTierModelChanges(ctx, overrides)
      return true
    }
    const tier = pick.slice(TIER_PREFIX.length)
    await pickLiveTierProvider(ctx, overrides, tier)
  }
}

// Level 3: Provider picker (live tier edit)
async function pickLiveTierProvider(
  ctx: Context,
  overrides: Record<string, string>,
  tier: string,
): Promise<void> {
  const catalog = await loadCatalog(ctx)
  const connected = connectedProviderRanks()
  const ids = sortedProviderIds(catalog)
  if (ids.length === 0) {
    await promptLiveTierRef(ctx, overrides, tier)
    return
  }

  const pick = await ctx.ui.dialog.select<string>({
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
  })
  if (pick === undefined) return // Esc → tier list loop resumes
  if (pick === TYPE_CUSTOM) {
    await promptLiveTierRef(ctx, overrides, tier)
    return
  }
  const provider = catalog[pick]
  if (!provider) return
  const model = await pickLiveTierModel(ctx, tier, pick, provider.models)
  if (model === undefined) return
  overrides[tier] = `${pick}/${model}`
  toast(ctx, tr("profile.liveTierModelChanged", { tier, provider: pick, model }), "info")
}

// Level 4: Model picker (live tier edit) — returns the chosen key.
async function pickLiveTierModel(
  ctx: Context,
  tier: string,
  providerId: string,
  models: Record<string, CatalogModel>,
): Promise<string | undefined> {
  const entries = Object.entries(models)
  return ctx.ui.dialog.select<string>({
    title: tr("profile.pickTierModelModelTitle", { tier, provider: providerId }),
    placeholder: tr("profile.pickModelPlaceholder", { count: entries.length }),
    options: entries.map(([key, m]) => ({
      title: key,
      value: key,
      description: m.name && m.name !== key ? m.name : undefined,
    })),
  })
}

// Manual entry fallback (live tier edit)
async function promptLiveTierRef(
  ctx: Context,
  overrides: Record<string, string>,
  tier: string,
): Promise<void> {
  const current = overrides[tier] ?? ""
  const value = await ctx.ui.dialog.prompt({
    title: tr("profile.promptTierModelRefTitle", { tier }),
    placeholder: tr("profile.promptTierRefPlaceholder"),
    value: current,
  })
  if (value === undefined) return // Esc → tier list loop
  const v = value.trim()
  if (v && v !== current) {
    if (!v.includes("/") || v.startsWith("/") || v.endsWith("/")) {
      toast(ctx, tr("profile.invalidRef", { ref: v }), "error")
    } else {
      overrides[tier] = v
      toast(ctx, tr("profile.liveTierModelChanged", { tier, provider: v.split("/")[0] ?? "", model: v.split("/")[1] ?? v }), "info")
    }
  }
}

// Apply live tier→model changes: rewrite opencode.jsonc agent models per
// tier (root model tracks standard), then sync the active profile file
// when present so a later profile re-apply does not revert the change.
async function applyTierModelChanges(
  ctx: Context,
  overrides: Record<string, string>,
): Promise<void> {
  const changeCount = Object.keys(overrides).length
  if (changeCount === 0) return

  let config: OpenCodeConfig
  try {
    config = readConfig(CONFIG_FILE)
  } catch (err) {
    toast(ctx, tr("profile.readConfigFailed", { err: (err as Error).message }), "error")
    return
  }

  const tierMap = loadTierMap()
  const tiersInUse = new Set(Object.values(tierMap))
  const merged: Record<string, string> = {}
  for (const [tier, ref] of Object.entries({ ...getCurrentTierMapping(config, tierMap), ...overrides })) {
    // Tiers no agent uses yet have nowhere to land in the live config;
    // they persist via the active-profile sync below instead.
    if (tiersInUse.has(tier)) merged[tier] = ref
  }
  if (Object.keys(merged).length === 0) {
    toast(ctx, tr("profile.noTierModels"), "warning")
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
    const { updated, details } = applyProfile(config, { tiers: merged }, tierMap)
    writeConfigAtomic(CONFIG_FILE, config)
    const live = await reloadLive(ctx)
    toast(
      ctx,
      tr("profile.tierModelsApplied", { count: updated, details: details.join("; "), live: live ? tr("profile.liveNoRestart") : tr("profile.restartToApply") }),
      "success",
    )
  } catch (err) {
    toast(ctx, tr("profile.applyFailed", { name: "tier→model", err: (err as Error).message }), "error")
  }
}

// ════════════════════════════════════════════════════════════════════
// ┌─ Branch 3: Manage: Profile→Models ─────────────────────────────────
// ════════════════════════════════════════════════════════════════════

// Level 2: Profile list (for managing models)
async function manageProfileModels(ctx: Context): Promise<void> {
  for (;;) {
    const profiles = loadProfiles()
    const sorted = sortedProfileEntries(profiles)
    const pick = await ctx.ui.dialog.select<string>({
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
    })
    if (pick === undefined) return // Esc → main menu
    if (pick === ADD_PROFILE) {
      await promptAddProfile(ctx)
      continue
    }
    const profile = profiles.get(pick)
    if (!profile) {
      toast(ctx, tr("profile.profileVanished", { name: pick }), "error")
      continue
    }
    await reviewProfileTiers(ctx, pick, profile)
  }
}

// Level 3: Tier review (per profile — edit tier→model, then Apply/Cancel)
async function reviewProfileTiers(
  ctx: Context,
  name: string,
  profile: Profile,
): Promise<void> {
  // Edits accumulate in memory for the lifetime of this review screen.
  const overrides: Record<string, string> = {}
  for (;;) {
    // Recompute the working profile with pending overrides so rows show the live values.
    const effective: Profile = { ...profile, tiers: { ...profile.tiers, ...overrides } }
    const pick = await ctx.ui.dialog.select<string>({
      title: tr("profile.reviewTiersTitle", { name }),
      placeholder: tr("profile.reviewTiersPlaceholder"),
      options: [
        ...Object.entries(effective.tiers).map(([tier, ref]) => ({
          title: tier,
          value: `${TIER_PREFIX}${tier}`,
          description:
            overrides[tier] !== undefined
              ? tr("profile.customized", { override: overrides[tier], ref: profile.tiers[tier] })
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
    })
    if (pick === undefined || pick === CANCEL) return // back to the profile list
    if (pick === APPLY) {
      await applyProfileModelChanges(ctx, name, profile, overrides)
      return
    }
    if (pick === DELETE_PROFILE) {
      const confirmed = await ctx.ui.dialog.confirm({
        title: tr("profile.deleteProfileTitle"),
        message: tr("profile.confirmDeleteMsg", { name, path: profilePath(name) }),
      })
      if (confirmed === true) {
        try {
          deleteProfile(name)
          forgetProfileState(name)
          toast(ctx, tr("profile.profileDeleted", { name }), "success")
        } catch (err) {
          toast(ctx, tr("profile.deleteFailed", { err: (err as Error).message }), "error")
        }
        return
      }
      continue
    }
    const tier = pick.slice(TIER_PREFIX.length)
    if (!(tier in effective.tiers)) continue
    await pickProviderForTier(ctx, name, effective.tiers[tier] ?? "", overrides, tier)
  }
}

// Level 4: Provider picker (profile tier edit)
async function pickProviderForTier(
  ctx: Context,
  name: string,
  currentRef: string,
  overrides: Record<string, string>,
  tier: string,
): Promise<void> {
  const catalog = await loadCatalog(ctx)
  const connected = connectedProviderRanks()
  const ids = sortedProviderIds(catalog)
  if (ids.length === 0) {
    await promptTierRef(ctx, name, currentRef, overrides, tier)
    return
  }
  const pick = await ctx.ui.dialog.select<string>({
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
  })
  if (pick === undefined) return
  if (pick === TYPE_CUSTOM) {
    await promptTierRef(ctx, name, currentRef, overrides, tier)
    return
  }
  const provider = catalog[pick]
  if (!provider) return
  const entries = Object.entries(provider.models)
  const model = await ctx.ui.dialog.select<string>({
    title: tr("profile.pickModelTitle", { name, tier, provider: pick }),
    placeholder: tr("profile.pickModelPlaceholder", { count: entries.length }),
    options: entries.map(([key, m]) => ({
      title: key,
      value: key,
      description: m.name && m.name !== key ? m.name : undefined,
    })),
  })
  if (model === undefined) return
  overrides[tier] = `${pick}/${model}`
  toast(ctx, tr("profile.modelChanged", { name, tier, provider: pick, model }), "info")
}

// Manual entry fallback for providers missing from every catalog source.
async function promptTierRef(
  ctx: Context,
  name: string,
  currentRef: string,
  overrides: Record<string, string>,
  tier: string,
): Promise<void> {
  const value = await ctx.ui.dialog.prompt({
    title: tr("profile.promptTierRefTitle", { name, tier }),
    placeholder: tr("profile.promptTierRefPlaceholder"),
    value: overrides[tier] ?? currentRef,
  })
  if (value === undefined) return
  const v = value.trim()
  if (v && v !== currentRef) {
    if (!v.includes("/") || v.startsWith("/") || v.endsWith("/")) {
      toast(ctx, tr("profile.invalidRef", { ref: v }), "error")
    } else {
      overrides[tier] = v
      toast(ctx, tr("profile.modelChanged", { name, tier, provider: v.split("/")[0] ?? "", model: v.split("/")[1] ?? v }), "info")
    }
  }
}

// Apply profile model changes: write profile JSON, then apply to opencode.jsonc
async function applyProfileModelChanges(
  ctx: Context,
  name: string,
  profile: Profile,
  overrides: Record<string, string>,
): Promise<void> {
  const hasOverrides = Object.keys(overrides).length > 0
  if (!hasOverrides) return

  // Build updated profile
  const updatedProfile: Profile = {
    ...profile,
    tiers: { ...profile.tiers, ...overrides },
  }

  // Write profile JSON atomically
  try {
    writeProfileAtomic(name, updatedProfile)
  } catch (err) {
    toast(ctx, tr("profile.writeProfileFailed", { name, err: (err as Error).message }), "error")
    return
  }

  // Apply the profile to opencode.jsonc (rewrite agent models per tier)
  try {
    const config = readConfig(CONFIG_FILE)
    const { updated, details } = applyProfile(config, updatedProfile, loadTierMap())
    writeConfigAtomic(CONFIG_FILE, config)
    const live = await reloadLive(ctx)
    setActiveProfile(name)
    recordRecentProfile(name)
    toast(
      ctx,
      tr("profile.profileUpdatedApplied", { name, updated, details: details.join("; "), live: live ? tr("profile.liveNoRestart") : tr("profile.restartToApply2") }),
      "success",
    )
  } catch (err) {
    toast(ctx, tr("profile.profileSavedApplyFailed", { err: (err as Error).message }), "warning")
  }
}

// ─── Add / Delete profile ────────────────────────────────────────────

// Add a profile: prompt for the name, create a blank five-tier profile,
// and jump straight into its tier review. The caller's loop re-presents
// itself when this returns.
async function promptAddProfile(ctx: Context): Promise<void> {
  for (;;) {
    const value = await ctx.ui.dialog.prompt({
      title: tr("profile.addProfileTitle"),
      placeholder: tr("profile.addProfilePlaceholder"),
    })
    if (value === undefined) return // Esc
    const name = value.trim()
    if (!name) return
    if (existsSync(profilePath(name))) {
      toast(ctx, tr("profile.profileExists", { name }), "error")
      continue
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
      toast(ctx, tr("profile.profileCreated", { name }), "success")
      await reviewProfileTiers(ctx, name, blankProfile)
      return
    } catch (err) {
      toast(ctx, tr("profile.createProfileFailed", { err: (err as Error).message }), "error")
      return
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// ┌─ Branch 4: Select: Profile — pick, review mapping, confirm & apply ─
// ════════════════════════════════════════════════════════════════════

async function selectProfile(ctx: Context): Promise<boolean> {
  const profiles = loadProfiles()
  if (profiles.size === 0) {
    toast(ctx, tr("profile.noProfiles", { dir: PROFILES_DIR }), "warning")
    return false
  }

  const sorted = sortedProfileEntries(profiles)

  for (;;) {
    const pick = await ctx.ui.dialog.select<string>({
      title: tr("profile.selectTitle"),
      placeholder: tr("profile.selectPlaceholder"),
      options: sorted.map((entry) => ({
        title: profileTitle(entry),
        value: entry.name,
        description: entry.profile.description?.slice(0, 100),
        category: profileCategory(entry),
      })),
    })
    if (pick === undefined) return false // Esc → main menu
    const profile = profiles.get(pick)
    if (!profile) {
      toast(ctx, tr("profile.profileVanished", { name: pick }), "error")
      continue
    }
    // Confirmation gate: show the profile's full tier→model mapping in a
    // confirm dialog (message = preview), so the user can cancel instead
    // of applying blind.
    const mapping = Object.entries(profile.tiers)
      .map(([tier, ref]) => `  ${tier} → ${ref || tr("common.unset")}`)
      .join("\n")
    const confirmed = await ctx.ui.dialog.confirm({
      title: tr("profile.confirmApplyTitle", { name: pick }),
      message: tr("profile.confirmApplyMsg", { mapping }),
    })
    if (confirmed === true) {
      await applySelection(ctx, pick, profile)
      return true
    }
  }
}

async function applySelection(
  ctx: Context,
  name: string,
  profile: Profile,
): Promise<void> {
  try {
    const config = readConfig(CONFIG_FILE)
    const { updated, details } = applyProfile(config, profile, loadTierMap())
    writeConfigAtomic(CONFIG_FILE, config)
    const live = await reloadLive(ctx)
    setActiveProfile(name)
    recordRecentProfile(name)
    toast(
      ctx,
      tr("profile.switchedTo", { name, updated, details: details.join("; "), live: live ? tr("profile.appliedLive") : tr("profile.restartToApply2") }),
      "success",
    )
  } catch (err) {
    toast(ctx, tr("profile.applyFailed", { name, err: (err as Error).message }), "error")
  }
}

// ════════════════════════════════════════════════════════════════════
// ┌─ Branch 5: Reset: Model refs ──────────────────────────────────────
// ════════════════════════════════════════════════════════════════════

async function resetModels(ctx: Context): Promise<boolean> {
  let config: OpenCodeConfig
  try {
    config = readConfig(CONFIG_FILE)
  } catch (err) {
    toast(ctx, tr("profile.readConfigFailed", { err: (err as Error).message }), "error")
    return false
  }
  const refs = listModelRefs(config)
  if (refs.length === 0) {
    toast(ctx, tr("profile.resetNothing"), "info")
    return false
  }
  // Destructive — the message lists exactly what will be removed and what
  // is kept, so "reset" cannot be misread as restore-defaults.
  const confirmed = await ctx.ui.dialog.confirm({
    title: tr("profile.resetTitle"),
    message: tr("profile.resetMsg", { refs: refs.map((r) => `  ${r}`).join("\n") }),
  })
  if (confirmed !== true) return false
  // File rewrite only — a merge PATCH cannot delete keys, so the reload
  // only refreshes what was written (writeConfigAtomic keeps a .bak).
  try {
    const removed = stripModelRefs(config)
    writeConfigAtomic(CONFIG_FILE, config)
    // Deactivate the profile so the sidebar badge clears too.
    if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE)
    await reloadLive(ctx)
    toast(ctx, tr("profile.resetDone", { count: removed }), "success")
  } catch (err) {
    toast(ctx, tr("profile.resetFailed", { err: (err as Error).message }), "error")
  }
  return true
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

// The server catalog is fetched once per wizard generation (v1 memoized
// for the session's lifetime because providers registered at startup;
// v2 exposes provider/model data through the reactive cache — sync once,
// then read the merged snapshot). Only the cheap config-file merge
// re-runs per call so models added via /provider still show up without a
// restart. Keeps provider/model pickers snappy on every entry and on
// Esc-back navigation.
let serverCatalogPromise: Promise<Catalog> | null = null
function serverCatalog(ctx: Context): Promise<Catalog> {
  serverCatalogPromise ??= (async () => {
    const catalog: Catalog = {}
    try {
      const location = ctx.location
      await Promise.all([
        ctx.data.location.provider.sync(location),
        ctx.data.location.model.sync(location),
      ])
      const providers = ctx.data.location.provider.list(location) ?? []
      for (const p of providers) catalog[p.id] = { name: p.name, models: {} }
      const models = ctx.data.location.model.list(location) ?? []
      for (const m of models) {
        const entry = catalog[m.providerID]
        if (!entry) continue
        entry.models[m.modelID] = { name: m.name, status: m.status }
      }
      for (const [id, entry] of Object.entries(catalog)) {
        if (Object.keys(entry.models).length === 0) delete catalog[id]
      }
    } catch {
      // fall through to the config-file catalog
    }
    return catalog
  })()
  return serverCatalogPromise
}

async function loadCatalog(ctx: Context): Promise<Catalog> {
  const catalog: Catalog = { ...(await serverCatalog(ctx)) }

  // Merge the opencode.jsonc definitions on top: models added via
  // /provider after launch are missing from the server catalog until
  // reload, so they must not be shadowed by it.
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

const plugin: Plugin.Definition = {
  id: PLUGIN_ID,
  setup(ctx: Context) {
    initI18n()
    appKeymapLayer(ctx, () => ({
      mode: "global",
      commands: [
        {
          id: "profile.switch",
          title: tr("profile.cmdTitle"),
          description: tr("profile.cmdDesc"),
          group: "Profile",
          palette: true,
          slash: { name: "profile" },
          run(input?: string) {
            const sub = parseProfileSubcommand(input)
            if (sub === "reset") {
              void resetModels(ctx)
              return
            }
            if (sub) {
              ctx.ui.toast.show({ title: tr("profile.cmdTitle"), message: tr("profile.unknownSub", { sub }), variant: "warning" })
              return
            }
            void startWizard(ctx)
          },
        },
      ],
    }))
  },
}

export default plugin
