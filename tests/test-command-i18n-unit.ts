// Command-surface i18n completeness — every slash-command-facing STRINGS key
// must carry a non-empty string in ALL 8 registered locales.
//
// Rationale: `tr()` falls back to English, so a missing locale silently shows
// an English row inside an otherwise localized menu — a user-visible
// half-translation. The ADR glossary is unit-test enforced per locale
// (AGENTS.md §1); command rows get the same contract. When adding a command
// key (palette title/description, server help/desc, command feedback), add
// it to COMMAND_KEYS here and fill all 8 locales.
//
// Run: bun tests/test-command-i18n-unit.ts

import { strict as assert } from "node:assert"
import { LOCALES, STRINGS } from "../plugins/tui/i18n"

const COMMAND_KEYS = [
  // /profile (+ reset hint in desc)
  "profile.cmdTitle",
  "profile.cmdDesc",
  // /provider
  "provider.cmdTitle",
  "provider.cmdDesc",
  // /disconnect
  "provider.cmdDisconnectTitle",
  "provider.cmdDisconnectDesc",
  // /project (TUI wizard palette rows)
  "project.cmdTitle",
  "project.cmdDesc",
  // /usage
  "usage.commandTitle",
  "usage.commandDesc",
  // /project server twin (help + menu label + bad-subcommand feedback)
  "guard.pm.help",
  "guard.pm.desc",
  "guard.pm.unknown",
] as const

const strings = STRINGS as unknown as Record<string, Partial<Record<string, string>> | undefined>

let checked = 0
for (const key of COMMAND_KEYS) {
  const entry = strings[key]
  assert(entry !== undefined, `STRINGS[${key}] exists`)
  for (const locale of LOCALES) {
    const value = entry[locale.code]
    assert(
      typeof value === "string" && value.trim().length > 0,
      `STRINGS[${key}][${locale.code}] is non-empty (8-locale command i18n contract)`,
    )
  }
  // Sanity: every translation keeps slash/flag/placeholder tokens intact —
  // a translated "/project" or "{sub}" that drifts breaks the command itself.
  const tokens = ["/project", "/profile", "/usage", "{sub}"].filter((token) => strings[key]![enKey()]!.includes(token))
  for (const token of tokens) {
    for (const locale of LOCALES) {
      assert(
        strings[key]![locale.code]!.includes(token),
        `STRINGS[${key}][${locale.code}] keeps token "${token}"`,
      )
    }
  }
  checked++
}

function enKey(): string {
  return "en"
}

console.log(`✅ ${checked} command keys × ${LOCALES.length} locales complete (tokens preserved)`)
