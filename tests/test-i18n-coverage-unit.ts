// Full-catalog i18n coverage — every registered locale must carry all 612
// STRINGS keys, not just the 13 command-surface keys.
//
// Design rationale: tr() silently falls back to English, so a missing key is
// invisible at runtime and only shows up as a half-translated screen. This
// test makes the fallback a test failure instead.
//
// Hard failures:
//   1. key set != en key set (missing or unknown key)
//   2. non-empty value for every key
//   3. structural shape identical to en (bullet count, markdown table row
//      count, blank-line count). Raw \n parity is deliberately NOT required:
//      CJK wraps denser than Spanish, so re-wrapping prose is legitimate —
//      dropping a list item or collapsing a table is not.
//   4. every locale placeholder exists in en (a locale-only {token} the
//      caller never passes renders literally) — unless allowlisted below
//   5. every slash-command token present in en survives in the locale
//      (a translated "/project" breaks the command itself)
//   6. no cross-script contamination — a kanji inside a Russian line passes
//      every structural rule above while reading as nonsense to the user
//   7. no duplicate keys in the raw source — Object.keys() silently keeps
//      only the last value, so a duplicated key reports 612 and passes while
//      one translation is dropped without a trace
//   8. angle-bracket metasyntax balanced as in en (`<ADR-x.y.z>`, `<title>`)
//      — usage syntax like "<ADR-x.y.z]" is not caught by the slash-token rule
//      because the command itself is intact
//
// Reported but not fatal:
//   - en placeholder unused by the locale (caller passes it, locale chose a
//     different word — legitimate, e.g. guard.memory.set STATE vs zhState)
//   - locale value byte-identical to en (may be legitimately untranslated:
//     identifiers like "baseURL", "envGuard")
//
// Run: bun tests/test-i18n-coverage-unit.ts

import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import en from "../plugins/tui/i18n/locales/en"
import zhCN from "../plugins/tui/i18n/locales/zh-CN"
import es from "../plugins/tui/i18n/locales/es"
import fr from "../plugins/tui/i18n/locales/fr"
import ru from "../plugins/tui/i18n/locales/ru"
import ar from "../plugins/tui/i18n/locales/ar"
import pt from "../plugins/tui/i18n/locales/pt"
import ja from "../plugins/tui/i18n/locales/ja"

type Catalog = Record<string, string>

const CATALOGS: Record<string, Catalog> = {
  "zh-CN": zhCN as Catalog,
  es: es as Catalog,
  fr: fr as Catalog,
  ru: ru as Catalog,
  ar: ar as Catalog,
  pt: pt as Catalog,
  ja: ja as Catalog,
}

/**
 * Locale-only placeholders that ARE passed by the caller. Key-specific.
 * guard.memory.set: en renders {STATE} (ON/OFF token), zh-CN instead renders
 * {zhState} (a localized word supplied alongside STATE by
 * plugins/project-memory/project-memory-command.ts).
 */
const PLACEHOLDER_ALLOW: Record<string, string[]> = {
  "guard.memory.set": ["zhState"],
}

const EN = en as unknown as Catalog

const placeholders = (s: string): Set<string> => {
  const out = new Set<string>()
  for (const m of s.matchAll(/\{(\w+)\}/g)) out.add(m[1])
  return out
}

/**
 * Slash-command tokens: a "/" immediately preceded by start-of-string,
 * whitespace, backtick or "[" and followed by a lowercase letter. The
 * lookbehind-by-char-class keeps prose separators ("session / agent"),
 * fractions ("1/2/3"), paths (".config/opencode"), tier chains
 * ("flash/standard/pro") and URLs out of the token set.
 */
