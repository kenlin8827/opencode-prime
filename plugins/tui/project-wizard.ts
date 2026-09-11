/**
 * Project Wizard — TUI dialog-based project initialization and switch configuration.
 *
 * Phase 1A refactor (2026-09-11):
 *   - First screen is now a group picker, not a flat action list.
 *   - Each group has its own sub-wizard; cross-group actions go through showAlertModal.
 *   - Helpers (toast / showAlertModal / projectRoot / badge formatters / report lines)
 *     extracted to `./_wizard-helpers.ts`; not a separate framework directory by design.
 *   - Phase 1B refactor (2026-09-11): "git-workflow" group renamed and split into
 *     three meaningful units:
 *       - `projectGuards`→ sub-dialog (envGuard + e2eGuard, on/off guards)
 *       - `adr`          → sub-dialog (adrGuard + adrDir + adrLayout)
 *       - `autoAdvisor`  → inline row on the main menu (1 field, single value)
 *   - Phase 1C refactor (2026-09-11): responsibility separation + UX scaling.
 *     1. Single-field groups (`projectMemory`, `autoAdvisor`) stay as
 *        INLINE rows on the main menu. Picking a value auto-saves in
 *        one step (no sub-dialog, no explicit Save button) via
 *        `saveInlineField`. Multi-step sub-dialog flow was tried and
 *        abandoned as too deep (5 clicks for one value).
 *     2. Multi-field groups (`projectGuards`, `adr`) open a sub-dialog
 *        with a "💾 Save & Apply Changes" button so users can
 *        accumulate multiple field edits before persisting.
 *     3. The main-menu button is now "🏗 Initialize / Update Project
 *        Skeleton" — its responsibility is the FILE skeleton
 *        (AGENTS.md, docs/git-commits.md, opencode.jsonc structure,
 *        template evolution via sync, backends, hooks). It is NOT a
 *        save-switches action.
 *     4. Both save flows (`saveInlineField`, `runSaveSwitches`) call
 *        `updateSwitches` → scaffold layer's `updateSwitchesOnly`:
 *        writes only the switch values to opencode.jsonc, never
 *        touches the other baseline files.
 *     Schema files: `plugins/tui/wizard-schema/{project-memory,
 *     auto-advisor,project-guards,adr}.json`.
 *     `.opencode/opencode.jsonc` remains the runtime source of truth
 *     for switch values; the JSON schemas only describe the wizard
 *     picker UI.
 *
 * Menu selection flow:
 *   - Each group opens a dedicated DialogSelect dialog with clear choices.
 *   - The OpenCode TUI host provides built-in type-to-filter; we keep that on
 *     (no skipFilter) so power users can jump by typing the first letters.
 *     Arrow-key navigation still works for users who prefer discovery.
 *   - When the project already exists, loads existing configuration and echoes
 *     the active/commented switches in the dialog.
 *
 * Registered via `tui.json` → `plugin` array.
 */

/// <reference types="bun" />
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { tr, initI18n, languageOption, switchLanguage, SWITCH_LANG, type DialogOption } from "./i18n"
import { CONFIG_REL, getProjectDir, setProjectDir } from "../project-manager/project-manager-config"
import { indexProject, initProject, syncProject, updateSwitches } from "../project-manager/project-manager-operations"
import { planDprintSetup, setupDprint } from "../project-manager/project-manager-dprint"
import { PROJECT_SWITCH_OPTIONS } from "../project-manager/project-manager-options"
import { detectProjectSwitches } from "../project-manager/project-manager-options"
import type { ProjectSwitches } from "../project-manager/project-manager-scaffold"
import {
  projectRoot,
  toast,
  showAlertModal,
  backendLine,
  initReport,
  breadcrumbHeader,
  scaffoldLine,
  type WizardGroupId,
} from "./_wizard-helpers"
import autoAdvisorSchemaJson from "./wizard-schema/auto-advisor.json" with { type: "json" }
import projectMemorySchemaJson from "./wizard-schema/project-memory.json" with { type: "json" }
import projectGuardsSchemaJson from "./wizard-schema/project-guards.json" with { type: "json" }
import adrSchemaJson from "./wizard-schema/adr.json" with { type: "json" }
import {
  badgeFor,
  renderSchemaField,
  type WizardGroupSchema,
} from "./schema-driven"

