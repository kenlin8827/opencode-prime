/**
 * Shared wizard helpers — private to the project-wizard plugin.
 *
 * These functions were inlined in `project-wizard.ts` (874 lines) before the
 * Phase 1A refactor. They are extracted here as private helpers (no formal
 * framework, no plugin-scope gating, no shared `wizard-framework/` directory
 * by user direction). Provider-wizard and profile-wizard may adopt these
 * later; for now they are owned by project-wizard.
 *
 * Conventions:
 *   - Pure functions where possible (no module state).
 *   - TuiPluginApi is passed explicitly; no global api.
 *   - Functions exported here are not part of the public TUI plugin API.
 */

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { tr } from "./i18n"
import type { BackendResult } from "../project-manager/project-manager-index"
import type { HookResult } from "../project-manager/project-manager-hooks"
import type { ScaffoldResult } from "../project-manager/project-manager-scaffold"

// ─── Project root resolution ─────────────────────────────────────────

/**
 * Project root for scaffolding: opencode's resolved project directory.
 * process.cwd() is the TUI process launch cwd (e.g. C:\Windows\System32
 * when started from a Windows shortcut) and MUST NOT be trusted.
 */
export function projectRoot(api: TuiPluginApi): string {
  return api.state.path.directory || process.cwd()
}

// ─── Breadcrumb ──────────────────────────────────────────────────────

/**
 * The wizard sub-dialogs that use a breadcrumb header (the ones with
 * their own DialogSelect screen). Order matches their lifecycle position.
 *
 * `autoAdvisor` is intentionally NOT here: it is rendered as an inline
 * field row on the main menu (its enum picker is reached directly via
 * `__field_autoAdvisorMode`), not as a separate sub-dialog. Adding it
 * to this tuple would put a redundant `●Auto advisor` marker on every
 * breadcrumb while the user is in another group.
 *
 * The legacy "Project structure" group was merged into the Skeleton
 * section (inline actions on the main menu); index maintenance is also
 * inline.
 */
export const WIZARD_GROUPS = ["projectGuards", "adr", "tooling"] as const
export type WizardGroupId = (typeof WIZARD_GROUPS)[number]

/**
 * Renders a horizontal breadcrumb showing all sub-dialogs, with the
 * currently-active one marked by a leading `●` bullet:
 *
 *   ●Project guards │ ADR │ Tooling
 *
 * Used as a title prefix on sub-dialogs. The root menu (showGroupMenu)
 * IS the navigation — no prefix needed there.
 *
 * The separator `│` is punctuation glyph, not localizable.
 */
export function breadcrumbHeader(active: WizardGroupId): string {
  return WIZARD_GROUPS
    .map((g) => g === active ? `●${tr(`project.groups.${g}`)}` : tr(`project.groups.${g}`))
    .join(" │ ")
}

// ─── Toast ───────────────────────────────────────────────────────────

/** Show a toast; swallow ui.toast failures so the wizard keeps running. */
export function toast(
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

// ─── Alert modal ─────────────────────────────────────────────────────

/**
 * Renders a `DialogAlert` modal and safely returns to wizard upon confirm
 * or Esc.
 *
 * DialogAlert only has onConfirm (no onCancel), so we use dialog.replace's
 * second argument (onClose) to catch the Esc key. A navigated flag is
 * flipped before any navigation to prevent double-firing: the dialog stack
 * invokes onClose again while clearing/replacing the stack, and pops the
 * stack only after onClose returns (so re-rendering must be deferred).
 */
export function showAlertModal(
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

// ─── Badge formatters ────────────────────────────────────────────────

export type GuardValue = "on" | "off" | "default" | undefined
export type AdvisorValue = "off" | "lite" | "full" | "default" | undefined
export type AdrModeValue = "auto" | "flat" | "hierarchical" | "default" | undefined

export function formatGuardBadge(val: GuardValue): string {
  if (val === "on") return "🟢 ON"
  if (val === "off") return "🔴 OFF"
  return "⚪ default"
}

export function formatAdvisorBadge(val: AdvisorValue): string {
  if (val === "lite") return "🟢 lite"
  if (val === "full") return "🔵 full"
  if (val === "off") return "🔴 off"
  return "⚪ default"
}

export function formatAdrModeBadge(val: AdrModeValue): string {
  if (val === "auto") return "🟢 auto"
  if (val === "flat") return "📄 flat"
  if (val === "hierarchical") return "📦 hierarchy"
  return "⚪ default"
}

// ─── Report formatters ───────────────────────────────────────────────

/** Single line for a backend result — used in init / index reports. */
export function backendLine(r: BackendResult): string {
  if (r.status === "ran") return `  ✅ ${r.backend}: ${r.detail}`
  if (r.status === "failed") return `  ❌ ${r.backend}: ${r.detail}`
  return `  ⏭️ ${r.backend}: skipped (${r.detail})`
}

/** Single line for a hook registration result. */
export function hookLine(r: HookResult): string {
  if (r.status === "registered") return `  ✅ ${r.hook}: ${r.detail}`
  if (r.status === "updated") return `  ♻️ ${r.hook}: ${r.detail}`
  if (r.status === "failed") return `  ❌ ${r.hook}: ${r.detail}`
  return `  ⏭️ ${r.hook}: skipped (${r.detail})`
}

/** Single line for a scaffold result. */
export function scaffoldLine(r: ScaffoldResult): string {
  if (r.status === "created") return `  ✅ created ${r.relPath}`
  if (r.status === "updated") return `  ♻️ updated ${r.relPath}`
  if (r.status === "invalid") return `  ⚠️ malformed ${r.relPath}`
  return `  ⏭️ kept ${r.relPath}`
}

/** Compose the multi-section init/update report. */
export function initReport(
  files: ScaffoldResult[],
  backends: BackendResult[],
  hooks: HookResult[],
  projectDir: string,
): string {
  return `Target: ${projectDir}\n\nFiles:\n${files.map(scaffoldLine).join("\n")}\n\nBackends:\n${backends.map(backendLine).join("\n")}\n\nHooks:\n${hooks.map(hookLine).join("\n")}`
}
