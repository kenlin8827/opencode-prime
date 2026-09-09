/// <reference types="bun" />
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import { tr, initI18n, languageOption, switchLanguage, SWITCH_LANG, type DialogOption } from "./i18n"
import {
  CONFIG_REL,
  getProjectDir,
  setProjectDir,
} from "../project-manager/project-manager-config"
import type { BackendResult } from "../project-manager/project-manager-index"
import type { HookResult } from "../project-manager/project-manager-hooks"
import { indexProject, initProject, syncProject } from "../project-manager/project-manager-operations"
import {
  applySwitchesToConfigContent,
  generateConfigContent,
  type ProjectSwitches,
  type ScaffoldResult,
} from "../project-manager/project-manager-scaffold"
import { planDprintSetup, setupDprint } from "../project-manager/project-manager-dprint"
import {
  detectProjectSwitches,
  PROJECT_SWITCH_OPTIONS,
} from "../project-manager/project-manager-options"

/**
 * Project Wizard — TUI dialog-based project initialization and switch configuration.
 *
 * Menu selection flow:
 *   - Each switch opens a dedicated Select dialog with clear choices.
 *   - Built-in `skipFilter: true` ensures pure direction-key selection (no typing required).
 *   - When the project already exists, loads existing configuration and echoes
 *     the active/commented switches in the dialog.
 *
 * Registered via `tui.json` → `plugin` array.
 */

const PLUGIN_ID = "opencode-prime.project-wizard"

/**
 * Project root for scaffolding: opencode's resolved project directory.
 * process.cwd() is the TUI process launch cwd (e.g. C:\Windows\System32
 * when started from a Windows shortcut) and MUST NOT be trusted.
 */
function projectRoot(api: TuiPluginApi): string {
  return api.state.path.directory || process.cwd()
}

function toast(
  api: TuiPluginApi,
  message: string,
  variant: "info" | "success" | "warning" | "error" = "info",
): void {
  try {
    api.ui.toast({ title: tr("project.toastTitle"), message, variant })
  } catch {
    // safe fallback if ui.toast is unsupported
  }
}

export interface DetectedProjectState {
  exists: boolean
  configPath?: string
  configRelPath?: string
  switches: ProjectSwitches
}

/** Toggle helper for on/off/default boolean-like switches. */
export function toggleGuardState(
  current?: "on" | "off" | "default",
): "on" | "off" | "default" {
  const values = PROJECT_SWITCH_OPTIONS.adrGuard.map((option) => option.value)
  const index = values.indexOf(current ?? "default")
  return values[(index + 1) % values.length]
}

/** Cycle helper for autoAdvisorMode (lite -> full -> off -> default -> lite). */
export function cycleAdvisorMode(
  current?: "off" | "lite" | "full" | "default",
): "off" | "lite" | "full" | "default" {
  const values = PROJECT_SWITCH_OPTIONS.autoAdvisorMode.map((option) => option.value)
  const index = values.indexOf(current ?? "default")
  return values[(index + 1) % values.length]
}

/** Detect initial switch values from existing project config or defaults. */
export function detectCurrentSwitches(rootDir: string): DetectedProjectState {
  return detectProjectSwitches(rootDir)
}
function formatGuardBadge(val?: "on" | "off" | "default"): string {
  if (val === "on") return "🟢 ON"
  if (val === "off") return "🔴 OFF"
  return "⚪ default"
}

function formatAdrModeBadge(val?: "auto" | "flat" | "hierarchical" | "default"): string {
  if (val === "auto") return "🟢 auto"
  if (val === "flat") return "📄 flat"
  if (val === "hierarchical") return "📦 hierarchy"
  return "⚪ default"
}

function formatAdvisorBadge(val?: "off" | "lite" | "full" | "default"): string {
  if (val === "lite") return "🟢 lite"
  if (val === "full") return "🔵 full"
  if (val === "off") return "🔴 off"
  return "⚪ default"
}