const slashTokens = (s: string): Set<string> => {
  const out = new Set<string>()
  const re = /(?:^|[\s(`[])(\/[a-z][a-z0-9-]*)/g
  for (const m of s.matchAll(re)) out.add(m[1])
  return out
}

/**
 * Structural shape — what must survive translation. Prose may re-wrap per
 * language (CJK is denser than Spanish), so counting raw \n flags harmless
 * re-wrapping while still missing a dropped bullet. These three capture the
 * invariants that actually break rendering: a lost list item, a collapsed
 * markdown table row, a fused paragraph.
 */
const lines = (s: string): string[] => s.split("\n")
const bullets = (s: string): number => lines(s).filter((l) => /^\s*-\s/.test(l)).length
const tableRows = (s: string): number => lines(s).filter((l) => l.startsWith("|")).length
const blankLines = (s: string): number => lines(s).filter((l) => l.trim() === "").length

/**
 * Cross-script contamination — the one defect no structural rule can see.
 * Only scripts that are NEVER native or legitimate to a locale are banned,
 * which keeps the project's locale-invariant Latin vocabulary (baseURL,
 * /project, envGuard, codegraph) legal everywhere it legitimately appears:
 *
 *   es/fr/pt — Latin native → no Cyrillic, Arabic, Kana, Han, Hangul
 *   ru       — Cyrillic native, Latin identifiers legal → no Kana, Han, Hangul, Arabic
 *   ar       — Arabic native, Latin identifiers legal → no Cyrillic, Kana, Han, Hangul
 *   ja       — Kana + Han are native, Latin legal → no Cyrillic, Arabic, Hangul
 *   zh-CN    — Han native, Latin legal → no Cyrillic, Arabic, Hangul, Kana
 *
 * Ranges are written as \u escapes so the check cannot be silently corrupted
 * by an encoding round-trip: Cyrillic U+0400-04FF, Arabic U+0600-06FF,
 * Kana U+3040-30FF, Han U+4E00-9FFF, Hangul syllables U+AC00-D7AF.
 *
 * A regex that never matches looks exactly like one that always passes, so
 * REGRESSION_PROBE below asserts each rule still fires on a known foreign
 * character — otherwise a broken range would silently "pass" forever.
 */
const CONTAMINATION: Record<string, RegExp> = {
  es: /[Ѐ-ӿ؀-ۿ぀-ヿ一-鿿가-힣]/u,
  fr: /[Ѐ-ӿ؀-ۿ぀-ヿ一-鿿가-힣]/u,
  pt: /[Ѐ-ӿ؀-ۿ぀-ヿ一-鿿가-힣]/u,
  ru: /[぀-ヿ一-鿿가-힣؀-ۿ]/u,
  ar: /[Ѐ-ӿ぀-ヿ一-鿿가-힣]/u,
  ja: /[Ѐ-ӿ؀-ۿ가-힣]/u,
  "zh-CN": /[Ѐ-ӿ؀-ۿ぀-ヿ가-힣]/u,
}

/** One character each rule MUST flag: [locale, code point]. */
const REGRESSION_PROBE: ReadonlyArray<readonly [string, string]> = [
  ["es", "х"], // Cyrillic ef in a Spanish line
  ["fr", "あ"], // Hiragana a in a French line
  ["pt", "中"], // Han zhong in a Portuguese line
  ["ru", "設"], // Kanji setsu in a Russian line (the real defect found)
  ["ar", "Я"], // Cyrillic YA in an Arabic line
  ["ja", "Ж"], // Cyrillic ZHE in a Japanese line
  ["zh-CN", "م"], // Arabic meem in a Chinese line
]

const enKeys = Object.keys(EN)
const hard: string[] = []
const info: string[] = []

const LOCALE_DIR = join(import.meta.dir, "..", "plugins", "tui", "i18n", "locales")

/** Raw source keys, BEFORE object-literal dedup — the only place dups are visible. */
const rawKeys = (file: string): string[] =>
  [...readFileSync(join(LOCALE_DIR, file), "utf8").matchAll(/^\s*"((?:[^"\\]|\\.)+)":/gm)].map((m) => m[1])

/** en's own angle-bracket metasyntax volume — the balance every locale must match. */
const enOpen = (EN["guard.adr.help"].match(/</g) ?? []).length
const enClose = (EN["guard.adr.help"].match(/>/g) ?? []).length

// Prove every contamination rule can still fire before trusting its silence.
for (const [code, cp] of REGRESSION_PROBE) {
  const re = CONTAMINATION[code]
  assert(re !== undefined, `probe: contamination rule exists for ${code}`)
  const m = String.fromCodePoint(Number.parseInt(cp.codePointAt(0)!.toString(16), 16)).match(re)
  assert(m !== null, `probe: ${code} rule must flag U+${cp.codePointAt(0)!.toString(16).toUpperCase()} — a dead regex would pass forever`)
}
console.log(`  probes ${REGRESSION_PROBE.length}/${REGRESSION_PROBE.length} contamination rules verified live`)

// 7. duplicate keys — checked against raw text, not the parsed object.
for (const [code, file] of Object.entries({ "zh-CN": "zh-CN.ts", es: "es.ts", fr: "fr.ts", ru: "ru.ts", ar: "ar.ts", pt: "pt.ts", ja: "ja.ts" })) {
  const seen = rawKeys(file)
  const dupes = [...new Set(seen.filter((k, i) => seen.indexOf(k) !== i))]
  if (dupes.length) hard.push(`[${code}] ${file}: duplicate key(s) silently deduped by Object.keys: ${dupes.join(", ")}`)
}

for (const [code, catalog] of Object.entries(CATALOGS)) {
  const keys = Object.keys(catalog)

  // 1. key set parity
  const missing = enKeys.filter((k) => !(k in catalog))
  const unknown = keys.filter((k) => !(k in EN))
  if (missing.length) hard.push(`[${code}] missing ${missing.length} key(s): ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ", …" : ""}`)
  if (unknown.length) hard.push(`[${code}] ${unknown.length} key(s) not in en: ${unknown.slice(0, 8).join(", ")}`)

  let identical = 0
  for (const key of enKeys) {
    const value = catalog[key]
    if (value === undefined) continue
    const source = EN[key]

    // 2. non-empty
    if (typeof value !== "string" || value.trim().length === 0) {
      hard.push(`[${code}] ${key}: empty value`)
      continue
    }

    // 3. structural shape parity (bullets / table rows / paragraph breaks)
    if (source.includes("\n") && !value.includes("\n")) {
      hard.push(`[${code}] ${key}: multi-line en value collapsed to one line`)
    }
    if (bullets(value) !== bullets(source)) {
      hard.push(`[${code}] ${key}: bullet count ${bullets(value)} != en ${bullets(source)}`)
    }
    if (tableRows(value) !== tableRows(source)) {
      hard.push(`[${code}] ${key}: table row count ${tableRows(value)} != en ${tableRows(source)}`)
    }
    if (blankLines(value) !== blankLines(source)) {
      hard.push(`[${code}] ${key}: blank line count ${blankLines(value)} != en ${blankLines(source)}`)
    }

    // 4. locale placeholders must be known to the caller
    const allow = new Set(PLACEHOLDER_ALLOW[key] ?? [])
    for (const p of placeholders(value)) {
      if (!placeholders(source).has(p) && !allow.has(p)) {
        hard.push(`[${code}] ${key}: locale-only placeholder {${p}} (caller may not pass it)`)
      }
    }

    // 5. slash-command tokens survive translation. Tokens are DERIVED from
    // en with the strict lookbehind (so only real commands qualify), then
    // matched as a plain SUBSTRING of the locale. Re-deriving from the
    // locale would misfire: a locale may drop the ASCII space before a
    // fullwidth colon ("开关：/adr"), so the lookbehind finds nothing even
    // though the token is intact.
    for (const t of slashTokens(source)) {
      if (!value.includes(t)) {
        hard.push(`[${code}] ${key}: lost slash token "${t}"`)
      }
    }

    // 6. cross-script contamination (values are the shipped, user-visible
    // surface — header comments are not part of this check)
    const banned = CONTAMINATION[code]
    if (banned) {
      const bad = value.match(banned)
      if (bad) {
        hard.push(`[${code}] ${key}: contains foreign script character "${bad[0]}" (U+${bad[0].codePointAt(0)!.toString(16).toUpperCase()})`)
      }
    }

    // 8. angle-bracket usage syntax stays balanced exactly as in en — the
    // slash-token rule cannot see "<ADR-x.y.z]" because "/adr section"
    // is still present
    const vOpen = (value.match(/</g) ?? []).length
    const vClose = (value.match(/>/g) ?? []).length
    if (key === "guard.adr.help" && (vOpen !== enOpen || vClose !== enClose)) {
      hard.push(`[${code}] ${key}: angle brackets ${vOpen}/${vClose} != en ${enOpen}/${enClose} (mismatched <...])`)
    }

    if (value === source) identical++
    else {
      // en placeholder the locale chose not to render — informational
      for (const p of placeholders(source)) {
        if (!placeholders(value).has(p)) info.push(`[${code}] ${key}: en {${p}} unused`)
      }
    }
  }

  console.log(`  ${code.padEnd(6)} ${keys.length}/${enKeys.length} keys · ${identical} byte-identical to en`)
}

if (info.length) {
  console.log(`\nℹ️ ${info.length} informational note(s):`)
  for (const line of info) console.log(`   ${line}`)
}

if (hard.length) {
  console.error(`\n❌ ${hard.length} hard failure(s):`)
  for (const line of hard) console.error(`   ${line}`)
  assert.fail(`${hard.length} i18n coverage failure(s)`)
}

assert.equal(enKeys.length, 612, "en registry holds 612 keys")
console.log(`\n✅ ${enKeys.length} keys × ${Object.keys(CATALOGS).length + 1} locales complete (structure, placeholders, slash tokens preserved)`)
