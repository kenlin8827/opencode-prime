/**
 * Shared i18n module for all TUI wizard plugins.
 *
 * Centralizes locale detection, storage, and all translation strings
 * for profile-wizard, provider-wizard, queue-manager,
 * and usage. The standalone OpenTUI host (`ocp provider|profile`) loads
 * the same wizard plugins through a TuiPluginApi-compatible adapter.
 *
 * The chosen language is persisted as the "language" key of the shared
 * user config (~/.config/opencode/ocp.jsonc, via plugins/shared/ocp-config).
 * A legacy api.kv value is migrated on first init.
 *
 * Usage in plugins:
 *   import { initI18n, tr, registerLangCommand } from "./i18n"
 *   // in plugin entry: initI18n(api); registerLangCommand(api)
 *   // in dialog code:  tr("profile.mainTitle")
 */

import type { TuiPluginApi, TuiDialogSelectOption } from "@opencode-ai/plugin/tui"
import { readOcpField, writeOcpField } from "../shared/ocp-config"

// ─── Types ───────────────────────────────────────────────────────────

export type Locale = string

interface LocaleMeta {
  code: Locale
  /** Native display name shown in the language menu. */
  name: string
  /** Matched against LANG/LC_ALL/Intl locale/timezone for auto-detection. */
  match?: RegExp
}

/**
 * Locale registry (menu order). "en" is the mandatory fallback locale.
 * To add a language: register it here and fill its entries in STRINGS;
 * detection, persistence, switching and menus pick it up automatically.
 */
const LOCALES: readonly LocaleMeta[] = [
  { code: "en", name: "English" },
  { code: "zh-CN", name: "中文", match: /zh|cn|hans|shanghai|chongqing|urumqi|harbin|beijing|prc|taipei|hong_kong/i },
]

const FALLBACK_LOCALE: Locale = "en"

/**
 * Convenience alias for dialog option objects used by all wizards.
 */
export type DialogOption<V = string> = TuiDialogSelectOption<V>

type StringEntry = Partial<Record<Locale, string>> & { en: string }

// ─── Locale state ────────────────────────────────────────────────────

let currentLocale: Locale = "en"

export function getLocale(): Locale {
  return currentLocale
}

function isRegistered(code: unknown): code is Locale {
  return typeof code === "string" && LOCALES.some((l) => l.code === code)
}

function detectLocale(): Locale {
  const probes = [
    process.env.LANG || "",
    process.env.LC_ALL || "",
    process.env.LANGUAGE || "",
  ]
  try {
    const opts = Intl.DateTimeFormat().resolvedOptions()
    probes.push(opts.locale, opts.timeZone)
  } catch { /* ignore */ }
  const haystack = probes.join(" ")
  for (const l of LOCALES) {
    if (l.code !== FALLBACK_LOCALE && l.match?.test(haystack)) return l.code
  }
  return FALLBACK_LOCALE
}

/** "language" key in the shared user config (~/.config/opencode/ocp.jsonc). */
const CONFIG_KEY = "language"
/** Pre-ocp-config storage; read once for migration, no longer written. */
const LEGACY_KV_KEY = "opencode.locale"

let initialized = false

export function initI18n(api: TuiPluginApi): void {
  // Guard against repeated calls from multiple plugins —
  // only the first call performs detection & persistence.
  if (initialized) return
  initialized = true

  const fromFile = readOcpField<Locale>(CONFIG_KEY)
  if (isRegistered(fromFile)) {
    currentLocale = fromFile
    return
  }
  // Legacy migration: an api.kv choice made before ocp.jsonc existed.
  const legacy = api.kv?.get<Locale>(LEGACY_KV_KEY)
  if (isRegistered(legacy)) {
    currentLocale = legacy
    writeOcpField(CONFIG_KEY, currentLocale)
    return
  }
  // Env detection is not a user choice — don't persist it.
  currentLocale = detectLocale()
}

/** Initialize translations without the TUI API (used by headless CLI commands). */
export function initI18nHeadless(): void {
  if (initialized) return
  initialized = true
  const saved = readOcpField<Locale>(CONFIG_KEY)
  currentLocale = isRegistered(saved) ? saved : detectLocale()
}

/**
 * Re-resolve the locale from the shared user config (falling back to
 * environment detection). Server-side plugin processes do not share the
 * TUI's in-memory state, so user-visible command/announce text calls this
 * right before composing output — a `/lang` switch taken in the TUI is
 * picked up by the next guard command without a restart. Cost: one small
 * JSONC read per command invocation.
 */
export function refreshLocale(): Locale {
  initialized = true
  const saved = readOcpField<Locale>(CONFIG_KEY)
  currentLocale = isRegistered(saved) ? saved : detectLocale()
  return currentLocale
}

export function setLocale(api: TuiPluginApi, locale: Locale): void {
  currentLocale = locale
  // Keep the in-memory value even if the file write fails (read-only home).
  writeOcpField(CONFIG_KEY, locale)
}

/** Locale the menu switch would move to (cycles through the registry). */
export function nextLocale(): Locale {
  const idx = LOCALES.findIndex((l) => l.code === currentLocale)
  return LOCALES[(idx + 1) % LOCALES.length].code
}

export function toggleLocale(api: TuiPluginApi): Locale {
  const next = nextLocale()
  setLocale(api, next)
  return next
}

export function localeName(locale: Locale): string {
  return LOCALES.find((l) => l.code === locale)?.name ?? locale
}

// ─── Translation table ──────────────────────────────────────────────
// Keys are namespaced: "common.xxx", "profile.xxx", "provider.xxx",
// "project.xxx", "queue.xxx", "usage.xxx".  Placeholders use {name} syntax.

