/**
 * Project Wizard — TUI dialog-based project initialization and switch configuration.
 *
 * v2 migration: dialog chains are async control flow over the promise
 * based `ctx.ui.dialog` API (select/confirm/alert/prompt). Each menu
 * level is an async loop — a pick dispatches, Esc returns to the parent
 * loop, and re-rendering happens by continuing the loop, replacing v1's
 * `dialog.replace` chains + `navigated` flags + setTimeout deferrals.
 *
 * History (kept for context):
 *   - Phase 1A (2026-09-11): group picker first screen; helpers extracted
 *     to `../_wizard-helpers.ts`.
 *   - Phase 1B: "git-workflow" split into projectGuards / adr sub-dialogs
 *     and the inline autoAdvisor row.
 *   - Phase 1C: responsibility separation — single-field groups
 *     (`projectMemory`, `autoAdvisor`) are INLINE rows on the main menu
 *     with one-step auto-save (`saveInlineField`); multi-field groups
 *     (`projectGuards`, `adr`) open a sub-dialog with "💾 Save & Apply
 *     Changes" (`runSaveSwitches`, config-only writes). The main-menu
 *     button is the FILE skeleton (AGENTS.md, docs/git-commits.md,
 *     .ocp/ocp.json, one-shot legacy migration, backends, hooks).
 *     Schema files: `plugins/tui/wizard-schema/{project-memory,
 *     auto-advisor,project-guards,adr}.json`.
 *     `.ocp/ocp.json` is the ONLY runtime source of truth for switch
 *     values (ADR 0004 v2 — no fallback chain); the JSON schemas only
 *     describe the wizard picker UI.
 *
 * Menu selection flow:
 *   - Each group is a select dialog with clear choices; the host provides
 *     built-in type-to-filter (kept on).
 *   - When the project already exists, loads existing configuration and
 *     echoes the active/commented switches in the dialog.
 *
 * Registered as a CLI-only plugin in `cli.json` (v2 TUI plugin list).
 */

/// <reference types="bun" />
import type { Context } from "@opencode/plugin/tui/context"
import { Plugin } from "@opencode/plugin/tui"
import { appKeymapLayer } from "../_keymap-app"
import { migrateLegacyProjectArtifacts, type MigrationReport } from "../../shared/opencode-prime"
import { tr, initI18n, refreshLocale, languageOption, switchLanguage, SWITCH_LANG, type DialogOption, type StringKey } from "../i18n"
import { CONFIG_REL, setProjectDir } from "../../project-manager/project-manager-config"
import {
  ADR_SUITES,
  normalizeAdrGovernance,
  normalizeAdrLayout,
  normalizeAdrNumbering,
  normalizeAdrStyle,
} from "../../adr/adr-config"
import { indexProject, initProject, syncProject, updateSwitches } from "../../project-manager/project-manager-operations"
import { planDprintSetup, setupDprint } from "../../project-manager/project-manager-dprint"
import { PROJECT_SWITCH_OPTIONS } from "../../project-manager/project-manager-options"
import { detectProjectSwitches } from "../../project-manager/project-manager-options"
import type { ProjectSwitches } from "../../project-manager/project-manager-scaffold"
import {
  projectRoot,
  toast,
  showBusyModal,
  backendLine,
  initReport,
  breadcrumbHeader,
  scaffoldLine,
  type WizardGroupId,
} from "../_wizard-helpers"
import autoAdvisorSchemaJson from "../wizard-schema/auto-advisor.json" with { type: "json" }
import projectMemorySchemaJson from "../wizard-schema/project-memory.json" with { type: "json" }
import projectGuardsSchemaJson from "../wizard-schema/project-guards.json" with { type: "json" }
import adrSchemaJson from "../wizard-schema/adr.json" with { type: "json" }
import {
  badgeFor,
  renderSchemaField,
  type WizardGroupSchema,
} from "../schema-driven"

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

/**
 * Apply an `/adr init` suite bundle onto the wizard switch state — style +
 * numbering + governance + layout in one pick, mirroring `ADR_SUITES`
 * (which is data-driven from adr-suites.json). The suite's layout maps to
 * the LEGACY root `adrLayout` key: the wizard's layout field writes that
 * key and the adr plugin gives it precedence over `adr.layout`, so the root key
 * is the authoritative surface here. Values pass through the adr plugin's
 * normalizers (fail-closed). Unknown suite names are a no-op.
 */
