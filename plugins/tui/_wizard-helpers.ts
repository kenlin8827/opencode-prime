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

// ─── Busy indicator ──────────────────────────────────────────────────

/**
 * Surfaces a transient "working…" indicator while an async operation runs.
 * The operation's result dialog (alert/select/prompt) replaces it through
 * the normal single-active-dialog model.
 *
 * Why a toast, not `dialog.show(jsx)`: when opencode loads our plugin files
 * from `~/.config/opencode/plugins/tui/*.ts`, every `import { jsx } from
 * "@opentui/solid/jsx-runtime"` resolves to the *plugin's* installed copy of
 * `@opentui/solid` — a separate physical module from the host's bundled
 * copy. Solid resolves contexts by Symbol identity, so `useContext(
 * RendererContext)` inside the plugin's `createElement` looks up the wrong
 * symbol and throws `Error: No renderer found`. The throw happens inside the
 * JSX evaluation that opencode invokes on its render loop, which propagates
 * and kills the TUI (opencode issues #27447 and #33884 document the same
 * dual-instance failure mode for npm-spec and local TUI plugins).
 *
 * `ctx.ui.toast.show` takes plain options and renders through the host's
 * own renderer — no plugin JSX is involved, so the dual-instance trap is
 * bypassed. The toast's auto-dismiss matches the busy panel's "result
 * dialog replaces it" semantics in practice: every caller in this file
 * awaits the operation and immediately shows a result dialog, which lands
 * before the toast's 5s window expires for the slow network ops the busy
 * indicator originally covered (provider fetch/clear).
 *
 * The standalone OCP host (`ocp provider|project|...`) routes the plugin's
 * `dialog.show(jsx)` through `install/src/ui/app.tsx` and would hit the
 * same dual-instance throw — toast works there too.
 */
export function showBusyModal(
  ctx: Context,
  params: { title: string; message: string; busyText?: string },
): void {
  toast(ctx, `${params.title}\n${params.message}\n⏳ ${params.busyText ?? tr("common.working")}`)
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
