/**
 * Multi-style ADL — Style Registry, Normalized Model & Phase 1 Foundation
 *
 * Coverage:
 *   - normalizeAdrId grammar (single authority, §8)
 *   - madr adapter: scaffold / detect / parse / validate / format / index entry
 *   - registry dispatch (explicit style, legacy fallback, unregistered style)
 *   - global whole-ADL ID allocation + legacy duplicate tolerance (§6.1)
 *   - ID + path reference resolution into normalized records
 *   - §9.5 supersession: status-line-only flip, byte-stable old body
 *   - created/date split, explicit `style: madr` on scaffold
 *   - adr.* config block (defaults, nested upsert, init suite idempotency)
 *   - iteration numbering + sequential fallback warning (§6.1 rule 8)
 *
 * Run: bun run tests/test-adr-style-registry-unit.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  detectAdrInitSignals,
  detectLegacyAdrKeys,
  getAdrConfig,
  getAdrDir,
  isAdrStyleAvailable,
  isEnabled,
  normalizeAdrGovernance,
  normalizeAdrStyle,
  normalizeAdrSuite,
  resetAdrGovernanceWarnings,
  resetLegacyAdrKeyWarnings,
  resolveAdrSuite,
  setAdrConfigFields,
  setProjectDir,
  stripJsonc,
  upsertAdrBlock,
} from "../plugins/adr-guard/adr-guard-config"
import {
  allocateAdrIterationId,
  appendAdrSection,
  checkAdrIntegrity,
  createAdr,
  createAdrContainer,
  getAllAdrs,
  getNormalizedAdrs,
  parseAdrFile,
  resolveAdrRef,
  supersedeAdr,
  toNormalizedRecord,
} from "../plugins/adr-guard/adr-engine"
import {
  getAdrStyleAdapter,
  listAdrStyles,
  resolveDocumentAdapter,
} from "../plugins/adr-guard/adr-style-registry"
import {
  adrIdFromFilename,
  bareAdrId,
  normalizeAdrId,
  type AdrDocument,
  type AdrStyle,
} from "../plugins/adr-guard/adr-types"
import { madrAdapter } from "../plugins/adr-guard/styles/madr"
import { nygardAdapter } from "../plugins/adr-guard/styles/nygard"
import { ocpAdapter } from "../plugins/adr-guard/styles/ocp"

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
  const dir = mkdtempSync(join(tmpdir(), `adr-style-${tag}-`))
  setProjectDir(dir)
  return dir
}

function writeAdr(dir: string, relPath: string, content: string): string {
  const full = join(dir, relPath)
  mkdirSync(join(full, ".."), { recursive: true })
  writeFileSync(full, content, "utf-8")
  return full
}

function legacyAdr(id: string, title: string, extra = ""): string {
  return `---\nstatus: accepted\ndate: 2026-01-01\nlayer: system\n${extra}---\n\n# ${id}. ${title}\n\n## Context and Problem Statement\n\nX\n\n## Considered Options\n\n- A\n\n## Decision Outcome\n\nB\n`
}

// ═════════════════════════════════════════════════════════════════════════
//  1. ID grammar — normalizeAdrId (§8)
// ═════════════════════════════════════════════════════════════════════════

function test01_IdGrammar() {
  section("01: normalizeAdrId — single authority")
  assert(normalizeAdrId("0001") === "ADR-0001", "bare 0001 → ADR-0001")
  assert(normalizeAdrId("ADR-0001") === "ADR-0001", "prefixed ADR-0001 stays")
  assert(normalizeAdrId("adr-0001") === "ADR-0001", "case-insensitive prefix")
  assert(normalizeAdrId("12") === "ADR-0012", "short digits pad to four")
  assert(normalizeAdrId("0.2.54.01") === "ADR-0.2.54.01", "bare dotted → prefixed")
  assert(normalizeAdrId("ADR-0.2.54.01") === "ADR-0.2.54.01", "prefixed dotted stays")
  assert(normalizeAdrId("") === null, "empty → null")
  assert(normalizeAdrId("foo") === null, "garbage → null")
  assert(normalizeAdrId("ADR-00012") === null, "five digits → null (not the grammar)")
  assert(normalizeAdrId("0.2.54") === "ADR-0.2.54", "three dotted segments → container ID (ocp grammar)")
  assert(normalizeAdrId("0.2.54#1") === "ADR-0.2.54#01", "section form: bare # ref pads seq to two")
  assert(normalizeAdrId("ADR-0042#2") === "ADR-0042#02", "section form works on sequential containers too")
  assert(normalizeAdrId("0.2.54.3") === "ADR-0.2.54.3", "dotted 4-segment stays the per-decision record grammar")
  assert(normalizeAdrId("docs/adr/0001-x.md") === null, "path is not an ID → null")
  assert(bareAdrId("ADR-0.2.54.01") === "0.2.54.01", "bareAdrId strips prefix")
  assert(adrIdFromFilename("0001-use-postgresql.md") === "ADR-0001", "filename → sequential ID")
  assert(adrIdFromFilename("0.2.54.01-use-decimal.md") === "ADR-0.2.54.01", "filename → dotted ID")
  assert(adrIdFromFilename("INDEX.md") === null, "INDEX.md is not a record")
  assert(adrIdFromFilename("notes.md") === null, "plain markdown is not a record")
}

// ═════════════════════════════════════════════════════════════════════════
//  2. madr adapter — scaffold / detect / parse / validate / format
// ═════════════════════════════════════════════════════════════════════════

function madrDoc(rawContent: string, filename = "0001-sample.md"): AdrDocument {
  return { fullPath: `/p/docs/adr/${filename}`, relPath: `docs/adr/${filename}`, filename, rawContent, frontmatter: {} }
}

function test02_MadrAdapter() {
  section("02: madr adapter — scaffold/parse/detect/validate")
  const scaffolded = madrAdapter.scaffold({
    id: "0001",
    title: "Use PostgreSQL",
    status: "proposed",
    date: "2026-09-17",
    created: "2026-09-17",
    layer: "system",
  })
  assert(scaffolded.includes("style: madr"), "scaffold declares style: madr")
  assert(scaffolded.includes("status: Proposed"), "scaffold writes the capitalized status label")
  assert(scaffolded.includes("created: 2026-09-17"), "scaffold writes immutable created")
  assert(scaffolded.includes("date: 2026-09-17"), "scaffold writes date")
  assert(scaffolded.includes("## Context and Problem Statement"), "canonical heading: Context and Problem Statement")
  assert(scaffolded.includes("## Considered Options"), "canonical heading: Considered Options")
  assert(scaffolded.includes("## Decision Outcome"), "canonical heading: Decision Outcome")
  assert(scaffolded.includes("### Consequences"), "canonical heading: Consequences")
  assert(scaffolded.includes("# 0001. Use PostgreSQL"), "H1 carries the ID")

  // parse round-trip
  const doc = madrDoc(scaffolded)
  const record = madrAdapter.parse(doc)
  assert(record.id === "ADR-0001", "parsed record ID is canonical ADR-0001")
  assert(record.style === "madr", "parsed record style madr")
  assert(record.title === "Use PostgreSQL", "parsed title")
  assert(record.status === "proposed", "parsed status")
  assert(record.created === "2026-09-17" && record.date === "2026-09-17", "created/date split preserved")

  // detect: explicit style, legacy shape, non-ADR
  assert(madrAdapter.detect(scaffolded, "docs/adr/0001-x.md"), "detects explicit style: madr")
  assert(madrAdapter.detect(legacyAdr("0001", "Legacy"), "docs/adr/0001-x.md"), "detects legacy MADR shape (no style key)")
  assert(!madrAdapter.detect("# Just a note\n\nNothing here.\n", "docs/note.md"), "rejects unrelated markdown")

  // validate: optional sections never required (§7.2)
  const issues = madrAdapter.validate(doc, record)
  assert(issues.length === 0, `scaffolded system record validates clean (got ${issues.length})`)
  const broken = scaffolded.replace("## Decision Outcome", "## Something Else")
  const brokenIssues = madrAdapter.validate(madrDoc(broken), madrAdapter.parse(madrDoc(broken)))
  assert(brokenIssues.some((i) => i.type === "missing-section" && i.severity === "error"), "missing canonical section flagged as error")
  assert(
    !brokenIssues.some((i) => i.message.includes("Confirmation")),
    "optional MADR sections (Confirmation etc.) are never required",
  )

  // lean domain template validates without Considered Options
  const lean = madrAdapter.scaffold({ id: "0002", title: "Lean", status: "proposed", date: "2026-09-17", created: "2026-09-17", layer: "domain" })
  const leanIssues = madrAdapter.validate(madrDoc(lean, "0002-lean.md"), madrAdapter.parse(madrDoc(lean, "0002-lean.md")))
  assert(leanIssues.length === 0, "lean domain template validates without Considered Options")

  // format + index entry
  assert(madrAdapter.format(doc).endsWith("\n"), "format returns newline-terminated content")
  const entry = madrAdapter.renderIndexEntry(record)
  assert(entry.includes("[ADR-0001](./0001-sample.md)"), "index entry links canonical ID to source file")
  assert(entry.includes("Use PostgreSQL"), "index entry carries title")
}

// ═════════════════════════════════════════════════════════════════════════
//  3. Style registry dispatch (§8)
// ═════════════════════════════════════════════════════════════════════════

function test03_Registry() {
  section("03: style registry — dispatch")
  assert(listAdrStyles().includes("madr") && listAdrStyles().includes("nygard"), "madr and nygard are registered")
  assert(getAdrStyleAdapter("madr") === madrAdapter, "getAdrStyleAdapter returns madr adapter")
  assert(getAdrStyleAdapter("nygard") === nygardAdapter, "getAdrStyleAdapter returns nygard adapter")
  let threw = false
  try {
    getAdrStyleAdapter("bogus" as AdrStyle)
  } catch {
    threw = true
  }
  assert(threw, "getAdrStyleAdapter throws for unregistered style")

  const explicit = resolveDocumentAdapter(madrDoc(legacyAdr("0001", "X", "style: madr\n")))
  assert(explicit.adapter === madrAdapter && explicit.declaredStyle === "madr", "explicit style: madr dispatches to madr")
  const legacy = resolveDocumentAdapter(madrDoc(legacyAdr("0001", "X")))
  assert(legacy.adapter === madrAdapter && legacy.declaredStyle === null, "no style frontmatter → legacy → madr, declaredStyle null")
  const nygardDoc = resolveDocumentAdapter(madrDoc(legacyAdr("0001", "X", "style: nygard\n")))
  assert(nygardDoc.adapter === nygardAdapter && nygardDoc.declaredStyle === "nygard", "explicit style: nygard dispatches to nygard (Phase 2)")
  const ocpResolved = resolveDocumentAdapter(madrDoc(legacyAdr("0001", "X", "style: ocp\n")))
  assert(ocpResolved.adapter === ocpAdapter && ocpResolved.declaredStyle === "ocp", "explicit style: ocp dispatches to the ocp container adapter")
  const future = resolveDocumentAdapter(madrDoc(legacyAdr("0001", "X", "style: futuristic\n")))
  assert(future.adapter === madrAdapter && future.declaredStyle === "futuristic", "unknown declared style parses via madr fallback, declaredStyle preserved for reporting")
}

// ═════════════════════════════════════════════════════════════════════════
//  4. Whole-ADL allocation & legacy duplicate tolerance (§6.1)
// ═════════════════════════════════════════════════════════════════════════

function test04_GlobalAllocation() {
  section("04: global allocation + duplicate tolerance")
  const sandbox = makeSandbox("alloc")
  try {
    mkdirSync(join(sandbox, "docs/adr"), { recursive: true })
    mkdirSync(join(sandbox, "packages/pay/docs/adr"), { recursive: true })

    const a = createAdr({ projectDir: sandbox, title: "Root Decision", targetDir: "docs/adr" })
    const b = createAdr({ projectDir: sandbox, title: "Payment Decision", targetDir: "packages/pay/docs/adr" })
    assert(a.id === "0001", "first ADR is 0001")
    assert(b.id === "0002", "second directory continues the GLOBAL counter (0002) — per-directory counters replaced")

    // Legacy cross-directory duplicate (legal under the old engine)
    writeAdr(sandbox, "docs/adr/0003-alpha.md", legacyAdr("0003", "Alpha"))
    writeAdr(sandbox, "packages/pay/docs/adr/0003-beta.md", legacyAdr("0003", "Beta"))
    const issues = checkAdrIntegrity(sandbox)
    const dupWarn = issues.filter((i) => i.type === "duplicate-id" && i.severity === "warn")
    assert(dupWarn.length === 1, `cross-directory duplicate ID reports exactly one WARNING (got ${dupWarn.length})`)
    assert(dupWarn[0]?.message.includes("0003"), "warning names the duplicated ID")
    assert(
      !issues.some((i) => i.type === "duplicate-id" && i.severity === "error"),
      "cross-directory duplicate is NOT an error",
    )

    // New allocation never reuses a warned ID
    const c = createAdr({ projectDir: sandbox, title: "Gamma", targetDir: "docs/adr" })
    assert(c.id === "0004", "new allocation skips the duplicate 0003 entirely (warned IDs never reused)")

    // Same-directory duplicate remains an error
    writeAdr(sandbox, "docs/adr/0004-delta.md", legacyAdr("0004", "Delta"))
    const issues2 = checkAdrIntegrity(sandbox)
    assert(
      issues2.some((i) => i.type === "duplicate-id" && i.severity === "error" && i.file === "docs/adr"),
      "same-directory duplicate ID remains an ERROR",
    )
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  5. Reference resolution — ID form + path form (§8)
// ═════════════════════════════════════════════════════════════════════════

function test05_RefResolution() {
  section("05: ID + path reference resolution")
  const sandbox = makeSandbox("refs")
  try {
    writeAdr(sandbox, "docs/adr/0001-base.md", legacyAdr("0001", "Base"))
    // ID-based parent (new form) and path-based parent (legacy form) coexist
    writeAdr(sandbox, "docs/adr/0002-by-id.md", legacyAdr("0002", "ById", "parent: ADR-0001\n"))
    writeAdr(sandbox, "docs/adr/0003-by-path.md", legacyAdr("0003", "ByPath", "parent: docs/adr/0001-base.md\n"))
    writeAdr(sandbox, "docs/adr/0004-superseded.md", legacyAdr("0004", "Old", "superseded_by: ADR-0001\nstatus: superseded by ADR-0001\n"))

    const adrs = getAllAdrs(sandbox)
    const byId = toNormalizedRecord(adrs.find((a) => a.id === "0002")!, adrs)
    const byPath = toNormalizedRecord(adrs.find((a) => a.id === "0003")!, adrs)
    const sup = toNormalizedRecord(adrs.find((a) => a.id === "0004")!, adrs)
    assert(JSON.stringify(byId.parentIds) === JSON.stringify(["ADR-0001"]), "ID-form parent resolves to normalized ADR-0001")
    assert(JSON.stringify(byPath.parentIds) === JSON.stringify(["ADR-0001"]), "path-form parent resolves to the SAME normalized ADR-0001")
    assert(JSON.stringify(sup.supersededBy) === JSON.stringify(["ADR-0001"]), "ID-form superseded_by resolves to normalized ADR-0001")
    assert(!byId.parentIds.some((p) => p.includes("/")), "normalized parentIds are never paths")

    // resolveAdrRef: IDs, paths, filenames
    assert(resolveAdrRef("ADR-0001", adrs)?.id === "0001", "resolveAdrRef by canonical ID")
    assert(resolveAdrRef("1", adrs)?.id === "0001", "resolveAdrRef by unpadded number")
    assert(resolveAdrRef("docs/adr/0001-base.md", adrs)?.id === "0001", "resolveAdrRef by relPath")
    assert(resolveAdrRef("0001-base.md", adrs)?.id === "0001", "resolveAdrRef by filename")
    assert(resolveAdrRef("9999", adrs) === null, "unresolvable ref → null")

    // Path-scoped fallback under duplicate IDs
    writeAdr(sandbox, "packages/x/docs/adr/0001-dup.md", legacyAdr("0001", "Dup"))
    const adrs2 = getAllAdrs(sandbox)
    assert(resolveAdrRef("docs/adr/0001-base.md", adrs2)?.title === "Base", "with duplicate IDs, the PATH form resolves path-scoped")
    assert(resolveAdrRef("0001", adrs2) !== null, "ambiguous bare ID still resolves (first match, tolerated legacy)")

    // Normalized discovery end-to-end
    const records = getNormalizedAdrs(sandbox)
    assert(records.length === 5, `getNormalizedAdrs returns one record per file (got ${records.length})`)
    assert(records.every((r) => r.id.startsWith("ADR-")), "all normalized IDs are canonical")
    const legacyRecord = records.find((r) => r.id === "ADR-0001")
    assert(legacyRecord?.style === "madr", "legacy file (no style key) still parses to a madr record — reported, never modified")
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  6. §9.5 supersession — status-line-only flip
// ═════════════════════════════════════════════════════════════════════════

function test06_Supersede() {
  section("06: §9.5 supersession semantics")
  const sandbox = makeSandbox("super")
  try {
    const old = createAdr({ projectDir: sandbox, title: "Original Choice", targetDir: "docs/adr" })
    const originalContent = readFileSync(old.fullPath, "utf-8")
    const originalLines = originalContent.split("\n")

    const { newAdr, oldAdr } = supersedeAdr(sandbox, "ADR-0001", "Replacement Choice")

    // Successor carries the ID-based supersedes reference
    const newContent = readFileSync(newAdr.fullPath, "utf-8")
    assert(newAdr.id === "0002", "successor allocated the next global ID")
    assert(newContent.includes("supersedes: ADR-0001"), "successor frontmatter: supersedes: ADR-0001")
    assert(newContent.includes("style: madr"), "successor declares style: madr")

    // Old file: ONLY the status line changed — body byte-stable
    const updatedContent = readFileSync(oldAdr.fullPath, "utf-8")
    const updatedLines = updatedContent.split("\n")
    assert(updatedLines.length === originalLines.length, "old file line count unchanged (no wholesale rewrite)")
    const diffLines = updatedLines.filter((l, i) => l !== originalLines[i])
    assert(diffLines.length === 1 && /status:\s*Superseded by ADR-0002/i.test(diffLines[0] ?? ""), "exactly ONE line changed: the status line")
    assert(!updatedContent.includes("superseded_by:"), "no superseded_by frontmatter injected into the old file")
    assert(updatedContent.includes("created: ") && updatedContent.includes(old.id), "old created date and ID untouched")

    // Integrity stays clean across the supersession chain
    const issues = checkAdrIntegrity(sandbox)
    assert(issues.length === 0, `supersession chain integrity clean (got ${issues.length}: ${issues.map((i) => i.message).join("; ")})`)
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  7. adr.* config block + /adr init suites (§6 / §6.3)
// ═════════════════════════════════════════════════════════════════════════

function test07_ConfigAndSuites() {
  section("07: adr.* config + init suites")
  const sandbox = makeSandbox("cfg")
  try {
    // Defaults with no config
    assert(getAdrConfig().style === "madr", "style defaults to madr (zero-config behavior unchanged)")
    assert(getAdrConfig().numbering === "sequential", "numbering defaults to sequential")
    assert(getAdrConfig().governance === "none", "governance defaults to none")
    assert(getAdrConfig().suite === null, "no suite label by default")
    assert(normalizeAdrStyle("MADR") === "madr", "normalizeAdrStyle case-insensitive")
    assert(normalizeAdrStyle("bogus") === null, "normalizeAdrStyle rejects unknown")
    assert(normalizeAdrSuite("Evolution") === "evolution", "normalizeAdrSuite case-insensitive")

    // Nested upsert preserves unrelated top-level keys
    mkdirSync(join(sandbox, ".ocp"), { recursive: true })
    writeFileSync(join(sandbox, ".ocp", "ocp.json"), `{\n  "adrGuard": "on",\n  "adrDir": "docs/adr"\n}\n`, "utf-8")
    assert(setAdrConfigFields({ style: "madr", numbering: "iteration", layout: "hierarchical", governance: "review", suite: "evolution" }), "setAdrConfigFields writes the adr block")
    const raw1 = readFileSync(join(sandbox, ".ocp", "ocp.json"), "utf-8")
    const parsed1 = JSON.parse(raw1)
    assert(parsed1.adrGuard === "on" && parsed1.adrDir === "docs/adr", "legacy keys untouched by adr.* writes")
    assert(parsed1.adr.style === "madr" && parsed1.adr.numbering === "iteration", "adr block values persisted")
    assert(parsed1.adr.suite === "evolution", "informational adr.suite label persisted")

    // Idempotent re-run: same selection → same bytes (no drift)
    assert(setAdrConfigFields(resolveAdrSuite("evolution").fields), "re-running init writes again")
    const raw2 = readFileSync(join(sandbox, ".ocp", "ocp.json"), "utf-8")
    assert(raw2 === raw1, "idempotent re-run produces byte-identical config (no drift)")
    assert(getAdrConfig().numbering === "iteration" && getAdrConfig().suite === "evolution", "getAdrConfig reads the persisted block")

    // Later per-option override: label stays informational, never re-enforces
    assert(setAdrConfigFields({ numbering: "sequential" }), "individual option override allowed")
    assert(getAdrConfig().numbering === "sequential" && getAdrConfig().suite === "evolution", "override applied; suite label inert")

    // Suite resolution tables (§6.3)
    const std = resolveAdrSuite("standard").fields
    assert(std.style === "madr" && std.numbering === "sequential" && std.layout === "auto" && std.governance === "none" && std.suite === "standard", "standard suite resolves to the §6.3 row")
    const evo = resolveAdrSuite("evolution").fields
    assert(evo.numbering === "iteration" && evo.layout === "hierarchical" && evo.governance === "review", "evolution suite resolves to the §6.3 row")
    // ocp suite: container style + iteration numbering + review (OCP preset)
    const ocpSuite = resolveAdrSuite("ocp").fields
    assert(
      ocpSuite.style === "ocp" && ocpSuite.numbering === "iteration" && ocpSuite.layout === "hierarchical" && ocpSuite.governance === "review" && ocpSuite.suite === "ocp",
      "ocp suite resolves the container preset (§7 amendment)",
    )
    assert(normalizeAdrSuite("OCP") === "ocp", "normalizeAdrSuite accepts ocp case-insensitively")
    const custom = resolveAdrSuite("custom", { style: "madr", numbering: "sequential" }).fields
    assert(custom.suite === "custom" && custom.numbering === "sequential" && custom.governance === undefined, "custom resolves only the explicitly given options")

    // Governance read axis (§13 Phase 6): normalize + unknown → none + warn
    assert(normalizeAdrGovernance("STRICT") === "strict", "normalizeAdrGovernance case-insensitive")
    assert(normalizeAdrGovernance("review") === "review", "normalizeAdrGovernance review")
    assert(normalizeAdrGovernance("bogus") === null, "normalizeAdrGovernance rejects unknown")
    resetAdrGovernanceWarnings()
    const warnings: string[] = []
    const origWarn = console.warn
    console.warn = (msg?: unknown) => warnings.push(String(msg))
    try {
      assert(setAdrConfigFields({ governance: "bogus" }), "unknown governance value persisted as-is")
      assert(getAdrConfig().governance === "none", "unknown governance falls back to none")
      assert(warnings.length === 1 && warnings[0]!.includes("bogus"), "unknown governance warns once with the offending value")
      assert(getAdrConfig().governance === "none", "second read still none (warn once per process)")
    } finally {
      console.warn = origWarn
      resetAdrGovernanceWarnings()
    }
    assert(setAdrConfigFields({ governance: "review" }), "governance reset to review for later assertions")
    assert(getAdrConfig().governance === "review", "valid governance value reads back exactly")

    // Detection pre-selects, never applies (§6.3)
    const quiet = detectAdrInitSignals(sandbox)
    assert(quiet.recommendedSuite === "standard" && quiet.packageCount === 0, "plain project → standard recommended")
    mkdirSync(join(sandbox, ".opencode"), { recursive: true })
    mkdirSync(join(sandbox, "packages/a"), { recursive: true })
    mkdirSync(join(sandbox, "packages/b"), { recursive: true })
    mkdirSync(join(sandbox, "migrations"), { recursive: true })
    const rich = detectAdrInitSignals(sandbox)
    assert(rich.hasAgentConfig && rich.hasMigrations && rich.packageCount === 2, "signals detected: .opencode/, packages, migrations/")
    assert(rich.recommendedSuite === "evolution", "agent-configured monorepo with migrations → evolution pre-selected")
    assert(getAdrConfig().suite === "evolution", "detection alone did NOT change the suite label (still the earlier explicit write)")
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// Pure upsertAdrBlock edge cases (no fs)
function test07b_UpsertEdges() {
  section("07b: upsertAdrBlock — text-level edges")
  const once = upsertAdrBlock("", { style: "madr" })
  assert(JSON.parse(once).adr.style === "madr", "empty input bootstraps a root object")
  const twice = upsertAdrBlock(once, { numbering: "sequential" })
  const parsed = JSON.parse(twice)
  assert(parsed.adr.style === "madr" && parsed.adr.numbering === "sequential", "second upsert merges into the existing block")
  assert((twice.match(/"adr"\s*:/g) ?? []).length === 1, "no duplicate adr block created")
  // Commented template lines are not valid strict JSON (.ocp/ocp.json is a
  // pure-JSON file) — but upsert must still not mistake them for the active
  // block, and must preserve them + unrelated keys (same append semantics
  // as upsertConfigField).
  const commented = upsertAdrBlock(`{\n  // "adr": { "style": "nygard" }\n  "adrGuard": "off"\n}\n`, { style: "madr" })
  assert(commented.includes(`// "adr": { "style": "nygard" }`), "commented template line preserved")
  assert(commented.includes(`"adrGuard": "off"`), "legacy key intact")
  assert((commented.match(/"adr"\s*:/g) ?? []).length === 2, "commented + one new active adr block (commented one not treated as active)")
}

// ═════════════════════════════════════════════════════════════════════════
//  7c. Comment-safety: comma placement + commented-out duplicate keys
// ═════════════════════════════════════════════════════════════════════════

function test07c_UpsertCommentSafety() {
  section("07c: upsertAdrBlock — trailing-comment comma safety")
  // 1. Root append after a member with NO trailing comma + trailing comment
  const raw1 = `{\n  "modelCatalog": "x"\n  // note\n}\n`
  const out1 = upsertAdrBlock(raw1, { style: "madr" })
  let parsed1: { adr?: { style?: string } }
  let threw = false
  try {
    parsed1 = JSON.parse(stripJsonc(out1))
  } catch {
    threw = true
    parsed1 = {}
  }
  assert(!threw, "root append after comment line → still strict-JSON parseable")
  assert(parsed1.adr?.style === "madr", "adr block appended and persisted")
  assert(out1.includes("// note"), "trailing comment preserved")
  assert(
    out1.indexOf(`"modelCatalog": "x",`) !== -1 &&
      out1.indexOf("// note") > out1.indexOf(`"modelCatalog": "x",`) &&
      out1.indexOf("// note") < out1.indexOf(`"adr":`),
    "comma lands on the member line; comment sits BETWEEN comma and new adr block",
  )

  // 2. Upsert into an existing adr block whose last inner line is a comment
  const raw2 = `{\n  "adr": {\n    "style": "madr"\n    // inner note\n  }\n}\n`
  const out2 = upsertAdrBlock(raw2, { numbering: "sequential" })
  let parsed2: { adr?: { numbering?: string } } = {}
  threw = false
  try {
    parsed2 = JSON.parse(stripJsonc(out2))
  } catch {
    threw = true
  }
  assert(!threw, "in-block insert after comment line → still strict-JSON parseable")
  assert(parsed2.adr?.numbering === "sequential", "missing key inserted into existing block")
  assert(out2.includes("// inner note"), "inner comment preserved")
  assert(
    out2.indexOf(`"style": "madr",`) !== -1 &&
      out2.indexOf("// inner note") > out2.indexOf(`"style": "madr",`),
    "in-block comma lands on the member line, comment re-attached after it",
  )

  // 3a. Commented-out duplicate BEFORE the real key: comment untouched
  const dup1 = `{\n  "adr": {\n    // "style": "nygard"\n    "style": "madr"\n  }\n}\n`
  const fixed1 = upsertAdrBlock(dup1, { style: "madr" })
  assert(fixed1.includes(`// "style": "nygard"`), "commented-out duplicate line untouched (comment-first order)")
  assert(JSON.parse(stripJsonc(fixed1)).adr.style === "madr", "real key stays active and correct (comment-first order)")

  // 3b. Commented-out duplicate AFTER the real key: real key updated, comment untouched
  const dup2 = `{\n  "adr": {\n    "suite": "custom"\n    // "suite": "evolution"\n  }\n}\n`
  const fixed2 = upsertAdrBlock(dup2, { suite: "standard" })
  assert(fixed2.includes(`// "suite": "evolution"`), "commented-out duplicate line untouched (comment-last order)")
  assert(JSON.parse(stripJsonc(fixed2)).adr.suite === "standard", "REAL key updated, not the comment (comment-last order)")

  // 4. Footer comment AFTER the root close containing `}` (parked template):
  // root-append path must not mistake the comment's `}` for the root close.
  const footer = `// template: { "adr": { "style": "madr" } }`
  const raw3 = `{\n  "adrGuard": "off"\n}\n${footer}\n`
  const out3 = upsertAdrBlock(raw3, { style: "nygard" })
  const parsed3 = JSON.parse(stripJsonc(out3)) as { adr: { style: string } }
  assert(parsed3.adr.style === "nygard", "upsert succeeds with footer comment containing braces")
  assert(
    out3.indexOf(`"adr":`) !== -1 && out3.indexOf(`\n}\n${footer}`) > out3.indexOf(`"adr":`),
    "adr block inserted INSIDE the root object (root close + footer sit AFTER it)",
  )
  assert(out3.endsWith(footer + "\n"), "footer comment survives byte-identical after the root close")

  // 5. CRLF variant of the same footer-comment shape
  const raw3crlf = `{\r\n  "adrGuard": "off"\r\n}\r\n${footer}\r\n`
  const out3crlf = upsertAdrBlock(raw3crlf, { style: "nygard" })
  const parsed3crlf = JSON.parse(stripJsonc(out3crlf)) as { adr: { style: string } }
  assert(parsed3crlf.adr.style === "nygard", "CRLF: upsert succeeds with footer comment containing braces")
  assert(
    out3crlf.indexOf(`"adr":`) !== -1 && out3crlf.indexOf(`}\r\n${footer}`) > out3crlf.indexOf(`"adr":`),
    "CRLF: adr block inserted INSIDE the root object (root close + footer sit AFTER it)",
  )
  assert(out3crlf.endsWith(footer + "\r\n"), "CRLF: footer comment survives byte-identical after the root close")
}

// ═════════════════════════════════════════════════════════════════════════
//  7d. /adr init style-availability gate (Finding 2 regression)
// ═════════════════════════════════════════════════════════════════════════

function test07d_InitStyleGate() {
  section("07d: init style-availability gate")
  assert(isAdrStyleAvailable("MADR"), "madr is persistable (case-insensitive)")
  assert(isAdrStyleAvailable("madr"), "madr is persistable")
  assert(isAdrStyleAvailable("nygard") && isAdrStyleAvailable("NYGARD"), "nygard persistable now its adapter is registered (Phase 2)")
  assert(!isAdrStyleAvailable("bogus"), "unknown style rejected")
  assert(!isAdrStyleAvailable(undefined), "missing style rejected")
  // Suite tables: standard/evolution stay madr; ocp is the container preset
  for (const s of ["standard", "evolution"] as const) {
    assert(resolveAdrSuite(s).fields.style === "madr", `${s} suite resolves style=madr only`)
  }
  assert(resolveAdrSuite("ocp").fields.style === "ocp", "ocp suite resolves style=ocp")
  // The guard now ACCEPTS what `/adr init custom --style nygard` resolves to
  const nygardFields = resolveAdrSuite("custom", { style: "nygard" }).fields
  assert(isAdrStyleAvailable(nygardFields.style), "guard accepts the nygard-resolved init fields")

  // Simulate the handleAdrInit decision flow (guard runs BEFORE setAdrConfigFields)
  const sandbox = makeSandbox("style-gate")
  try {
    mkdirSync(join(sandbox, ".ocp"), { recursive: true })
    const cfgFile = join(sandbox, ".ocp", "ocp.json")
    writeFileSync(cfgFile, `{\n  "adrGuard": "off"\n}\n`, "utf-8")

    const nygard = "nygard"
    if (isAdrStyleAvailable(nygard)) {
      setAdrConfigFields(resolveAdrSuite("custom", { style: nygard }).fields)
    }
    const persistedNygard = JSON.parse(readFileSync(cfgFile, "utf-8")) as { adr?: { style?: string } }
    assert(persistedNygard.adr?.style === "nygard", "nygard init: guard passes — persisted end-to-end")

    const bogus = "bogus"
    if (isAdrStyleAvailable(bogus)) {
      setAdrConfigFields(resolveAdrSuite("custom", { style: bogus }).fields)
    }
    const persisted = JSON.parse(readFileSync(cfgFile, "utf-8")) as { adr?: { style?: string } }
    assert(persisted.adr?.style === "nygard", "bogus init: guard blocks — previous config untouched")
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  8. Numbering: iteration IDs + sequential fallback warning (§6.1)
// ═════════════════════════════════════════════════════════════════════════

function test08_Numbering() {
  section("08: iteration numbering + fallback")
  const sandbox = makeSandbox("num")
  try {
    mkdirSync(join(sandbox, ".ocp"), { recursive: true })
    writeFileSync(join(sandbox, ".ocp", "ocp.json"), `{\n  "adr": {\n    "style": "madr",\n    "numbering": "iteration",\n    "suite": "evolution"\n  }\n}\n`, "utf-8")

    // Explicit --baseline/--iteration → dotted ID (0.2.54.01)
    const first = createAdr({ projectDir: sandbox, title: "Store calc mode on lines", targetDir: "docs/adr", baseline: "0.2", iteration: "54" })
    assert(first.id === "0.2.54.01", `iteration allocation mints 0.2.54.01 (got ${first.id})`)
    assert(first.relPath === "docs/adr/0.2.54.01-store-calc-mode-on-lines.md", "filename follows baseline.iter.seq-slug.md")
    assert(first.warnings.length === 0, "no fallback warning when baseline/iteration given")

    const second = createAdr({ projectDir: sandbox, title: "Decimal snapshots", targetDir: "docs/adr", baseline: "0.2", iteration: "54" })
    assert(second.id === "0.2.54.02", "sequence increments within the same iteration")
    const nextIter = createAdr({ projectDir: sandbox, title: "Next iteration", targetDir: "docs/adr", baseline: "0.2", iteration: "61" })
    assert(nextIter.id === "0.2.61.01", "sequence resets per iteration")
    assert(allocateAdrIterationId(sandbox, "0.2", "54") === "0.2.54.03", "allocateAdrIterationId scans the whole ADL")

    // Dotted records parse + normalize
    const parsed = parseAdrFile(join(sandbox, first.relPath), sandbox)
    assert(parsed?.id === "0.2.54.01", "parser accepts dotted filename IDs")
    const records = getNormalizedAdrs(sandbox)
    assert(records.some((r) => r.id === "ADR-0.2.54.01"), "normalized dotted ID is ADR-0.2.54.01")

    // Bare creation under numbering:iteration WITHOUT --baseline/--iteration
    // → sequential fallback with a VISIBLE warning; nothing invented (§6.1 rule 8)
    const fallback = createAdr({ projectDir: sandbox, title: "Unversioned fix", targetDir: "docs/adr" })
    assert(/^\d{4}$/.test(fallback.id), "bare creation falls back to sequential numbering")
    assert(fallback.warnings.length === 1 && fallback.warnings[0].includes("fell back to sequential"), "visible fallback warning emitted")

    // Mixed schemes coexist: sequential + dotted IDs in one ADL. (0001 was
    // already minted by the sequential fallback above.)
    const seq = createAdr({ projectDir: sandbox, title: "Sequential record", targetDir: "docs/adr", numbering: "sequential" })
    assert(seq.id === "0002", "sequential numbering available per-record alongside iteration IDs")
    const issues = checkAdrIntegrity(sandbox)
    assert(!issues.some((i) => i.type === "duplicate-id"), "mixed numbering schemes produce no duplicate-ID issues (disjoint grammars)")
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  9. Engine scaffold contract (acceptance: /adr new format + style: madr)
// ═════════════════════════════════════════════════════════════════════════

function test09_ScaffoldContract() {
  section("09: scaffold contract — /adr new compatibility")
  const sandbox = makeSandbox("scaffold")
  try {
    const created = createAdr({ projectDir: sandbox, title: "Contract Check", targetDir: "docs/adr" })
    const content = readFileSync(created.fullPath, "utf-8")
    assert(content.includes("style: madr"), "new scaffold carries explicit style: madr frontmatter")
    assert(content.includes("created: ") && content.includes("date: "), "scaffold writes created alongside date")
    assert(content.includes("## Context and Problem Statement"), "MADR-compatible body preserved")
    assert(content.includes("status: Proposed"), "default status is Proposed (§6.2 — no code path writes Accepted)")
    const meta = parseAdrFile(created.fullPath, sandbox)
    assert(meta?.created === meta?.date, "created equals date on the creation day")
    assert(existsSync(join(sandbox, "docs/adr/INDEX.md")), "index regenerated")
    const index = readFileSync(join(sandbox, "docs/adr/INDEX.md"), "utf-8")
    assert(index.includes("ADR-0001"), "index renders canonical ADR-0001 IDs")
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  10. Legacy key deprecation warning (§6.4 read-compat)
// ═════════════════════════════════════════════════════════════════════════

function test10_LegacyKeyWarning() {
  section("10: legacy key deprecation warning")
  const sandbox = makeSandbox("legacy-warn")
  const cfgFile = join(sandbox, ".ocp", "ocp.json")
  mkdirSync(join(sandbox, ".ocp"), { recursive: true })

  const warnings: string[] = []
  const origWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  try {
    // Pure detector
    assert(JSON.stringify(detectLegacyAdrKeys(null)) === "[]", "null cfg → no legacy keys")
    assert(JSON.stringify(detectLegacyAdrKeys({ adr: {} })) === "[]", "adr.* block alone → no legacy keys")
    assert(
      JSON.stringify(detectLegacyAdrKeys({ adrGuard: "on", adrLayout: "flat" })) === JSON.stringify(["adrGuard", "adrLayout"]),
      "detector names exactly the present legacy keys",
    )

    // Absent → no warning on the real read paths
    resetLegacyAdrKeyWarnings()
    warnings.length = 0
    writeFileSync(cfgFile, `{\n  "adr": { "style": "madr" }\n}\n`, "utf-8")
    getAdrDir()
    getAdrConfig()
    isEnabled()
    assert(warnings.length === 0, `no legacy keys → no deprecation warning (got ${warnings.length})`)

    // Present → exactly one warning
    warnings.length = 0
    resetLegacyAdrKeyWarnings()
    writeFileSync(cfgFile, `{\n  "adrGuard": "on",\n  "adrDir": "docs/adr"\n}\n`, "utf-8")
    getAdrDir()
    assert(warnings.length === 1, `legacy keys → exactly ONE deprecation warning (got ${warnings.length})`)
    assert(warnings[0]?.includes("adrGuard") && warnings[0]?.includes("adrDir"), "warning names the detected keys")
    assert(warnings[0]?.includes("v1.0") && warnings[0]?.includes("adr.*"), "warning states v1.0 removal and points to adr.* block")

    // Idempotency: repeated reads across paths never duplicate
    getAdrDir()
    getAdrConfig()
    isEnabled()
    assert(warnings.length === 1, "second read across all paths does not duplicate the warning")

    // Precedence untouched: legacy keys keep full authority
    assert(getAdrDir() === "docs/adr", "legacy adrDir still governs the ADR root")
    assert(isEnabled() === true, "legacy adrGuard still governs the guard gate")
  } finally {
    console.warn = origWarn
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 11. appendAdrSection style gate — ocp containers only
// ═════════════════════════════════════════════════════════════════════════

function test11_SectionStyleGate() {
  section("11: appendAdrSection — ocp container style gate")
  const sandbox = makeSandbox("section-gate")
  try {
    mkdirSync(join(sandbox, "docs/adr"), { recursive: true })

    // Sequential MADR record passes the container ID grammar but must be
    // refused: an appended ocp block would corrupt the MADR grammar and
    // stay invisible to style-dispatched tooling.
    const madr = createAdr({ projectDir: sandbox, title: "Plain madr decision", targetDir: "docs/adr" })
    const before = readFileSync(madr.fullPath, "utf-8")
    let threw = ""
    try {
      appendAdrSection(sandbox, "ADR-0001", "must not append")
    } catch (err) {
      threw = String(err)
    }
    assert(threw.includes("'madr'"), `madr record refused with its actual style named (got: ${threw})`)
    assert(readFileSync(madr.fullPath, "utf-8") === before, "refused append leaves the madr record byte-stable")

    // Legacy record without style frontmatter dispatches as madr → refused.
    writeAdr(sandbox, "docs/adr/0002-legacy-record.md", legacyAdr("0002", "Legacy no-style record"))
    threw = ""
    try {
      appendAdrSection(sandbox, "ADR-0002", "must not append")
    } catch (err) {
      threw = String(err)
    }
    assert(threw.includes("ocp container records only"), `legacy sequential record refused (got: ${threw})`)

    // The gate is not over-broad: a real sequential ocp container still works.
    const seqContainer = createAdrContainer({ projectDir: sandbox, title: "Sequential container" })
    const appended = appendAdrSection(sandbox, seqContainer.id, "container section")
    assert(appended.id === "ADR-0003#01", `sequential ocp container still accepts sections (got ${appended.id})`)
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ─── Main entry ───────────────────────────────────────────────────────────

function main() {
  console.log("╔══════════════════════════════════════════════════════════╗")
  console.log("║  Multi-style ADL — Style Registry & Foundation Tests     ║")
  console.log("╚══════════════════════════════════════════════════════════╝")

  const origDir = getProjectDirSafe()
  try {
    test01_IdGrammar()
    test02_MadrAdapter()
    test03_Registry()
    test04_GlobalAllocation()
    test05_RefResolution()
    test06_Supersede()
    test07_ConfigAndSuites()
    test07b_UpsertEdges()
    test07c_UpsertCommentSafety()
    test07d_InitStyleGate()
    test08_Numbering()
    test09_ScaffoldContract()
    test10_LegacyKeyWarning()
    test11_SectionStyleGate()
  } finally {
    setProjectDir(origDir)
  }

  console.log(`\n${"═".repeat(60)}`)
  console.log(`  Result: ${passed} passed / ${failed} failed`)
  console.log(`${"═".repeat(60)}`)
  if (failed > 0) process.exit(1)
}

function getProjectDirSafe(): string {
  try {
    return process.cwd()
  } catch {
    return "."
  }
}

main()