function backendLine(r: BackendResult): string {
  if (r.status === "ran") return `  ✅ ${r.backend}: ${r.detail}`
  if (r.status === "failed") return `  ❌ ${r.backend}: ${r.detail}`
  return `  ⏭️ ${r.backend}: skipped (${r.detail})`
}

function initReport(results: ScaffoldResult[], backends: BackendResult[], hooks: HookResult[]): string {
  const lines = results.map((r) => {
    if (r.status === "created") return `  ✅ created ${r.relPath}`
    if (r.status === "updated") return `  ♻️ updated ${r.relPath}`
    if (r.status === "invalid") return `  ⚠️ malformed ${r.relPath}`
    return `  ⏭️ kept ${r.relPath}`
  })
  const hookLines = hooks.map((r) => {
    if (r.status === "registered") return `  ✅ ${r.hook}: ${r.detail}`
    if (r.status === "updated") return `  ♻️ ${r.hook}: ${r.detail}`
    if (r.status === "failed") return `  ❌ ${r.hook}: ${r.detail}`
    return `  ⏭️ ${r.hook}: skipped (${r.detail})`
  })
  return `Target: ${getProjectDir()}\n\nFiles:\n${lines.join("\n")}\n\nBackends:\n${backends.map(backendLine).join("\n")}\n\nHooks:\n${hookLines.join("\n")}`
}

export interface WizardState {
  switches: ProjectSwitches
  exists: boolean
  configRelPath?: string
  currentSelection?: string
}

export function startProjectWizard(
  api: TuiPluginApi,
  stateOverride?: WizardState,
): void {
  const rootDir = projectRoot(api)
  setProjectDir(rootDir)

  const detected = detectCurrentSwitches(rootDir)
  const isExisting = stateOverride ? stateOverride.exists : detected.exists
  const configRel = stateOverride ? stateOverride.configRelPath : detected.configRelPath
  const current: ProjectSwitches = stateOverride ? stateOverride.switches : detected.switches

  showMainMenu(api, {
    switches: current,
    exists: isExisting,
    configRelPath: configRel,
    currentSelection: stateOverride?.currentSelection ?? "__action_init__",
  })
}

/**
 * Renders authentic DialogAlert popup modal and safely returns to wizard
 * upon confirmation or Esc.
 *
 * DialogAlert only has onConfirm (no onCancel), so we use dialog.replace's
 * second argument (onClose) to catch the Esc key.  A navigated flag is
 * flipped before any navigation to prevent double-firing: the dialog stack
 * invokes onClose again while clearing/replacing the stack, and pops the
 * stack only after onClose returns (so re-rendering must be deferred).
 */
function showAlertModal(
  api: TuiPluginApi,
  params: {
    title: string
    message: string
    onDismiss: () => void
    onConfirm?: () => void
  },
): void {
  let navigated = false
  api.ui.dialog.replace(
    () =>
      api.ui.DialogAlert({
        title: params.title,
        message: params.message,
        onConfirm: () => {
          navigated = true
          setTimeout(() => {
            ;(params.onConfirm ?? params.onDismiss)()
          }, 20)
        },
      }),
    () => {
      if (navigated) return
      navigated = true
      // Defer: stack pops after onClose returns; sync re-render is wiped and re-fires onClose
      setTimeout(() => {
        params.onDismiss()
      }, 20)
    },
  )
}