const AUTO_ADVISOR_SCHEMA: WizardGroupSchema = autoAdvisorSchemaJson as WizardGroupSchema
const PROJECT_MEMORY_SCHEMA: WizardGroupSchema = projectMemorySchemaJson as WizardGroupSchema
const PROJECT_GUARDS_SCHEMA: WizardGroupSchema = projectGuardsSchemaJson as WizardGroupSchema
const ADR_SCHEMA: WizardGroupSchema = adrSchemaJson as WizardGroupSchema

const PLUGIN_ID = "opencode-prime.project-wizard"

export interface DetectedProjectState {
  exists: boolean
  configPath?: string
  configRelPath?: string
  switches: ProjectSwitches
}

/** Toggle helper for on/off boolean-like switches (exported for tests). */
export function toggleGuardState(
  current?: "on" | "off",
): "on" | "off" {
  const values = PROJECT_SWITCH_OPTIONS.adrGuard.map((option) => option.value)
  const index = values.indexOf(current ?? "on")
  return values[(index + 1) % values.length]
}

/** Cycle helper for autoAdvisorMode (lite → full → off → lite). */
export function cycleAdvisorMode(
  current?: "off" | "lite" | "full",
): "off" | "lite" | "full" {
  const values = PROJECT_SWITCH_OPTIONS.autoAdvisorMode.map((option) => option.value)
  const index = values.indexOf(current ?? "lite")
  return values[(index + 1) % values.length]
}

/** Detect initial switch values from existing project config or defaults. */
export function detectCurrentSwitches(rootDir: string): DetectedProjectState {
  return detectProjectSwitches(rootDir)
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

  showGroupMenu(api, {
    switches: current,
    exists: isExisting,
    configRelPath: configRel,
    currentSelection: stateOverride?.currentSelection ?? "__action_init__",
  })
}

// ─── Group menu (Level 1) ────────────────────────────────────────────

