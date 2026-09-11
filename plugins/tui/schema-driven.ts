/**
 * Schema-driven wizard renderer.
 *
 * Renders enum / enum-with-custom pickers driven by a JSON schema. Adding
 * a new wizard field = add a row to the schema JSON, no wizard code change.
 *
 * i18n: every label, description, and value-text is referenced by i18n key.
 * The schema never holds raw user-facing strings — that is the whole point
 * of putting i18n in the schema contract rather than in the wizard code.
 *
 * Scope: covers form-style fields (enum pickers). Does NOT cover:
 *   - Form pages with multiple editable fields (multi-field forms keep
 *     their bespoke wizard for now).
 *   - Conditional visibility / cross-field validation (would need a richer
 *     schema; out of Phase 1 scope).
 *   - File pickers, async operations (dprint setup, index refresh) — those
 *     are flows, not forms.
 *
 * Phase 1 scope: project-wizard's auto-advisor + project-guards + ADR groups
 * (1 + 2 + 3 = 6 enum fields total, spread across three schemas).
 * Other wizards migrate in a later phase.
 */

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { tr } from "./i18n"
import {
  formatGuardBadge,
  formatAdvisorBadge,
  formatAdrModeBadge,
} from "./_wizard-helpers"

// ─── Schema types ────────────────────────────────────────────────────

export type SchemaFieldType = "enum" | "enum-with-custom"
export type BadgeKind = "guard" | "advisor" | "adrMode" | "string"

export interface SchemaFieldValue {
  readonly value: string
  readonly labelKey: string
  /** Optional description shown alongside the value label in the picker. */
  readonly descriptionKey?: string
}

export interface SchemaField {
  readonly key: string
  readonly type: SchemaFieldType
  readonly labelKey: string
  readonly descriptionKey: string
  readonly badgeKind: BadgeKind
  /** Emoji prefix shown before the field key in the wizard menu. */
  readonly icon: string
  readonly values: readonly SchemaFieldValue[]
  /** enum-with-custom only — show a "Custom…" row. */
  readonly allowCustom?: boolean
  /** enum-with-custom only — title for the custom value prompt. */
  readonly customPromptKey?: string
  /** enum-with-custom only — placeholder for the custom value prompt. */
  readonly customPlaceholderKey?: string
  readonly default?: string
}

export interface WizardGroupSchema {
  readonly id: string
  readonly i18nKey: string
  readonly description?: string
  readonly fields: readonly SchemaField[]
}

// ─── Badge formatter dispatch ───────────────────────────────────────

/**
 * Format the current value of a field as a short badge string.
 * Used inline in the wizard menu next to the field name
 * (`🤖 autoAdvisorMode:  🟢 lite`).
 */
export function badgeFor(field: SchemaField, value: string | undefined): string {
  const v = value ?? field.default
  if (v === undefined) return ""
  switch (field.badgeKind) {
    case "guard":
      return formatGuardBadge(v as "on" | "off" | "default")
    case "advisor":
      return formatAdvisorBadge(v as "off" | "lite" | "full" | "default")
    case "adrMode":
      return formatAdrModeBadge(v as "auto" | "flat" | "hierarchical" | "default")
    case "string":
    default:
      return v
  }
}

// ─── Renderer entry point ───────────────────────────────────────────

/**
 * Render a field's picker. Calls onCommit with the chosen value, or
 * onCancel if the user backs out (Esc on every dialog level).
 *
 * Both callbacks are invoked at most once.
 */
export function renderSchemaField(
  api: TuiPluginApi,
  field: SchemaField,
  currentValue: string | undefined,
  onCommit: (newValue: string) => void,
  onCancel: () => void,
): void {
  if (field.type === "enum") {
    renderEnumPicker(api, field, currentValue, onCommit, onCancel)
  } else if (field.type === "enum-with-custom") {
    renderEnumWithCustomPicker(api, field, currentValue, onCommit, onCancel)
  } else {
    // Unknown field type — fail closed by going back.
    onCancel()
  }
}

// ─── enum picker ─────────────────────────────────────────────────────