const STRINGS = {
  // ════════════════════════════════════════════════════════════════
  // ── Common (shared across all wizards) ───────────────────────────
  // ════════════════════════════════════════════════════════════════
  "common.cancel": { en: "❌ Cancel", "zh-CN": "❌ 取消" },
  "common.applyChanges": { en: "✅ Apply", "zh-CN": "✅ 应用" },
  "common.activeMarker": { en: "← active", "zh-CN": "← 当前" },
  "common.currentMarker": { en: "← current", "zh-CN": "← 当前" },
  "common.addedMarker": { en: "added", "zh-CN": "已添加" },
  "common.unset": { en: "(unset)", "zh-CN": "(未设置)" },
  "common.config": { en: "config", "zh-CN": "配置" },
  "common.builtin": { en: "built-in", "zh-CN": "内置" },
  "common.connected": { en: "connected", "zh-CN": "已连接" },
  "common.modelCount": { en: "{count} model(s)", "zh-CN": "{count} 个模型" },
  "common.langTitle": { en: "Switch language", "zh-CN": "切换语言" },
  "common.langDesc": { en: "Switch interface language", "zh-CN": "切换界面语言" },
  "common.langPickPlaceholder": { en: "Select language (Esc cancels)", "zh-CN": "选择语言 (Esc 取消)" },
  "common.langSwitched": { en: "Language switched to {lang}", "zh-CN": "语言已切换为 {lang}" },
  "common.interfaceHeader": { en: "Interface", "zh-CN": "界面" },
  "common.working": { en: "Working…", "zh-CN": "处理中…" },

  // ════════════════════════════════════════════════════════════════
  // ── Profile wizard ──────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════
  "profile.cmdTitle": { en: "Switch model profile", "zh-CN": "切换配置方案" },
  "profile.cmdDesc": { en: "Select a profile, edit agent tiers or live tier models, or manage profile models — /profile reset clears all model refs", "zh-CN": "选择配置方案，编辑 Agent 的模型层级或当前层级的模型，或管理配置方案的模型 — /profile reset 清空所有模型引用" },
  "profile.cli.noProfiles": { en: "No profiles found.", "zh-CN": "未找到配置方案。" },
  "profile.cli.usage": { en: "Usage: ocp profile [list|apply <name>|reset]", "zh-CN": "用法：ocp profile [list|apply <名称>|reset]" },
  "profile.cli.applied": { en: "Applied profile '{name}'.", "zh-CN": "已应用配置方案“{name}”。" },
  "profile.cli.nothing": { en: "Nothing to change.", "zh-CN": "没有需要变更的内容。" },

  // Main menu
  "profile.mainTitle": { en: "Profile wizard", "zh-CN": "配置方案向导" },
  "profile.agentsHeader": { en: "Agents", "zh-CN": "Agents" },
  "profile.tiersHeader": { en: "Tiers", "zh-CN": "模型层级" },
  "profile.selectionHeader": { en: "Selection", "zh-CN": "选择" },
  "profile.editHeader": { en: "Edit", "zh-CN": "编辑" },
  "profile.manageHeader": { en: "Manage", "zh-CN": "管理" },
  "profile.providersHeader": { en: "Providers", "zh-CN": "服务商" },
  "profile.connectedProvidersHeader": { en: "✅ Connected providers", "zh-CN": "✅ 已连接服务商" },
  "profile.profilesHeader": { en: "Profiles", "zh-CN": "配置方案" },
  "profile.activeProfilesHeader": { en: "⭐ Active", "zh-CN": "⭐ 当前" },
  "profile.customProfilesHeader": { en: "🧩 Custom profiles", "zh-CN": "🧩 自定义配置方案" },
  "profile.recentProfilesHeader": { en: "🕘 Recent presets", "zh-CN": "🕘 最近使用的预设" },
  "profile.presetProfilesHeader": { en: "📦 {group}", "zh-CN": "📦 {group}" },
  "profile.actionsHeader": { en: "Actions", "zh-CN": "操作" },
  "profile.mainPlaceholder": { en: "Pick an action (Esc: close)", "zh-CN": "选择一个操作 (Esc: 关闭)" },
  "profile.editAgentTier": { en: "🤖 Edit: Agent→Tier", "zh-CN": "🤖 编辑: Agent→模型层级" },
  "profile.editAgentTierDesc": { en: "Reassign which tier (flash/standard/pro/max/vision) each agent uses", "zh-CN": "重新分配每个 Agent 所属的模型层级 (flash/standard/pro/max/vision)" },
  "profile.editTierModels": { en: "⚙️ Edit: Tier→Model", "zh-CN": "⚙️ 编辑: 模型层级→模型" },
  "profile.editTierModelsDesc": { en: "Change the live tier→model mapping directly, without going through a profile", "zh-CN": "直接修改当前生效的 模型层级→模型 映射，无需经过配置方案" },
  "profile.manageModels": { en: "🗂️ Manage: Profile→Models", "zh-CN": "🗂️ 管理: 配置方案→模型" },
  "profile.manageModelsDesc": { en: "Edit a profile's tier→model mapping, or add/delete profiles", "zh-CN": "编辑配置方案的 模型层级→模型 映射，或添加/删除配置方案" },
  "profile.selectProfile": { en: "🎯 Select: Profile", "zh-CN": "🎯 选择: 配置方案" },
  "profile.selectProfileActive": { en: "🎯 Select: Profile (active: {active})", "zh-CN": "🎯 选择: 配置方案 (当前: {active})" },
  "profile.selectProfileDesc": { en: "Pick a profile, review its mapping, then apply", "zh-CN": "选一个配置方案，确认映射后再应用" },
  "profile.resetModels": { en: "🧹 Reset: Model refs", "zh-CN": "🧹 重置: 模型引用" },
  "profile.resetModelsDesc": { en: "Remove every model ref from opencode.jsonc — opencode falls back to its model picker (asks for confirmation)", "zh-CN": "移除 opencode.jsonc 中所有模型引用 — opencode 回落到原生模型选择器（执行前需确认）" },
  "profile.resetTitle": { en: "Reset model refs", "zh-CN": "重置模型引用" },
  "profile.resetMsg": { en: "Remove ALL model refs from opencode.jsonc?\n\n{refs}\n\nProfile files and tiers.json are kept; a .bak backup of the config is kept. opencode falls back to its native model picker.", "zh-CN": "移除 opencode.jsonc 中的全部模型引用？\n\n{refs}\n\n配置方案文件与 tiers.json 保留；配置会保留 .bak 备份。opencode 将回落到原生模型选择器。" },
  "profile.resetNothing": { en: "Nothing to reset — no model refs in the config.", "zh-CN": "无需重置 — 配置中没有模型引用。" },
  "profile.resetDone": { en: "Removed {count} model ref(s). Restart opencode to apply.", "zh-CN": "已移除 {count} 个模型引用。重启 opencode 后生效。" },
  "profile.resetFailed": { en: "Reset failed: {err}", "zh-CN": "重置失败: {err}" },
  "profile.unknownSub": { en: "Unknown subcommand '{sub}'. Usage: /profile [reset]", "zh-CN": "未知子命令 '{sub}'。用法: /profile [reset]" },
  "provider.cli.usage": { en: "Usage: ocp provider [list]", "zh-CN": "用法：ocp provider [list]" },
  "provider.cli.noProviders": { en: "No providers configured.", "zh-CN": "未配置服务商。" },
  "tuiHost.interactiveRequired": { en: "This command requires an interactive terminal. Use provider list, profile list, profile apply <name>, or profile reset --yes.", "zh-CN": "此命令需要交互式终端。请使用 provider list、profile list、profile apply <名称> 或 profile reset --yes。" },

  // Edit: Agent→Tier
  "profile.editTierTitle": { en: "Edit agent→tier", "zh-CN": "编辑 Agent→模型层级" },
  "profile.editTierTitlePending": { en: "Edit agent→tier ({count} pending)", "zh-CN": "编辑 Agent→模型层级 ({count} 个待应用)" },
  "profile.editTierPlaceholder": { en: "Pick an agent to reassign its tier (Esc: back)", "zh-CN": "选择 Agent 重新分配模型层级 (Esc: 返回)" },
  "profile.applyChangesDesc": { en: "Write {count} change{s} to tiers.json and apply live", "zh-CN": "将 {count} 个变更写入 tiers.json 并热生效" },
  "profile.tierModelDesc": { en: "Tier: {tier} — model: {model}", "zh-CN": "模型层级: {tier} — 模型: {model}" },
  "profile.pickTierTitle": { en: "Set tier for '{agent}' (current: {tier})", "zh-CN": "设置 '{agent}' 的模型层级 (当前: {tier})" },
  "profile.pickTierPlaceholder": { en: "Pick a tier (Esc: back)", "zh-CN": "选择模型层级 (Esc: 返回)" },
  "profile.tierChanged": { en: "{agent}: {old} → {new} (pending)", "zh-CN": "{agent}: {old} → {new} (待应用)" },
  "profile.writeTiersFailed": { en: "Failed to write tiers.json: {err}", "zh-CN": "写入 tiers.json 失败: {err}" },
  "profile.readConfigFailed": { en: "Cannot read the opencode config: {err}", "zh-CN": "无法读取 opencode 配置: {err}" },
  "profile.noAgents": { en: "No agents found in the config.", "zh-CN": "配置中未找到 Agent。" },
  "profile.tiersUpdatedConfigFailed": { en: "tiers.json updated, but cannot read the opencode config: {err}. Restart or run /profile to apply.", "zh-CN": "tiers.json 已更新，但无法读取 opencode 配置: {err}。重启或运行 /profile 来应用。" },
  "profile.noModelRef": { en: "{agent} → {tier} (no model ref — set via /profile)", "zh-CN": "{agent} → {tier} (无模型引用 — 通过 /profile 设置)" },
  "profile.writeOpencodeFailed": { en: "tiers.json updated, but failed to write the opencode config: {err}. Restart or run /profile.", "zh-CN": "tiers.json 已更新，但写入 opencode 配置失败: {err}。重启或运行 /profile。" },
  "profile.tierChangesApplied": { en: "{count} tier change{s} applied — {details}. {live}", "zh-CN": "{count} 个模型层级变更已应用 — {details}。{live}" },
  "profile.liveNoRestart": { en: "Live, no restart needed.", "zh-CN": "已热生效，无需重启。" },
  "profile.restartToApply": { en: "Restart to apply.", "zh-CN": "重启后生效。" },

  // Edit: Tier→Model (live config, no profile)
  "profile.editTierModelsTitle": { en: "Edit tier→model (live)", "zh-CN": "编辑 模型层级→模型（当前生效）" },
  "profile.editTierModelsTitlePending": { en: "Edit tier→model (live) ({count} pending)", "zh-CN": "编辑 模型层级→模型（当前生效）({count} 个待应用)" },
  "profile.editTierModelsPlaceholder": { en: "Pick a tier to change its model (Esc: back)", "zh-CN": "选择模型层级修改其模型 (Esc: 返回)" },
  "profile.applyTierModelsDesc": { en: "Apply {count} model change{s} to the live config", "zh-CN": "将 {count} 个模型变更热应用到当前配置" },
  "profile.noTierModels": { en: "No tier mapping found — agents have no models in the config.", "zh-CN": "未找到模型层级映射 — 配置中 Agent 没有模型。" },
  "profile.pickTierModelProviderTitle": { en: "tier.{tier} → provider", "zh-CN": "模型层级 {tier} → 服务商" },
  "profile.pickTierModelModelTitle": { en: "tier.{tier} → model on {provider}", "zh-CN": "模型层级 {tier} → {provider} 上的模型" },
  "profile.promptTierModelRefTitle": { en: "tier.{tier} — custom ref", "zh-CN": "模型层级 {tier} — 手动输入引用" },
  "profile.liveTierModelChanged": { en: "tier.{tier} → {provider}/{model} (pending)", "zh-CN": "模型层级 {tier} → {provider}/{model} (待应用)" },
  "profile.tierModelsApplied": { en: "{count} model change{s} applied — {details}. {live}", "zh-CN": "{count} 个模型变更已应用 — {details}。{live}" },

  // Manage: Profile→Models
  "profile.manageTitle": { en: "Manage: Profile→Models", "zh-CN": "管理: 配置方案→模型" },
  "profile.managePlaceholder": { en: "Pick a profile to edit its tier→model mapping (Esc: back)", "zh-CN": "选择配置方案编辑其 模型层级→模型 映射 (Esc: 返回)" },
  "profile.addProfile": { en: "➕ Add: Profile", "zh-CN": "➕ 添加: 配置方案" },
  "profile.addProfileDesc": { en: "Create a new blank profile JSON in ~/.config/opencode/profiles/", "zh-CN": "在 ~/.config/opencode/profiles/ 创建空白配置方案 JSON" },
  "profile.deleteProfile": { en: "🗑️ Delete", "zh-CN": "🗑️ 删除" },
  "profile.deleteProfileDesc": { en: "Delete this profile's JSON file (asks for confirmation)", "zh-CN": "删除此配置方案的 JSON 文件（删除前需确认）" },
  "profile.reviewTiersTitle": { en: "{name} — review tiers", "zh-CN": "{name} — 审阅模型层级" },
  "profile.reviewTiersPlaceholder": { en: "Pick a tier to change its model (provider → model), or apply (Esc: back)", "zh-CN": "选择模型层级修改其模型 (服务商 → 模型)，或应用 (Esc: 返回)" },
  "profile.applyChangesModelDesc": { en: "Write the mapping below to the profile JSON and apply", "zh-CN": "将以下映射写入配置方案 JSON 并应用" },
  "profile.cancelDiscard": { en: "Discard overrides and return to profile list", "zh-CN": "丢弃覆写，返回配置方案列表" },
  "profile.pickProviderTitle": { en: "{name} — tier.{tier} → provider", "zh-CN": "{name} — 模型层级 {tier} → 服务商" },
  "profile.pickProviderPlaceholder": { en: "Pick a provider (Esc: back)", "zh-CN": "选择服务商 (Esc: 返回)" },
  "profile.typeCustomRef": { en: "( Type a custom ref )", "zh-CN": "( 手动输入引用 )" },
  "profile.typeCustomRefDesc": { en: "For providers not listed above", "zh-CN": "用于未列出的服务商" },
  "profile.pickModelTitle": { en: "{name} — tier.{tier} → model on {provider}", "zh-CN": "{name} — 模型层级 {tier} → {provider} 上的模型" },
  "profile.pickModelPlaceholder": { en: "Pick a model — {count} available (Esc: back)", "zh-CN": "选择模型 — {count} 个可用 (Esc: 返回)" },
  "profile.modelChanged": { en: "{name}: tier.{tier} → {provider}/{model} (pending)", "zh-CN": "{name}: 模型层级 {tier} → {provider}/{model} (待应用)" },
  "profile.promptTierRefTitle": { en: "{name} — tier.{tier}", "zh-CN": "{name} — 模型层级 {tier}" },
  "profile.promptTierRefPlaceholder": { en: "<provider>/<model_id> (empty keeps current)", "zh-CN": "<provider>/<model_id> (留空保留当前值)" },
  "profile.invalidRef": { en: "Invalid ref '{ref}' — expected '<provider>/<model_id>'.", "zh-CN": "无效引用 '{ref}' — 格式应为 '<provider>/<model_id>'。" },
  "profile.customized": { en: "{override} ← customized (preset: {ref})", "zh-CN": "{override} ← 已覆写 (原配置方案: {ref})" },
  "profile.profileVanished": { en: "Profile '{name}' vanished.", "zh-CN": "配置方案 '{name}' 不见了。" },
  "profile.writeProfileFailed": { en: "Failed to write profile '{name}': {err}", "zh-CN": "写入配置方案 '{name}' 失败: {err}" },
  "profile.profileUpdatedApplied": { en: "Profile '{name}' updated and applied — {updated} agent(s) updated ({details}). {live}", "zh-CN": "配置方案 '{name}' 已更新并应用 — {updated} 个 Agent 已更新 ({details})。{live}" },
  "profile.profileSavedApplyFailed": { en: "Profile JSON saved, but failed to apply: {err}", "zh-CN": "配置方案 JSON 已保存，但应用失败: {err}" },

  // Add / Delete profile
  "profile.addProfileTitle": { en: "Add new profile", "zh-CN": "添加新配置方案" },
  "profile.addProfilePlaceholder": { en: "Profile name (e.g. my-custom)", "zh-CN": "配置方案名称 (如 my-custom)" },
  "profile.profileExists": { en: "Profile '{name}' already exists.", "zh-CN": "配置方案 '{name}' 已存在。" },
  "profile.customProfile": { en: "Custom profile", "zh-CN": "自定义配置方案" },
  "profile.profileCreated": { en: "Profile '{name}' created — edit its tiers via Manage.", "zh-CN": "配置方案 '{name}' 已创建 — 通过管理编辑其模型层级。" },
  "profile.createProfileFailed": { en: "Failed to create profile: {err}", "zh-CN": "创建配置方案失败: {err}" },
  "profile.deleteProfileTitle": { en: "Delete profile", "zh-CN": "删除配置方案" },
  "profile.confirmDeleteMsg": { en: "Delete profile '{name}'?\n\nFile: {path}\n\nA .bak backup will be kept. This cannot be undone.", "zh-CN": "删除配置方案 '{name}'?\n\n文件: {path}\n\n将保留 .bak 备份。此操作不可撤销。" },
  "profile.profileDeleted": { en: "Profile '{name}' deleted (.bak kept).", "zh-CN": "配置方案 '{name}' 已删除（保留 .bak 备份）。" },
  "profile.deleteFailed": { en: "Failed to delete: {err}", "zh-CN": "删除失败: {err}" },

  // Select: Profile
  "profile.selectTitle": { en: "Select: Profile", "zh-CN": "选择: 配置方案" },
  "profile.selectPlaceholder": { en: "Pick a profile to review and apply (Esc: back)", "zh-CN": "选择配置方案审阅并应用 (Esc: 返回)" },
  "profile.confirmApplyTitle": { en: "Apply profile '{name}'?", "zh-CN": "应用配置方案 '{name}'？" },
  "profile.confirmApplyMsg": { en: "The following tier→model mapping will be applied:\n\n{mapping}\n\nAgent models in the config will be overwritten.", "zh-CN": "即将应用以下 模型层级→模型 映射：\n\n{mapping}\n\n配置中的 Agent 模型将被覆写。" },
  "profile.noProfiles": { en: "No profiles found in {dir}.", "zh-CN": "在 {dir} 中未找到配置方案。" },
  "profile.switchedTo": { en: "Switched to '{name}' — {updated} agent(s) updated ({details}). {live}", "zh-CN": "已切换到 '{name}' — {updated} 个 Agent 已更新 ({details})。{live}" },
  "profile.appliedLive": { en: "Applied live, no restart needed.", "zh-CN": "已热生效，无需重启。" },
  "profile.restartToApply2": { en: "Restart opencode to apply.", "zh-CN": "重启 opencode 后生效。" },
  "profile.applyFailed": { en: "Failed to apply '{name}': {err}", "zh-CN": "应用 '{name}' 失败: {err}" },

  // Tier descriptions
  "profile.tierFlash": { en: "Fast / lightweight — exploration, high-throughput", "zh-CN": "快速 / 轻量 — 代码粗筛，高吞吐" },
  "profile.tierStandard": { en: "General workhorse — orchestrator (root model)", "zh-CN": "通用主力 — 编排中枢（根模型）" },
  "profile.tierPro": { en: "Professional — strongest coding models", "zh-CN": "专业级 — 最强编码模型" },
  "profile.tierMax": { en: "Flagship reasoning — deep analysis, review, design", "zh-CN": "旗舰推理 — 深度分析，审查，设计" },
  "profile.tierVision": { en: "Multimodal — image/screenshot analysis", "zh-CN": "多模态 — 图像/截图分析" },

  // Misc
  "profile.activeProfileToast": { en: "Active profile: {name}", "zh-CN": "当前配置方案: {name}" },

  // ════════════════════════════════════════════════════════════════
  // ── Provider wizard ────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════
  "provider.cmdTitle": { en: "Configure provider", "zh-CN": "配置服务商" },
  "provider.cmdDesc": { en: "Add custom providers, configure credentials, fetch and manage models", "zh-CN": "添加自定义服务商，配置凭证，拉取和管理模型" },
  "provider.toastTitle": { en: "Provider wizard", "zh-CN": "服务商向导" },
  "provider.setupTitle": { en: "Provider wizard", "zh-CN": "服务商向导" },
  "provider.setupPlaceholder": { en: "Pick a provider to configure (Esc: close)", "zh-CN": "选择服务商进行配置 (Esc: 关闭)" },
  "provider.addProvider": { en: "➕ Add custom provider", "zh-CN": "➕ 添加自定义服务商" },
  "provider.addProviderDesc": { en: "Create a blank provider config from scratch", "zh-CN": "从零创建空白服务商配置" },
  "provider.addPresetProvider": { en: "📦 Add preset provider…", "zh-CN": "📦 添加预设服务商…" },
  "provider.manageConnections": { en: "🔌 Manage connections…", "zh-CN": "🔌 管理连接…" },
  "provider.manageConnectionsDesc": { en: "{count} connected — official built-ins and custom providers, disconnectable in one click", "zh-CN": "{count} 个已连接 — 官方内置与自定义服务商，点击即可断开" },
  "provider.connectionsTitle": { en: "Connections", "zh-CN": "连接" },
  "provider.connectionsHeader": { en: "Connections", "zh-CN": "连接" },
  "provider.connectionsPlaceholder": { en: "Pick a connection to disconnect (Esc: back)", "zh-CN": "选择要断开的连接 (Esc: 返回)" },
  "provider.connectionsEmpty": { en: "No connections — connect providers via /connect or ⚙ Basic settings.", "zh-CN": "当前没有连接 — 可通过 /connect 或 ⚙ 基础设置 连接服务商。" },
  "provider.connSourceStore": { en: "credential store", "zh-CN": "凭证存储" },
  "provider.connSourceConfig": { en: "config", "zh-CN": "配置文件" },
  "provider.connKindCustom": { en: "custom", "zh-CN": "自定义" },
  "provider.connKindExternal": { en: "official/external (not in config)", "zh-CN": "官方/外部（不在配置中）" },
  "provider.connTypeApi": { en: "API key", "zh-CN": "API 密钥" },
  "provider.connTypeOauth": { en: "OAuth", "zh-CN": "OAuth" },
  "provider.connTypeEnv": { en: "env ref", "zh-CN": "环境变量引用" },
  "provider.cmdDisconnectTitle": { en: "Disconnect provider", "zh-CN": "断开服务商连接" },
  "provider.cmdDisconnectDesc": { en: "Interactive: connections wizard (bare); <id> jumps to confirm; --all asks once", "zh-CN": "交互弹窗：连接向导（无参）；<id> 直达确认；--all 一次确认" },
  "provider.connNotFound": { en: "No connection found for '{id}'.", "zh-CN": "未找到 '{id}' 的连接。" },
  "provider.disconnectAllTitle": { en: "Disconnect all", "zh-CN": "断开全部连接" },
  "provider.disconnectAllConfirm": { en: "Disconnect all {count} connection(s)? Provider definitions and models stay.", "zh-CN": "断开全部 {count} 个连接？服务商定义与模型保留。" },
  "provider.disconnectAllDone": { en: "Disconnected {ok}/{count} connection(s).", "zh-CN": "已断开 {ok}/{count} 个连接。" },
  "provider.addPresetProviderDesc": { en: "Import a preset provider from the bundled providers/ definitions", "zh-CN": "从内置的 providers/ 定义文件导入预设服务商" },
  "provider.pickPresetTitle": { en: "Add preset provider", "zh-CN": "添加预设服务商" },
  "provider.pickPresetPlaceholder": { en: "Pick a preset — new ones are imported, added ones open their details (Esc: back)", "zh-CN": "选择预设服务商 — 新的将导入，已添加的直接进详情 (Esc: 返回)" },
  "provider.noPresetsLeft": { en: "No preset definitions found in the providers/ directory.", "zh-CN": "providers/ 目录中未找到预设定义。" },
  "provider.invalidProviderId": { en: "Invalid id — lowercase letters, digits, '-' and '_' only.", "zh-CN": "无效 id — 仅限小写字母、数字、'-' 和 '_'。" },
  "provider.providerExists": { en: "Provider '{id}' already exists.", "zh-CN": "服务商 '{id}' 已存在。" },
  "provider.providerRenamed": { en: "Renamed '{from}' → '{to}'.", "zh-CN": "已重命名 '{from}' → '{to}'。" },
  "provider.detailTitle": { en: "{id} — provider details", "zh-CN": "{id} — 服务商详情" },
  "provider.detailPlaceholder": { en: "Pick settings, a model, or an action (Esc: back)", "zh-CN": "选择设置、模型或操作 (Esc: 返回)" },
  "provider.noCustomProviders": { en: "No custom providers yet.", "zh-CN": "还没有自定义服务商。" },
  "provider.modelsHeader": { en: "Models", "zh-CN": "模型" },
  "provider.settingsHeader": { en: "Settings", "zh-CN": "设置" },
  "provider.actionsHeader": { en: "Actions", "zh-CN": "操作" },
  "provider.configuredHeader": { en: "Providers", "zh-CN": "服务商" },
  "provider.setupHeader": { en: "Setup", "zh-CN": "新增" },
  "provider.basicSettings": { en: "⚙ Basic settings…", "zh-CN": "⚙ 基础设置…" },
  "provider.addProviderFormTitle": { en: "Add custom provider — basic settings", "zh-CN": "添加自定义服务商 — 基础设置" },
  "provider.idTitle": { en: "New provider — id", "zh-CN": "新服务商 — id" },
  "provider.idPlaceholder": { en: "Used in refs '<id>/<model>'; lowercase letters, digits, '-' and '_'", "zh-CN": "用于引用 '<id>/<model>'；小写字母、数字、'-' 和 '_'" },
  "provider.idRequired": { en: "id is required.", "zh-CN": "id 为必填。" },
  "provider.providerFormTitleEdit": { en: "{id} — basic settings", "zh-CN": "{id} — 基础设置" },
  "provider.providerFormPlaceholder": { en: "Edit fields, then save (* = required; Esc: back)", "zh-CN": "编辑字段后保存 (* = 必填；Esc: 返回)" },
  "provider.saveProvider": { en: "💾 Save provider", "zh-CN": "💾 保存服务商" },
  "provider.nameLabel": { en: "name", "zh-CN": "名称" },
  "provider.editNameDesc": { en: "Display name shown in pickers", "zh-CN": "选择器中显示的名称" },
  "provider.nameTitle": { en: "{id} — name", "zh-CN": "{id} — 名称" },
  "provider.namePlaceholder": { en: "Shown in pickers ({hint}). Empty clears to the id.", "zh-CN": "在选择器中显示 ({hint})。留空则清除，回退为 id。" },
  "provider.npmLabel": { en: "npm", "zh-CN": "npm 包" },
  "provider.baseURLLabel": { en: "baseURL", "zh-CN": "服务地址" },
  "provider.apiKeyLabel": { en: "apiKey", "zh-CN": "API 密钥" },
  "provider.pickNpmTitle": { en: "{id} — npm package", "zh-CN": "{id} — npm 包" },
  "provider.pickNpmPlaceholder": { en: "Pick the SDK package — it decides the API protocol (Esc: back)", "zh-CN": "选择 SDK 包 — 决定 API 协议 (Esc: 返回)" },
  "provider.editBaseURLDesc": { en: "API endpoint base URL", "zh-CN": "API 端点地址" },
  "provider.editApiKeyDesc": { en: "API key credential", "zh-CN": "API 密钥凭证" },
  "provider.baseURLTitle": { en: "{id} — baseURL", "zh-CN": "{id} — 服务地址" },
  "provider.apiKeyTitle": { en: "{id} — apiKey", "zh-CN": "{id} — API 密钥" },
  "provider.baseURLPlaceholder": { en: "https://api.example.com/v1 or {env:VAR} ({hint}; empty clears)", "zh-CN": "https://api.example.com/v1 或 {env:VAR} ({hint}；留空清除)" },
  "provider.baseURLRequired": { en: "baseURL is required for openai-compatible providers.", "zh-CN": "openai 兼容服务商必须填写服务地址。" },
  "provider.apiKeyPlaceholder": { en: "sk-... or {env:VAR} ({hint}; empty keeps)", "zh-CN": "sk-... 或 {env:VAR} ({hint}；留空保留)" },
  "provider.fetchModels": { en: "📥 Fetch models…", "zh-CN": "📥 拉取模型…" },
  "provider.fetchingTitle": { en: "Fetching models — {id}", "zh-CN": "正在拉取模型 — {id}" },
  "provider.fetchingBusy": { en: "Contacting the provider and the model catalog…", "zh-CN": "正在连接服务商和模型目录，请稍候…" },
  "provider.fetchModelsDesc": { en: "Fetch the remote model list and import matches as custom models", "zh-CN": "拉取远端模型列表，匹配项导入为自定义" },
  "provider.fetchPatternTitle": { en: "{id} — fetch pattern", "zh-CN": "{id} — 拉取 pattern" },
  "provider.fetchPatternPlaceholder": { en: "Glob filter for model ids, e.g. gpt-* (empty = *)", "zh-CN": "按模型 id 过滤的 glob，如 gpt-* (留空 = *)" },
  "provider.fetchNeedsBaseURL": { en: "Set baseURL before fetching.", "zh-CN": "拉取前请先设置服务地址。" },
  "provider.fetchNeedsKey": { en: "Set apiKey before fetching.", "zh-CN": "拉取前请先设置 API 密钥。" },
  "provider.keyMigrated": { en: "API key moved to the shared credential store used by /connect.", "zh-CN": "API 密钥已移至与 /connect 共享的凭证存储。" },
  "provider.keyInCredStore": { en: "set (in credential store)", "zh-CN": "已设置（凭证存储）" },
  "provider.keyInConfig": { en: "set (in config)", "zh-CN": "已设置（配置文件）" },
  "provider.fetchEnvMissing": { en: "Environment variable '{name}' is not set.", "zh-CN": "环境变量 '{name}' 未设置。" },
  "provider.fetchFailed": { en: "Fetch failed: {err}", "zh-CN": "拉取失败: {err}" },
  "provider.fetchNoMatch": { en: "Fetch OK — no models match '{pattern}' ({total} total).", "zh-CN": "拉取成功 — 没有匹配 '{pattern}' 的模型 (共 {total} 个)。" },
  "provider.fetchImported": { en: "Imported {added} model(s) into '{id}' (pattern '{pattern}'); {enriched} existing enriched with catalog capabilities; {skipped} kept as-is.", "zh-CN": "已导入 {added} 个模型到 '{id}' (pattern '{pattern}')；{enriched} 个已有模型按目录补齐了属性；{skipped} 个保持原样。" },
  "provider.fetchNoNew": { en: "All {skipped} matched model(s) already exist on '{id}' — nothing added.", "zh-CN": "匹配的 {skipped} 个模型均已存在于 '{id}' — 未新增。" },
  "provider.addModel": { en: "➕ Add model…", "zh-CN": "➕ 添加模型…" },
  "provider.addModelDesc": { en: "Form sheet: identity, capabilities, limits", "zh-CN": "表单录入: 身份、能力、限制" },
  "provider.removeModelTitle": { en: "{id} — remove model", "zh-CN": "{id} — 删除模型" },
  "provider.modelFormTitleAdd": { en: "{id} — add model", "zh-CN": "{id} — 添加模型" },
  "provider.modelFormTitleEdit": { en: "{id}/{key} — edit model", "zh-CN": "{id}/{key} — 编辑模型" },
  "provider.modelFormPlaceholder": { en: "Pick a field to edit, or save (* = required; Esc: back)", "zh-CN": "选择要编辑的字段，或保存 (* = 必填；Esc: 返回)" },
  "provider.modelFieldTitle": { en: "{id} — model {field}", "zh-CN": "{id} — 模型 {field}" },
  "provider.formFieldsHeader": { en: "Fields", "zh-CN": "字段" },
  "provider.formCapsHeader": { en: "Capabilities", "zh-CN": "能力" },
  "provider.formLimitsHeader": { en: "Limits", "zh-CN": "限制" },
  "provider.formActionsHeader": { en: "Actions", "zh-CN": "操作" },
  "provider.capAttachmentDesc": { en: "Accepts image / file attachments", "zh-CN": "接受图片 / 文件附件" },
  "provider.capTemperatureDesc": { en: "Supports the temperature parameter", "zh-CN": "支持 temperature 参数" },
  "provider.capReasoningDesc": { en: "Reasoning model", "zh-CN": "推理模型" },
  "provider.capToolCallDesc": { en: "Tool calling (keep on for coding)", "zh-CN": "工具调用 (编码模型保持开)" },
  "provider.modalitiesPlaceholder": { en: "Enter/click to toggle, Esc to return", "zh-CN": "回车/点击切换，Esc 返回" },
  "provider.limitContextPlaceholder": { en: "Context window in tokens (empty = unset)", "zh-CN": "上下文窗口 (tokens，留空 = 未设置)" },
  "provider.limitOutputPlaceholder": { en: "Max output tokens (empty = unset)", "zh-CN": "最大输出 tokens (留空 = 未设置)" },
  "provider.invalidNumber": { en: "Not a valid non-negative integer.", "zh-CN": "不是有效的非负整数。" },
  "provider.saveModel": { en: "💾 Save model", "zh-CN": "💾 保存模型" },
  "provider.deleteProvider": { en: "🗑 Delete provider…", "zh-CN": "🗑 删除服务商…" },
  "provider.disconnect": { en: "🔌 Disconnect…", "zh-CN": "🔌 断开连接…" },
  "provider.disconnectDesc": { en: "Remove the stored credential — provider config and models stay; reconnect anytime", "zh-CN": "移除已存密钥 — 服务商配置与模型保留，可随时重新连接" },
  "provider.disconnectTitle": { en: "{id} — disconnect", "zh-CN": "{id} — 断开连接" },
  "provider.disconnectConfirm": { en: "Remove the stored credential and clear the apiKey field for '{id}'? The provider config and models stay — reconnect anytime via ⚙ Basic settings.", "zh-CN": "移除 '{id}' 的已存密钥并清空 apiKey 字段？服务商配置与模型保留 — 可随时在 ⚙ 基础设置 中重新连接。" },
  "provider.disconnected": { en: "Disconnected '{id}' — credential removed.", "zh-CN": "已断开 '{id}' — 密钥已移除。" },
  "provider.deleteProviderTitle": { en: "{id} — delete provider", "zh-CN": "{id} — 删除服务商" },
  "provider.deleteProviderConfirm": { en: "Remove '{id}', all its models and the stored credential? This cannot be undone.", "zh-CN": "移除 '{id}'、其全部模型及已存密钥？不可撤销。" },
  "provider.clearModels": { en: "🗑 Clear models…", "zh-CN": "🗑 清空模型…" },
  "provider.clearModelsDesc": { en: "Remove models by glob pattern (default: all)", "zh-CN": "按 glob 模式移除模型（默认：全部）" },
  "provider.clearModelsTitle": { en: "{id} — clear models", "zh-CN": "{id} — 清空模型" },
  "provider.clearModelsPatternTitle": { en: "{id} — clear models by pattern", "zh-CN": "{id} — 按模式清空模型" },
  "provider.clearModelsPatternPlaceholder": { en: "Glob pattern for model keys, e.g. gpt-* (empty = *)", "zh-CN": "模型 key 的 glob 模式，如 gpt-*（留空 = *）" },
  "provider.clearModelsConfirm": { en: "Remove {count} model(s) matching '{pattern}' from '{id}'? Profiles referencing them will break.", "zh-CN": "从 '{id}' 移除匹配 '{pattern}' 的 {count} 个模型？引用它们的配置方案将会失效。" },
  "provider.noModelsToClear": { en: "No models to clear on '{id}'.", "zh-CN": "'{id}' 上没有可清空的模型。" },
  "provider.clearModelsNoMatch": { en: "No models on '{id}' match '{pattern}'.", "zh-CN": "'{id}' 上没有匹配 '{pattern}' 的模型。" },
  "provider.modelsCleared": { en: "Cleared {count} model(s) matching '{pattern}' from '{id}'.", "zh-CN": "已从 '{id}' 清空匹配 '{pattern}' 的 {count} 个模型。" },
  "provider.providerDeleted": { en: "Provider '{id}' deleted.", "zh-CN": "服务商 '{id}' 已删除。" },
  "provider.deleteModel": { en: "🗑 Delete model…", "zh-CN": "🗑 删除模型…" },
  "provider.modelKeyPlaceholder": { en: "Key used in refs '<provider>/<key>', e.g. gpt-5.6-low or vendor/gpt-5.6", "zh-CN": "引用中使用的 key '<provider>/<key>'，如 gpt-5.6-low 或 vendor/gpt-5.6" },
  "provider.modelIdPlaceholder": { en: "Id sent to the API (empty keeps the key)", "zh-CN": "发送给 API 的 id (留空则使用 key)" },
  "provider.modelNamePlaceholder": { en: "Shown in pickers (empty keeps the key)", "zh-CN": "在选择器中显示 (留空则使用 key)" },
  "provider.fieldStatusDesc": { en: "deprecated = hidden from pickers (soft disable); alpha = experimental only", "zh-CN": "deprecated = 从选择器隐藏 (软禁用)；alpha = 仅实验模式显示" },
  "provider.wizardTitle": { en: "Provider setup wizard", "zh-CN": "服务商配置向导" },
  "provider.writeFailed": { en: "Failed to write config: {err}", "zh-CN": "写入配置失败: {err}" },
  "provider.configSaved": { en: "'{id}' saved — restart to take effect.", "zh-CN": "'{id}' 已保存 — 重启后生效。" },
  "provider.modelAdded": { en: "Model '{key}' added to '{id}'.", "zh-CN": "模型 '{key}' 已添加到 '{id}'。" },
  "provider.modelRemoved": { en: "Model '{key}' removed from '{id}'.", "zh-CN": "模型 '{key}' 已从 '{id}' 删除。" },
  "provider.addModelFailed": { en: "Failed to add model: {err}", "zh-CN": "添加模型失败: {err}" },
  "provider.invalidKey": { en: "Invalid key — no spaces; '/' allowed inside, not at edges or doubled.", "zh-CN": "无效 key — 不能含空格；'/' 可在中间使用，但不能在首尾或连续出现。" },
  "provider.modelExists": { en: "Model '{key}' already exists on '{id}'.", "zh-CN": "模型 '{key}' 已存在于 '{id}'。" },
  "provider.providerVanished": { en: "Provider '{id}' no longer exists.", "zh-CN": "服务商 '{id}' 已不存在。" },
  "provider.removeModelConfirm": { en: "Remove model '{key}' from '{id}'? Profiles referencing '{id}/{key}' will break.", "zh-CN": "从 '{id}' 删除模型 '{key}'？引用 '{id}/{key}' 的配置方案将会失效。" },
  "provider.noProvidersAvailable": { en: "No providers configured and no definitions in {dir}.", "zh-CN": "未配置服务商且 {dir} 中无定义文件。" },
  "provider.cannotReadConfig": { en: "Cannot read {path}: {err}", "zh-CN": "无法读取 {path}: {err}" },

  // ════════════════════════════════════════════════════════════════
  // ── Project wizard ─────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════
  "project.cmdTitle": { en: "Project setup wizard", "zh-CN": "项目设置向导" },
  "project.cmdDesc": { en: "Configure project switches, sync templates, refresh indexes", "zh-CN": "配置项目开关，同步模板，刷新索引" },
  "project.toastTitle": { en: "Project wizard", "zh-CN": "项目向导" },
  "project.mainPlaceholder": { en: "Select action (Esc to exit)", "zh-CN": "选择操作 (Esc 退出)" },
  "project.firstScreenPlaceholder": { en: "Skeleton → conventions → maintenance → system (Esc: close)", "zh-CN": "骨架 → 规范 → 维护 → 系统 (Esc: 关闭)" },
  "project.groupsHeader": { en: "Groups", "zh-CN": "分组" },
  "project.groups.autoAdvisor": { en: "Auto advisor", "zh-CN": "自动顾问" },
  "project.groups.projectGuards": { en: "Project guards", "zh-CN": "项目护栏" },
  "project.groups.adr": { en: "ADR Settings", "zh-CN": "ADR设置" },
  "project.groups.tooling": { en: "Project tooling", "zh-CN": "项目工具" },
  "project.groups.index": { en: "Index maintenance", "zh-CN": "索引维护" },
  "project.groups.indexDesc": { en: "Backend indexing refresh", "zh-CN": "后端索引刷新" },
  "project.navigationHeader": { en: "Navigation", "zh-CN": "导航" },
  "project.tooling.title": { en: "Formatter setup", "zh-CN": "格式化器设置" },
  "project.tooling.placeholder": { en: "Pick an action (Esc: back)", "zh-CN": "选择操作 (Esc: 返回)" },
  "project.tooling.summaryEligible": { en: "dprint setup available", "zh-CN": "可配置 dprint" },
  "project.tooling.summaryNotEligible": { en: "dprint not eligible for this project", "zh-CN": "此项目不适用 dprint" },
  "project.tooling.dprintNotEligibleTitle": { en: "dprint not eligible", "zh-CN": "dprint 不适用" },
  "project.tooling.dprintNotEligibleDesc": { en: "No supported files detected in this project", "zh-CN": "未在项目中检测到支持的文件类型" },
  "project.projectGuards.title": { en: "Project guards — {config}", "zh-CN": "项目护栏 — {config}" },
  "project.projectGuards.placeholder": { en: "Pick a guard to edit (Esc: back)", "zh-CN": "选择要编辑的护栏 (Esc: 返回)" },
  "project.autoAdvisor.title": { en: "Auto-advisor mode — {config}", "zh-CN": "顾问模式 — {config}" },
  "project.adr.title": { en: "ADR Settings — {config}", "zh-CN": "ADR 设置 — {config}" },
  "project.adr.placeholder": { en: "Pick an ADR setting (Esc: back)", "zh-CN": "选择 ADR 设置 (Esc: 返回)" },
  "project.configureSwitches": { en: "⚙️ Configure Project Switches", "zh-CN": "⚙️ 配置项目开关" },
  "project.syncTemplates": { en: "🔄 Sync Template Switches", "zh-CN": "🔄 同步模板开关" },
  "project.syncTemplatesDesc": { en: "Append missing switch lines to config", "zh-CN": "将缺失的开关行追加到配置" },
  "project.refreshIndex": { en: "⚡ Refresh Code Index", "zh-CN": "⚡ 刷新代码索引" },
  "project.refreshIndexDesc": { en: "Catch up codegraph & gitnexus indexes", "zh-CN": "更新 codegraph 和 gitnexus 索引" },
  "project.exitWizard": { en: "❌ Exit Wizard", "zh-CN": "❌ 退出向导" },
  "project.exitWizardDesc": { en: "Close setup dialog (or Esc)", "zh-CN": "关闭设置对话框 (或 Esc)" },
  "project.configureSwitchesTitle": { en: "Configure Switches — {config}", "zh-CN": "配置开关 — {config}" },
  "project.configureSwitchesPlaceholder": { en: "Select switch to edit (Esc cancels)", "zh-CN": "选择要编辑的开关 (Esc 取消)" },
  "project.setupHeader": { en: "Setup", "zh-CN": "设置" },
  "project.maintainHeader": { en: "Maintenance", "zh-CN": "维护" },
  "project.advisorHeader": { en: "Advisor", "zh-CN": "顾问" },
  "project.guardsHeader": { en: "Quality Guards", "zh-CN": "质量护栏" },
  "project.actionsHeader": { en: "Actions", "zh-CN": "操作" },
  "project.skeletonHeader": { en: "🏗 Skeleton", "zh-CN": "🏗 骨架" },
  "project.conventionsHeader": { en: "📋 Conventions", "zh-CN": "📋 规范" },
  "project.maintenanceHeader": { en: "🔧 Maintenance", "zh-CN": "🔧 维护" },
  "project.systemHeader": { en: "⚙ System", "zh-CN": "⚙ 系统" },
  "project.saveApply": { en: "💾 Save & Apply Changes", "zh-CN": "💾 保存并应用变更" },
  "project.saveApplyDesc": { en: "Write switches to config file", "zh-CN": "将开关写入配置文件" },
  "project.backToMain": { en: "🔙 Back to Main Menu", "zh-CN": "🔙 返回主菜单" },
  "project.backToMainDesc": { en: "Return to Level 1 action menu", "zh-CN": "返回第一层操作菜单" },
  "project.initResult": { en: "Project Initialization Result", "zh-CN": "项目初始化结果" },
  "project.updateResult": { en: "Project Update Result", "zh-CN": "项目更新结果" },
  "project.initFailed": { en: "Init / Update Failed", "zh-CN": "初始化 / 更新失败" },
  "project.saveResult": { en: "Project Save Result", "zh-CN": "项目保存结果" },
  "project.saveFailed": { en: "Save Failed", "zh-CN": "保存失败" },
  "project.syncResult": { en: "Template Switches Sync Result", "zh-CN": "模板开关同步结果" },
  "project.syncError": { en: "Sync Error", "zh-CN": "同步错误" },
  "project.indexResult": { en: "Code Index Refresh Results", "zh-CN": "代码索引刷新结果" },
  "project.indexError": { en: "Index Error", "zh-CN": "索引错误" },
  "project.newProject": { en: "Project Setup Wizard — new project", "zh-CN": "项目设置向导 — 新建项目" },
  "project.setupExisting": { en: "Project Setup Wizard — {config}", "zh-CN": "项目设置向导 — {config}" },
  "project.applyUpdate": { en: "🚀 Apply Changes", "zh-CN": "🚀 应用更改" },
  "project.applyInit": { en: "🚀 Initialize Project", "zh-CN": "🚀 初始化项目" },
  "project.applyUpdateDesc": { en: "Save switches & update baseline files", "zh-CN": "保存开关并更新基线文件" },
  "project.applyInitDesc": { en: "Create config, AGENTS.md & git-commits.md", "zh-CN": "创建配置、AGENTS.md 和 git-commits.md" },
  "project.setupDprint": { en: "✨ Set up dprint", "zh-CN": "✨ 配置 dprint" },
  "project.setupDprintDesc": { en: "Add local dprint and generate a config from detected files", "zh-CN": "添加项目本地 dprint，并根据检测到的文件生成配置" },
  "project.setupDprintConfirmTitle": { en: "Set up dprint", "zh-CN": "配置 dprint" },
  "project.setupDprintConfirm": { en: "Add dprint to this project's dev dependencies and create dprint.json using detected files? Existing formatter configurations are never changed.", "zh-CN": "将 dprint 添加到此项目的开发依赖，并根据检测到的文件创建 dprint.json？不会修改任何现有 formatter 配置。" },
  "project.setupDprintDone": { en: "dprint is ready; created dprint.json from detected files.", "zh-CN": "dprint 已就绪；已根据检测到的文件创建 dprint.json。" },
  "project.setupDprintFailed": { en: "dprint setup failed", "zh-CN": "dprint 配置失败" },
  "project.configUpdated": { en: "Project configuration updated!", "zh-CN": "项目配置已更新！" },
  "project.configSavedToast": { en: "Project configuration saved!", "zh-CN": "项目配置已保存！" },
  "project.initSuccess": { en: "Project initialized successfully!", "zh-CN": "项目初始化成功！" },
  "project.operationFailed": { en: "Operation failed: {err}", "zh-CN": "操作失败: {err}" },
  "project.saveFailedMsg": { en: "Save failed: {err}", "zh-CN": "保存失败: {err}" },
  "project.indexFailed": { en: "Index refresh failed: {err}", "zh-CN": "索引刷新失败: {err}" },
  "project.syncMissing": { en: "⚠️ Project config does not exist.\nPlease run Init first.", "zh-CN": "⚠️ 项目配置文件不存在。\n请先运行初始化。" },
  "project.syncUpToDate": { en: "ℹ️ Configuration is already up to date.\nAll latest template switch keys are already present.", "zh-CN": "ℹ️ 配置已是最新。\n所有最新模板开关键已存在。" },
  "project.syncAdded": { en: "✅ Successfully appended {count} new switch line(s) to config:\n\n{lines}\n\nExisting configuration content was preserved.", "zh-CN": "✅ 已追加 {count} 个新开关行到配置:\n\n{lines}\n\n已保留现有配置内容。" },
  "project.syncMalformed": { en: "❌ Configuration file is malformed (missing proper closing brace).\nPlease fix the file manually.", "zh-CN": "❌ 配置文件格式错误（缺少正确的闭合括号）。\n请手动修复文件。" },
  "project.syncFailed": { en: "Sync operation failed: {err}", "zh-CN": "同步操作失败: {err}" },
  "project.noBackends": { en: "ℹ️ No backends needed index refresh.", "zh-CN": "ℹ️ 无后端需要索引刷新。" },

  // ─── Async-operation loading states (showBusyModal placeholders) ────
  // Replaces the menu with a busy DialogAlert while init/dprint/index run
  // in the background. Footer shows the spinner + busyText; Enter/Esc are
  // suppressed until the wizard replaces the frame with the result alert.
  "project.initWorkingTitle": { en: "Initializing project", "zh-CN": "正在初始化项目" },
  "project.initWorking": { en: "Scaffolding config files, registering hooks, and running detected backends.\nThis usually takes a few seconds.", "zh-CN": "正在生成配置文件、注册钩子、运行检测到的后端。\n这通常需要几秒钟。" },
  "project.initBusyText": { en: "Initializing…", "zh-CN": "正在初始化…" },
  "project.updateWorkingTitle": { en: "Updating project", "zh-CN": "正在更新项目" },
  "project.updateWorking": { en: "Updating baseline files and re-running detected backends.\nThis usually takes a few seconds.", "zh-CN": "正在更新基线文件并重新运行检测到的后端。\n这通常需要几秒钟。" },
  "project.updateBusyText": { en: "Updating…", "zh-CN": "正在更新…" },
  "project.saveWorkingTitle": { en: "Saving configuration", "zh-CN": "正在保存配置" },
  "project.saveWorking": { en: "Writing switches and refreshing baseline files.\nThis usually takes a few seconds.", "zh-CN": "正在写入开关并刷新基线文件。\n这通常需要几秒钟。" },
  "project.saveBusyText": { en: "Saving…", "zh-CN": "正在保存…" },
  "project.setupDprintWorkingTitle": { en: "Setting up dprint", "zh-CN": "正在配置 dprint" },
  "project.setupDprintWorking": { en: "Installing dprint and generating dprint.json from detected files.\nThis may take a few seconds.", "zh-CN": "正在安装 dprint 并根据检测到的文件生成 dprint.json。\n这可能需要几秒钟。" },
  "project.setupDprintBusyText": { en: "Setting up dprint…", "zh-CN": "正在配置 dprint…" },
  "project.indexWorkingTitle": { en: "Refreshing code index", "zh-CN": "正在刷新代码索引" },
  "project.indexWorking": { en: "Running index backends against the project.\nThis may take a few seconds for large repos.", "zh-CN": "正在对项目运行索引后端。\n大型仓库可能需要几秒钟。" },
  "project.indexBusyText": { en: "Refreshing…", "zh-CN": "正在刷新…" },

  // Switch picker labels and descriptions (each guard has its own on/off; default = the recommended runtime value).
  "project.currentMarker": { en: "  (current)", "zh-CN": "  (当前)" },
  "project.currentValue": { en: "Current: {value}", "zh-CN": "当前: {value}" },
  "project.cancel": { en: "🔙 Cancel", "zh-CN": "🔙 取消" },
  "project.cancelDesc": { en: "Keep current and return", "zh-CN": "保留当前值并返回" },

  "project.pickAdvisor": { en: "Select autoAdvisorMode", "zh-CN": "选择 autoAdvisorMode" },
  "project.valueAdvisorLite": { en: "Advisory mode (recommended)", "zh-CN": "顾问模式 (推荐)" },
  "project.valueAdvisorFull": { en: "Decisive review mode", "zh-CN": "决定性审查模式" },
  "project.valueAdvisorOff": { en: "Disable advisor completely", "zh-CN": "完全关闭顾问" },
  "project.toastAdvisor": { en: "autoAdvisorMode -> {value}", "zh-CN": "autoAdvisorMode -> {value}" },

  "project.pickAdrGuard": { en: "Select adrGuard", "zh-CN": "选择 adrGuard" },
  "project.valueGuardAdrOn": { en: "Enforce ADR change check on feat/refactor", "zh-CN": "对 feat / refactor 类型启用 ADR 变更检查" },
  "project.valueGuardAdrOff": { en: "Disable ADR guard check", "zh-CN": "关闭 ADR 守卫检查" },
  "project.toastAdrGuard": { en: "adrGuard -> {value}", "zh-CN": "adrGuard -> {value}" },

  "project.pickEnvGuard": { en: "Select envGuard", "zh-CN": "选择 envGuard" },
  "project.valueGuardEnvOn": { en: "Block agent reading secret .env files", "zh-CN": "阻止代理读取 .env 密钥文件" },
  "project.valueGuardEnvOff": { en: "Allow unrestricted access to env files", "zh-CN": "允许对 .env 文件的无限制访问" },
  "project.toastEnvGuard": { en: "envGuard -> {value}", "zh-CN": "envGuard -> {value}" },

  "project.pickE2eGuard": { en: "Select e2eGuard", "zh-CN": "选择 e2eGuard" },
  "project.valueGuardE2eOn": { en: "Assess E2E impact & prompt user", "zh-CN": "评估 E2E 影响并提示用户" },
  "project.valueGuardE2eOff": { en: "Skip E2E assessment check", "zh-CN": "跳过 E2E 评估检查" },
  "project.toastE2eGuard": { en: "e2eGuard -> {value}", "zh-CN": "e2eGuard -> {value}" },

  "project.valueGuardMemoryOn": { en: "Inject curated project-memory lessons", "zh-CN": "注入已整理的项目记忆经验" },
  "project.valueGuardMemoryOff": { en: "Never inject project memory", "zh-CN": "从不注入项目记忆" },
  "project.toastGuard": { en: "{key} -> {value}", "zh-CN": "{key} -> {value}" },

  "project.pickAdrLayout": { en: "Select ADR Layout (adrLayout)", "zh-CN": "选择 ADR 布局 (adrLayout)" },
  "project.valueAdrLayoutAuto": { en: "Smart adaptive (flat <=15, hierarchy >15)", "zh-CN": "智能适配 (≤15 平铺, >15 分层)" },
  "project.valueAdrLayoutFlat": { en: "Single directory (0001-xxx.md)", "zh-CN": "单目录 (0001-xxx.md)" },
  "project.valueAdrLayoutHierarchy": { en: "Domain subdirectories (auth/0001-xxx.md)", "zh-CN": "按域划分子目录 (auth/0001-xxx.md)" },
  "project.toastAdrLayout": { en: "adrLayout -> {value}", "zh-CN": "adrLayout -> {value}" },

  "project.pickAdrDir": { en: "Select ADR Directory (adrDir)", "zh-CN": "选择 ADR 目录 (adrDir)" },
  "project.valueAdrDirDocsAdr": { en: "Standard docs/adr/ folder", "zh-CN": "标准 docs/adr/ 目录" },
  "project.valueAdrDirDocsDecisions": { en: "docs/decisions/ folder", "zh-CN": "docs/decisions/ 目录" },
  "project.valueAdrDirArchitecture": { en: "architecture/decisions/ folder", "zh-CN": "architecture/decisions/ 目录" },
  "project.valueAdrDirCustom": { en: "✍️ Custom Path...", "zh-CN": "✍️ 自定义路径..." },
  "project.valueAdrDirCustomDesc": { en: "Type custom directory path", "zh-CN": "输入自定义目录路径" },
  "project.promptAdrDirTitle": { en: "Custom ADR Directory", "zh-CN": "自定义 ADR 目录" },
  "project.promptAdrDirPlaceholder": { en: "e.g. docs/adr", "zh-CN": "例如 docs/adr" },
  "project.toastAdrDir": { en: "adrDir -> {value}", "zh-CN": "adrDir -> {value}" },

  // Switch row descriptors on the Level-2 (configure switches) menu.
  "project.switchAdvisor": { en: "Advisor reviews (lite / full / off)", "zh-CN": "顾问审查 (lite / full / off)" },
  "project.switchAdrGuard": { en: "Enforce ADR on feat/refactor", "zh-CN": "对 feat / refactor 启用 ADR 守护" },
  "project.switchAdrDir": { en: "ADR markdown folder path", "zh-CN": "ADR Markdown 目录路径" },
  "project.switchAdrLayout": { en: "ADR structure (auto/flat/hierarchy)", "zh-CN": "ADR 结构 (auto / flat / hierarchy)" },
  "project.switchEnvGuard": { en: "Protect secret .env file reads", "zh-CN": "保护 .env 密钥文件读取" },
  "project.switchE2eGuard": { en: "Assess E2E before test execution", "zh-CN": "测试执行前评估 E2E 影响" },
  "project.switchProjectMemory": { en: "Inject curated project memory into context (outside the project, per ocp memory root)", "zh-CN": "将整理后的项目记忆注入上下文(存于 ocp 记忆根目录,独立于项目)" },
  "project.nameEnvGuard": { en: "envGuard", "zh-CN": "环境护栏" },
  "project.nameE2eGuard": { en: "e2eGuard", "zh-CN": "E2E 护栏" },
  "project.nameAdrGuard": { en: "adrGuard", "zh-CN": "ADR 护栏" },
  "project.nameProjectMemory": { en: "projectMemory", "zh-CN": "项目记忆" },

  // ════════════════════════════════════════════════════════════════
  // ── Queue manager ──────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════
  "queue.cmdTitle": { en: "Manage queued messages", "zh-CN": "管理排队消息" },
  "queue.cmdDesc": { en: "View, edit, or cancel queued messages in the current session", "zh-CN": "查看、编辑或取消当前会话的排队消息" },
  "queue.toastTitle": { en: "Queue manager", "zh-CN": "队列管理" },
  "queue.editTitle": { en: "Edit queued message", "zh-CN": "编辑排队消息" },
  "queue.editPlaceholder": { en: "New text for this queued message (replaces all text parts)", "zh-CN": "此排队消息的新文本（替换所有文本部分）" },
  "queue.cancelTitle": { en: "Cancel queued message", "zh-CN": "取消排队消息" },
  "queue.fullTextTitle": { en: "Queued message — full text", "zh-CN": "排队消息 — 完整文本" },
  "queue.entryTitle": { en: "Queued message ({age})", "zh-CN": "排队消息 ({age})" },
  "queue.editAction": { en: "( Edit text… )", "zh-CN": "( 编辑文本… )" },
  "queue.editActionDesc": { en: "Rewrite this message before it is processed", "zh-CN": "在消息处理前重写内容" },
  "queue.cancelAction": { en: "( Cancel message )", "zh-CN": "( 取消消息 )" },
  "queue.viewAction": { en: "( View full text )", "zh-CN": "( 查看全文 )" },
  "queue.viewActionDesc": { en: "Show the complete message text", "zh-CN": "显示完整消息文本" },
  "queue.backToQueue": { en: "( ← Back to queue )", "zh-CN": "( ← 返回队列 )" },
  "queue.listTitle": { en: "Message queue — {count} queued{busy}", "zh-CN": "消息队列 — {count} 条排队{busy}" },
  "queue.queuedHeader": { en: "Queued", "zh-CN": "排队中" },
  "queue.actionsHeader": { en: "Actions", "zh-CN": "操作" },
  "queue.sessionBusy": { en: " (session busy)", "zh-CN": " (会话忙碌)" },
  "queue.sessionIdle": { en: " (session idle)", "zh-CN": " (会话空闲)" },
  "queue.listPlaceholder": { en: "Pick a queued message to edit or cancel (Esc closes)", "zh-CN": "选择排队消息进行编辑或取消 (Esc 关闭)" },
  "queue.cancelAll": { en: "( Cancel ALL queued messages )", "zh-CN": "( 取消全部排队消息 )" },
  "queue.cancelAllTitle": { en: "Cancel ALL queued messages", "zh-CN": "取消全部排队消息" },
  "queue.editSaved": { en: "Edit saved — takes effect when this message's turn arrives.", "zh-CN": "编辑已保存 — 轮到该消息时生效。" },
  "queue.editFailed": { en: "Edit failed: {err}", "zh-CN": "编辑失败: {err}" },
  "queue.cancelled": { en: "Queued message cancelled.", "zh-CN": "排队消息已取消。" },
  "queue.cancelFailed": { en: "Cancel failed: {err}", "zh-CN": "取消失败: {err}" },
  "queue.allCancelled": { en: "All {count} queued message{s} cancelled.", "zh-CN": "已取消全部 {count} 条排队消息。" },
  "queue.loadMessagesFailed": { en: "Failed to load messages (HTTP {status}).", "zh-CN": "加载消息失败 (HTTP {status})。" },
  "queue.loadMessagesError": { en: "Failed to load messages: {err}", "zh-CN": "加载消息失败: {err}" },
  "queue.deleteFailedHttp": { en: "Delete failed (HTTP {status}).", "zh-CN": "删除失败 (HTTP {status})。" },
  "queue.deleteFailed": { en: "Delete failed: {err}", "zh-CN": "删除失败: {err}" },
  "queue.busyStripFailed": { en: "Busy-strip failed: {err}", "zh-CN": "忙碌剥离失败: {err}" },
  "queue.noTextParts": { en: "This message has no editable text parts.", "zh-CN": "此消息没有可编辑的文本部分。" },
  "queue.emptyText": { en: "Empty text — use Cancel instead.", "zh-CN": "文本为空 — 请改用取消。" },
  "queue.unchanged": { en: "Unchanged.", "zh-CN": "未更改。" },
  "queue.noQueuedMessages": { en: "No queued messages in this session.", "zh-CN": "此会话中没有排队消息。" },
  "queue.cancelResult": { en: "Cancelled {ok}/{total} queued messages.", "zh-CN": "已取消 {ok}/{total} 条排队消息。" },
  "queue.openSessionFirst": { en: "Open a session first — the queue is per-session.", "zh-CN": "请先打开一个会话 — 队列是按会话隔离的。" },
  "queue.noCurrentSession": { en: "No current session.", "zh-CN": "没有当前会话。" },
  "queue.attachmentOnly": { en: "[attachment only — no text]", "zh-CN": "[仅附件 — 无文本]" },
  "queue.busyStripWarning": { en: "Session busy — attachment-only messages can't be stripped safely. Wait for idle, then cancel again.", "zh-CN": "会话忙碌 — 仅附件消息无法安全剥离。请等待空闲后再取消。" },
  "queue.busyStripResult": { en: "Session busy — message content stripped (tombstone kept). It will not send instructions.", "zh-CN": "会话忙碌 — 消息内容已剥离（保留墓碑标记）。不会发送指令。" },
  "queue.confirmCancelBusy": { en: "Cancel this queued message?\n\n\"{preview}\"\n\nThe session is BUSY: the message cannot be deleted right now — its content will be stripped (tombstone kept) instead.", "zh-CN": "取消此排队消息？\n\n\"{preview}\"\n\n会话忙碌：消息无法立即删除 — 其内容将被剥离（保留墓碑标记）。" },
  "queue.confirmCancelIdle": { en: "Cancel this queued message?\n\n\"{preview}\"\n\nThe session is idle: the message will be deleted permanently.", "zh-CN": "取消此排队消息？\n\n\"{preview}\"\n\n会话空闲：消息将被永久删除。" },
  "queue.confirmCancelAllBusy": { en: "Strip all {count} queued messages? The session is BUSY — contents are replaced with tombstones (messages stay visible but send no instructions).", "zh-CN": "剥离全部 {count} 条排队消息？会话忙碌 — 内容将被替换为墓碑标记（消息保持可见但不发送指令）。" },
  "queue.confirmCancelAllIdle": { en: "Delete all {count} queued messages permanently?", "zh-CN": "永久删除全部 {count} 条排队消息？" },
  "queue.noTextAttachmentsOnly": { en: "(no text — attachments only)", "zh-CN": "(无文本 — 仅附件)" },
  "queue.stripAllCount": { en: "Strip/delete all {count} queued messages", "zh-CN": "剥离/删除全部 {count} 条排队消息" },
  "queue.textPartCount": { en: "{count} text part(s)", "zh-CN": "{count} 个文本部分" },
  "queue.attachmentCount": { en: "{count} attachment(s)", "zh-CN": "{count} 个附件" },

  // ════════════════════════════════════════════════════════════════
  // ── Usage (token/cost view — usage.ts) ───────────────────────────
  // ════════════════════════════════════════════════════════════════
  "usage.commandTitle": { en: "Show token usage", "zh-CN": "查看 token 用量" },
  "usage.commandDesc": { en: "Token/cost usage with tabbed dimensions (session / agent / model) — 1/2/3 or ←→ to switch, ↑/↓ to scroll", "zh-CN": "按会话 / Agent / 模型分 tab 查看 token/费用消耗 — 1/2/3 或 ←→ 切换，↑/↓ 滚动" },
  "usage.dialogTitle": { en: "Token usage", "zh-CN": "Token 用量" },
  "usage.dimPrev": { en: "Previous usage tab", "zh-CN": "上一个用量 tab" },
  "usage.dimNext": { en: "Next usage tab", "zh-CN": "下一个用量 tab" },
  "usage.dimSession": { en: "By session", "zh-CN": "按会话" },
  "usage.dimAgent": { en: "By agent", "zh-CN": "按Agent" },
  "usage.dimModel": { en: "By model", "zh-CN": "按模型" },
  "usage.scrollHint": { en: "↑/↓ scroll · rows {first}–{last} of {total}", "zh-CN": "↑/↓ 滚动 · 第 {first}–{last} 行 / 共 {total} 行" },
  "usage.totalRow": { en: "total", "zh-CN": "总计" },
  "usage.hSession": { en: "session", "zh-CN": "会话" },
  "usage.hAgent": { en: "agent", "zh-CN": "Agent" },
  "usage.hSessions": { en: "sess", "zh-CN": "会话" },
  "usage.hIn": { en: "in", "zh-CN": "输入" },
  "usage.hOut": { en: "out", "zh-CN": "输出" },
  "usage.hCached": { en: "cached", "zh-CN": "缓存" },
  "usage.hCost": { en: "cost", "zh-CN": "费用" },
  "usage.hCredits": { en: "credits", "zh-CN": "积分" },
  "usage.hSteps": { en: "steps", "zh-CN": "步数" },
  "usage.hHit": { en: "hit", "zh-CN": "命中率" },
  "usage.hShare": { en: "share", "zh-CN": "占比" },
  "usage.hModel": { en: "model", "zh-CN": "模型" },
  "usage.hitCell": { en: "hit {hit}% · {total}", "zh-CN": "命中 {hit}% · {total}" },
  "usage.estimateNote": { en: "🪙 = simulated pricing (public list-price estimate, not an actual invoice)", "zh-CN": "🪙 = 模拟计价（按公开标价估算，非实际账单）" },
  "usage.estimateFloor": { en: "Some models were not found on models.dev; those rows use a low-end market-floor fallback.", "zh-CN": "部分模型未在 models.dev 匹配到价格，已按市场最低价下界兜底估算。" },
  "usage.fullIdMapping": { en: "Full IDs:", "zh-CN": "模型全名:" },
  "usage.noData": { en: "📊 No token data for the current session yet.", "zh-CN": "📊 当前会话还没有 token 数据。" },
  "usage.picker.today": { en: "Today", "zh-CN": "今天" },
  "usage.picker.yesterday": { en: "Yesterday", "zh-CN": "昨天" },
  "usage.picker.daysAgo": { en: "2 days ago", "zh-CN": "前天" },
  "usage.picker.earlier": { en: "Earlier", "zh-CN": "之前" },
  "usage.picker.filterHint": { en: "Type to filter", "zh-CN": "输入以筛选" },
  "usage.unknownSub": { en: "📊 Unknown subcommand \"{sub}\". Usage: /usage [all|model]", "zh-CN": "📊 未知子命令 \"{sub}\"。用法: /usage [all|model]" },
  "usage.failed": { en: "📊 Failed to query usage: {err}", "zh-CN": "📊 查询用量失败: {err}" },

  // Context-watch: long-session reminders injected above the table.
  // Three tiers — gentle hint at soft threshold, strong warning past the
  // standard attention-decay boundary, and a hard "you should handoff
  // now" beyond the compaction safety line. Compactions flagging fires
  // independently because compaction is an opencode-internal action the
  // user can't undo from the prompt side.
  "usage.contextWarning.soft": {
    en: "💡 {count} turns — early context may be losing weight. Consider asking the agent for a recap before the next task.",
    "zh-CN": "💡 已 {count} 轮 — 早期上下文可能开始在弱化。下一步任务前建议让 agent 做个小结。",
  },
  "usage.contextWarning.strong": {
    en: "⚠️ {count} turns — context is getting heavy. Strongly recommend wrapping up and opening a fresh session with a recap bridge.",
    "zh-CN": "⚠️ 已 {count} 轮 — 上下文已经很重。强烈建议尽快收尾，用小结桥接开新会话。",
  },
  "usage.contextWarning.hard": {
    en: "🚨 {count} turns — past the attention-decay line. Old instructions may already be forgotten; a fresh session will be cheaper AND more reliable.",
    "zh-CN": "🚨 已 {count} 轮 — 超过注意力衰减红线。早期指令可能已经被遗忘，开新会话既省钱又可靠。",
  },
  "usage.contextWarning.compactions": {
    en: "⚠️ {count} compaction(s) detected — opencode has already auto-summarized earlier context. Past history may be lossy.",
    "zh-CN": "⚠️ 已发生 {count} 次自动压缩 — opencode 已经摘要过早期上下文，更早的历史可能有损。",
  },

  // ════════════════════════════════════════════════════════════════
  // ── Host (standalone OpenTUI shell: right-click copy) ──────────
  // ════════════════════════════════════════════════════════════════
  "host.copy.copied": { en: "📋 Copied {count} characters", "zh-CN": "📋 已复制 {count} 个字符" },
  "host.copy.empty": { en: "📋 No selection — drag to select text, then right-click to copy", "zh-CN": "📋 未选中内容 — 先拖动选中文字，再右键复制" },
  "host.copy.failed": { en: "📋 Copy failed — this terminal does not allow clipboard writes", "zh-CN": "📋 复制失败 — 当前终端不支持剪贴板写入" },

  // ════════════════════════════════════════════════════════════════
  // ── Guard command/announce layer (server-side plugins) ────────
  //   Locale-invariant by design: [plugin] prefixes, `gate:`/`Status:`
  //   labels, on/off/ON/OFF/ACTIVE/INACTIVE tokens, subcommand names,
  //   paths, config field names. Prose is translated. LLM-facing
  //   protocol/injection fragments stay English and are NOT here.
  // ════════════════════════════════════════════════════════════════

  // ── project-memory (/memory) ──
  "guard.memory.help": {
    en: "[project-memory] Project-level lessons memory — capture + inject (phase 1; review tool is phase 2).\nUsage:\n/memory capture <lesson>  → append a dated lesson to {draft} (awaiting review)\n/memory on | off          → toggle injection of {memory} into the system prompt\n/memory status            → gate state + entry counts\nPromotion draft → memory is a manual edit for now: move stable entries, delete stale ones.\n{memory} is advisory — AGENTS.md stays authoritative on conflict.",
    "zh-CN": "[project-memory] 项目级经验记忆 —— 捕获 + 注入（阶段 1；review 工具在阶段 2）。\n用法：\n/memory capture <lesson>  → 将一条带日期的经验追加到 {draft}（待整理）\n/memory on | off          → 切换是否把 {memory} 注入系统提示\n/memory status            → 开关状态 + 条目计数\n草稿 → 记忆文件目前为手工晋升：保留稳定的条目，删除过期的条目。\n记忆文件仅为建议 —— 冲突时以 AGENTS.md 为准。",
  },
  "guard.memory.captured": { en: "[project-memory] Captured to {draft} — promote to {memory} (manual edit) for it to be injected.", "zh-CN": "[project-memory] 已捕获到 {draft} —— 需手工晋升到 {memory} 才会被注入。" },
  "guard.memory.nothing": { en: "[project-memory] Nothing to capture — usage: /memory capture <lesson>", "zh-CN": "[project-memory] 没有可捕获的内容 —— 用法：/memory capture <经验>" },
  "guard.memory.unknown": { en: "[project-memory] Unknown subcommand \"{sub}\".", "zh-CN": "[project-memory] 未知子命令 \"{sub}\"。" },
  "guard.memory.set": { en: "[project-memory] Injection {STATE} — wrote \"projectMemory\": \"{state}\" to {path}.", "zh-CN": "[project-memory] 注入已{zhState} —— 已把 \"projectMemory\": \"{state}\" 写入 {path}。" },
  "guard.memory.setFail": { en: "[project-memory] Failed to write the project config — edit the \"{field}\" field of opencode.jsonc by hand.", "zh-CN": "[project-memory] 写入项目配置失败 —— 请手工编辑 opencode.jsonc 的 \"{field}\" 字段。" },
  "guard.memory.status": { en: "[project-memory] gate: {gate} — memory: {memory}, draft: {draft} pending. Injection {flag}.", "zh-CN": "[project-memory] gate: {gate} —— 记忆：{memory}，草稿 {draft} 条待整理。注入 {flag}。" },
  "guard.memory.entries": { en: "{count} entries", "zh-CN": "{count} 条" },
  "guard.memory.missing": { en: "missing/empty", "zh-CN": "缺失或为空" },

  // ── e2e-guard (/e2e-guard) ──
  "guard.e2e.help": {
    en: "[e2e-guard] E2E Red-Line Guard — project switch controls.\nUsage:\n/e2e-guard status   → check current guard status (on / off)\n/e2e-guard on | off → flip the project gate in opencode.jsonc (persisted)",
    "zh-CN": "[e2e-guard] E2E 红线护栏 —— 项目开关控制。\n用法：\n/e2e-guard status   → 查看当前护栏状态 (on / off)\n/e2e-guard on | off → 翻转 opencode.jsonc 中的项目开关（持久化）",
  },
  "guard.e2e.status": { en: "[e2e-guard] gate: {gate}. (Protocol injection is {flag})", "zh-CN": "[e2e-guard] gate: {gate}。（协议注入 {flag}）" },
  "guard.e2e.set": { en: "[e2e-guard] Gate {STATE} — wrote \"e2eGuard\": \"{state}\" to {path}.", "zh-CN": "[e2e-guard] 护栏已{zhState} —— 已把 \"e2eGuard\": \"{state}\" 写入 {path}。" },
  "guard.e2e.setFail": { en: "[e2e-guard] Failed to write the project config — edit the \"e2eGuard\" field of opencode.jsonc by hand.", "zh-CN": "[e2e-guard] 写入项目配置失败 —— 请手工编辑 opencode.jsonc 的 \"e2eGuard\" 字段。" },
  "guard.e2e.unknown": { en: "[e2e-guard] Unknown subcommand \"{sub}\".", "zh-CN": "[e2e-guard] 未知子命令 \"{sub}\"。" },
  "guard.e2e.announceOn": { en: "[e2e-guard] ON — E2E runs are blocked until the user confirms and /e2e-guard allow grants a one-shot pass. /e2e-guard off to disable.", "zh-CN": "[e2e-guard] ON —— E2E 运行会被拦截，直到用户确认并由 /e2e-guard allow 发放一次性放行。用 /e2e-guard off 关闭。" },
  "guard.e2e.announceOff": { en: "[e2e-guard] OFF — no E2E gating. /e2e-guard on to require user confirmation before E2E runs in this project.", "zh-CN": "[e2e-guard] OFF —— 不做 E2E 门控。用 /e2e-guard on 要求本项目 E2E 运行前先经用户确认。" },
  "guard.e2e.statusMsg": { en: "[e2e-guard] Status: {state} | switch: /e2e-guard on|off (project-level, stored in opencode.jsonc) | allow: /e2e-guard allow (one full-suite pass) | allow targeted: unlock affected-spec re-runs only, full suites stay gated", "zh-CN": "[e2e-guard] Status: {state} | 开关：/e2e-guard on|off（项目级，存于 opencode.jsonc）| 放行：/e2e-guard allow（一次整套运行）| targeted 放行：仅解锁受影响 spec 的重跑，整套运行仍需门控" },
  "guard.e2e.allowFull": { en: "[e2e-guard] Approved — the next FULL-suite run passes (one-shot). Targeted single-spec re-runs stay unlocked for the rest of this session; each later FULL-suite run needs a fresh user confirmation.", "zh-CN": "[e2e-guard] Approved —— 下一次整套（FULL）运行放行（一次性）。本会话后续受影响 spec 的定向重跑保持解锁；每次整套运行仍需用户重新确认。" },
  "guard.e2e.allowTargeted": { en: "[e2e-guard] Approved (TARGETED only) — targeted spec re-runs now pass for the rest of this session. Full-suite runs stay gated and still need a fresh confirmation + /e2e-guard allow.", "zh-CN": "[e2e-guard] Approved（仅 TARGETED）—— 本会话内定向 spec 重跑现已放行。整套运行仍然门控，需要新的确认 + /e2e-guard allow。" },

  // ── adr-guard (/adr-guard, /adr) ──
  "guard.adr.announceOn": { en: "[adr-guard] ON — every feat/refactor commit requires a new/updated ADR ({dir}/). /adr-guard off to disable.", "zh-CN": "[adr-guard] ON —— 每个 feat/refactor 提交都需要新增/更新 ADR（{dir}/）。用 /adr-guard off 关闭。" },
  "guard.adr.announceOff": { en: "[adr-guard] OFF — no ADR enforcement. /adr-guard on to enable the iron law for this project.", "zh-CN": "[adr-guard] OFF —— 不做 ADR 强制。用 /adr-guard on 为本项目启用铁律。" },
  "guard.adr.statusMsg": { en: "[adr-guard] Status: {state} | ADR dir: {dir}/ | switch: /adr-guard on|off (project-level, stored in opencode.jsonc)", "zh-CN": "[adr-guard] Status: {state} | ADR 目录：{dir}/ | 开关：/adr-guard on|off（项目级，存于 opencode.jsonc）" },
  "guard.adr.help": {
    en: "### 🏛️ Architecture Decision Records (/adr)\n\nCurrent Layout: **`{mode}`**\n\nCommands:\n- `/adr [new] [layer/scope] <title> [--empty]` — Create and auto-draft a new ADR (use --empty for template only)\n- `/adr supersede <old-id> <new-title> [--empty]` — Supersede an old decision & auto-draft replacement\n- `/adr tree` — Visualize hierarchical decision tree & Mermaid DAG\n- `/adr check` — Verify ADR integrity, links, and complexity advice\n- `/adr layout [auto|flat|hierarchical]` — Configure ADR layout\n- `/adr migrate [flat|hierarchical] [--confirm]` — Plan and restructure ADR architecture\n- `/adr-guard on|off|status` — Toggle commit guard enforcement",
    "zh-CN": "### 🏛️ 架构决策记录 (/adr)\n\n当前布局：**`{mode}`**\n\n命令：\n- `/adr [new] [层级/范围] <标题> [--empty]` — 新建并自动起草 ADR（--empty 仅生成模板）\n- `/adr supersede <旧id> <新标题> [--empty]` — 取代旧决策并自动起草替代文档\n- `/adr tree` — 展示层级决策树 & Mermaid DAG\n- `/adr check` — 校验 ADR 完整性、链接并给出复杂度建议\n- `/adr layout [auto|flat|hierarchical]` — 配置 ADR 布局\n- `/adr migrate [flat|hierarchical] [--confirm]` — 规划并重组 ADR 架构\n- `/adr-guard on|off|status` — 切换提交护栏强制检查",
  },
  "guard.adr.layoutCurrent": { en: "🏛️ ADR Layout is currently set to: **`{mode}`** (in project opencode.jsonc)\nOptions: `/adr layout auto`, `/adr layout flat`, `/adr layout hierarchical`", "zh-CN": "🏛️ ADR 布局当前为：**`{mode}`**（项目 opencode.jsonc）\n可选：`/adr layout auto`、`/adr layout flat`、`/adr layout hierarchical`" },
  "guard.adr.layoutInvalid": { en: "❌ Invalid ADR layout `{rest}`. Valid values are: `auto`, `flat`, `hierarchical`.", "zh-CN": "❌ 无效的 ADR 布局 `{rest}`。可选：`auto`、`flat`、`hierarchical`。" },
  "guard.adr.layoutSet": { en: "✅ ADR Layout updated to: **`{mode}`** (saved in project opencode.jsonc).", "zh-CN": "✅ ADR 布局已更新为 **`{mode}`**（已保存到项目 opencode.jsonc）。" },
  "guard.adr.migrateHint": { en: "💡 **Restructuring Available**: {count} file(s) can be automatically reorganized to match the `{mode}` layout.\nRun `/adr migrate {mode}` to preview and apply.", "zh-CN": "💡 **可重组**：{count} 个文件可自动整理为 `{mode}` 布局。\n运行 `/adr migrate {mode}` 预览并执行。" },
  "guard.adr.migrateNone": { en: "ℹ️ **ADR Migration Plan ({cur} $\\to$ {target})**:\nAll ADR files are already in optimal locations. No file moves required.", "zh-CN": "ℹ️ **ADR 迁移计划（{cur} → {target}）**：\n所有 ADR 文件已在最佳位置，无需移动。" },
  "guard.adr.migrateDoneHead": { en: "🎉 **ADR Migration Completed ({cur} $\\to$ {target})**\n\nSuccessfully relocated **{count}** file(s) and synchronized indexes:\n\n", "zh-CN": "🎉 **ADR 迁移完成（{cur} → {target}）**\n\n已成功移动 **{count}** 个文件并同步索引：\n\n" },
  "guard.adr.migratePreviewHead": { en: "📋 **ADR Migration Preview ({cur} $\\to$ {target})**\n\nProposed Restructuring Plan (**{count}** moves):\n\n", "zh-CN": "📋 **ADR 迁移预览（{cur} → {target}）**\n\n拟议重组计划（**{count}** 次移动）：\n\n" },
  "guard.adr.migrateTableHead": { en: "| Source Path | Target Path | Title | Layer |\n| :--- | :--- | :--- | :--- |\n", "zh-CN": "| 源路径 | 目标路径 | 标题 | 层级 |\n| :--- | :--- | :--- | :--- |\n" },
  "guard.adr.migrateNoWrite": { en: "\n⚠️ *No files have been modified yet.* To execute this migration, run:\n", "zh-CN": "\n⚠️ *尚未修改任何文件。* 要执行本迁移，请运行：\n" },
  "guard.adr.checkOk": { en: "✅ **ADR Integrity Check Passed**: All ADRs, links, and indexes are consistent.\n\n", "zh-CN": "✅ **ADR 完整性检查通过**：所有 ADR、链接与索引一致。\n\n" },
  "guard.adr.checkIssues": { en: "⚠️ **ADR Integrity Issues Found ({count})**:\n\n", "zh-CN": "⚠️ **发现 ADR 完整性问题（{count}）**：\n\n" },
  "guard.adr.complexityHead": { en: "💡 **Architecture Complexity Advisory**:\n", "zh-CN": "💡 **架构复杂度建议**：\n" },
  "guard.adr.complexityRun": { en: "👉 Run `/adr migrate {mode}` to preview the recommended restructuring.", "zh-CN": "👉 运行 `/adr migrate {mode}` 预览建议的重组方案。" },
  "guard.adr.newUsage": { en: "❌ Usage: `/adr [new] [system|domain|component|scope] <title> [--empty]`\nExample: `/adr \"Core Event Architecture\"` or `/adr new system \"Core Event Architecture\"`", "zh-CN": "❌ 用法：`/adr [new] [system|domain|component|范围] <标题> [--empty]`\n示例：`/adr \"核心事件架构\"` 或 `/adr new system \"核心事件架构\"`" },
  "guard.adr.createdScaffold": { en: "✅ **Created ADR [{id}] ({layer}) [Scaffold Only]**\n\n- File: `{file}`\n- Empty template ready. Edit file and commit alongside your code.", "zh-CN": "✅ **已创建 ADR [{id}]（{layer}）[仅骨架]**\n\n- 文件：`{file}`\n- 空模板已就绪。编辑该文件并随代码一起提交。" },
  "guard.adr.created": { en: "✅ **Created ADR [{id}] ({layer})**\n\n- File: `{file}`\n- 🤖 *Agent is analyzing codebase context and auto-drafting decision document...*\n- 💡 *SDD Lifecycle: After drafting this ADR, proceed to `/plan` or jump directly to `/impl`.*", "zh-CN": "✅ **已创建 ADR [{id}]（{layer}）**\n\n- 文件：`{file}`\n- 🤖 *智能体正在分析代码库上下文并自动起草决策文档...*\n- 💡 *SDD 生命周期：起草本 ADR 后，进入 `/plan` 或直接跳到 `/impl`。*" },
  "guard.adr.createFail": { en: "❌ Failed to create ADR: {err}", "zh-CN": "❌ 创建 ADR 失败：{err}" },
  "guard.adr.supUsage": { en: "❌ Usage: `/adr supersede <old-id-or-path> <new-title> [--empty]`\nExample: `/adr supersede 0001 \"NATS Streaming Standard\"`", "zh-CN": "❌ 用法：`/adr supersede <旧id或路径> <新标题> [--empty]`\n示例：`/adr supersede 0001 \"NATS 流式标准\"`" },
  "guard.adr.supMissingTitle": { en: "❌ Missing new ADR title.\nUsage: `/adr supersede <old-id-or-path> <new-title> [--empty]`", "zh-CN": "❌ 缺少新 ADR 标题。\n用法：`/adr supersede <旧id或路径> <新标题> [--empty]`" },
  "guard.adr.supDoneScaffold": { en: "🔄 **Superseded ADR [{old}] $\\to$ [{new}] [Scaffold Only]**\n\n- Old ADR: `{oldPath}` (marked as superseded)\n- New ADR: `{newPath}` (accepted)\n- Indexes updated.", "zh-CN": "🔄 **已取代 ADR [{old}] → [{new}] [仅骨架]**\n\n- 旧 ADR：`{oldPath}`（已标记为被取代）\n- 新 ADR：`{newPath}`（已采纳）\n- 索引已更新。" },
  "guard.adr.supDone": { en: "🔄 **Superseded ADR [{old}] $\\to$ [{new}]**\n\n- Old ADR: `{oldPath}` (marked as superseded)\n- New ADR: `{newPath}` (accepted)\n- 🤖 *Agent is analyzing codebase context and auto-drafting replacement decision...*\n- 💡 *SDD Lifecycle: After drafting this ADR, proceed to `/plan` or jump directly to `/impl`.*", "zh-CN": "🔄 **已取代 ADR [{old}] → [{new}]**\n\n- 旧 ADR：`{oldPath}`（已标记为被取代）\n- 新 ADR：`{newPath}`（已采纳）\n- 🤖 *智能体正在分析代码库上下文并自动起草替代决策...*\n- 💡 *SDD 生命周期：起草本 ADR 后，进入 `/plan` 或直接跳到 `/impl`。*" },
  "guard.adr.supFail": { en: "❌ Failed to supersede ADR: {err}", "zh-CN": "❌ 取代 ADR 失败：{err}" },
  "guard.adr.unknown": { en: "Unknown subcommand `{sub}`. Run `/adr help` for available commands.", "zh-CN": "未知子命令 `{sub}`。运行 `/adr help` 查看可用命令。" },

  // ── project-manager (/project) ──
  "guard.pm.help": {
    en: "[project-manager] Project scaffolding & configuration manager.\n\nUsage:\n- `ocp project init --wizard` → open the interactive project setup wizard\n- /project        → show available subcommands & options (CLI mode)\n- /project init   → scaffold baseline files & bootstrap indexes (headless / non-TUI):\n                    create baseline files if missing (never overwrites):\n                    .opencode/opencode.jsonc, docs/git-commits.md, AGENTS.md\n                    An EXISTING project config gets an append-only top-up:\n                    switch lines the template gained since init are added,\n                    existing content is never changed.\n                    Then run every first-time backend init step — each only\n                    when its CLI is installed and enabled:\n                      codegraph init    one-time; watcher keeps it fresh\n                      gitnexus analyze  initial index build (index missing)\n                      dbhub.toml        scaffolded when the dbhub MCP is\n                                        enabled and its CLI is installed\n                      gitnexus hooks    post-commit/post-merge/post-checkout\n                                        auto-refresh the GitNexus index when\n                                        gitnexus is enabled; removed when not\n- /project setup  → inspect current project switches & setup options (CLI mode)\n- /project index  → manual rebuild/refresh for EXISTING indexes\n- /project sync   → top up an EXISTING {cfg} with template switches",
    "zh-CN": "[project-manager] 项目脚手架与配置管理器。\n\n用法：\n- `ocp project init --wizard` → 打开交互式项目设置向导\n- /project        → 显示子命令与选项（CLI 模式）\n- /project init   → 生成基线文件并引导索引（无头 / 非 TUI）：\n                    缺失时创建基线文件（从不覆盖）：\n                    .opencode/opencode.jsonc、docs/git-commits.md、AGENTS.md\n                    已有项目配置会获得只追加式补齐：\n                    添加 init 之后模板新增的开关行，既有内容永不改动。\n                    随后运行各后端的首次初始化 —— 仅当其 CLI\n                    已安装且已启用：\n                      codegraph init    一次性；watcher 保持新鲜\n                      gitnexus analyze  初次索引构建（索引缺失时）\n                      dbhub.toml        dbhub MCP 已启用且 CLI 已安装时生成\n                      gitnexus hooks    gitnexus 启用时注册 post-commit/\n                                        post-merge/post-checkout 自动刷新\n                                        钩子；未启用时移除\n- /project setup  → 查看当前项目开关与设置选项（CLI 模式）\n- /project index  → 手动重建/刷新已有索引\n- /project sync   → 用模板开关补齐现有的 {cfg}",
  },
  "guard.pm.initHead": { en: "[project-manager] init done in {dir} — {created} created, {updated} updated, {invalid} invalid, {skipped} skipped", "zh-CN": "[project-manager] init 完成于 {dir} —— 新建 {created}、更新 {updated}、无效 {invalid}、跳过 {skipped}" },
  "guard.pm.created": { en: "  ✅ created {rel}", "zh-CN": "  ✅ 已创建 {rel}" },
  "guard.pm.updated": { en: "  ♻️ updated {rel} (appended new template switches; existing content untouched)", "zh-CN": "  ♻️ 已更新 {rel}（追加新模板开关；既有内容未动）" },
  "guard.pm.invalid": { en: "  ⚠️ {rel} is malformed (no proper closing brace) — left untouched, fix it manually", "zh-CN": "  ⚠️ {rel} 格式有误（缺少正确的右花括号）—— 保持原样，请手工修复" },
  "guard.pm.skippedFile": { en: "  ⏭️ skipped {rel} (already exists)", "zh-CN": "  ⏭️ 跳过 {rel}（已存在）" },
  "guard.pm.lineOk": { en: "  ✅ {name}: {detail}", "zh-CN": "  ✅ {name}：{detail}" },
  "guard.pm.lineUpdated": { en: "  ♻️ {name}: {detail}", "zh-CN": "  ♻️ {name}：{detail}" },
  "guard.pm.lineFail": { en: "  ❌ {name}: {detail}", "zh-CN": "  ❌ {name}：{detail}" },
  "guard.pm.lineSkip": { en: "  ⏭️ {name}: skipped — {detail}", "zh-CN": "  ⏭️ {name}：跳过 —— {detail}" },
  "guard.pm.unknown": { en: "[project-manager] Unknown subcommand \"{sub}\".", "zh-CN": "[project-manager] 未知子命令 \"{sub}\"。" },
  "guard.pm.failed": { en: "[project-manager] {sub} failed: {err}", "zh-CN": "[project-manager] {sub} 失败：{err}" },
  "guard.pm.indexHead": { en: "[project-manager] index done in {dir}", "zh-CN": "[project-manager] index 完成于 {dir}" },
  "guard.pm.syncMissing": { en: "[project-manager] sync in {dir}: {cfg} does not exist — run /project init first", "zh-CN": "[project-manager] sync 于 {dir}：{cfg} 不存在 —— 请先运行 /project init" },
  "guard.pm.syncInvalid": { en: "[project-manager] sync in {dir}: {cfg} is malformed (no proper closing brace) — left untouched, fix it manually", "zh-CN": "[project-manager] sync 于 {dir}：{cfg} 格式有误（缺少正确的右花括号）—— 保持原样，请手工修复" },
  "guard.pm.syncUptodate": { en: "[project-manager] sync in {dir}: {cfg} already has every template switch — nothing to add", "zh-CN": "[project-manager] sync 于 {dir}：{cfg} 已包含全部模板开关 —— 无需添加" },
  "guard.pm.syncAppended": { en: "[project-manager] sync in {dir}: appended {count} new switch line(s) to {cfg} (existing content untouched):", "zh-CN": "[project-manager] sync 于 {dir}：已向 {cfg} 追加 {count} 行新开关（既有内容未动）：" },
  "guard.pm.setup": {
    en: "[project-manager] Project setup status in {dir}:\n- Interactive CLI: run `ocp project init --wizard` to open the project setup wizard.\n- Headless / CLI: run /project init to scaffold baseline files and bootstrap indexes.\n- Config sync: run /project sync to append newly added template switches.",
    "zh-CN": "[project-manager] 项目设置状态（{dir}）：\n- 交互式 CLI：运行 `ocp project init --wizard` 打开项目设置向导。\n- 无头 / CLI：运行 /project init 生成基线文件并引导索引。\n- 配置同步：运行 /project sync 追加新增的模板开关。",
  },
  "guard.pm.suggestInit": { en: "[project-manager] This project has never been initialized ({files}). Run `/project init` to scaffold them (never overwrites) and run the first-time backend init.{extras}", "zh-CN": "[project-manager] 本项目从未初始化过（{files}）。运行 `/project init` 生成基线文件（从不覆盖）并执行后端首次初始化。{extras}" },
  "guard.pm.suggestMissing": { en: "missing baseline files: {files}", "zh-CN": "缺失基线文件：{files}" },
  "guard.pm.hintCodegraph": { en: "codegraph CLI is installed but not indexed", "zh-CN": "codegraph CLI 已安装但未建索引" },
  "guard.pm.hintGitnexus": { en: "gitnexus CLI is installed but not indexed", "zh-CN": "gitnexus CLI 已安装但未建索引" },
  "guard.pm.hintTail": { en: " Also: {hints} — init covers both.", "zh-CN": " 另外：{hints} —— init 会一并处理。" },
} as const