/** Level 1 Menu: Select primary action */
function showMainMenu(api: TuiPluginApi, state: WizardState): void {
  const rootDir = projectRoot(api)
  const { switches: current, exists: isExisting, configRelPath: configRel } = state
  const activeSelection = state.currentSelection ?? "__action_init__"

  const dialogTitle = isExisting
    ? tr("project.setupExisting", { config: configRel ?? ".opencode/opencode.jsonc" })
    : tr("project.newProject")

  const mainActionTitle = isExisting
    ? tr("project.applyUpdate")
    : tr("project.applyInit")

  const mainActionDesc = isExisting
    ? tr("project.applyUpdateDesc")
    : tr("project.applyInitDesc")

  const switchesSummary = tr("project.summary", {
    adv: current.autoAdvisorMode ?? "def",
    adr: current.adrGuard ?? "def",
    env: current.envGuard ?? "def",
    e2e: current.e2eGuard ?? "def",
  })
  const dprintPlan = planDprintSetup(rootDir)

  // The host DialogSelect renders `category` as bold accent section
  // headers that are NOT focusable options — real grouping, no fake rows.
  const setupCat = tr("project.setupHeader")
  const maintainCat = tr("project.maintainHeader")
  const actionsCat = tr("project.actionsHeader")
  const items: DialogOption<string>[] = [
    { title: mainActionTitle, value: "__action_init__", description: mainActionDesc, category: setupCat },
    ...(!isExisting && dprintPlan.status === "eligible" ? [{
      title: tr("project.setupDprint"),
      value: "__action_dprint__",
      description: tr("project.setupDprintDesc"),
      category: setupCat,
    }] : []),
    { title: tr("project.configureSwitches"), value: "__action_switches__", description: switchesSummary, category: setupCat },
    { title: tr("project.syncTemplates"), value: "__action_sync__", description: tr("project.syncTemplatesDesc"), category: maintainCat },
    { title: tr("project.refreshIndex"), value: "__action_index__", description: tr("project.refreshIndexDesc"), category: maintainCat },
    { title: tr("project.exitWizard"), value: "__action_exit__", description: tr("project.exitWizardDesc"), category: actionsCat },
    { ...languageOption(api), category: tr("common.interfaceHeader") },
  ]

  let navigated = false
  api.ui.dialog.replace(
    () =>
      api.ui.DialogSelect<string>({
      title: dialogTitle,
      placeholder: tr("project.mainPlaceholder"),
      skipFilter: true,
      current: activeSelection,
      options: items,
      onSelect: async (option) => {
        navigated = true
        switch (option.value) {
          case SWITCH_LANG: {
            switchLanguage(api, () => showMainMenu(api, state))
            return
          }
          case "__action_exit__": {
            api.ui.dialog.clear()
            break
          }
          case "__action_init__": {
            try {
              const result = await initProject({ root: rootDir, switches: current })
              const report = initReport(result.files, result.backends, result.hooks)
              toast(
                api,
                isExisting ? tr("project.configUpdated") : tr("project.initSuccess"),
                "success",
              )
              showAlertModal(api, {
                title: isExisting ? tr("project.updateResult") : tr("project.initResult"),
                message: report,
                onDismiss: () =>
                  showMainMenu(api, {
                    ...state,
                    exists: true,
                    currentSelection: "__action_init__",
                  }),
              })
            } catch (err) {
              showAlertModal(api, {
                title: tr("project.initFailed"),
                message: tr("project.operationFailed", { err: (err as Error).message }),
                onDismiss: () =>
                  showMainMenu(api, {
                    ...state,
                    currentSelection: "__action_init__",
                  }),
              })
            }
            break
          }

          case "__action_dprint__": {
            showAlertModal(api, {
              title: tr("project.setupDprintConfirmTitle"),
              message: tr("project.setupDprintConfirm"),
              onConfirm: () => {
                void setupDprint(rootDir).then(
                  () => {
                    toast(api, tr("project.setupDprintDone"), "success")
                    showAlertModal(api, {
                      title: tr("project.setupDprintConfirmTitle"),
                      message: tr("project.setupDprintDone"),
                      onDismiss: () => showMainMenu(api, { ...state, currentSelection: "__action_dprint__" }),
                    })
                  },
                  (err) => showAlertModal(api, {
                    title: tr("project.setupDprintFailed"),
                    message: tr("project.operationFailed", { err: (err as Error).message }),
                    onDismiss: () => showMainMenu(api, { ...state, currentSelection: "__action_dprint__" }),
                  }),
                )
              },
              onDismiss: () => showMainMenu(api, { ...state, currentSelection: "__action_dprint__" }),
            })
            break
          }

          case "__action_switches__": {
            showSwitchesMenu(api, {
              ...state,
              currentSelection: "__switch_advisor__",
            })
            break
          }

          case "__action_sync__": {
            try {
              const res = syncProject(rootDir)
              let syncMsg = ""
              if (res.status === "missing") {
                syncMsg = "⚠️ Project config does not exist.\nPlease run Init first."
              } else if (res.status === "up-to-date") {
                syncMsg = "ℹ️ Configuration is already up to date.\nAll latest template switch keys are already present."
              } else if (res.status === "added") {
                syncMsg = `✅ Successfully appended ${res.added.length} new switch line(s) to config:\n\n${res.added.map((k) => `  + ${k}`).join("\n")}\n\nExisting configuration content was preserved.`
              } else {
                syncMsg = "❌ Configuration file is malformed (missing proper closing brace).\nPlease fix the file manually."
              }
              showAlertModal(api, {
                title: tr("project.syncResult"),
                message: syncMsg,
                onDismiss: () =>
                  showMainMenu(api, {
                    ...state,
                    currentSelection: "__action_sync__",
                  }),
              })
            } catch (err) {
              showAlertModal(api, {
                title: tr("project.syncError"),
                message: `Sync operation failed: ${(err as Error).message}`,
                onDismiss: () =>
                  showMainMenu(api, {
                    ...state,
                    currentSelection: "__action_sync__",
                  }),
              })
            }
            break
          }

          case "__action_index__": {
            try {
              const results = await indexProject(rootDir)
              const msg =
                results.map(backendLine).join("\n") || "ℹ️ No backends needed index refresh."
              showAlertModal(api, {
                title: tr("project.indexResult"),
                message: msg,
                onDismiss: () =>
                  showMainMenu(api, {
                    ...state,
                    currentSelection: "__action_index__",
                  }),
              })
            } catch (err) {
              showAlertModal(api, {
                title: tr("project.indexError"),
                message: tr("project.indexFailed", { err: (err as Error).message }),
                onDismiss: () =>
                  showMainMenu(api, {
                    ...state,
                    currentSelection: "__action_index__",
                  }),
              })
            }
            break
          }
        }
      },
    }),
    () => {
      // Esc on main menu = close wizard entirely
      if (navigated) return
      navigated = true
      api.ui.dialog.clear()
    },
  )
}

