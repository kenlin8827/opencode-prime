/**
 * Phase 7 — Project-level ADR overrides (configurable extensions).
 *
 * Coverage:
 *   - normalizeFilenamePattern / normalizeSlugStyle / normalizeExtraSections /
 *     normalizeIndexColumns: schema validation
 *   - getAdrConfig(): defaults + overrides + silent fallback
 *   - setAdrConfigKey / clearAdrConfigKey: unified 8-key write path
 *   - slugify / renderAdrFilename / appendExtraSections
 *   - renderUnifiedIndexRow column projection + byte-stable backward compat
 *   - suite-field consistency (/adr config style madr)
 *   - runtime config fragment + hint (skill-based protocol, Phase 7.8)
 *   - last-good fallback on corrupt config (Phase 7.9)
 *   - /adr receipt skill-trigger assertions (i18n, Phase 7.8)
 *
 * Run: bun run tests/test-adr-project-overrides-unit.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_INDEX_COLUMNS,
  clearAdrConfigKey,
  getAdrConfig,
  isEnabled,
  normalizeExtraSections,
  normalizeFilenamePattern,
  normalizeIndexColumns,
  normalizeSlugStyle,
  resetAdrGovernanceWarnings,
  resetAdrOverrideWarnings,
  resetLegacyAdrKeyWarnings,
  setAdrConfigFields,
  setAdrConfigKey,
  setProjectDir,
  clearState,
  setState,
} from "../plugins/adr/adr-config"
import {
  appendExtraSections,
  createAdr,
  regenerateAdlIndexes,
  renderAdrFilename,
  slugify,
} from "../plugins/adr/adr-engine"
import {
  getAdrConfigRuntimeFragment,
  getGuardHintPrompt,
  MARKER_CONFIG,
  MARKER_HINT,
  PROTOCOL_SKILL_REF,
  resetAdrLastGoodFragment,
} from "../plugins/adr/adr-instructions"
import { renderAdlIndex, renderLabelGlossaryLocalized, renderUnifiedIndexRow, type IndexColumn } from "../plugins/adr/adr-views"
import { ADR_GLOSSARY, LOCALES, type GlossaryLocale } from "../plugins/tui/i18n"
import type { NormalizedAdrRecord } from "../plugins/adr/adr-types"

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✅ ${msg}`)
    passed++
  } else {
    console.error(`  ❌ ${msg}`)
    failed++
  }
}

function section(title: string): void {
  console.log(`\n${"═".repeat(60)}`)
  console.log(`  ${title}`)
  console.log(`${"═".repeat(60)}`)
}

function makeSandbox(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `adr-overrides-${tag}-`))
  setProjectDir(dir)
  mkdirSync(join(dir, ".ocp"), { recursive: true })
  return dir
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort
  }
}

function writeConfig(dir: string, body: string): void {
  writeFileSync(join(dir, ".ocp", "ocp.json"), body, "utf-8")
}

function record(opts: Partial<NormalizedAdrRecord> = {}): NormalizedAdrRecord {
  return {
    id: opts.id ?? "ADR-0001",
    style: opts.style ?? "madr",
    sourcePath: opts.sourcePath ?? "docs/adr/0001-x.md",
    title: opts.title ?? "Use Postgres",
    status: opts.status ?? "accepted",
    created: opts.created ?? "2026-01-15",
    date: opts.date ?? "2026-01-15",
    layer: opts.layer ?? "system",
    domain: opts.domain,
    scope: opts.scope,
    baseline: opts.baseline,
    iteration: opts.iteration,
    parentIds: opts.parentIds ?? [],
    supersedes: opts.supersedes ?? [],
    supersededBy: opts.supersededBy ?? [],
    rawContent: opts.rawContent ?? "",
  }
}

// ─── filenamePattern normalization ─────────────────────────────────────

function test01_FilenamePattern(): void {
  section("Phase 7 §7.1 — filenamePattern normalization")

  assert(normalizeFilenamePattern("{id}-{slug}") === "{id}-{slug}", "default pattern is unchanged")
  assert(normalizeFilenamePattern("ADR-{id}-{slug}") === "ADR-{id}-{slug}", "ADR- prefix accepted")
  assert(normalizeFilenamePattern("  {id}  ") === "{id}", "leading/trailing whitespace trimmed")
  assert(normalizeFilenamePattern("{id}\t{slug}") === "{id} {slug}", "internal tabs collapsed to single space")
  assert(normalizeFilenamePattern("prefix-{id}") !== null, "slug-less pattern accepted when {id} present")
  assert(normalizeFilenamePattern("{slug}") === null, "missing {id} rejected")
  assert(normalizeFilenamePattern("") === null, "empty rejected")
  assert(normalizeFilenamePattern(null) === null, "non-string rejected")
  assert(normalizeFilenamePattern(42) === null, "number rejected")
}

// ─── slugStyle normalization ───────────────────────────────────────────

function test02_SlugStyle(): void {
  section("Phase 7 §7.2 — slugStyle normalization")

  assert(normalizeSlugStyle("kebab") === "kebab", "kebab accepted")
  assert(normalizeSlugStyle("SNAKE") === "snake", "case-insensitive")
  assert(normalizeSlugStyle("  lower  ") === "lower", "trimmed")
  assert(normalizeSlugStyle("camel") === null, "unknown value rejected")
  assert(normalizeSlugStyle(null) === null, "non-string rejected")
}

// ─── extraSections normalization ───────────────────────────────────────

function test03_ExtraSections(): void {
  section("Phase 7 §7.3 — extraSections normalization")

  const ok = normalizeExtraSections(["## Risks", "## Notes", "## Open Questions"])
  assert(ok !== null && ok.length === 3, "three H2 headings accepted")
  assert(ok !== null && ok[0] === "## Risks", "first heading preserved verbatim")

  assert(normalizeExtraSections([])?.length === 0, "empty array → empty array")
  assert(normalizeExtraSections(["## Risks", "### Subsection"]) === null, "non-H2 entry rejected")
  assert(normalizeExtraSections(["## Risks", ""]) === null, "empty entry rejected")
  assert(normalizeExtraSections(["## Risks", 42]) === null, "non-string entry rejected")
  assert(normalizeExtraSections("not-an-array") === null, "non-array rejected")
  assert(normalizeExtraSections(null) === null, "null rejected")
}

// ─── indexColumns normalization ────────────────────────────────────────

function test04_IndexColumns(): void {
  section("Phase 7 §7.4 — indexColumns normalization")

  const a = normalizeIndexColumns(["id", "title", "status"])
  assert(a !== null && a.length === 3, "three known columns accepted")
  assert(a !== null && a[0] === "id" && a[1] === "title" && a[2] === "status", "order preserved")

  const b = normalizeIndexColumns(["ID", "Title"])
  assert(b !== null && b[0] === "id" && b[1] === "title", "case-insensitive")

  assert(normalizeIndexColumns(["id", "id"]) === null, "duplicate rejected")
  assert(normalizeIndexColumns(["unknown"]) === null, "unknown column rejected")
  assert(normalizeIndexColumns([]) === null, "empty array rejected")
  assert(normalizeIndexColumns("id,title") === null, "CSV string rejected (must be array)")
}

// ─── getAdrConfig integration with the new keys ────────────────────────

function test05_GetAdrConfig_DefaultsAndOverrides(): void {
  section("Phase 7 §7.5 — getAdrConfig() defaults + overrides")

  resetAdrOverrideWarnings()
  resetLegacyAdrKeyWarnings()
  resetAdrGovernanceWarnings()
  const dir = makeSandbox("defaults")

  try {
    // No config file → all defaults
    const def = getAdrConfig()
    assert(def.filenamePattern === "{id}-{slug}", "default filenamePattern")
    assert(def.slugStyle === "kebab", "default slugStyle")
    assert(def.extraSections.length === 0, "default extraSections empty")
    assert(def.indexColumns.length === DEFAULT_INDEX_COLUMNS.length, "default indexColumns = full set")
    assert(def.indexColumns[0] === "id", "default indexColumns[0] = id")

    // Override every field
    writeConfig(
      dir,
      JSON.stringify({
        adr: {
          style: "madr",
          numbering: "sequential",
          filenamePattern: "ADR-{id}-{slug}",
          slugStyle: "snake",
          extraSections: ["## Risks", "## Notes"],
          indexColumns: ["id", "title", "status"],
        },
      }),
    )
    const cfg = getAdrConfig()
    assert(cfg.filenamePattern === "ADR-{id}-{slug}", "filenamePattern applied")
    assert(cfg.slugStyle === "snake", "slugStyle applied")
    assert(cfg.extraSections.length === 2 && cfg.extraSections[0] === "## Risks", "extraSections applied")
    assert(cfg.indexColumns.length === 3, "indexColumns narrowed to 3")
    assert(cfg.indexColumns[0] === "id" && cfg.indexColumns[2] === "status", "indexColumns order preserved")

    // Invalid values silently fall back to defaults
    writeConfig(
      dir,
      JSON.stringify({
        adr: {
          filenamePattern: "no-id-here",
          slugStyle: "kebab-case",
          extraSections: ["### not-h2"],
          indexColumns: ["nope"],
        },
      }),
    )
    const fb = getAdrConfig()
    assert(fb.filenamePattern === "{id}-{slug}", "invalid filenamePattern falls back")
    assert(fb.slugStyle === "kebab", "invalid slugStyle falls back")
    assert(fb.extraSections.length === 0, "invalid extraSections falls back")
    assert(fb.indexColumns.length === DEFAULT_INDEX_COLUMNS.length, "invalid indexColumns falls back")
  } finally {
    cleanup(dir)
  }
}

// ─── setAdrConfigKey / clearAdrConfigKey ───────────────────────────────

function test06_SetClearOverride(): void {
  section("Phase 7 §7.6 — set/clear override round-trip")

  resetAdrOverrideWarnings()
  resetLegacyAdrKeyWarnings()
  const dir = makeSandbox("setclear")

  try {
    writeConfig(dir, JSON.stringify({ adr: { style: "madr" } }))

    const ok = setAdrConfigKey("filenamePattern", "ADR-{id}-{slug}")
    assert(ok, "setAdrConfigKey returns true on success")

    const onDisk = readFileSync(join(dir, ".ocp", "ocp.json"), "utf-8")
    assert(onDisk.includes("ADR-{id}-{slug}"), "filenamePattern appears in disk config")
    assert(/"style"\s*:\s*"madr"/.test(onDisk), "other adr.* keys preserved (style=madr)")

    // Re-running with same value is a no-op (byte-stable)
    const ok2 = setAdrConfigKey("filenamePattern", "ADR-{id}-{slug}")
    assert(ok2, "idempotent set still returns true")

    // Array fields round-trip as JSON
    const ok3 = setAdrConfigKey("extraSections", "## Risks\n## Notes")
    assert(ok3, "newline-separated extraSections accepted")
    const onDisk2 = readFileSync(join(dir, ".ocp", "ocp.json"), "utf-8")
    assert(onDisk2.includes("## Risks") && onDisk2.includes("## Notes"), "extraSections serialized")
    assert(/"extraSections"\s*:\s*\[\s*"## Risks"/.test(onDisk2), "extraSections serializes as JSON array (not double-encoded string)")

    // Invalid value rejected
    const bad = setAdrConfigKey("slugStyle", "kebab-case")
    assert(!bad, "invalid slugStyle returns false")
    const afterBad = getAdrConfig()
    assert(afterBad.slugStyle === "kebab", "rejected value leaves slugStyle at default")

    // Clear
    const cl = clearAdrConfigKey("filenamePattern")
    assert(cl, "clear returns true")
    const after = getAdrConfig()
    assert(after.filenamePattern === "{id}-{slug}", "cleared filenamePattern reverts to default")

    // Other fields untouched by clear
    assert(after.extraSections.length === 2, "clearing one key preserves others")
  } finally {
    cleanup(dir)
  }
}

// ─── suite-field consistency: same /adr config command path ─────────────

function test14_SuiteFieldsOnSamePath(): void {
  section("Phase 7.6 §7.14 — suite fields share /adr config path")

  resetAdrOverrideWarnings()
  resetLegacyAdrKeyWarnings()
  resetAdrGovernanceWarnings()
  const dir = makeSandbox("suitefields")

  try {
    writeConfig(dir, JSON.stringify({ adr: { style: "madr", numbering: "sequential" } }))

    // Set each suite field through the unified setter
    assert(setAdrConfigKey("style", "nygard"), "setAdrConfigKey style=nygard")
    assert(setAdrConfigKey("numbering", "iteration"), "setAdrConfigKey numbering=iteration")
    assert(setAdrConfigKey("layout", "hierarchical"), "setAdrConfigKey layout=hierarchical")
    assert(setAdrConfigKey("governance", "review"), "setAdrConfigKey governance=review")

    const cfg = getAdrConfig()
    assert(cfg.style === "nygard", "style applied")
    assert(cfg.numbering === "iteration", "numbering applied")
    assert(cfg.layout === "hierarchical", "layout applied")
    assert(cfg.governance === "review", "governance applied")

    // On-disk keeps the nested `adr.*` shape (suite fields, no array wrapping)
    const onDisk = readFileSync(join(dir, ".ocp", "ocp.json"), "utf-8")
    assert(/"style"\s*:\s*"nygard"/.test(onDisk), "style serialized as plain string in nested block")
    assert(/"governance"\s*:\s*"review"/.test(onDisk), "governance serialized as plain string")

    // Invalid suite value rejected
    assert(!setAdrConfigKey("style", "alexandrian"), "invalid style rejected")
    assert(!setAdrConfigKey("governance", "audit"), "invalid governance rejected")
    const cfgAfter = getAdrConfig()
    assert(cfgAfter.style === "nygard", "rejected style leaves prior value intact")
    assert(cfgAfter.governance === "review", "rejected governance leaves prior value intact")

    // Clearing each suite field falls back to the in-code default
    assert(clearAdrConfigKey("numbering"), "clear numbering")
    assert(clearAdrConfigKey("layout"), "clear layout")
    const cfgCleared = getAdrConfig()
    assert(cfgCleared.numbering === "sequential", "cleared numbering reverts to default")
    assert(cfgCleared.layout === null, "cleared layout reverts to null (legacy adrLayout governs)")

    // Clear preserves other adr.* keys (style + governance still present)
    assert(cfgCleared.style === "nygard", "style still present after clearing others")
    assert(cfgCleared.governance === "review", "governance still present after clearing others")
  } finally {
    cleanup(dir)
  }
}

// ─── /adr config style madr works (the original bug case) ───────────────

function test15_ConfigStyleMadrOriginalBug(): void {
  section("Phase 7.6 §7.15 — original bug case: /adr config style madr")

  resetAdrOverrideWarnings()
  resetLegacyAdrKeyWarnings()
  resetAdrGovernanceWarnings()
  const dir = makeSandbox("style-madr")

  try {
    writeConfig(dir, JSON.stringify({ adr: { style: "ocp" } }))

    // Pre-state: style is ocp
    assert(getAdrConfig().style === "ocp", "initial style = ocp")

    // The action that was previously rejected — now accepted
    assert(setAdrConfigKey("style", "madr"), "/adr config style madr accepted")
    assert(getAdrConfig().style === "madr", "style = madr after set")

    // Round-trip via clear
    assert(clearAdrConfigKey("style"), "clear style")
    assert(getAdrConfig().style === "madr", "cleared style reverts to in-code default (madr)")
  } finally {
    cleanup(dir)
  }
}

// ─── runtime config fragment — the system-prompt piece the LLM sees ───

function test16_RuntimeConfigFragment(): void {
  section("Phase 7.8 §7.16 — hint + config fragments (skill-based protocol)")

  resetAdrOverrideWarnings()
  resetLegacyAdrKeyWarnings()
  resetAdrGovernanceWarnings()
  const dir = makeSandbox("runtime-frag")

  try {
    // No config → defaults surface in the fragment
    const defFragment = getAdrConfigRuntimeFragment()
    assert(defFragment.includes("adr.style"), "fragment shows adr.style key")
    assert(defFragment.includes("`madr`"), "fragment shows default style = madr")
    assert(defFragment.includes("`{id}-{slug}`"), "fragment shows default filenamePattern")
    assert(defFragment.includes("`kebab`"), "fragment shows default slugStyle")
    assert(defFragment.includes("_(none)_"), "fragment shows extraSections as _(none)_ when empty")
    assert(defFragment.includes("docs/adr/"), "fragment shows adrDir default path")

    // With a populated config, the fragment reflects the override
    writeConfig(
      dir,
      JSON.stringify({
        adr: {
          style: "nygard",
          filenamePattern: "ADR-{id}-{slug}",
          slugStyle: "snake",
          extraSections: ["## Risks"],
          indexColumns: ["id", "title", "status"],
        },
      }),
    )
    const overridden = getAdrConfigRuntimeFragment()
    assert(overridden.includes("`nygard`"), "overridden fragment shows style=nygard")
    assert(overridden.includes("`ADR-{id}-{slug}`"), "overridden fragment shows filenamePattern")
    assert(overridden.includes("`snake`"), "overridden fragment shows slugStyle=snake")
    assert(overridden.includes("`## Risks`"), "overridden fragment shows extraSections entry")

    // Phase 7.8: NO protocol body in any injected fragment — the
    // protocol lives as skills/adr-protocol/SKILL.md. The hint points
    // at it; neither fragment inlines the body.
    const hintPrompt = getGuardHintPrompt()
    assert(hintPrompt.startsWith(`\n\n${MARKER_HINT}\n\n`), "hint opens with MARKER_HINT")
    assert(!hintPrompt.includes("ADR Iron Law"), "hint does NOT inline the protocol body (Phase 7.8)")
    assert(hintPrompt.includes("adr-protocol"), "hint points at the adr-protocol skill")
    assert(hintPrompt.includes("/adr config"), "hint advertises /adr config")
    assert(hintPrompt.includes("/adr guard on"), "hint advertises how to enable the gate")
    assert(!defFragment.includes("ADR Iron Law"), "config fragment does NOT inline the protocol body")
    assert(hintPrompt.length < defFragment.length, "hint is smaller than the config fragment")

    // The hint is byte-stable across calls (cache contract) — only
    // adrDir feeds it, and adrDir only changes when the config does.
    const hintAgain = getGuardHintPrompt()
    assert(hintAgain === hintPrompt, "hint renders byte-identical across calls (cache-safe)")

    // The skill file actually exists where the hint points (discovery
    // integrity: a dangling pointer would silently break protocol load).
    const skillPath = join(testsDir(), "..", "skills", "adr-protocol", "SKILL.md")
    assert(existsSync(skillPath), "skills/adr-protocol/SKILL.md exists (hint pointer is not dangling)")
    const skillBody = readFileSync(skillPath, "utf-8")
    assert(skillBody.includes("name: adr-protocol"), "skill frontmatter declares name: adr-protocol")
    assert(skillBody.includes("Load ONLY when"), "skill description carries load-gating wording")
    assert(skillBody.includes("ADR Iron Law"), "skill body carries the protocol (the hint no longer does)")

    // The PROTOCOL_SKILL_REF exported for other modules matches the
    // on-disk skill location.
    assert(PROTOCOL_SKILL_REF.includes("skills/adr-protocol/SKILL.md"), "PROTOCOL_SKILL_REF points at the shipped skill path")
  } finally {
    cleanup(dir)
  }
}

function test17_RuntimeFragmentTracksConfigEdits(): void {
  section("Phase 7.6 §7.17 — runtime fragment reflects mid-session config edits")

  resetAdrOverrideWarnings()
  resetLegacyAdrKeyWarnings()
  resetAdrGovernanceWarnings()
  const dir = makeSandbox("runtime-mid-edit")

  try {
    // Turn 1: project has default config
    const before = getAdrConfigRuntimeFragment()
    assert(before.includes("`madr`"), "Turn 1: style = madr (default)")
    assert(before.includes("`{id}-{slug}`"), "Turn 1: filenamePattern = default")
    assert(before.includes("`kebab`"), "Turn 1: slugStyle = kebab (default)")

    // Mid-session: user runs /adr config to switch to snake + ADR- prefix
    assert(setAdrConfigKey("slugStyle", "snake"), "user runs /adr config slugStyle snake")
    assert(setAdrConfigKey("filenamePattern", "ADR-{id}-{slug}"), "user runs /adr config filenamePattern")

    // Turn 2: same session, next chat — fragment reflects the edits
    // because getAdrConfigRuntimeFragment re-reads .ocp/ocp.json on
    // every call (no module-level cache for the config table).
    const after = getAdrConfigRuntimeFragment()
    assert(after.includes("`snake`"), "Turn 2: slugStyle = snake (mid-session edit visible)")
    assert(after.includes("`ADR-{id}-{slug}`"), "Turn 2: filenamePattern = ADR- prefix (mid-session edit visible)")

    // Byte-stability (provider prefix-cache contract): when the config
    // is UNCHANGED, two consecutive renders must be byte-identical —
    // the fragment must never embed timestamps or other volatile
    // content, or every turn would break the provider cache.
    const again = getAdrConfigRuntimeFragment()
    assert(again === after, "unchanged config renders byte-identical fragment (cache-safe)")

    // MARKER contract: the fragment opens with the CONFIG marker so the
    // system hook can strip/re-inject it independently of the hint.
    assert(after.startsWith(`\n\n${MARKER_CONFIG}\n\n`), "config fragment opens with MARKER_CONFIG")
  } finally {
    cleanup(dir)
  }
}

// ─── last-good fallback on corrupt config (Phase 7.9) ──────────────────

function test18_LastGoodOnCorruptConfig(): void {
  section("Phase 7.9 §7.18 — last-good fallback on corrupt config")

  resetAdrOverrideWarnings()
  resetLegacyAdrKeyWarnings()
  resetAdrGovernanceWarnings()
  resetAdrLastGoodFragment()
  const dir = makeSandbox("last-good")

  try {
    // 1. Good config → table reflects it, memo primed
    writeConfig(dir, JSON.stringify({ adr: { slugStyle: "snake", style: "nygard" } }))
    const good = getAdrConfigRuntimeFragment()
    assert(good.includes("`snake`"), "good config renders snake")
    assert(good.includes("`nygard`"), "good config renders nygard")

    // 2. Corrupt the file (hand-edit typo) → last-good table survives.
    //    Without the guard this would silently flip to defaults (madr/
    //    kebab) — a table that LIES about the user's real config.
    writeFileSync(join(dir, ".ocp", "ocp.json"), "{ not valid json {{{", "utf-8")
    const during = getAdrConfigRuntimeFragment()
    assert(during === good, "corrupt config serves the byte-identical last-good table (stale but truthful)")
    assert(during.includes("`snake`"), "corrupt config does NOT silently flip to defaults")

    // 3. Fix the file → fresh values land immediately (memo replaced)
    writeConfig(dir, JSON.stringify({ adr: { slugStyle: "lower" } }))
    const recovered = getAdrConfigRuntimeFragment()
    assert(recovered.includes("`lower`"), "fixed config renders fresh values (recovery)")
    assert(!recovered.includes("`snake`"), "recovered table drops the stale value")

    // 4. Corrupt from process start with no memo → graceful defaults,
    //    and the corrupt-state render must NOT be memoized (recovery
    //    lands the moment the file is fixed).
    resetAdrLastGoodFragment()
    writeFileSync(join(dir, ".ocp", "ocp.json"), "{ still broken", "utf-8")
    const fromScratch = getAdrConfigRuntimeFragment()
    assert(fromScratch.includes("`madr`"), "corrupt-from-start with no memo degrades to defaults (graceful)")
    writeConfig(dir, JSON.stringify({ adr: { slugStyle: "snake" } }))
    const healed = getAdrConfigRuntimeFragment()
    assert(healed.includes("`snake`"), "no-memo corrupt path recovers immediately when fixed")

    // 5. Absent file is NOT corruption — defaults are legitimately
    //    correct there (regression guard on the corrupt detector).
    resetAdrLastGoodFragment()
    const absent = getAdrConfigRuntimeFragment()
    assert(absent.includes("`madr`"), "absent config renders defaults (not treated as corrupt)")
  } finally {
    resetAdrLastGoodFragment()
    cleanup(dir)
  }
}

// ─── /adr receipts keep the deterministic skill trigger (i18n) ────────

function test19_AnnounceSkillTriggerAssertions(): void {
  section("Phase 7.8 §7.19 — /adr receipts embed the deterministic skill trigger")

  // The ADR protocol body lives only in skills/adr-protocol/SKILL.md
  // (loaded on demand). The /adr new + /adr supersede receipts are the
  // deterministic fallback trigger: their text MUST keep pointing at
  // the skill file in BOTH locales, or a future i18n edit would
  // silently kill protocol loading with no test failure.
  const skillPath = join(testsDir(), "..", "skills", "adr-protocol", "SKILL.md")
  assert(existsSync(skillPath), "skills/adr-protocol/SKILL.md exists (receipt pointer is not dangling)")

  const i18nPath = join(testsDir(), "..", "plugins", "tui", "i18n.ts")
  assert(existsSync(i18nPath), "plugins/tui/i18n.ts exists")
  // STRINGS is assembled from per-locale catalogs (plugins/tui/i18n/locales/);
  // assert the receipt pointers directly in the en / zh-CN catalog files.
  const catalogLines = (code: string) =>
    readFileSync(join(testsDir(), "..", "plugins", "tui", "i18n", "locales", `${code}.ts`), "utf-8").split("\n")
  const enLines = catalogLines("en")
  const zhLines = catalogLines("zh-CN")

  const SKILL_REF = "skills/adr-protocol/SKILL.md"
  // Markers mirror each receipt's actual wording: created/supDone use
  // "BEFORE"/"起草前", the scaffold variant uses "before filling"/"填充正文前先读".
  const triggerKeys = [
    { key: "guard.adr.created", enMarker: "BEFORE", zhMarker: "起草前" },
    { key: "guard.adr.createdScaffold", enMarker: "before filling", zhMarker: "填充正文前先读" },
    { key: "guard.adr.supDone", enMarker: "BEFORE", zhMarker: "起草前" },
  ]

  for (const { key, enMarker, zhMarker } of triggerKeys) {
    // Needle keeps the closing quote + colon so "guard.adr.created":
    // never matches "guard.adr.createdScaffold": / "guard.adr.supDoneScaffold":.
    const enLine = enLines.find((l) => l.includes(`"${key}":`))
    const zhLine = zhLines.find((l) => l.includes(`"${key}":`))
    assert(enLine !== undefined, `${key}: entry line found in locales/en.ts`)
    assert(zhLine !== undefined, `${key}: entry line found in locales/zh-CN.ts`)
    if (enLine === undefined || zhLine === undefined) continue

    // One catalog line per key per locale (values are JSON-escaped onto a
    // single physical line) — assert each locale's value in its own file.
    assert(enLine.includes(SKILL_REF), `${key}: en value embeds ${SKILL_REF}`)
    assert(zhLine.includes(SKILL_REF), `${key}: zh-CN value embeds ${SKILL_REF}`)
    assert(enLine.includes(enMarker), `${key}: en value keeps the read-before-drafting marker ("${enMarker}")`)
    assert(zhLine.includes(zhMarker), `${key}: zh-CN value keeps the read-before-drafting marker ("${zhMarker}")`)
  }
}

// ─── slugify() three styles ────────────────────────────────────────────

function test07_Slugify(): void {
  section("Phase 7 §7.7 — slugify three styles")

  assert(slugify("Event Bus & Streaming") === "event-bus-streaming", "kebab default")
  assert(slugify("Event Bus & Streaming", "kebab") === "event-bus-streaming", "kebab explicit")
  assert(slugify("Event Bus & Streaming", "snake") === "event_bus_streaming", "snake")
  assert(slugify("Event Bus & Streaming", "lower") === "eventbusstreaming", "lower")
  assert(slugify("  --Hello-World--  ", "kebab") === "hello-world", "kebab trim+collapse")
  assert(slugify("  --Hello-World--  ", "snake") === "hello_world", "snake trim+collapse")
  assert(slugify("  --Hello-World--  ", "lower") === "helloworld", "lower trim+strip-all")
}

// ─── renderAdrFilename() ───────────────────────────────────────────────

function test08_RenderAdrFilename(): void {
  section("Phase 7 §7.8 — renderAdrFilename")

  assert(renderAdrFilename("{id}-{slug}", "0001", "use-postgres") === "0001-use-postgres.md", "default pattern")
  assert(renderAdrFilename("ADR-{id}-{slug}", "0001", "use-postgres") === "ADR-0001-use-postgres.md", "ADR-prefixed")
  assert(renderAdrFilename("{id}-{slug}", "0.2.54", "batch") === "0.2.54-batch.md", "iteration container")
  assert(renderAdrFilename("prefix-{id}", "0001", "ignored") === "prefix-0001.md", "no slug placeholder")
  // {slug} with slashes / colons — sanitized
  assert(
    renderAdrFilename("{id}-{slug}", "0001", "weird/name:with?chars") === "0001-weirdnamewithchars.md",
    "slug sanitized for filesystem-hostile chars",
  )
}

// ─── appendExtraSections ───────────────────────────────────────────────

function test09_AppendExtraSections(): void {
  section("Phase 7 §7.9 — appendExtraSections")

  const madr = "## Decision Outcome\n\nChosen option: **X**, because <why>.\n"
  const out = appendExtraSections(madr, ["## Risks", "## Notes"], "madr")
  assert(out.includes("## Risks"), "Risks section appended")
  assert(out.includes("## Notes"), "Notes section appended")
  assert(out.indexOf("## Risks") > out.indexOf("## Decision Outcome"), "appended AFTER canonical section")
  assert(out.indexOf("## Notes") > out.indexOf("## Risks"), "sections appended in array order")

  // OCP containers deliberately opt out
  const ocp = "## Cheatsheet\n\n1. item\n"
  const ocpOut = appendExtraSections(ocp, ["## Risks"], "ocp")
  assert(ocpOut === ocp, "OCP container returned unchanged")

  // Empty array is a no-op
  assert(appendExtraSections(madr, [], "madr") === madr, "empty array is no-op")

  // Trims trailing whitespace before appending (no blank line at end)
  const trailing = madr + "   \n\n  \n"
  const outTrailing = appendExtraSections(trailing, ["## Risks"], "madr")
  assert(!outTrailing.includes("   \n\n  \n## Risks"), "trailing whitespace trimmed before append")
}

// ─── createAdr uses config-driven slugify + pattern ────────────────────

function test10_CreateAdr_UsesProjectConfig(): void {
  section("Phase 7 §7.10 — createAdr honors project overrides")

  resetAdrOverrideWarnings()
  resetLegacyAdrKeyWarnings()
  const dir = makeSandbox("create")

  try {
    writeConfig(
      dir,
      JSON.stringify({
        adr: {
          style: "madr",
          numbering: "sequential",
          filenamePattern: "ADR-{id}-{slug}",
          slugStyle: "snake",
          extraSections: ["## Risks"],
        },
      }),
    )
    const result = createAdr({
      projectDir: dir,
      title: "Use Postgres",
      layer: "system",
    })
    assert(result.fullPath.endsWith("ADR-0001-use_postgres.md"), "filename uses snake slug + ADR- prefix")

    const onDisk = readFileSync(result.fullPath, "utf-8")
    assert(onDisk.includes("## Risks"), "extra section appended to scaffold")
    assert(onDisk.includes("use_postgres") === false, "snake slug does not appear in body (only in filename)")

    // Cleanup so subsequent test in this run isn't disturbed
    rmSync(result.fullPath, { force: true })
  } finally {
    cleanup(dir)
  }
}

// ─── renderUnifiedIndexRow + renderAdlIndex column projection ──────────

function test11_IndexColumnProjection(): void {
  section("Phase 7 §7.11 — INDEX column projection")

  const r = record({ id: "ADR-0001", sourcePath: "docs/adr/0001-x.md", title: "Test" })

  // Default projection = all 8 columns
  const def = renderUnifiedIndexRow(r)
  assert(def.split("|").length === 10, "default row has 8 cells + 2 outer empties (10 splits)")

  // Narrowed projection
  const narrow = renderUnifiedIndexRow(r, ["id", "title", "status"])
  assert(narrow.split("|").length === 5, "narrow row has 3 cells + 2 outer empties (5 splits)")
  assert(narrow.includes("ADR-0001") && narrow.includes("Test"), "id + title present")
  assert(!narrow.includes("`madr`"), "style column dropped")

  // Index header reflects columns
  const fakeNode = {
    relDir: "docs/adr",
    parent: null,
    records: [r],
    children: [],
  }
  const idx = renderAdlIndex(fakeNode, ["id", "title"])
  assert(idx.includes("| ID | Decision Title |"), "header uses canonical column labels")
  assert(!idx.includes("Style | Layer"), "narrow header omits dropped columns")
}

// ─── Backward-compat: defaults regenerate byte-identical INDEX.md ──────

function test12_BackwardCompat_NoOverrides(): void {
  section("Phase 7 §7.12 — backward-compat: defaults preserve pre-Phase-7 shape")

  resetAdrOverrideWarnings()
  resetLegacyAdrKeyWarnings()
  const dir = makeSandbox("compat")

  try {
    // No config file at all → defaults must reproduce the pre-Phase-7 row.
    const r = record({ id: "ADR-0001", sourcePath: "docs/adr/0001-x.md" })
    const def = renderUnifiedIndexRow(r)
    // The pre-Phase-7 canonical 8-column row, byte-for-byte, must equal
    // the default projection. Compare the cell text exactly.
    const expected = `| [${r.id}](./${r.sourcePath.split("/").pop()}) | ${r.title} | \`${r.style}\` | \`${r.layer ?? "system"}\` | 🟢 Accepted |  |  | ${r.created} |`
    assert(def === expected, "default projection equals pre-Phase-7 row (byte-identical)")

    // The default INDEX.md header must be the pre-Phase-7 string
    const fakeNode = { relDir: "docs/adr", parent: null, records: [r], children: [] }
    const idx = renderAdlIndex(fakeNode)
    assert(idx.includes("| ID | Decision Title | Style | Layer | Status | Domain | Iteration | Created |"), "default header matches pre-Phase-7 string")

    // Slugify default = kebab = pre-Phase-7 behavior
    assert(slugify("Hello World", "kebab") === "hello-world", "default slugify equals pre-Phase-7")

    // renderAdrFilename default = `{id}-{slug}.md` = pre-Phase-7
    assert(
      renderAdrFilename("{id}-{slug}", "0001", "use-postgres") === "0001-use-postgres.md",
      "default filename pattern equals pre-Phase-7",
    )
  } finally {
    cleanup(dir)
  }
}

// ─── Root index label glossary ─────────────────────────────────────────

function test20_RootIndexLabelGlossary(): void {
  section("Root INDEX label glossary — root only, English-only, deterministic")

  const r = record({ id: "ADR-0001", sourcePath: "docs/adr/0001-x.md", title: "Test" })

  // Root index carries the glossary — English-only (byte-stable contract:
  // generated files never carry locale-following content).
  const root = renderAdlIndex({ relDir: "docs/adr", parent: null, records: [r], children: [] })
  assert(root.includes("## Label glossary"), "root index carries the label glossary")
  assert(root.includes("| Label | Style | Meaning |"), "glossary table is the 3-column English shape")
  assert(!root.includes("Meaning (zh-CN)"), "generated glossary has no locale columns")
  assert(root.includes("`## Decision Outcome`"), "madr labels present")
  assert(root.includes("`**Rejected**`"), "ocp labels present")
  assert(!/[\u4e00-\u9fff]/.test(root), "generated glossary stays English-only (no CJK meanings)")

  // …and regeneration is byte-stable (no locale input).
  const again = renderAdlIndex({ relDir: "docs/adr", parent: null, records: [r], children: [] })
  assert(root === again, "glossary rendering is deterministic (byte-stable regeneration)")

  // Child indexes stay lean — glossary is root-only.
  const child = renderAdlIndex({
    relDir: "docs/adr/domains/billing",
    parent: { relDir: "docs/adr", parent: null, records: [], children: [] },
    records: [r],
    children: [],
  })
  assert(!child.includes("## Label glossary"), "child index has no glossary")
}

// ─── Glossary 8-locale catalog + TUI locale view ──────────────────────

function test21_GlossaryEightLocales(): void {
  section("ADR glossary — 8 world locales, complete catalog, TUI locale view")

  const codes = LOCALES.map((l) => l.code)
  assert(codes.length === 8, "8 major world languages registered")
  assert(codes.includes("en") && codes.includes("zh-CN"), "en + zh-CN remain registered")

  // Every meaning cell is filled in every locale (compile-time shape via
  // Record<GlossaryLocale, string>; runtime values enforced here).
  for (const row of ADR_GLOSSARY) {
    for (const code of codes) {
      const text = row.meanings[code as GlossaryLocale]
      assert(typeof text === "string" && text.length > 0, `meaning filled: ${row.label} × ${code}`)
    }
  }

  // Locale-following TUI view: exact code, base-language match, fallback.
  const fr = renderLabelGlossaryLocalized("fr")
  assert(fr.includes("Alternatives évaluées"), "fr view renders French meanings")
  const ptBr = renderLabelGlossaryLocalized("pt-BR")
  assert(ptBr.includes("Forças em jogo"), "pt-BR resolves to pt (base-language match)")
  const zhTw = renderLabelGlossaryLocalized("zh-TW")
  assert(zhTw.includes("背景与问题陈述"), "zh-TW resolves to zh-CN (base-language match)")
  const unknown = renderLabelGlossaryLocalized("klingon")
  assert(unknown.includes("Forces at play"), "unknown locale falls back to English")
  assert(unknown.includes("not available"), "fallback carries a visibility note")
  const en = renderLabelGlossaryLocalized("en")
  assert(!/[\u4e00-\u9fff]/.test(en), "en view contains no CJK")
}

// ─── regenerateAdlIndexes honors columns arg ───────────────────────────

function test13_RegenerateIndexes_HonorsColumns(): void {
  section("Phase 7 §7.13 — regenerateAdlIndexes honors column projection")

  resetAdrOverrideWarnings()
  resetLegacyAdrKeyWarnings()
  const dir = makeSandbox("regen")

  try {
    // Write a real record + run regenerate with a narrowed column set
    const adrDir = join(dir, "docs/adr")
    mkdirSync(adrDir, { recursive: true })
    writeFileSync(
      join(adrDir, "0001-x.md"),
      [
        "---",
        "style: madr",
        "status: Accepted",
        "created: 2026-01-15",
        "date: 2026-01-15",
        "layer: system",
        "---",
        "",
        "# 0001. X",
        "",
        "## Context and Problem Statement",
        "",
        "ctx",
        "",
        "## Decision Outcome",
        "",
        "Chosen option: X, because y.",
        "",
        "### Consequences",
        "",
        "- ok",
      ].join("\n"),
      "utf-8",
    )

    regenerateAdlIndexes(dir, "docs/adr", "flat", ["id", "title"])
    const idxPath = join(adrDir, "INDEX.md")
    assert(existsSync(idxPath), "INDEX.md generated")
    const idxBody = readFileSync(idxPath, "utf-8")
    assert(idxBody.includes("| ID | Decision Title |"), "regenerated header = narrowed columns")
    assert(!idxBody.includes("Style | Layer"), "narrowed header omits Style/Layer")
  } finally {
    cleanup(dir)
  }
}

/** Repo-root-relative test dir (the tests run from the repo root). */
function testsDir(): string {
  return "tests"
}

