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

import type { Context } from "@opencode/plugin/tui/context"
import { tr, type StringKey } from "./i18n"
import {
  formatGuardBadge,
  formatAdvisorBadge,
  formatAdrLayoutBadge,
} from "./_wizard-helpers"

// ─── Schema types ────────────────────────────────────────────────────

export type SchemaFieldType = "enum" | "enum-with-custom"
export type BadgeKind = "guard" | "advisor" | "adrLayout" | "string"

export interface SchemaFieldValue {
  readonly value: string
  readonly labelKey: StringKey
  /** Optional description shown alongside the value label in the picker. */
  readonly descriptionKey?: StringKey
}

export interface SchemaField {
  readonly key: string
  readonly type: SchemaFieldType
  readonly labelKey: StringKey
  readonly descriptionKey: StringKey
  /** Optional i18n key for the field's DISPLAY NAME on the group menu row
   * (localized item name); falls back to the raw config key when absent. */
  readonly nameKey?: StringKey
  readonly badgeKind: BadgeKind
  /** Emoji prefix shown before the field key in the wizard menu. */
  readonly icon: string
  readonly values: readonly SchemaFieldValue[]
  /** enum-with-custom only — show a "Custom…" row. */
  readonly allowCustom?: boolean
  /** enum-with-custom only — title for the custom value prompt. */
  readonly customPromptKey?: StringKey
  /** enum-with-custom only — placeholder for the custom value prompt. */
  readonly customPlaceholderKey?: StringKey
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
      return formatGuardBadge(v as "on" | "off")
    case "advisor":
      return formatAdvisorBadge(v as "off" | "lite" | "full")
    case "adrLayout":
      return formatAdrLayoutBadge(v as "auto" | "flat" | "hierarchical")
    case "string":
    default:
      return v
  }
}

// ─── Renderer entry point ───────────────────────────────────────────

/**
 * Render a field's picker (v2: promise-based dialogs). Resolves with the
 * committed value, or `undefined` when the user backs out (cancel row or
 * Esc on every dialog level).
 */
export async function renderSchemaField(
  ctx: Context,
  field: SchemaField,
  currentValue: string | undefined,
): Promise<string | undefined> {
  if (field.type === "enum") {
    return renderEnumPicker(ctx, field, currentValue)
  }
  if (field.type === "enum-with-custom") {
    return renderEnumWithCustomPicker(ctx, field, currentValue)
  }
  // Unknown field type — fail closed by going back.
  return undefined
}

// ─── enum picker ─────────────────────────────────────────────────────

async function renderEnumPicker(
  ctx: Context,
  field: SchemaField,
  currentValue: string | undefined,
): Promise<string | undefined> {
  const initialValue = currentValue ?? field.default ?? field.values[0]?.value ?? ""
  const pick = await ctx.ui.dialog.select<string>({
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
  })
  if (pick === undefined || pick === "__cancel__") return undefined
  return pick
}

// ─── enum-with-custom picker ────────────────────────────────────────

async function renderEnumWithCustomPicker(
  ctx: Context,
  field: SchemaField,
  currentValue: string | undefined,
): Promise<string | undefined> {
  const initialValue = currentValue ?? field.default ?? field.values[0]?.value ?? ""
  const pick = await ctx.ui.dialog.select<string>({
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
  })
  if (pick === undefined || pick === "__cancel__") return undefined
  if (pick === "__custom__") return renderCustomPrompt(ctx, field, initialValue)
  return pick
}

async function renderCustomPrompt(
  ctx: Context,
  field: SchemaField,
  initialValue: string,
): Promise<string | undefined> {
  const val = await ctx.ui.dialog.prompt({
    title: tr(field.customPromptKey ?? "project.promptAdrDirTitle"),
    placeholder: tr(field.customPlaceholderKey ?? "project.promptAdrDirPlaceholder"),
    value: initialValue,
  })
  // Esc / blank input backs out; blank with text commits the trimmed value.
  if (val === undefined) return undefined
  const trimmed = val.trim()
  return trimmed === "" ? initialValue : trimmed
}

// ─── Icon dispatch for enum values ──────────────────────────────────

/**
 * Pick an icon for an enum value. Determined by value semantics
 * (on/off, lite/full/off, etc.), NOT by the field — same icon
 * for the same value across all fields that use it.
 */
function iconForValueKind(field: SchemaField, value: string): string {
  // Boolean-like (on/off) — used by guard fields.
  if (value === "on") return "🟢"
  if (value === "off") return "🔴"
  // Advisor mode — uses its own color set.
  if (field.badgeKind === "advisor") {
    if (value === "lite") return "🟢"
    if (value === "full") return "🔵"
  }
  // ADR layout — uses document/folder icons.
  if (field.badgeKind === "adrLayout") {
    if (value === "auto") return "🟢"
    if (value === "flat") return "📄"
    if (value === "hierarchical") return "📦"
  }
  return ""
}