function renderEnumPicker(
  api: TuiPluginApi,
  field: SchemaField,
  currentValue: string | undefined,
  onCommit: (newValue: string) => void,
  onCancel: () => void,
): void {
  let navigated = false
  const initialValue = currentValue ?? field.default ?? field.values[0]?.value ?? ""
  api.ui.dialog.replace(
    () =>
      api.ui.DialogSelect<string>({
        title: tr(field.labelKey),
        placeholder: tr("project.currentValue", { value: initialValue }),
        current: initialValue,
        options: [
          ...field.values.map((v) => ({
            title: `${iconForValueKind(field, v.value)} ${v.value}${currentValue === v.value ? tr("project.currentMarker") : ""}`,
            value: v.value,
            description: tr(v.labelKey),
          })),
          { title: tr("project.cancel"), value: "__cancel__", description: tr("project.cancelDesc") },
        ],
        onSelect: (sel) => {
          navigated = true
          if (sel.value === "__cancel__") {
            onCancel()
          } else {
            onCommit(sel.value)
          }
        },
      }),
    () => {
      if (!navigated) setTimeout(onCancel, 0)
    },
  )
}

// ─── enum-with-custom picker ────────────────────────────────────────

function renderEnumWithCustomPicker(
  api: TuiPluginApi,
  field: SchemaField,
  currentValue: string | undefined,
  onCommit: (newValue: string) => void,
  onCancel: () => void,
): void {
  let navigated = false
  const initialValue = currentValue ?? field.default ?? field.values[0]?.value ?? ""
  api.ui.dialog.replace(
    () =>
      api.ui.DialogSelect<string>({
        title: tr(field.labelKey),
        placeholder: tr("project.currentValue", { value: initialValue }),
        current: initialValue,
        options: [
          ...field.values.map((v) => ({
            title: `📁 ${v.value}${currentValue === v.value ? tr("project.currentMarker") : ""}`,
            value: v.value,
            description: tr(v.labelKey),
          })),
          ...(field.allowCustom
            ? [{
                title: tr("project.valueAdrDirCustom"),
                value: "__custom__",
                description: tr("project.valueAdrDirCustomDesc"),
              }]
            : []),
          { title: tr("project.cancel"), value: "__cancel__", description: tr("project.cancelDesc") },
        ],
        onSelect: (sel) => {
          navigated = true
          if (sel.value === "__cancel__") {
            onCancel()
          } else if (sel.value === "__custom__") {
            renderCustomPrompt(api, field, initialValue, onCommit, onCancel)
          } else {
            onCommit(sel.value)
          }
        },
      }),
    () => {
      if (!navigated) setTimeout(onCancel, 0)
    },
  )
}

function renderCustomPrompt(
  api: TuiPluginApi,
  field: SchemaField,
  initialValue: string,
  onCommit: (value: string) => void,
  onCancel: () => void,
): void {
  let navPrompt = false
  api.ui.dialog.replace(
    () =>
      api.ui.DialogPrompt({
        title: tr(field.customPromptKey ?? "project.promptAdrDirTitle"),
        placeholder: tr(field.customPlaceholderKey ?? "project.promptAdrDirPlaceholder"),
        value: initialValue,
        onConfirm: (val) => {
          navPrompt = true
          const trimmed = val.trim()
          onCommit(trimmed === "" ? initialValue : trimmed)
        },
        onCancel: () => {
          navPrompt = true
          setTimeout(onCancel, 0)
        },
      }),
    () => {
      if (!navPrompt) setTimeout(onCancel, 0)
    },
  )
}

// ─── Icon dispatch for enum values ──────────────────────────────────

/**
 * Pick an icon for an enum value. Determined by value semantics
 * (on/off/default, lite/full/off, etc.), NOT by the field — same icon
 * for the same value across all fields that use it.
 */
function iconForValueKind(field: SchemaField, value: string): string {
  // Boolean-like tri-state (on/off/default) — used by guard fields.
  if (value === "on") return "🟢"
  if (value === "off") return "🔴"
  if (value === "default") return "⚪"
  // Advisor mode — uses its own color set.
  if (field.badgeKind === "advisor") {
    if (value === "lite") return "🟢"
    if (value === "full") return "🔵"
  }
  // ADR mode — uses document/folder icons.
  if (field.badgeKind === "adrMode") {
    if (value === "auto") return "🟢"
    if (value === "flat") return "📄"
    if (value === "hierarchical") return "📦"
  }
  return ""
}