function showGroupMenu(api: TuiPluginApi, state: WizardState): void {
  const { switches: current, exists: isExisting, configRelPath: configRel } = state
  const activeSelection = state.currentSelection ?? "__action_init__"

  const dialogTitle = isExisting
    ? tr("project.setupExisting", { config: configRel ?? ".opencode/opencode.jsonc" })
    : tr("project.newProject")

  const skeletonHeader = tr("project.skeletonHeader")
  const conventionsHeader = tr("project.conventionsHeader")
  const maintenanceHeader = tr("project.maintenanceHeader")
  const systemHeader = tr("project.systemHeader")

  // Per-group summary hints shown as the description of each group row on
  // the main menu. Built inline (no i18n template) — these are compact
  // status snapshots, not user-facing messages.
  const projectGuardsSummary = `env:${current.envGuard ?? "def"} · e2e:${current.e2eGuard ?? "def"} · adr:${current.adrGuard ?? "def"}`
  const adrSummary = `layout:${current.adrLayout ?? "def"}`

  const dprintPlan = planDprintSetup(projectRoot(api))
  const toolingSummary = dprintPlan.status === "eligible"
    ? tr("project.tooling.summaryEligible")
    : tr("project.tooling.summaryNotEligible")

  // Single-field groups render inline on the main menu and auto-save on
  // commit (one-step UX). Multi-field groups open a sub-dialog + Save.
  const advisorField = AUTO_ADVISOR_SCHEMA.fields[0]!
  const memoryField = PROJECT_MEMORY_SCHEMA.fields[0]!
  const memoryInlineTitle = `${memoryField.icon} ${tr("project.groups.projectMemory")}: ${badgeFor(memoryField, current.projectMemory)}`
  const advisorInlineTitle = `${advisorField.icon} ${tr("project.groups.autoAdvisor")}: ${badgeFor(advisorField, current.autoAdvisorMode)}`

  const items: DialogOption<string>[] = [
    {
      title: isExisting ? tr("project.applyUpdate") : tr("project.applyInit"),
      value: "__action_init__",
      description: isExisting
        ? tr("project.applyUpdateDesc")
        : tr("project.applyInitDesc"),
      category: skeletonHeader,
    },
    {
      title: memoryInlineTitle,
      value: "__field_projectMemory",
      description: tr(memoryField.descriptionKey),
      category: conventionsHeader,
    },
    {
      title: advisorInlineTitle,
      value: "__field_autoAdvisorMode",
      description: tr(advisorField.descriptionKey),
      category: conventionsHeader,
    },
    {
      title: `🛡️ ${tr("project.groups.projectGuards")}`,
      value: "__group_project_guards__",
      description: projectGuardsSummary,
      category: conventionsHeader,
    },
    {
      title: `🏛️ ${tr("project.groups.adr")}`,
      value: "__group_adr__",
      description: adrSummary,
      category: conventionsHeader,
    },
    {
      title: `⚙️ ${tr("project.groups.tooling")}`,
      value: "__group_tooling__",
      description: toolingSummary,
      category: conventionsHeader,
    },
    {
      title: tr("project.syncTemplates"),
      value: "__action_sync__",
      description: tr("project.syncTemplatesDesc"),
      category: maintenanceHeader,
    },
    {
      title: `🔄 ${tr("project.groups.index")}`,
      value: "__action_index__",
      description: tr("project.groups.indexDesc"),
      category: maintenanceHeader,
    },
    {
      title: tr("project.exitWizard"),
      value: "__action_exit__",
      description: tr("project.exitWizardDesc"),
      category: systemHeader,
    },
    { ...languageOption(api), category: systemHeader },
  ]

  let navigated = false
  api.ui.dialog.replace(
    () =>
      api.ui.DialogSelect<string>({
        title: dialogTitle,
        placeholder: tr("project.firstScreenPlaceholder"),
        current: activeSelection,
        options: items,
        onSelect: async (option) => {
          navigated = true
          switch (option.value) {
            case SWITCH_LANG: {
              switchLanguage(api, () => showGroupMenu(api, state))
              return
            }
            case "__action_exit__": {
              api.ui.dialog.clear()
              break
            }
            case "__action_init__": {
              await runInitOrUpdate(api, state, projectRoot(api), isExisting)
              break
            }
            case "__action_sync__": {
              runSyncAction(api, state, projectRoot(api))
              break
            }
            case "__action_index__": {
              await runIndexRefresh(api, state)
              break
            }
            case "__field_projectMemory": {
              renderSchemaField(
                api,
                memoryField,
                current.projectMemory,
                (newValue) => {
                  current.projectMemory = newValue as ProjectSwitches["projectMemory"]
                  void saveInlineField(api, state, projectRoot(api), isExisting, "__field_projectMemory")
                },
                () => showGroupMenu(api, { ...state, currentSelection: "__field_projectMemory" }),
              )
              break
            }
            case "__field_autoAdvisorMode": {
              renderSchemaField(
                api,
                advisorField,
                current.autoAdvisorMode,
                (newValue) => {
                  current.autoAdvisorMode = newValue as ProjectSwitches["autoAdvisorMode"]
                  void saveInlineField(api, state, projectRoot(api), isExisting, "__field_autoAdvisorMode")
                },
                () => showGroupMenu(api, { ...state, currentSelection: "__field_autoAdvisorMode" }),
              )
              break
            }
            case "__group_project_guards__": {
              showSchemaGroup(api, state, "projectGuards", PROJECT_GUARDS_SCHEMA)
              break
            }
            case "__group_adr__": {
              showSchemaGroup(api, state, "adr", ADR_SCHEMA)
              break
            }
            case "__group_tooling__": {
              showToolingGroup(api, state)
              break
            }
          }
        },
      }),
      () => {
      if (navigated) return
      navigated = true
      api.ui.dialog.clear()
    },
  )
}