export type StringKey = keyof typeof STRINGS

// ─── tr() function ───────────────────────────────────────────────────

export function tr(key: StringKey, params?: Record<string, string | number>): string {
  const entry = STRINGS[key] as StringEntry | undefined
  if (!entry) return key
  const text: string = entry[currentLocale] ?? entry.en
  if (!params) return text
  // Single pass: values are never rescanned for placeholders (no chained
  // substitution) and a function-replacer avoids `$&`/`$1` expansion when
  // an interpolated path or name contains `$`. Unknown {tokens} survive.
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole)
}

/**
 * Extract the first non-command token from a keymap command context —
 * i.e. the slash argument. `commandTokens` lists every known spelling of
 * the command itself ("my.cmd", "my", "/my") so it gets skipped. Same
 * semantics as usage.ts's parseSubcommand, generalized for any wizard.
 */
export function parseSlashArgs(ctx: unknown, commandTokens: string[]): string | null {
  const known = new Set(commandTokens.map((t) => t.toLowerCase()))
  if (typeof ctx !== "object" || ctx === null) return null
  const c = ctx as { input?: unknown; payload?: unknown; data?: { args?: unknown } }
  const sources = [c.data?.args, c.payload, c.input]
  for (const raw of sources) {
    const parts = Array.isArray(raw) ? raw : [raw]
    for (const item of parts) {
      if (typeof item !== "string" || item.trim() === "") continue
      const tokens = item.trim().split(/\s+/).map((t) => t.toLowerCase())
      let i = 0
      while (i < tokens.length && known.has(tokens[i])) i++
      if (i < tokens.length) return tokens[i]
    }
  }
  return null
}