/** Level 2 Menu: Configure Switches and Quality Guards */
function showSwitchesMenu(api: TuiPluginApi, state: WizardState): void {
  const rootDir = projectRoot(api)
  const { switches: current, exists: isExisting, configRelPath: configRel } = state
  const activeSelection = state.currentSelection ?? "__switch_advisor__"

  // The host DialogSelect renders `category` as bold accent section
  // headers that are NOT focusable options — real grouping, no fake rows.
  const advisorCat = tr("project.advisorHeader")
  const guardsCat = tr("project.guardsHeader")
  const actionsCat = tr("project.actionsHeader")
  const items: DialogOption<string>[] = [
    { title: `🤖 autoAdvisorMode:  ${formatAdvisorBadge(current.autoAdvisorMode)}`, value: "__switch_advisor__", description: tr("project.switchAdvisor"), category: advisorCat },
    { title: `🛡️ adrGuard:         ${formatGuardBadge(current.adrGuard)}`, value: "__switch_adr__", description: tr("project.switchAdrGuard"), category: guardsCat },
    { title: `📁 adrGuardDir:      ${current.adrGuardDir ?? "docs/adr"}`, value: "__switch_adr_dir__", description: tr("project.switchAdrGuardDir"), category: guardsCat },
    { title: `🏛️ adrMode:          ${formatAdrModeBadge(current.adrMode)}`, value: "__switch_adr_mode__", description: tr("project.switchAdrMode"), category: guardsCat },
    { title: `🔒 envGuard:         ${formatGuardBadge(current.envGuard)}`, value: "__switch_env__", description: tr("project.switchEnvGuard"), category: guardsCat },
    { title: `🧪 e2eGuard:         ${formatGuardBadge(current.e2eGuard)}`, value: "__switch_e2e__", description: tr("project.switchE2eGuard"), category: guardsCat },
    { title: tr("project.saveApply"), value: "__save_switches__", description: tr("project.saveApplyDesc"), category: actionsCat },
    { title: tr("project.backToMain"), value: "__back_main__", description: tr("project.backToMainDesc"), category: actionsCat },
  ]

  let navigated = false
  api.ui.dialog.replace(
    () =>
      api.ui.DialogSelect<string>({
      title: tr("project.configureSwitchesTitle", { config: configRel ?? ".opencode/opencode.jsonc" }),
      placeholder: tr("project.configureSwitchesPlaceholder"),
      skipFilter: true,
      current: activeSelection,
      options: items,
      onSelect: async (option) => {
        navigated = true
        const nextState = { switches: current, exists: isExisting, configRelPath: configRel }
        switch (option.value) {
          case "__save_switches__": {
            try {
              const result = await initProject({ root: rootDir, switches: current })
              const report = initReport(result.files, result.backends, result.hooks)
              toast(
                api,
                isExisting ? tr("project.configSavedToast") : tr("project.initSuccess"),
                "success",
              )
              showAlertModal(api, {
                title: isExisting ? tr("project.saveResult") : tr("project.initResult"),
                message: report,
                onDismiss: () =>
                  showSwitchesMenu(api, {
                    ...nextState,
                    exists: true,
                    currentSelection: "__save_switches__",
                  }),
              })
            } catch (err) {
              showAlertModal(api, {
                title: tr("project.saveFailed"),
                message: tr("project.saveFailedMsg", { err: (err as Error).message }),
                onDismiss: () =>
                  showSwitchesMenu(api, {
                    ...nextState,
                    currentSelection: "__save_switches__",
                  }),
              })
            }
            break
          }

          case "__back_main__": {
            showMainMenu(api, {
              ...nextState,
              currentSelection: "__action_switches__",
            })
            break
          }

          case "__switch_advisor__": {
            let navAdvisor = false
api.ui.dialog.replace(
                () =>
                  api.ui.DialogSelect<string>({
                  title: tr("project.pickAdvisor"),
                  placeholder: tr("project.currentValue", { value: current.autoAdvisorMode ?? "default" }),
                  skipFilter: true,
                  current: current.autoAdvisorMode ?? "lite",
                  options: [
                    {
                      title: `🟢 lite${current.autoAdvisorMode === "lite" ? tr("project.currentMarker") : ""}`,
                      value: "lite",
                      description: tr("project.valueAdvisorLite"),
                    },
                    {
                      title: `🔵 full${current.autoAdvisorMode === "full" ? tr("project.currentMarker") : ""}`,
                      value: "full",
                      description: tr("project.valueAdvisorFull"),
                    },
                    {
                      title: `🔴 off${current.autoAdvisorMode === "off" ? tr("project.currentMarker") : ""}`,
                      value: "off",
                      description: tr("project.valueAdvisorOff"),
                    },
                    {
                      title: `⚪ default${current.autoAdvisorMode === "default" || !current.autoAdvisorMode ? tr("project.currentMarker") : ""}`,
                      value: "default",
                      description: tr("project.valueAdvisorDefault"),
                    },
                    {
                      title: tr("project.cancel"),
                      value: "__cancel__",
                      description: tr("project.cancelDesc"),
                    },
                  ],
                  onSelect: (sel) => {
                    navAdvisor = true
                    if (sel.value !== "__cancel__") {
                      current.autoAdvisorMode = sel.value as ProjectSwitches["autoAdvisorMode"]
                      toast(api, tr("project.toastAdvisor", { value: formatAdvisorBadge(current.autoAdvisorMode) }), "success")
                    }
                    showSwitchesMenu(api, {
                      ...nextState,
                      currentSelection: "__switch_advisor__",
                    })
                  },
                }),
              () => {
                // Esc on advisor picker = back to switches menu
                if (!navAdvisor) setTimeout(() => showSwitchesMenu(api, { ...nextState, currentSelection: "__switch_advisor__" }), 0)
              },
            )
            break
          }
          case "__switch_adr__": {
            let navAdr = false
api.ui.dialog.replace(
                () =>
                  api.ui.DialogSelect<string>({
                  title: tr("project.pickAdrGuard"),
                  placeholder: tr("project.currentValue", { value: current.adrGuard ?? "default" }),
                  skipFilter: true,
                  current: current.adrGuard ?? "on",
                  options: [
                    {
                      title: `🟢 on${current.adrGuard === "on" ? tr("project.currentMarker") : ""}`,
                      value: "on",
                      description: tr("project.valueGuardAdrOn"),
                    },
                    {
                      title: `🔴 off${current.adrGuard === "off" ? tr("project.currentMarker") : ""}`,
                      value: "off",
                      description: tr("project.valueGuardAdrOff"),
                    },
                    {
                      title: `⚪ default${current.adrGuard === "default" || !current.adrGuard ? tr("project.currentMarker") : ""}`,
                      value: "default",
                      description: tr("project.valueAdvisorDefault"),
                    },
                    {
                      title: tr("project.cancel"),
                      value: "__cancel__",
                      description: tr("project.cancelDesc"),
                    },
                  ],
                  onSelect: (sel) => {
                    navAdr = true
                    if (sel.value !== "__cancel__") {
                      current.adrGuard = sel.value as ProjectSwitches["adrGuard"]
                      toast(api, tr("project.toastAdrGuard", { value: formatGuardBadge(current.adrGuard) }), "success")
                    }
                    showSwitchesMenu(api, {
                      ...nextState,
                      currentSelection: "__switch_adr__",
                    })
                  },
                }),
              () => {
                // Esc on adrGuard picker = back to switches menu
                if (!navAdr) setTimeout(() => showSwitchesMenu(api, { ...nextState, currentSelection: "__switch_adr__" }), 0)
              },
            )
            break
          }
          case "__switch_adr_dir__": {
            let navAdrDir = false
api.ui.dialog.replace(
                () =>
                  api.ui.DialogSelect<string>({
                  title: tr("project.pickAdrDir"),
                  placeholder: tr("project.currentValue", { value: current.adrGuardDir ?? "docs/adr" }),
                  skipFilter: true,
                  current: current.adrGuardDir ?? "docs/adr",
                  options: [
                    {
                      title: `📁 docs/adr${(current.adrGuardDir ?? "docs/adr") === "docs/adr" ? tr("project.currentMarker") : ""}`,
                      value: "docs/adr",
                      description: tr("project.valueAdrDirDocsAdr"),
                    },
                    {
                      title: `📁 docs/decisions${current.adrGuardDir === "docs/decisions" ? tr("project.currentMarker") : ""}`,
                      value: "docs/decisions",
                      description: tr("project.valueAdrDirDocsDecisions"),
                    },
                    {
                      title: `📁 architecture/decisions${current.adrGuardDir === "architecture/decisions" ? tr("project.currentMarker") : ""}`,
                      value: "architecture/decisions",
                      description: tr("project.valueAdrDirArchitecture"),
                    },
                    {
                      title: tr("project.valueAdrDirCustom"),
                      value: "__custom__",
                      description: tr("project.valueAdrDirCustomDesc"),
                    },
                    {
                      title: tr("project.cancel"),
                      value: "__cancel__",
                      description: tr("project.cancelDesc"),
                    },
                  ],
                  onSelect: (dirOpt) => {
                    navAdrDir = true
                    if (dirOpt.value === "__cancel__") {
                      showSwitchesMenu(api, {
                        ...nextState,
                        currentSelection: "__switch_adr_dir__",
                      })
                    } else if (dirOpt.value === "__custom__") {
                      let navPrompt = false
                      api.ui.dialog.replace(
                        () =>
                          api.ui.DialogPrompt({
                            title: tr("project.promptAdrDirTitle"),
                            placeholder: tr("project.promptAdrDirPlaceholder"),
                            value: current.adrGuardDir ?? "docs/adr",
                            onConfirm: (val) => {
                              navPrompt = true
                              current.adrGuardDir = val.trim() || "docs/adr"
                              toast(api, tr("project.toastAdrDir", { value: current.adrGuardDir }), "success")
                              showSwitchesMenu(api, {
                                ...nextState,
                                currentSelection: "__switch_adr_dir__",
                              })
                            },
                            onCancel: () => {
                              navPrompt = true
                              setTimeout(() => showSwitchesMenu(api, {
                                ...nextState,
                                currentSelection: "__switch_adr_dir__",
                              }), 0)
                            },
                          }),
                        () => {
                          // Esc on custom path prompt = back to switches menu
                          if (!navPrompt) setTimeout(() => showSwitchesMenu(api, { ...nextState, currentSelection: "__switch_adr_dir__" }), 0)
                        },
                      )
                    } else {
                      current.adrGuardDir = dirOpt.value
                      toast(api, tr("project.toastAdrDir", { value: current.adrGuardDir }), "success")
                      showSwitchesMenu(api, {
                        ...nextState,
                        currentSelection: "__switch_adr_dir__",
                      })
                    }
                  },
                }),
              () => {
                // Esc on ADR directory picker = back to switches menu
                if (!navAdrDir) setTimeout(() => showSwitchesMenu(api, { ...nextState, currentSelection: "__switch_adr_dir__" }), 0)
              },
            )
            break
          }
          case "__switch_adr_mode__": {
            let navAdrMode = false
api.ui.dialog.replace(
                () =>
                  api.ui.DialogSelect<string>({
                  title: tr("project.pickAdrMode"),
                  placeholder: tr("project.currentValue", { value: current.adrMode ?? "default" }),
                  skipFilter: true,
                  current: current.adrMode ?? "auto",
                  options: [
                    {
                      title: `🟢 auto${current.adrMode === "auto" ? tr("project.currentMarker") : ""}`,
                      value: "auto",
                      description: tr("project.valueAdrModeAuto"),
                    },
                    {
                      title: `📄 flat${current.adrMode === "flat" ? tr("project.currentMarker") : ""}`,
                      value: "flat",
                      description: tr("project.valueAdrModeFlat"),
                    },
                    {
                      title: `📦 hierarchy${current.adrMode === "hierarchical" ? tr("project.currentMarker") : ""}`,
                      value: "hierarchical",
                      description: tr("project.valueAdrModeHierarchy"),
                    },
                    {
                      title: `⚪ default${current.adrMode === "default" || !current.adrMode ? tr("project.currentMarker") : ""}`,
                      value: "default",
                      description: tr("project.valueAdrModeDefault"),
                    },
                    {
                      title: tr("project.cancel"),
                      value: "__cancel__",
                      description: tr("project.cancelDesc"),
                    },
                  ],
                  onSelect: (sel) => {
                    navAdrMode = true
                    if (sel.value !== "__cancel__") {
                      current.adrMode = sel.value as ProjectSwitches["adrMode"]
                      toast(api, tr("project.toastAdrMode", { value: formatAdrModeBadge(current.adrMode) }), "success")
                    }
                    showSwitchesMenu(api, {
                      ...nextState,
                      currentSelection: "__switch_adr_mode__",
                    })
                  },
                }),
              () => {
                // Esc on adrMode picker = back to switches menu
                if (!navAdrMode) setTimeout(() => showSwitchesMenu(api, { ...nextState, currentSelection: "__switch_adr_mode__" }), 0)
              },
            )
            break
          }
          case "__switch_env__": {
            let navEnv = false
api.ui.dialog.replace(
                () =>
                  api.ui.DialogSelect<string>({
                  title: tr("project.pickEnvGuard"),
                  placeholder: tr("project.currentValue", { value: current.envGuard ?? "default" }),
                  skipFilter: true,
                  current: current.envGuard ?? "on",
                  options: [
                    {
                      title: `🟢 on${current.envGuard === "on" ? tr("project.currentMarker") : ""}`,
                      value: "on",
                      description: tr("project.valueGuardEnvOn"),
                    },
                    {
                      title: `🔴 off${current.envGuard === "off" ? tr("project.currentMarker") : ""}`,
                      value: "off",
                      description: tr("project.valueGuardEnvOff"),
                    },
                    {
                      title: `⚪ default${current.envGuard === "default" || !current.envGuard ? tr("project.currentMarker") : ""}`,
                      value: "default",
                      description: tr("project.valueAdvisorDefault"),
                    },
                    {
                      title: tr("project.cancel"),
                      value: "__cancel__",
                      description: tr("project.cancelDesc"),
                    },
                  ],
                  onSelect: (sel) => {
                    navEnv = true
                    if (sel.value !== "__cancel__") {
                      current.envGuard = sel.value as ProjectSwitches["envGuard"]
                      toast(api, tr("project.toastEnvGuard", { value: formatGuardBadge(current.envGuard) }), "success")
                    }
                    showSwitchesMenu(api, {
                      ...nextState,
                      currentSelection: "__switch_env__",
                    })
                  },
                }),
              () => {
                // Esc on envGuard picker = back to switches menu
                if (!navEnv) setTimeout(() => showSwitchesMenu(api, { ...nextState, currentSelection: "__switch_env__" }), 0)
              },
            )
            break
          }
          case "__switch_e2e__": {
            let navE2e = false
api.ui.dialog.replace(
                () =>
                  api.ui.DialogSelect<string>({
                  title: tr("project.pickE2eGuard"),
                  placeholder: tr("project.currentValue", { value: current.e2eGuard ?? "default" }),
                  skipFilter: true,
                  current: current.e2eGuard ?? "on",
                  options: [
                    {
                      title: `🟢 on${current.e2eGuard === "on" ? tr("project.currentMarker") : ""}`,
                      value: "on",
                      description: tr("project.valueGuardE2eOn"),
                    },
                    {
                      title: `🔴 off${current.e2eGuard === "off" ? tr("project.currentMarker") : ""}`,
                      value: "off",
                      description: tr("project.valueGuardE2eOff"),
                    },
                    {
                      title: `⚪ default${current.e2eGuard === "default" || !current.e2eGuard ? tr("project.currentMarker") : ""}`,
                      value: "default",
                      description: tr("project.valueAdvisorDefault"),
                    },
                    {
                      title: tr("project.cancel"),
                      value: "__cancel__",
                      description: tr("project.cancelDesc"),
                    },
                  ],
                  onSelect: (sel) => {
                    navE2e = true
                    if (sel.value !== "__cancel__") {
                      current.e2eGuard = sel.value as ProjectSwitches["e2eGuard"]
                      toast(api, tr("project.toastE2eGuard", { value: formatGuardBadge(current.e2eGuard) }), "success")
                    }
                    showSwitchesMenu(api, {
                      ...nextState,
                      currentSelection: "__switch_e2e__",
                    })
                  },
                }),
              () => {
                // Esc on e2eGuard picker = back to switches menu
                if (!navE2e) setTimeout(() => showSwitchesMenu(api, { ...nextState, currentSelection: "__switch_e2e__" }), 0)
              },
            )
            break
          }
        }
      },
    }),
    () => {
      // Esc on switches menu = back to main menu
      if (!navigated) setTimeout(() => showMainMenu(api, { ...state, currentSelection: "__action_switches__" }), 0)
    },
  )
}

// ─── Plugin entry ────────────────────────────────────────────────────

const tui: TuiPlugin = async (api) => {
  initI18n(api)
  api.keymap.registerLayer({
    commands: [
      {
        name: "project.wizard",
        title: tr("project.cmdTitle"),
        desc: tr("project.cmdDesc"),
        category: "Project",
        namespace: "palette",
        slashName: "project-wizard",
        run() {
          startProjectWizard(api)
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