/**
 * Replaces the current dialog with a busy DialogAlert placeholder. The
 * host renders a ⏳ spinner and busyText in the footer, and swallows every
 * key until the wizard replaces the frame with a result alert. Use for
 * async operations that take more than a tick (init, dprint setup, index
 * refresh) — otherwise the menu sits there with no feedback.
 *
 * Pair pattern:
 *
 *   showBusyModal(api, { title, message, busyText })
 *   try {
 *     const result = await heavyOp(...)
 *     showAlertModal(api, { title, message: report, onDismiss })
 *   } catch (err) {
 *     showAlertModal(api, { title: errorTitle, message: errorMsg, onDismiss })
 *   }
 *
 * Note (2026-09-11, post-recovery): wired into all 4 async sites —
 * runInitOrUpdate (skeleton), runIndexRefresh (index), runDprintSetup
 * (dprint), and runSaveSwitches (save — per-group, config only).
 * runSyncAction (sync) is sync-only and intentionally unwired — the
 * spinner would just flash. The dismiss callback in runIndexRefresh
 * was also fixed (was `__group_index__`, stale post-refactor — now
 * `__action_index__`). Phase 1C separated responsibilities: main-menu
 * skeleton action stays in place (file scaffolding + backends + hooks),
 * sub-dialog Save is config-only (writeSwitchValues, no file scaffold).
 */
function showBusyModal(
  api: TuiPluginApi,
  params: { title: string; message: string; busyText?: string },
): void {
  // @opencode-ai/plugin 1.18.15's TuiDialogAlertProps lacks busy/busyText
  // (they exist only on Prompt); the OCP host accepts and renders them
  // (install/src/ui/app.tsx CompatAlertProps). Same compat cast as app.tsx.
  const busyAlert = api.ui.DialogAlert as (props: {
    title: string
    message: string
    busy?: boolean
    busyText?: string
  }) => ReturnType<typeof api.ui.DialogAlert>
  api.ui.dialog.replace(
    () =>
      busyAlert({
        title: params.title,
        message: params.message,
        busy: true,
        busyText: params.busyText ?? tr("common.working"),
      }),
    () => {
      // Busy modals cannot be dismissed by the user — the wizard always
      // replaces the frame with the operation's result. If Esc ever
      // reaches this callback (e.g. during the replacement tick), drop
      // the stack silently rather than running the previous frame's
      // onDismiss and landing on an empty stack with a still-pending
      // setTimeout-driven result.
    },
  )
}


// ─── Group: schema-driven sub-dialog ─────────────────────────────────

/**
 * Renders any schema-driven group as a sub-dialog. Items are driven entirely
 * by the JSON schema; adding a new switch = adding a row to the schema file,
 * no wizard code change.
 *
 * Each group is identified by its `groupId` (also used as the i18n key prefix
 * for `project.<groupId>.title` / `.placeholder`) and the schema it renders.
 * The current selection tag for the parent menu (`__group_<groupId>__`) is
 * computed locally so the back navigation always lands on the same row.
 */