// ─── Language switch (shared by all wizard main menus) ─────────────

export const SWITCH_LANG = "__switch_lang__"

/**
 * Central language-switch action. With two registered locales it
 * toggles directly (one-click); with more it opens a locale picker.
 * `reopen` re-renders the caller's menu so it refreshes in the new
 * language. Adding a locale requires NO wizard-side changes.
 *
 * Usage:
 *   import { languageOption, switchLanguage, SWITCH_LANG } from "./i18n"
 *   // in options array:  languageOption(api)
 *   // in onSelect:
 *   if (option.value === SWITCH_LANG) {
 *     switchLanguage(api, () => showMainMenu(api))
 *     return
 *   }
 */
export function switchLanguage(api: TuiPluginApi, reopen: () => void): void {
  const apply = (code: Locale) => {
    setLocale(api, code)
    try {
      api.ui.toast({ title: tr("common.langTitle"), message: tr("common.langSwitched", { lang: localeName(code) }), variant: "info" })
    } catch { /* ui.toast unsupported */ }
    reopen()
  }
  if (LOCALES.length <= 2) {
    apply(nextLocale())
    return
  }
  let navigated = false
  api.ui.dialog.replace(
    () =>
      api.ui.DialogSelect<Locale>({
        title: tr("common.langTitle"),
        placeholder: tr("common.langPickPlaceholder"),
        options: LOCALES.map((l) => ({ title: l.name, value: l.code })),
        current: currentLocale,
        onSelect: (option) => {
          navigated = true
          apply(option.value)
        },
      }),
    () => {
      // Esc closes the picker — return to the caller's menu; the host
      // clears the dialog first, so delay one beat before re-opening.
      if (!navigated) setTimeout(reopen, 0)
    },
  )
}

/**
 * Menu option for language switching, inserted into any wizard's main
 * DialogSelect options array. Handle it via `switchLanguage` above.
 */
export function languageOption(_api: TuiPluginApi): DialogOption<string> {
  // two locales → show the direct toggle target; more → the picker decides
  const title = LOCALES.length <= 2
    ? `🌐 ${localeName(currentLocale)} → ${localeName(nextLocale())}`
    : `🌐 ${localeName(currentLocale)}`
  return {
    title,
    value: SWITCH_LANG,
    description: tr("common.langDesc"),
  }
}