export function applyAdrSuiteToSwitches(
  switches: ProjectSwitches,
  suite: string,
): ProjectSwitches {
  const row = ADR_SUITES[suite]
  if (!row) return switches
  const fields = row.fields
  const style = normalizeAdrStyle(fields.style)
  if (style) switches.adrStyle = style
  const numbering = normalizeAdrNumbering(fields.numbering)
  if (numbering) switches.adrNumbering = numbering
  const governance = normalizeAdrGovernance(fields.governance)
  if (governance) switches.adrGovernance = governance
  const layout = normalizeAdrLayout(fields.layout)
  if (layout) switches.adrLayout = layout
  return switches
}

/** Reverse of `applyAdrSuiteToSwitches` for the dialog's current-marker:
 * which suite (if any) does the current switch state match exactly? Layout
 * is compared against the LEGACY root `adrLayout` key (the surface suites
 * write). Returns null for custom / partially-configured states. */
export function detectAdrSuite(switches: ProjectSwitches): string | null {
  for (const name of Object.keys(ADR_SUITES)) {
    const fields = ADR_SUITES[name].fields
    if (normalizeAdrStyle(fields.style) !== (switches.adrStyle ?? null)) continue
    if (normalizeAdrNumbering(fields.numbering) !== (switches.adrNumbering ?? null)) continue
    if (normalizeAdrGovernance(fields.governance) !== (switches.adrGovernance ?? null)) continue
    if (normalizeAdrLayout(fields.layout) !== (switches.adrLayout ?? null)) continue
    return name
  }
  return null
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

export async function startProjectWizard(
  ctx: Context,
  stateOverride?: WizardState,
): Promise<void> {
  // Cross-window language sync: another window's switch lives only in
  // ocp.json (initI18n ran once behind its `initialized` guard) — re-read
  // the shared config before composing any menu text.
  refreshLocale()
  const rootDir = projectRoot(ctx)
  setProjectDir(rootDir)

  // B1 (ADR 0004 §3): run the idempotent migration BEFORE detecting switch
  // values. Detecting first saw all-defaults on a legacy project and every
  // save then overwrote the freshly migrated explicit values
  // (autoAdvisorMode:"off" → "lite", custom adrDir lost). Migration-first
  // guarantees the wizard displays — and saves — the post-migration truth.
  // §3.5 visibility: the report rides a toast; a no-op open stays silent.
  const openMigration = migrateLegacyProjectArtifacts(rootDir)
  const migNote = migrationSuffix(openMigration).trim().replace(/\n+/g, " ")
  if (migNote) toast(ctx, migNote, "info")

  const detected = detectCurrentSwitches(rootDir)
  const isExisting = stateOverride ? stateOverride.exists : detected.exists
  const configRel = stateOverride ? stateOverride.configRelPath : detected.configRelPath
  const current: ProjectSwitches = stateOverride ? stateOverride.switches : detected.switches

  await showGroupMenu(ctx, {
    switches: current,
    exists: isExisting,
    configRelPath: configRel,
    currentSelection: stateOverride?.currentSelection ?? "__action_init__",
  })
}

// ─── Group menu (Level 1) ────────────────────────────────────────────

function buildMenuItems(ctx: Context, state: WizardState): DialogOption<string>[] {
  const { switches: current, exists: isExisting, configRelPath: configRel } = state
  const skeletonHeader = tr("project.skeletonHeader")
  const conventionsHeader = tr("project.conventionsHeader")
  const maintenanceHeader = tr("project.maintenanceHeader")
  const systemHeader = tr("project.systemHeader")

  // Per-group summary hints shown as the description of each group row on
  // the main menu. Built inline (no i18n template) — these are compact
  // status snapshots, not user-facing messages.
  const projectGuardsSummary = `env:${current.envGuard ?? "def"} · adr:${current.adrGuard ?? "def"}`
  const adrSummary = `layout:${current.adrLayout ?? "def"} · style:${current.adrStyle ?? "def"} · gov:${current.adrGovernance ?? "def"}`

  const dprintPlan = planDprintSetup(projectRoot(ctx))
  const toolingSummary = dprintPlan.status === "eligible"
    ? tr("project.tooling.summaryEligible")
    : tr("project.tooling.summaryNotEligible")

  // Single-field groups render inline on the main menu and auto-save on
  // commit (one-step UX). Multi-field groups open a sub-dialog + Save.
  const advisorField = AUTO_ADVISOR_SCHEMA.fields[0]!
  const memoryField = PROJECT_MEMORY_SCHEMA.fields[0]!
  const memoryInlineTitle = `${memoryField.icon} ${tr("project.groups.projectMemory")}: ${badgeFor(memoryField, current.projectMemory)}`
  const advisorInlineTitle = `${advisorField.icon} ${tr("project.groups.autoAdvisor")}: ${badgeFor(advisorField, current.autoAdvisorMode)}`

  return [
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
      value: "__group_projectGuards__",
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
    { ...languageOption(), category: systemHeader },
  ]
}

/**
 * Level 1 loop: pick → dispatch → re-present. Esc at this level closes
 * the wizard (v1's dialog.clear onDismiss). `selection` tracks the last
 * pick so re-entry lands the cursor on the row the user came back from.
 */
async function showGroupMenu(ctx: Context, state: WizardState): Promise<void> {
  let selection = state.currentSelection ?? "__action_init__"
  const rootDir = projectRoot(ctx)
  for (;;) {
    const dialogTitle = state.exists
      ? tr("project.setupExisting", { config: state.configRelPath ?? CONFIG_REL })
      : tr("project.newProject")
    const pick = await ctx.ui.dialog.select<string>({
      title: dialogTitle,
      placeholder: tr("project.firstScreenPlaceholder"),
      current: selection,
      options: buildMenuItems(ctx, state),
    })
    if (pick === undefined) return
    selection = pick

    if (pick === SWITCH_LANG) {
      await switchLanguage(ctx)
      continue
    }
    if (pick === "__action_exit__") return

    if (pick === "__action_init__") {
      await runInitOrUpdate(ctx, state, rootDir, state.exists)
      continue
    }
    if (pick === "__action_sync__") {
      await runSyncAction(ctx, state, rootDir)
      continue
    }
    if (pick === "__action_index__") {
      await runIndexRefresh(ctx, state, rootDir)
      continue
    }
    if (pick === "__field_projectMemory" || pick === "__field_autoAdvisorMode") {
      const fieldKey = pick === "__field_projectMemory" ? "projectMemory" : "autoAdvisorMode"
      const field = pick === "__field_projectMemory"
        ? PROJECT_MEMORY_SCHEMA.fields[0]!
        : AUTO_ADVISOR_SCHEMA.fields[0]!
      const prev = state.switches[fieldKey] as string | undefined
      const next = await renderSchemaField(ctx, field, prev)
      if (next === undefined) continue
      ;(state.switches as Record<string, unknown>)[fieldKey] = next
      await saveInlineField(ctx, state, rootDir, fieldKey)
      continue
    }
    if (pick === "__group_projectGuards__") {
      await showSchemaGroup(ctx, state, "projectGuards", PROJECT_GUARDS_SCHEMA)
      continue
    }
    if (pick === "__group_adr__") {
      await showSchemaGroup(ctx, state, "adr", ADR_SCHEMA)
      continue
    }
    if (pick === "__group_tooling__") {
      await showToolingGroup(ctx, state)
      continue
    }
  }
}

// ─── Group: schema-driven sub-dialog ─────────────────────────────────

/**
 * Renders any schema-driven group as a sub-dialog loop. Items are driven
 * entirely by the JSON schema; adding a new switch = adding a row to the
 * schema file, no wizard code change.
 *
 * Each group is identified by its `groupId` (also used as the i18n key
 * prefix for `project.<groupId>.title` / `.placeholder`). Esc or
 * "← Back to main" returns to the parent menu loop.
 */
async function showSchemaGroup(
  ctx: Context,
  state: WizardState,
  groupId: WizardGroupId,
  schema: WizardGroupSchema,
): Promise<void> {
  const rootDir = projectRoot(ctx)
  let selection = `__field_${schema.fields[0]?.key}`
  for (;;) {
    const { switches: current, exists: isExisting, configRelPath: configRel } = state
    const guardsCat = tr("project.guardsHeader")
    const adrCat = tr("project.adrConfigHeader")
    const advisorCat = tr("project.advisorHeader")
    const suiteCat = tr("project.suiteHeader")
    const actionsCat = tr("project.actionsHeader")
    const navCat = tr("project.navigationHeader")

    const items: DialogOption<string>[] = schema.fields.map((field) => {
      const displayName = field.nameKey ? tr(field.nameKey) : field.key
      return {
        title: `${field.icon} ${displayName}:${" ".repeat(Math.max(1, 15 - displayName.length))} ${badgeFor(field, current[field.key as keyof ProjectSwitches] as string | undefined)}`,
        value: `__field_${field.key}`,
        description: tr(field.descriptionKey),
        // Style/numbering/governance are configuration, not guards — the adr
        // group gets its own category header; guardsHeader stays for the
        // projectGuards group.
        category: groupId === "adr" ? adrCat : field.badgeKind === "advisor" ? advisorCat : guardsCat,
      }
    })

    // Suite quick-pick (adr group only): own category at the TOP of the
    // dialog, bundles listed directly — selecting one applies AND saves
    // immediately (saveAdrSuite), no 💾 Save round-trip. Cross-field logic is
    // deliberately outside the schema-driven renderer (Phase 1 scope,
    // schema-driven.ts); the current suite gets a marker.
    if (groupId === "adr") {
      const currentSuite = detectAdrSuite(current)
      items.unshift(
        ...ADR_SUITE_ROWS.map((row) => ({
          title: `${row.icon} ${row.value}${currentSuite === row.value ? tr("project.currentMarker") : ""}`,
          value: `__adr_suite_${row.value}__`,
          description: tr(row.descKey),
          category: suiteCat,
        })),
      )
    }
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

    const pick = await ctx.ui.dialog.select<string>({
      title: `${breadcrumbHeader(groupId)} — ${tr(`project.${groupId}.title`, {
        config: configRel ?? CONFIG_REL,
      })}`,
      placeholder: tr(`project.${groupId}.placeholder`),
      current: selection,
      options: items,
    })
    if (pick === undefined || pick === "__switch_back__") return
    selection = pick

    if (pick === "__save_switches__") {
      await runSaveSwitches(ctx, state, rootDir, isExisting, groupId, schema)
      continue
    }
    if (pick.startsWith("__adr_suite_")) {
      const suite = pick.slice("__adr_suite_".length, -"__".length)
      if (suite in ADR_SUITES) await saveAdrSuite(ctx, state, rootDir, suite, groupId, schema)
      continue
    }
    if (pick.startsWith("__field_")) {
      const fieldKey = pick.slice("__field_".length)
      const field = schema.fields.find((f) => f.key === fieldKey)
      if (!field) continue
      const currentValue = current[fieldKey as keyof ProjectSwitches] as string | undefined
      const next = await renderSchemaField(ctx, field, currentValue)
      if (next !== undefined) (current as Record<string, string | undefined>)[fieldKey] = next
      continue
    }
  }
}

// ─── ADR suite quick-pick (inside the adr sub-dialog) ────────────────

/** Suite rows rendered at the TOP of the adr sub-dialog (own category).
 * Derived from ADR_SUITES (adr-suites.json) — adding a suite is a JSON row,
 * never a wizard code change. */
const ADR_SUITE_ROWS: ReadonlyArray<{ value: string; icon: string; descKey: StringKey }> = Object.values(ADR_SUITES).map(
  (row) => ({ value: row.name, icon: row.icon, descKey: row.descKey as StringKey }),
)

/**
 * Confirming a suite row applies the bundle to the switch state and
 * auto-saves ONLY the four suite-owned fields (style/numbering/governance/
 * layout) — select-to-confirm, no 💾 Save round-trip. On success the four fields
 * are refreshed from disk (B1 lesson: UI shows the persisted truth, not the
 * optimistic in-memory value); unconfirmed sibling edits in this sub-dialog
 * are kept in memory, never flushed. On failure the in-memory mutation is
 * reverted and the error is surfaced.
 */
async function saveAdrSuite(
  ctx: Context,
  state: WizardState,
  rootDir: string,
  suite: string,
  groupId: WizardGroupId,
  schema: WizardGroupSchema,
): Promise<void> {
  const prev: Pick<ProjectSwitches, "adrStyle" | "adrNumbering" | "adrGovernance" | "adrLayout"> = {
    adrStyle: state.switches.adrStyle,
    adrNumbering: state.switches.adrNumbering,
    adrGovernance: state.switches.adrGovernance,
    adrLayout: state.switches.adrLayout,
  }
  applyAdrSuiteToSwitches(state.switches, suite)
  const switches: ProjectSwitches = {
    adrStyle: state.switches.adrStyle,
    adrNumbering: state.switches.adrNumbering,
    adrGovernance: state.switches.adrGovernance,
    adrLayout: state.switches.adrLayout,
  }
  try {
    const result = await updateSwitches({ root: rootDir, switches })
    // Refresh ONLY the suite-owned keys from disk: re-detecting the whole
    // state would clobber unconfirmed sibling edits sitting in memory.
    const detected = detectCurrentSwitches(rootDir)
    state.switches.adrStyle = detected.switches.adrStyle
    state.switches.adrNumbering = detected.switches.adrNumbering
    state.switches.adrGovernance = detected.switches.adrGovernance
    state.switches.adrLayout = detected.switches.adrLayout
    toast(
      ctx,
      tr("project.configSavedToast") + migrationSuffix(result.migration).trim().replace(/\n+/g, " "),
      "success",
    )
    state.exists = true
  } catch (err) {
    Object.assign(state.switches, prev)
    await ctx.ui.dialog.alert({
      title: tr("project.saveFailed"),
      message: tr("project.saveFailedMsg", { err: (err as Error).message }),
    })
  }
}

// ─── Group: Project tooling ──────────────────────────────────────────

async function showToolingGroup(ctx: Context, state: WizardState): Promise<void> {
  const rootDir = projectRoot(ctx)
  let selection = "__tool_dprint__"
  for (;;) {
    const dprintPlan = planDprintSetup(rootDir)
    const actionsCat = tr("project.actionsHeader")
    const navCat = tr("project.navigationHeader")

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

    const pick = await ctx.ui.dialog.select<string>({
      title: `${breadcrumbHeader("tooling")} — ${tr("project.tooling.title")}`,
      placeholder: tr("project.tooling.placeholder"),
      current: selection,
      options: items,
    })
    if (pick === undefined || pick === "__tool_back__") return
    selection = pick
    if (pick === "__tool_dprint__") await runDprintSetup(ctx, state, rootDir)
  }
}

// ─── Action: init / update (skeleton only — switches live in sub-dialog Save) ──
//
// Main-menu "🏗 Initialize / Update Project Skeleton" handles the SKELETON
// layer: run the one-shot legacy migration (ADR 0004 §3), then scaffold
// AGENTS.md / docs/git-commits.md / .ocp/ocp.json (first time). It applies
// the current `state.switches` to the config
// it creates/updates, but the user-facing responsibility is the file
// skeleton, not switch editing — switch editing lives in each sub-dialog's
// "💾 Save & Apply Changes" button (runSaveSwitches → updateSwitchesOnly,
// which writes the config WITHOUT touching the other baseline files).

/**
 * Busy feedback for async operations (init, dprint setup, index refresh):
 * `showBusyModal` paints a placeholder dialog; the operation's result
 * dialog replaces it through the single-active-dialog model. The v1
 * busy-workaround cast (compat-host `busy`/`busyText` props on
 * DialogAlert) is dead — v2 needs no cast because the busy panel is
 * plugin-drawn.
 */
async function runInitOrUpdate(
  ctx: Context,
  state: WizardState,
  rootDir: string,
  isExisting: boolean,
): Promise<void> {
  showBusyModal(ctx, {
    title: isExisting ? tr("project.updateWorkingTitle") : tr("project.initWorkingTitle"),
    message: isExisting ? tr("project.updateWorking") : tr("project.initWorking"),
    busyText: isExisting ? tr("project.updateBusyText") : tr("project.initBusyText"),
  })
  try {
    const result = await initProject({ root: rootDir, switches: state.switches })
    const report = initReport(result.files, result.backends, result.hooks, rootDir) + migrationSuffix(result.migration)
    toast(
      ctx,
      isExisting ? tr("project.configUpdated") : tr("project.initSuccess"),
      "success",
    )
    state.exists = true
    await ctx.ui.dialog.alert({
      title: isExisting ? tr("project.updateResult") : tr("project.initResult"),
      message: report,
    })
  } catch (err) {
    await ctx.ui.dialog.alert({
      title: tr("project.initFailed"),
      message: tr("project.operationFailed", { err: (err as Error).message }),
    })
  }
}

// ─── Action: sync ────────────────────────────────────────────────────

/**
 * Wizard suffix for the §3 migration report: one "migrated N switch(es),
 * moved M file(s)" line when the pass did anything, plus one raw line per
 * warning (paths — not localizable). Empty string on a no-op run so normal
 * init/save output stays clean.
 */
function migrationSuffix(migration: MigrationReport): string {
  const switched = migration.switchedKeys.length
  const moved = migration.movedFiles.length
  const lines: string[] = []
  if (switched > 0 || moved > 0) {
    lines.push(tr("project.migratedLine", { switches: switched, files: moved }))
  }
  for (const warning of migration.warnings) {
    lines.push(`⚠️ ${warning}`)
  }
  return lines.length > 0 ? `\n\n${lines.join("\n")}` : ""
}

/** Raw ⚠️ lines for migration warnings (paths — not localizable), appended
 * to EVERY `/project sync` outcome: an all-failed run must not read as
 * "up to date" in silence. Sync reports carry their own counts. */
function migrationWarnings(migration: MigrationReport): string {
  return migration.warnings.length > 0
    ? `\n\n${migration.warnings.map((w) => `⚠️ ${w}`).join("\n")}`
    : ""
}

async function runSyncAction(ctx: Context, state: WizardState, rootDir: string): Promise<void> {
  try {
    const res = syncProject(rootDir)
    let syncMsg = ""
    if (res.status === "missing") {
      syncMsg = tr("project.syncMissing")
    } else if (res.status === "up-to-date") {
      syncMsg = tr("project.syncUpToDate")
    } else {
      syncMsg = tr("project.syncAdded", {
        count: res.added.length,
        lines: res.added.map((k) => `  + ${k}`).join("\n"),
      })
    }
    syncMsg += migrationWarnings(res.migration)
    await ctx.ui.dialog.alert({
      title: tr("project.syncResult"),
      message: syncMsg,
    })
  } catch (err) {
    await ctx.ui.dialog.alert({
      title: tr("project.syncError"),
      message: tr("project.syncFailed", { err: (err as Error).message }),
    })
  }
}

// ─── Action: index refresh ───────────────────────────────────────────

async function runIndexRefresh(ctx: Context, state: WizardState, rootDir: string): Promise<void> {
  showBusyModal(ctx, {
    title: tr("project.indexWorkingTitle"),
    message: tr("project.indexWorking"),
    busyText: tr("project.indexBusyText"),
  })
  try {
    const results = await indexProject(rootDir)
    const msg = results.map(backendLine).join("\n") || tr("project.noBackends")
    await ctx.ui.dialog.alert({
      title: tr("project.indexResult"),
      message: msg,
    })
  } catch (err) {
    await ctx.ui.dialog.alert({
      title: tr("project.indexError"),
      message: tr("project.indexFailed", { err: (err as Error).message }),
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
//     `ADR`). User accumulates multiple field edits in a select dialog
//     then clicks "💾 Save & Apply Changes" to persist.
// Neither flow touches AGENTS.md / docs/git-commits.md — that's the
// main-menu skeleton's job (runInitOrUpdate → initProject).

// ─── Action: save inline (single-field auto-save on commit) ──────────

async function saveInlineField(
  ctx: Context,
  state: WizardState,
  rootDir: string,
  fieldKey: keyof ProjectSwitches,
): Promise<void> {
  // Write ONLY the committed field. Sub-dialog edits live in
  // `state.switches` without auto-persist until the user clicks "💾 Save
  // & Apply Changes" — inline auto-save must not flush those unconfirmed
  // edits. `applySwitchesToConfigContent` skips undefined values, so a
  // single-key object is safe.
  const switches = { [fieldKey]: state.switches[fieldKey] } as ProjectSwitches
  try {
    const result = await updateSwitches({ root: rootDir, switches })
    // Config-only save is never a full project init; AGENTS.md /
    // git-commits.md are still pending until the user clicks the main-menu
    // skeleton button. Always use the saved-config toast to avoid the
    // misleading "Project initialized" wording. The §3 migration ran with
    // the save — surface its line whenever it moved anything.
    toast(ctx, tr("project.configSavedToast") + migrationSuffix(result.migration).trim().replace(/\n+/g, " "), "success")
    state.exists = true
  } catch (err) {
    await ctx.ui.dialog.alert({
      title: tr("project.saveFailed"),
      message: tr("project.saveFailedMsg", { err: (err as Error).message }),
    })
    // Revert the optimistic local mutation so the badge on re-entry
    // reflects what is actually on disk.
    const detected = detectCurrentSwitches(rootDir)
    ;(state.switches as Record<string, unknown>)[fieldKey] = detected.switches[fieldKey]
  }
}

// ─── Action: save switches (sub-dialog "💾 Save & Apply Changes") ────

async function runSaveSwitches(
  ctx: Context,
  state: WizardState,
  rootDir: string,
  isExisting: boolean,
  groupId: WizardGroupId,
  schema: WizardGroupSchema,
): Promise<void> {
  showBusyModal(ctx, {
    title: tr("project.saveWorkingTitle"),
    message: tr("project.saveWorking"),
    busyText: tr("project.saveBusyText"),
  })
  try {
    const result = await updateSwitches({ root: rootDir, switches: state.switches })
    const fileLine = scaffoldLine(result.file)
    toast(
      ctx,
      isExisting ? tr("project.configSavedToast") : tr("project.initSuccess"),
      "success",
    )
    state.exists = true
    await ctx.ui.dialog.alert({
      title: isExisting ? tr("project.saveResult") : tr("project.initResult"),
      message: `Target: ${result.root}\n\nFiles:\n  ${fileLine}` + migrationSuffix(result.migration),
    })
  } catch (err) {
    await ctx.ui.dialog.alert({
      title: tr("project.saveFailed"),
      message: tr("project.saveFailedMsg", { err: (err as Error).message }),
    })
  }
}

// ─── Action: dprint setup ────────────────────────────────────────────

async function runDprintSetup(ctx: Context, state: WizardState, rootDir: string): Promise<void> {
  // v1 rendered this as a busy-less Alert (OK = proceed, Esc = back); the
  // v2 confirm dialog names both paths explicitly — same decision, clearer UX.
  const proceed = await ctx.ui.dialog.confirm({
    title: tr("project.setupDprintConfirmTitle"),
    message: tr("project.setupDprintConfirm"),
  })
  if (proceed !== true) return
  showBusyModal(ctx, {
    title: tr("project.setupDprintWorkingTitle"),
    message: tr("project.setupDprintWorking"),
    busyText: tr("project.setupDprintBusyText"),
  })
  try {
    await setupDprint(rootDir)
    toast(ctx, tr("project.setupDprintDone"), "success")
    await ctx.ui.dialog.alert({
      title: tr("project.setupDprintConfirmTitle"),
      message: tr("project.setupDprintDone"),
    })
  } catch (err) {
    await ctx.ui.dialog.alert({
      title: tr("project.setupDprintFailed"),
      message: tr("project.operationFailed", { err: (err as Error).message }),
    })
  }
}

// ─── Plugin entry ───────────────────────────────────────────────────

export default Plugin.define({
  id: PLUGIN_ID,
  setup(ctx: Context) {
    initI18n()
    appKeymapLayer(ctx, () => ({
      mode: "global",
      commands: [
        {
          id: "project.wizard",
          title: tr("project.cmdTitle"),
          description: tr("project.cmdDesc"),
          group: "Project",
          palette: true,
          // /project is also a server-side slash command (project-manager: init|index|sync).
          // The TUI keymap owns the slash entry — typing `/project` opens the wizard
          // menu (which itself dispatches init/index/sync via its own buttons).
          // The server hook remains as the headless / `ocp project <sub>` entry point.
          slash: { name: "project" },
          run() {
            void startProjectWizard(ctx)
          },
        },
      ],
    }))
  },
})