function showSchemaGroup(
  api: TuiPluginApi,
  state: WizardState,
  groupId: WizardGroupId,
  schema: WizardGroupSchema,
): void {
  const rootDir = projectRoot(api)
  const { switches: current, exists: isExisting, configRelPath: configRel } = state
  const firstFieldKey = schema.fields[0]?.key
  const activeSelection = state.currentSelection ?? `__field_${firstFieldKey}`

  const guardsCat = tr("project.guardsHeader")
  const advisorCat = tr("project.advisorHeader")
  const actionsCat = tr("project.actionsHeader")
  const navCat = tr("project.navigationHeader")

  const items: DialogOption<string>[] = schema.fields.map((field) => {
    const displayName = field.nameKey ? tr(field.nameKey) : field.key
    return {
      title: `${field.icon} ${displayName}:${" ".repeat(Math.max(1, 15 - displayName.length))} ${badgeFor(field, current[field.key as keyof ProjectSwitches] as string | undefined)}`,
      value: `__field_${field.key}`,
      description: tr(field.descriptionKey),
      category: field.badgeKind === "advisor" ? advisorCat : guardsCat,
    }
  })
  items.push(
    {
      title: tr("project.saveApply"),
      value: "__save_switches__",
      description: tr("project.saveApplyDesc"),
      category: actionsCat,
    },
    {
      title: tr("project.backToMain"),
      value: "__switch_back__",
      description: tr("project.backToMainDesc"),
      category: navCat,
    },
  )

  const groupSelectionValue = `__group_${groupId}__`
  let navigated = false
  api.ui.dialog.replace(
    () =>
      api.ui.DialogSelect<string>({
        title: `${breadcrumbHeader(groupId)} — ${tr(`project.${groupId}.title`, {
          config: configRel ?? ".opencode/opencode.jsonc",
        })}`,
        placeholder: tr(`project.${groupId}.placeholder`),
        current: activeSelection,
        options: items,
        onSelect: async (option) => {
          navigated = true
          if (option.value === "__save_switches__") {
            await runSaveSwitches(api, state, rootDir, isExisting, groupId, schema)
            return
          }
          if (option.value === "__switch_back__") {
            showGroupMenu(api, { ...state, currentSelection: groupSelectionValue })
            return
          }
          if (option.value.startsWith("__field_")) {
            const fieldKey = option.value.slice("__field_".length)
            const field = schema.fields.find((f) => f.key === fieldKey)
            if (!field) return
            const currentValue = current[field.key as keyof ProjectSwitches] as string | undefined
            renderSchemaField(
              api,
              field,
              currentValue,
              (newValue) => {
                ;(current as Record<string, string | undefined>)[field.key] = newValue
                showSchemaGroup(api, state, groupId, schema)
              },
              () => showSchemaGroup(api, state, groupId, schema),
            )
          }
        },
      }),
    () => {
      if (!navigated)
        setTimeout(
          () => showGroupMenu(api, { ...state, currentSelection: groupSelectionValue }),
          0,
        )
    },
  )
}

// ─── Group: Project tooling ──────────────────────────────────────────

function showToolingGroup(api: TuiPluginApi, state: WizardState): void {
  const rootDir = projectRoot(api)
  const dprintPlan = planDprintSetup(rootDir)
  const actionsCat = tr("project.actionsHeader")
  const navCat = tr("project.navigationHeader")
  const activeSelection = state.currentSelection ?? "__tool_dprint__"

  const items: DialogOption<string>[] = []
  if (dprintPlan.status === "eligible") {
    items.push({
      title: tr("project.setupDprint"),
      value: "__tool_dprint__",
      description: tr("project.setupDprintDesc"),
      category: actionsCat,
    })
  } else {
    items.push({
      title: tr("project.tooling.dprintNotEligibleTitle"),
      value: "__tool_dprint_disabled__",
      description: tr("project.tooling.dprintNotEligibleDesc"),
      category: actionsCat,
    })
  }
  items.push({
    title: tr("project.backToMain"),
    value: "__tool_back__",
    description: tr("project.backToMainDesc"),
    category: navCat,
  })

  let navigated = false
  api.ui.dialog.replace(
    () =>
      api.ui.DialogSelect<string>({
        title: `${breadcrumbHeader("tooling")} — ${tr("project.tooling.title")}`,
        placeholder: tr("project.tooling.placeholder"),
        current: activeSelection,
        options: items,
        onSelect: async (option) => {
          navigated = true
          switch (option.value) {
            case "__tool_back__":
              showGroupMenu(api, { ...state, currentSelection: "__group_tooling__" })
              break
            case "__tool_dprint__":
              runDprintSetup(api, state, rootDir)
              break
          }
        },
      }),
    () => {
      if (!navigated)
        setTimeout(
          () => showGroupMenu(api, { ...state, currentSelection: "__group_tooling__" }),
          0,
        )
    },
  )
}

// ─── Action: init / update (skeleton only — switches live in sub-dialog Save) ──
//
// Main-menu "🏗 Initialize / Update Project Skeleton" handles the SKELETON
// layer: scaffold AGENTS.md / docs/git-commits.md / .opencode/opencode.jsonc
// (first time) and append missing template switch lines to an existing
// config (update). It applies the current `state.switches` to the config
// it creates/updates, but the user-facing responsibility is the file
// skeleton, not switch editing — switch editing lives in each sub-dialog's
// "💾 Save & Apply Changes" button (runSaveSwitches → updateSwitchesOnly,
// which writes the config WITHOUT touching the other baseline files).

