/**
 * Schema-driven renderer — pure-function unit tests.
 *
 * Covers `badgeFor` (field-type dispatch to existing badge formatters) and
 * the schema type contract (i18n keys only, no raw strings). No TUI runtime.
 *
 * Run: npx tsx tests/test-schema-driven-unit.ts
 */

import { strict as assert } from "node:assert"
import {
  badgeFor,
  type SchemaField,
  type SchemaFieldValue,
} from "../plugins/tui/schema-driven"

let passed = 0
let failed = 0

function check(name: string, condition: boolean): void {
  if (condition) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`)
  }
}

// ─── Test fixtures ──────────────────────────────────────────────────

const advisorField: SchemaField = {
  key: "autoAdvisorMode",
  type: "enum",
  labelKey: "project.switchAdvisor",
  descriptionKey: "project.switchAdvisor",
  badgeKind: "advisor",
  icon: "🤖",
  values: [
    { value: "lite", labelKey: "project.valueAdvisorLite" },
    { value: "full", labelKey: "project.valueAdvisorFull" },
    { value: "off", labelKey: "project.valueAdvisorOff" },
    { value: "default", labelKey: "project.valueAdvisorDefault" },
  ],
  default: "lite",
}

const guardField: SchemaField = {
  key: "adrGuard",
  type: "enum",
  labelKey: "project.switchAdrGuard",
  descriptionKey: "project.switchAdrGuard",
  badgeKind: "guard",
  icon: "🛡️",
  values: [
    { value: "on", labelKey: "project.valueGuardAdrOn" },
    { value: "off", labelKey: "project.valueGuardAdrOff" },
    { value: "default", labelKey: "project.valueAdvisorDefault" },
  ],
  default: "on",
}

const adrLayoutField: SchemaField = {
  key: "adrLayout",
  type: "enum",
  labelKey: "project.switchAdrLayout",
  descriptionKey: "project.switchAdrLayout",
  badgeKind: "adrLayout",
  icon: "🏛️",
  values: [
    { value: "auto", labelKey: "project.valueAdrLayoutAuto" },
    { value: "flat", labelKey: "project.valueAdrLayoutFlat" },
    { value: "hierarchical", labelKey: "project.valueAdrLayoutHierarchy" },
    { value: "default", labelKey: "project.valueAdrLayoutDefault" },
  ],
  default: "auto",
}

const stringField: SchemaField = {
  key: "adrDir",
  type: "enum-with-custom",
  labelKey: "project.switchAdrDir",
  descriptionKey: "project.switchAdrDir",
  badgeKind: "string",
  icon: "📁",
  values: [
    { value: "docs/adr", labelKey: "project.valueAdrDirDocsAdr" },
    { value: "docs/decisions", labelKey: "project.valueAdrDirDocsDecisions" },
  ],
  default: "docs/adr",
}

const adrDirFieldNoDefault: SchemaField = {
  ...stringField,
  default: undefined,
}

// ─── badgeFor — advisor field ───────────────────────────────────────

console.log("\n=== badgeFor (advisor field) ===")

check(
  "advisor on → lite badge",
  badgeFor(advisorField, "lite") === "🟢 lite",
)
check(
  "advisor on → full badge",
  badgeFor(advisorField, "full") === "🔵 full",
)
check(
  "advisor off badge",
  badgeFor(advisorField, "off") === "🔴 off",
)
check(
  "advisor default badge",
  badgeFor(advisorField, "default") === "⚪ default",
)
check(
  "advisor undefined → falls back to default (lite)",
  badgeFor(advisorField, undefined) === "🟢 lite",
)

// ─── badgeFor — guard field ──────────────────────────────────────────

console.log("\n=== badgeFor (guard field) ===")

check("guard on → ON", badgeFor(guardField, "on") === "🟢 ON")
check("guard off → OFF", badgeFor(guardField, "off") === "🔴 OFF")
check("guard default → default", badgeFor(guardField, "default") === "⚪ default")
check(
  "guard undefined → falls back to default (on)",
  badgeFor(guardField, undefined) === "🟢 ON",
)

// ─── badgeFor — adrLayout field ───────────────────────────────────────

console.log("\n=== badgeFor (adrLayout field) ===")

check("adrLayout auto → auto", badgeFor(adrLayoutField, "auto") === "🟢 auto")
check("adrLayout flat → flat", badgeFor(adrLayoutField, "flat") === "📄 flat")
check(
  "adrLayout hierarchical → hierarchy",
  badgeFor(adrLayoutField, "hierarchical") === "📦 hierarchy",
)
check(
  "adrLayout default → default",
  badgeFor(adrLayoutField, "default") === "⚪ default",
)
check(
  "adrLayout undefined → falls back to default (auto)",
  badgeFor(adrLayoutField, undefined) === "🟢 auto",
)

// ─── badgeFor — string field ─────────────────────────────────────────

console.log("\n=== badgeFor (string field) ===")

check(
  "string shows raw value (docs/adr)",
  badgeFor(stringField, "docs/adr") === "docs/adr",
)
check(
  "string shows custom value verbatim",
  badgeFor(stringField, "custom/my-adrs") === "custom/my-adrs",
)
check(
  "string undefined → falls back to default (docs/adr)",
  badgeFor(stringField, undefined) === "docs/adr",
)
check(
  "string no-default → empty when undefined",
  badgeFor(adrDirFieldNoDefault, undefined) === "",
)

// ─── Schema contract — every label is an i18n key, never raw text ─────

console.log("\n=== Schema contract ===")

// Sanity-check: fixture values reference i18n key shape (project.* / common.*)
// rather than raw user-facing text. This is a static check — if a future
// contributor inlines raw strings into the schema, the test still passes,
// but the structural rule (and review) should catch it. Here we assert
// the type/contract: `labelKey` is required, not optional.
for (const field of [advisorField, guardField, adrLayoutField, stringField]) {
  check(
    `field ${field.key} has labelKey (non-empty)`,
    typeof field.labelKey === "string" && field.labelKey.length > 0,
  )
  check(
    `field ${field.key} has descriptionKey (non-empty)`,
    typeof field.descriptionKey === "string" && field.descriptionKey.length > 0,
  )
  check(
    `field ${field.key} has icon`,
    typeof field.icon === "string" && field.icon.length > 0,
  )
  for (const v of field.values) {
    check(
      `field ${field.key} value '${v.value}' has labelKey`,
      typeof v.labelKey === "string" && v.labelKey.length > 0,
    )
  }
}

// ─── Summary ────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(40)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