function main(): void {
  console.log("╔══════════════════════════════════════════════════════════╗")
  console.log("║  Phase 7 — Project-level ADR Overrides                  ║")
  console.log("╚══════════════════════════════════════════════════════════╝")

  test01_FilenamePattern()
  test02_SlugStyle()
  test03_ExtraSections()
  test04_IndexColumns()
  test05_GetAdrConfig_DefaultsAndOverrides()
  test06_SetClearOverride()
  test14_SuiteFieldsOnSamePath()
  test15_ConfigStyleMadrOriginalBug()
  test16_RuntimeConfigFragment()
  test17_RuntimeFragmentTracksConfigEdits()
  test18_LastGoodOnCorruptConfig()
  test19_AnnounceSkillTriggerAssertions()
  test07_Slugify()
  test08_RenderAdrFilename()
  test09_AppendExtraSections()
  test10_CreateAdr_UsesProjectConfig()
  test11_IndexColumnProjection()
  test12_BackwardCompat_NoOverrides()
  test13_RegenerateIndexes_HonorsColumns()
  test20_RootIndexLabelGlossary()
  test21_GlossaryEightLocales()

  console.log(`\n${"═".repeat(60)}`)
  console.log(`  Result: ${passed} passed / ${failed} failed`)
  console.log(`${"═".repeat(60)}`)
  if (failed > 0) process.exit(1)
}

main()