async function runInitOrUpdate(
  api: TuiPluginApi,
  state: WizardState,
  rootDir: string,
  isExisting: boolean,
): Promise<void> {
  showBusyModal(api, {
    title: isExisting ? tr("project.updateWorkingTitle") : tr("project.initWorkingTitle"),
    message: isExisting ? tr("project.updateWorking") : tr("project.initWorking"),
    busyText: isExisting ? tr("project.updateBusyText") : tr("project.initBusyText"),
  })
  try {
    const result = await initProject({ root: rootDir, switches: state.switches })
    const report = initReport(result.files, result.backends, result.hooks, rootDir)
    toast(
      api,
      isExisting ? tr("project.configUpdated") : tr("project.initSuccess"),
      "success",
    )
    showAlertModal(api, {
      title: isExisting ? tr("project.updateResult") : tr("project.initResult"),
      message: report,
      onDismiss: () =>
        showGroupMenu(api, { ...state, exists: true, currentSelection: "__action_init__" }),
    })
  } catch (err) {
    showAlertModal(api, {
      title: tr("project.initFailed"),
      message: tr("project.operationFailed", { err: (err as Error).message }),
      onDismiss: () => showGroupMenu(api, { ...state, currentSelection: "__action_init__" }),
    })
  }
}

// ─── Action: sync ────────────────────────────────────────────────────

function runSyncAction(api: TuiPluginApi, state: WizardState, rootDir: string): void {
  try {
    const res = syncProject(rootDir)
    let syncMsg = ""
    if (res.status === "missing") {
      syncMsg = tr("project.syncMissing")
    } else if (res.status === "up-to-date") {
      syncMsg = tr("project.syncUpToDate")
    } else if (res.status === "added") {
      syncMsg = tr("project.syncAdded", {
        count: res.added.length,
        lines: res.added.map((k) => `  + ${k}`).join("\n"),
      })
    } else {
      syncMsg = tr("project.syncMalformed")
    }
    showAlertModal(api, {
      title: tr("project.syncResult"),
      message: syncMsg,
      onDismiss: () => showGroupMenu(api, { ...state, currentSelection: "__action_sync__" }),
    })
  } catch (err) {
    showAlertModal(api, {
      title: tr("project.syncError"),
      message: tr("project.syncFailed", { err: (err as Error).message }),
      onDismiss: () => showGroupMenu(api, { ...state, currentSelection: "__action_sync__" }),
    })
  }
}

// ─── Action: index refresh ───────────────────────────────────────────

async function runIndexRefresh(api: TuiPluginApi, state: WizardState): Promise<void> {
  const rootDir = projectRoot(api)
  showBusyModal(api, {
    title: tr("project.indexWorkingTitle"),
    message: tr("project.indexWorking"),
    busyText: tr("project.indexBusyText"),
  })
  try {
    const results = await indexProject(rootDir)
    const msg = results.map(backendLine).join("\n") || tr("project.noBackends")
    showAlertModal(api, {
      title: tr("project.indexResult"),
      message: msg,
      onDismiss: () => showGroupMenu(api, { ...state, currentSelection: "__action_index__" }),
    })
  } catch (err) {
    showAlertModal(api, {
      title: tr("project.indexError"),
      message: tr("project.indexFailed", { err: (err as Error).message }),
      onDismiss: () => showGroupMenu(api, { ...state, currentSelection: "__action_index__" }),
    })
  }
}

