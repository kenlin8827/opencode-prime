/**
 * Shared wizard helpers — private to the TUI wizard plugins.
 *
 * v2 TUI plugin API: helpers take the plugin `Context` explicitly (no
 * global api), dialogs are promise-based (`ctx.ui.dialog.select/confirm/
 * prompt/alert`) so wizard flows are plain async control flow instead of
 * v1's dialog-stack replace chains.
 *
 * Conventions:
 *   - Pure functions where possible (no module state).
 *   - Context is passed explicitly; no global ctx.
 *   - Functions exported here are not part of the public TUI plugin API.
 */

import type { Context } from "@opencode/plugin/tui/context"
// Programmatically create JSX elements via the SolidJS factory — avoids
// tsconfig jsxImportSource complications in .ts files.
import { jsx } from "@opentui/solid/jsx-runtime"
import { tr } from "./i18n"
import type { BackendResult } from "../project-manager/project-manager-index"
import type { HookResult } from "../project-manager/project-manager-hooks"
import type { ScaffoldResult } from "../project-manager/project-manager-scaffold"

// ─── Project root resolution ─────────────────────────────────────────

/**
 * Project root for scaffolding: the location this plugin instance loaded
 * at. process.cwd() is the TUI process launch cwd (e.g. C:\Windows\System32
 * when started from a Windows shortcut) and MUST NOT be trusted.
 */
export function projectRoot(ctx: Context): string {
  return ctx.location?.directory || ctx.data.location.default().directory || process.cwd()
}

// ─── Breadcrumb ──────────────────────────────────────────────────────

/**
 * The wizard sub-dialogs that use a breadcrumb header (the ones with
 * their own select screen). Order matches their lifecycle position.
 *
 * Multi-field groups have their own sub-dialog + "💾 Save & Apply Changes"
 * button (multiple fields to compose before persisting). Single-field
 * groups (`projectMemory`, `autoAdvisor`) are intentionally NOT here —
 * they render as inline rows on the main menu and auto-save on commit
 * (one-step UX: pick value → write → back to main). The order here also
 * drives the breadcrumb prefix shown on every sub-dialog.
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
 * Used as a title prefix on sub-dialogs. The root menu IS the navigation —
 * no prefix needed there.
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
  ctx: Context,
  message: string,
  variant: "info" | "success" | "warning" | "error" = "info",
): void {
  try {
    ctx.ui.toast.show({ title: tr("project.toastTitle"), message, variant })
  } catch {
    // safe fallback if toast is unsupported
  }
}

// ─── Alert modal ─────────────────────────────────────────────────────

/**
 * Shows an alert dialog and runs the dismiss path once it closes.
 * v2's `dialog.alert` resolves on both confirm and Esc — the v1
 * onConfirm/onDismiss split only mattered because the compat host's
 * Alert lacked a cancel button; flows that need a real Yes/No use
 * `ctx.ui.dialog.confirm` instead.
 */
export async function showAlertModal(
  ctx: Context,
  params: {
    title: string
    message: string
    onDismiss: () => void | Promise<void>
    onConfirm?: () => void | Promise<void>
  },
): Promise<void> {
  await ctx.ui.dialog.alert({ title: params.title, message: params.message })
  await (params.onConfirm ?? params.onDismiss)()
}

// ─── Busy modal ──────────────────────────────────────────────────────

/**
 * Replaces the current dialog with a non-dismissable busy placeholder
 * while an async operation runs. v2 has no busy prop on the built-in
 * dialogs, so this draws a minimal panel via dialog.show; the operation's
 * result dialog (alert/select/prompt) replaces it through the normal
 * single-active-dialog model. Escape while busy is swallowed — the
 * result always lands.
 */
export function showBusyModal(
  ctx: Context,
  params: { title: string; message: string; busyText?: string },
): void {
  ctx.ui.dialog.show(() =>
    busyPanel(ctx, params.title, params.message, params.busyText ?? tr("common.working")),
  )
}

// Minimal text panel for the busy state.
function busyPanel(ctx: Context, title: string, message: string, busyText: string) {
  const theme = ctx.theme
  return jsx("box", {
    style: { flexDirection: "column", paddingLeft: 1, paddingRight: 1 },
    children: [
      jsx("text", { style: { fg: theme.text.base }, children: jsx("span", { children: title }) }),
      ...message.split("\n").map((line) =>
        jsx("text", { style: { fg: theme.text.muted }, children: jsx("span", { children: line }) })),
      jsx("text", { style: { fg: theme.text.feedback.info.base }, children: jsx("span", { children: `⏳ ${busyText}` }) }),
    ],
  })
}

// ─── Badge formatters ────────────────────────────────────────────────

export type GuardValue = "on" | "off" | undefined
export type AdvisorValue = "off" | "lite" | "full" | undefined
export type AdrLayoutValue = "auto" | "flat" | "hierarchical" | undefined

export function formatGuardBadge(val: GuardValue): string {
  if (val === "on") return "🟢 On"
  if (val === "off") return "🔴 Off"
  return ""
}

export function formatAdvisorBadge(val: AdvisorValue): string {
  if (val === "lite") return "🟢 Lite"
  if (val === "full") return "🔵 Full"
  if (val === "off") return "🔴 Off"
  return ""
}

export function formatAdrLayoutBadge(val: AdrLayoutValue): string {
  if (val === "auto") return "🟢 Auto"
  if (val === "flat") return "📄 Flat"
  if (val === "hierarchical") return "📦 Hierarchy"
  return ""
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