// ─── Action: save switches ───────────────────────────────────────────
//
// Two flows share the same write path (`updateSwitches` → scaffold
// layer's `updateSwitchesOnly`) and the same iron rule (never overwrite
// unrelated content). They differ in UX:
//   - `saveInlineField`: single-field groups on the main menu
//     (`projectMemory`, `autoAdvisor`). One-step UX — pick a value,
//     commit, persist. No sub-dialog, no explicit Save.
//   - `runSaveSwitches`: multi-field sub-dialogs (`projectGuards`,
//     `ADR`). User accumulates multiple field edits in a DialogSelect
//     then clicks "💾 Save & Apply Changes" to persist.
// Neither flow touches AGENTS.md / docs/git-commits.md — that's the
// main-menu skeleton's job (runInitOrUpdate → initProject).

// ─── Action: save inline (single-field auto-save on commit) ──────────

async function saveInlineField(
  api: TuiPluginApi,
  state: WizardState,
  rootDir: string,
  isExisting: boolean,
  returnSelection: string,
): Promise<void> {
  try {
    await updateSwitches({ root: rootDir, switches: state.switches })
    toast(
      api,
      isExisting ? tr("project.configSavedToast") : tr("project.initSuccess"),
      "success",
    )
    showGroupMenu(api, { ...state, exists: true, currentSelection: returnSelection })
  } catch (err) {
    showAlertModal(api, {
      title: tr("project.saveFailed"),
      message: tr("project.saveFailedMsg", { err: (err as Error).message }),
      onDismiss: () => showGroupMenu(api, { ...state, currentSelection: returnSelection }),
    })
  }
}

// ─── Action: save switches (sub-dialog "💾 Save & Apply Changes") ────

async function runSaveSwitches(
  api: TuiPluginApi,
  state: WizardState,
  rootDir: string,
  isExisting: boolean,
  groupId: WizardGroupId,
  schema: WizardGroupSchema,
): Promise<void> {
  showBusyModal(api, {
    title: tr("project.saveWorkingTitle"),
    message: tr("project.saveWorking"),
    busyText: tr("project.saveBusyText"),
  })
  try {
    const result = await updateSwitches({ root: rootDir, switches: state.switches })
    const fileLine = scaffoldLine(result.file)
    toast(
      api,
      isExisting ? tr("project.configSavedToast") : tr("project.initSuccess"),
      "success",
    )
    showAlertModal(api, {
      title: isExisting ? tr("project.saveResult") : tr("project.initResult"),
      message: `Target: ${result.root}\n\nFiles:\n  ${fileLine}`,
      onDismiss: () =>
        showSchemaGroup(api, { ...state, exists: true, currentSelection: "__save_switches__" }, groupId, schema),
    })
  } catch (err) {
    showAlertModal(api, {
      title: tr("project.saveFailed"),
      message: tr("project.saveFailedMsg", { err: (err as Error).message }),
      onDismiss: () =>
        showSchemaGroup(api, { ...state, currentSelection: "__save_switches__" }, groupId, schema),
    })
  }
}

// ─── Action: dprint setup ────────────────────────────────────────────

function runDprintSetup(api: TuiPluginApi, state: WizardState, rootDir: string): void {
  showAlertModal(api, {
    title: tr("project.setupDprintConfirmTitle"),
    message: tr("project.setupDprintConfirm"),
    onConfirm: () => {
      showBusyModal(api, {
        title: tr("project.setupDprintWorkingTitle"),
        message: tr("project.setupDprintWorking"),
        busyText: tr("project.setupDprintBusyText"),
      })
      void setupDprint(rootDir).then(
        () => {
          toast(api, tr("project.setupDprintDone"), "success")
          showAlertModal(api, {
            title: tr("project.setupDprintConfirmTitle"),
            message: tr("project.setupDprintDone"),
            onDismiss: () => showToolingGroup(api, { ...state, currentSelection: "__tool_dprint__" }),
          })
        },
        (err) =>
          showAlertModal(api, {
            title: tr("project.setupDprintFailed"),
            message: tr("project.operationFailed", { err: (err as Error).message }),
            onDismiss: () => showToolingGroup(api, { ...state, currentSelection: "__tool_dprint__" }),
          }),
      )
    },
    onDismiss: () => showToolingGroup(api, { ...state, currentSelection: "__tool_dprint__" }),
  })
}

// ─── Plugin entry ───────────────────────────────────────────────────

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
