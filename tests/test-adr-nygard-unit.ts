/**
 * Multi-style ADL — Phase 2: Nygard Adapter (§7.1, §8, §13 Phase 2)
 *
 * Coverage:
 *   - nygard adapter: scaffold / detect / parse / validate / format / index entry
 *   - strict style isolation (§7.4): scaffold carries ONLY Nygard's three
 *     canonical sections — no MADR/OCP headings injected
 *   - status mapping + supersession metadata (supersedes / superseded by)
 *   - /adr new --style nygard create flow via the engine (createAdr)
 *   - coexistence: a Nygard file and a MADR file under one ADR root share
 *     one normalized INDEX.md and decision graph
 *   - no cross-talk: a malformed Nygard file reports Nygard sections while
 *     a malformed MADR file reports MADR sections (§13 Phase 2 acceptance)
 *   - cross-style supersession: a nygard record superseded per §9.5
 *
 * Run: bun run tests/test-adr-nygard-unit.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { setProjectDir } from "../plugins/adr-guard/adr-guard-config"
import {
  checkAdrIntegrity,
  createAdr,
  generateDecisionMap,
  getNormalizedAdrs,
  supersedeAdr,
} from "../plugins/adr-guard/adr-engine"
import { getAdrStyleAdapter, resolveDocumentAdapter } from "../plugins/adr-guard/adr-style-registry"
import type { AdrDocument } from "../plugins/adr-guard/adr-types"
import { madrAdapter } from "../plugins/adr-guard/styles/madr"
import { nygardAdapter } from "../plugins/adr-guard/styles/nygard"

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
  const dir = mkdtempSync(join(tmpdir(), `adr-nygard-${tag}-`))
  setProjectDir(dir)
  return dir
}

function makeDoc(rawContent: string, filename: string): AdrDocument {
  return { fullPath: `/tmp/${filename}`, relPath: `docs/adr/${filename}`, filename, rawContent, frontmatter: {} }
}

function writeAdr(dir: string, relPath: string, content: string): string {
  const full = join(dir, relPath)
  mkdirSync(join(full, ".."), { recursive: true })
  writeFileSync(full, content, "utf-8")
  return full
}

function nygardDoc(rawContent: string, filename = "0001-sample.md"): AdrDocument {
  return { fullPath: `/p/docs/adr/${filename}`, relPath: `docs/adr/${filename}`, filename, rawContent, frontmatter: {} }
}

const SCAFFOLD_INPUT = {
  id: "0001",
  title: "Use PostgreSQL",
  status: "proposed",
  date: "2026-09-17",
  created: "2026-09-17",
  layer: "system" as const,
}

// ═════════════════════════════════════════════════════════════════════════
//  1. nygard adapter — scaffold (§7.1 canonical template, §7.4 isolation)
// ═════════════════════════════════════════════════════════════════════════

function test01_Scaffold() {
  section("01: nygard scaffold — canonical template only")
  const content = nygardAdapter.scaffold(SCAFFOLD_INPUT)

  // Frontmatter contract (same universal layer as madr)
  assert(content.includes("style: nygard"), "scaffold declares style: nygard")
  assert(content.includes("status: Proposed"), "scaffold writes the capitalized status label")
  assert(content.includes("created: 2026-09-17"), "scaffold writes immutable created")
  assert(content.includes("date: 2026-09-17"), "scaffold writes date")
  assert(content.includes("layer: system"), "scaffold writes layer")

  // H1 follows Nygard's canonical `# <number>. <Title>` form
  assert(content.includes("# 0001. Use PostgreSQL"), "H1 carries the number and title (Nygard form)")

  // Canonical sections — exactly Nygard's three, nothing more
  assert(content.includes("## Context"), "canonical heading: Context")
  assert(content.includes("## Decision"), "canonical heading: Decision")
  assert(content.includes("## Consequences"), "canonical heading: Consequences")

  // §7.4 strict style isolation: no MADR/OCP-specific headings or metadata
  const sectionHeadings = content.split(/\r?\n/).filter((l) => l.startsWith("#"))
  assert(sectionHeadings.length === 4, `exactly 4 headings (H1 + 3 sections) — got ${sectionHeadings.length}`)
  assert(!content.includes("## Context and Problem Statement"), "no MADR 'Context and Problem Statement' heading")
  assert(!content.includes("## Considered Options"), "no MADR 'Considered Options' heading")
  assert(!content.includes("## Decision Outcome"), "no MADR 'Decision Outcome' heading")
  assert(!content.includes("Decision Drivers"), "no MADR 'Decision Drivers'")
  assert(!content.includes("Confirmation"), "no MADR 'Confirmation'")

  // One canonical template for every layer (no layer-variant bodies)
  const domain = nygardAdapter.scaffold({ ...SCAFFOLD_INPUT, id: "0002", layer: "domain" })
  assert(domain.includes("## Context") && domain.includes("## Decision") && domain.includes("## Consequences"), "domain-layer scaffold keeps the same three sections")
  assert(!domain.includes("## Context and Problem Statement"), "domain-layer scaffold has no MADR lean-template shape")

  // Evolution metadata rides in frontmatter only (orthogonal option, §7.3)
  const evo = nygardAdapter.scaffold({
    ...SCAFFOLD_INPUT,
    id: "0.2.54.01",
    baseline: "0.2",
    iteration: "0.2.54",
    domain: "commission",
  })
  assert(evo.includes(`baseline: 0.2`) && evo.includes(`iteration: 0.2.54`) && evo.includes(`domain: commission`), "evolution metadata lands in frontmatter")
  assert(evo.split(/\r?\n/).filter((l) => l.startsWith("#")).length === 4, "evolution metadata adds NO body headings")
}

// ═════════════════════════════════════════════════════════════════════════
//  2. nygard adapter — parse round-trip (normalized model, §8)
// ═════════════════════════════════════════════════════════════════════════

function test02_Parse() {
  section("02: nygard parse → NormalizedAdrRecord")
  const scaffolded = nygardAdapter.scaffold(SCAFFOLD_INPUT)
  const record = nygardAdapter.parse(nygardDoc(scaffolded))

  // ID is normalized to ADR-NNNN even though the H1 shows Nygard's
  // `# 1. <Title>` form — style fidelity is body template only (§7.1)
  assert(record.id === "ADR-0001", "parsed record ID is canonical ADR-0001 (H1 number parsed, not the vocabulary)")
  assert(record.style === "nygard", "parsed record style nygard")
  assert(record.title === "Use PostgreSQL", "parsed title (H1 number prefix stripped)")
  assert(record.status === "proposed", "parsed status")
  assert(record.created === "2026-09-17" && record.date === "2026-09-17", "created/date split preserved")
  assert(record.layer === "system", "parsed layer")
  assert(record.sourcePath === "docs/adr/0001-sample.md", "record carries source path")
  assert(record.parentIds.length === 0 && record.supersedes.length === 0 && record.supersededBy.length === 0, "fresh record has empty relationship lists")

  // Dotted ID grammar also normalizes (§6.1)
  const dotted = nygardAdapter.parse(nygardDoc(nygardAdapter.scaffold({ ...SCAFFOLD_INPUT, id: "0.2.54.01" }), "0.2.54.01-sample.md"))
  assert(dotted.id === "ADR-0.2.54.01", "dotted filename ID normalizes to ADR-0.2.54.01")
}

// ═════════════════════════════════════════════════════════════════════════
//  3. nygard adapter — detect (explicit style + content shape)
// ═════════════════════════════════════════════════════════════════════════

function test03_Detect() {
  section("03: nygard detect")
  const scaffolded = nygardAdapter.scaffold(SCAFFOLD_INPUT)
  assert(nygardAdapter.detect(scaffolded, "docs/adr/0001-x.md"), "detects explicit style: nygard")

  // Nygard-shaped body without a style key (legacy-style content detection)
  const shape = `---\nstatus: accepted\ndate: 2026-01-01\n---\n\n# 1. Use Redis\n\n## Context\n\nX\n\n## Decision\n\nY\n\n## Consequences\n\nZ\n`
  assert(nygardAdapter.detect(shape, "docs/adr/0001-x.md"), "detects Nygard content shape (no style key)")

  // No cross-talk with MADR shape (§7.4)
  assert(!nygardAdapter.detect(madrAdapter.scaffold(SCAFFOLD_INPUT), "docs/adr/0001-x.md"), "rejects MADR body (explicit style: madr)")
  const madrShape = `---\nstatus: accepted\ndate: 2026-01-01\n---\n\n# 1. Use Redis\n\n## Context and Problem Statement\n\nX\n\n## Decision Outcome\n\nY\n`
  assert(!nygardAdapter.detect(madrShape, "docs/adr/0001-x.md"), "rejects legacy MADR shape (no exact '## Context'/'## Decision')")
  assert(!nygardAdapter.detect("# Just a note\n\nNothing here.\n", "docs/note.md"), "rejects unrelated markdown")
}

// ═════════════════════════════════════════════════════════════════════════
//  4. nygard adapter — validate (nothing beyond the three sections)
// ═════════════════════════════════════════════════════════════════════════

function test04_Validate() {
  section("04: nygard validate — style-specific missing sections")
  const scaffolded = nygardAdapter.scaffold(SCAFFOLD_INPUT)
  const doc = nygardDoc(scaffolded)
  const issues = nygardAdapter.validate(doc, nygardAdapter.parse(doc))
  assert(issues.length === 0, `scaffolded record validates clean (got ${issues.length})`)

  const broken = scaffolded.replace("## Decision", "## Rationale")
  const brokenDoc = nygardDoc(broken)
  const brokenIssues = nygardAdapter.validate(brokenDoc, nygardAdapter.parse(brokenDoc))
  assert(brokenIssues.length === 1, `exactly one issue for one missing section (got ${brokenIssues.length})`)
  assert(
    brokenIssues.some((i) => i.type === "missing-section" && i.severity === "error"),
    "missing canonical section flagged as error",
  )
  assert(
    brokenIssues.some((i) => i.message.includes("Missing canonical Nygard section '## Decision'")),
    "issue names the Nygard section style-specifically",
  )
  assert(
    !brokenIssues.some((i) => i.message.includes("MADR")),
    "no MADR wording leaks into Nygard validation",
  )

  // Nothing beyond the three sections is ever required (§7.1)
  const minimal = `---\nstyle: nygard\nstatus: proposed\ndate: 2026-09-17\n---\n\n# 1. Tiny\n\n## Context\n\nX\n\n## Decision\n\nY\n\n## Consequences\n\nZ\n`
  const minimalDoc = nygardDoc(minimal)
  assert(nygardAdapter.validate(minimalDoc, nygardAdapter.parse(minimalDoc)).length === 0, "minimal three-section record validates — no extra requirements")

  // One broken section each
  for (const section of ["Context", "Consequences"] as const) {
    const miss = scaffolded.replace(`## ${section}`, "## Something Else")
    const missDoc = nygardDoc(miss)
    const missIssues = nygardAdapter.validate(missDoc, nygardAdapter.parse(missDoc))
    assert(
      missIssues.some((i) => i.message.includes(`Missing canonical Nygard section '## ${section}'`)),
      `missing ## ${section} reported by name`,
    )
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  5. nygard adapter — status mapping + supersession metadata (§9.5)
// ═════════════════════════════════════════════════════════════════════════

function test05_StatusAndSupersession() {
  section("05: nygard status mapping + supersession metadata")

  // Status-line form: `status: Superseded by ADR-0002` (the §9.5 flip; parse lowercases)
  const flipped = nygardAdapter
    .scaffold(SCAFFOLD_INPUT)
    .replace("status: Proposed", "status: Superseded by ADR-0002")
  const flippedRecord = nygardAdapter.parse(nygardDoc(flipped))
  assert(flippedRecord.status === "superseded by adr-0002", "status line parsed verbatim (lowercased)")
  assert(JSON.stringify(flippedRecord.supersededBy) === JSON.stringify(["ADR-0002"]), "superseded-by ID normalized out of the status line")

  // Frontmatter forms: supersedes + superseded_by (ID-based, §9.5)
  const successor = nygardAdapter.scaffold({ ...SCAFFOLD_INPUT, id: "0002", supersedes: "ADR-0001" })
  const successorRecord = nygardAdapter.parse(nygardDoc(successor, "0002-successor.md"))
  assert(successor.includes("supersedes: ADR-0001"), "successor frontmatter carries supersedes: ADR-0001")
  assert(JSON.stringify(successorRecord.supersedes) === JSON.stringify(["ADR-0001"]), "supersedes normalized to ADR-0001")

  const archived = nygardAdapter
    .scaffold({ ...SCAFFOLD_INPUT, id: "0001" })
    .replace("status: Proposed", "status: accepted")
    .replace("date: 2026-09-17", "date: 2026-09-17\nsuperseded_by: ADR-0002")
  const archivedRecord = nygardAdapter.parse(nygardDoc(archived))
  assert(JSON.stringify(archivedRecord.supersededBy) === JSON.stringify(["ADR-0002"]), "superseded_by frontmatter resolves to normalized ADR-0002")

  // Status vocabulary mapping (lifecycle proposals)
  for (const [raw, needle] of [
    ["accepted", "🟢"],
    ["rejected", "🔴"],
    ["deprecated", "🟡"],
    ["proposed", "🔵"],
    ["superseded by ADR-0002", "⚪"],
  ] as const) {
    const rec = nygardAdapter.parse(nygardDoc(nygardAdapter.scaffold(SCAFFOLD_INPUT).replace("status: Proposed", `status: ${raw}`)))
    assert(nygardAdapter.renderIndexEntry(rec).includes(needle), `index badge for status '${raw}'`)
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  6. nygard adapter — format + index entry
// ═════════════════════════════════════════════════════════════════════════

function test06_FormatAndIndexEntry() {
  section("06: nygard format + index entry")
  const scaffolded = nygardAdapter.scaffold(SCAFFOLD_INPUT)
  const doc = nygardDoc(scaffolded)
  assert(nygardAdapter.format(doc).endsWith("\n"), "format returns newline-terminated content")
  assert(nygardAdapter.format(doc) === scaffolded, "format is idempotent on a clean scaffold")

  const entry = nygardAdapter.renderIndexEntry(nygardAdapter.parse(doc))
  assert(entry.includes("[ADR-0001](./0001-sample.md)"), "index entry links canonical ID to source file")
  assert(entry.includes("Use PostgreSQL"), "index entry carries title")
  assert(entry.includes("`system`"), "index entry carries layer")
  assert(entry.includes("🔵 Proposed"), "index entry carries status badge")
  assert(entry.includes("2026-09-17"), "index entry carries created date")
}

// ═════════════════════════════════════════════════════════════════════════
//  7. /adr new --style nygard — engine create flow (§13 Phase 2 task 3)
// ═════════════════════════════════════════════════════════════════════════

function test07_CreateFlow() {
  section("07: createAdr with style nygard")
  const sandbox = makeSandbox("create")
  try {
    const created = createAdr({ projectDir: sandbox, title: "Use PostgreSQL", targetDir: "docs/adr", style: "nygard" })
    assert(created.id === "0001", "first ADR is 0001")
    assert(created.warnings.length === 0, "no warnings on a plain sequential creation")

    const content = readFileSync(created.fullPath, "utf-8")
    assert(content.includes("style: nygard"), "created file declares style: nygard")
    assert(content.includes("status: Proposed"), "default status Proposed (§6.2)")
    assert(content.includes("created: ") && content.includes("date: "), "scaffold writes created alongside date")
    assert(content.includes("# 0001. Use PostgreSQL"), "H1 in Nygard form")
    assert(content.includes("## Context") && content.includes("## Decision") && content.includes("## Consequences"), "Nygard canonical body")
    assert(!content.includes("Context and Problem Statement"), "no MADR headings in the nygard file")

    // Allocation continues globally across styles (mixed-style ADL, §6.1)
    const madr = createAdr({ projectDir: sandbox, title: "Adopt Outbox", targetDir: "docs/adr", style: "madr" })
    assert(madr.id === "0002", "a madr record continues the SAME global counter after a nygard record")
    const anotherNygard = createAdr({ projectDir: sandbox, title: "Cache Reads", targetDir: "docs/adr", style: "nygard" })
    assert(anotherNygard.id === "0003", "global counter is style-agnostic")

    // The index rows for both styles render through their own adapters
    const index = readFileSync(join(sandbox, "docs/adr/INDEX.md"), "utf-8")
    assert(index.includes("[ADR-0001]") && index.includes("[ADR-0002]") && index.includes("[ADR-0003]"), "one INDEX.md lists every record regardless of style")

    const issues = checkAdrIntegrity(sandbox)
    assert(issues.length === 0, `mixed-style ADL integrity clean (got ${issues.length}: ${issues.map((i) => i.message).join("; ")})`)
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  8. Acceptance — coexistence: one ADL, both styles, one index + graph
// ═════════════════════════════════════════════════════════════════════════

function test08_Coexistence() {
  section("08: nygard + madr coexist in one ADL")
  const sandbox = makeSandbox("coexist")
  try {
    const ny = createAdr({ projectDir: sandbox, title: "Use PostgreSQL", targetDir: "docs/adr", style: "nygard" })
    const ma = createAdr({ projectDir: sandbox, title: "Adopt Transactional Outbox", targetDir: "docs/adr", style: "madr" })

    // Both discovered as normalized records with their own styles
    const records = getNormalizedAdrs(sandbox)
    assert(records.length === 2, `one record per file (got ${records.length})`)
    const nyRecord = records.find((r) => r.id === "ADR-0001")
    const maRecord = records.find((r) => r.id === "ADR-0002")
    assert(nyRecord?.style === "nygard", "nygard record keeps its style")
    assert(maRecord?.style === "madr", "madr record keeps its style")
    assert(nyRecord?.title === "Use PostgreSQL" && maRecord?.title === "Adopt Transactional Outbox", "titles parse per style")

    // One normalized INDEX.md (§13 Phase 2 acceptance)
    const index = readFileSync(join(sandbox, "docs/adr/INDEX.md"), "utf-8")
    assert(index.includes("[ADR-0001](./0001-use-postgresql.md)"), "index links the nygard record")
    assert(index.includes("[ADR-0002](./0002-adopt-transactional-outbox.md)"), "index links the madr record")

    // Both appear in one decision graph (map renders bare IDs in brackets)
    const map = generateDecisionMap(sandbox)
    assert(map.includes("[0001]") && map.includes("[0002]"), "decision map contains both records")
    assert(map.includes("Architecture Decision Map"), "graph generated for the mixed-style ADL")

    // Mixed-style integrity is clean
    const issues = checkAdrIntegrity(sandbox)
    assert(issues.length === 0, `coexistence integrity clean (got ${issues.length}: ${issues.map((i) => i.message).join("; ")})`)

    // Cross-style relationship resolution: nygard record parents a madr ID
    // (path form) and resolves it to the normalized ID (§8)
    writeAdr(
      sandbox,
      "docs/adr/0003-child.md",
      `---\nstyle: nygard\nstatus: proposed\ndate: 2026-09-17\nlayer: system\nparent: docs/adr/0002-adopt-transactional-outbox.md\n---\n\n# 3. Child Decision\n\n## Context\n\nX\n\n## Decision\n\nY\n\n## Consequences\n\nZ\n`,
    )
    const withChild = getNormalizedAdrs(sandbox)
    const child = withChild.find((r) => r.id === "ADR-0003")
    assert(JSON.stringify(child?.parentIds) === JSON.stringify(["ADR-0002"]), "nygard record resolves a PATH-form parent to the normalized MADR ID — cross-style links work")
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  9. Acceptance — no cross-talk: style-specific missing-section reports
// ═════════════════════════════════════════════════════════════════════════

function test09_NoCrosstalk() {
  section("09: malformed nygard vs malformed madr — no cross-talk")
  const sandbox = makeSandbox("crosstalk")
  try {
    // Malformed NYGARD: ## Decision renamed — must report Nygard sections
    writeAdr(
      sandbox,
      "docs/adr/0001-broken-nygard.md",
      `---\nstyle: nygard\nstatus: proposed\ndate: 2026-09-17\nlayer: system\n---\n\n# 1. Broken Nygard\n\n## Context\n\nX\n\n## Rationale\n\nY\n\n## Consequences\n\nZ\n`,
    )
    // Malformed MADR: ## Decision Outcome removed — must report MADR sections
    writeAdr(
      sandbox,
      "docs/adr/0002-broken-madr.md",
      `---\nstyle: madr\nstatus: proposed\ndate: 2026-09-17\nlayer: system\n---\n\n# 2. Broken Madr\n\n## Context and Problem Statement\n\nX\n\n## Considered Options\n\n- A\n`,
    )

    const issues = checkAdrIntegrity(sandbox)
    const nygardIssues = issues.filter((i) => i.file === "docs/adr/0001-broken-nygard.md")
    const madrIssues = issues.filter((i) => i.file === "docs/adr/0002-broken-madr.md")

    assert(nygardIssues.length === 1, `nygard file reports exactly its own issue(s) (got ${nygardIssues.length})`)
    assert(
      nygardIssues.some((i) => i.type === "missing-section" && i.message.includes("Missing canonical Nygard section '## Decision'")),
      "malformed nygard reports the missing Nygard '## Decision' section",
    )
    assert(!nygardIssues.some((i) => i.message.includes("MADR")), "nygard report contains NO MADR wording")

    assert(
      madrIssues.some((i) => i.type === "missing-section" && i.message.includes("Missing canonical MADR section '## Decision Outcome'")),
      "malformed madr reports the missing MADR '## Decision Outcome' section",
    )
    assert(!madrIssues.some((i) => i.message.includes("Nygard")), "madr report contains NO Nygard wording")

    // Each malformed document dispatches to its OWN adapter (registry proof)
    const nyDoc = { fullPath: "", relPath: "docs/adr/0001-broken-nygard.md", filename: "0001-broken-nygard.md", rawContent: readFileSync(join(sandbox, "docs/adr/0001-broken-nygard.md"), "utf-8"), frontmatter: {} }
    const maDoc = { fullPath: "", relPath: "docs/adr/0002-broken-madr.md", filename: "0002-broken-madr.md", rawContent: readFileSync(join(sandbox, "docs/adr/0002-broken-madr.md"), "utf-8"), frontmatter: {} }
    assert(resolveDocumentAdapter(nyDoc).adapter === nygardAdapter, "style: nygard dispatches to the nygard adapter")
    assert(resolveDocumentAdapter(maDoc).adapter === madrAdapter, "style: madr dispatches to the madr adapter")
    assert(getAdrStyleAdapter("nygard") === nygardAdapter, "registry serves the nygard adapter by style key")
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  10. Cross-style supersession (§9.5) on a nygard record
// ═════════════════════════════════════════════════════════════════════════

function test10_CrossStyleSupersede() {
  section("10: supersede a nygard record (§9.5)")
  const sandbox = makeSandbox("supersede")
  try {
    const old = createAdr({ projectDir: sandbox, title: "Original Choice", targetDir: "docs/adr", style: "nygard" })
    const originalContent = readFileSync(old.fullPath, "utf-8")
    const originalLines = originalContent.split("\n")

    const { newAdr, oldAdr } = supersedeAdr(sandbox, "ADR-0001", "Replacement Choice")

    // Successor carries the ID-based supersedes reference
    const newContent = readFileSync(newAdr.fullPath, "utf-8")
    assert(newAdr.id === "0002", "successor allocated the next global ID")
    assert(newContent.includes("supersedes: ADR-0001"), "successor frontmatter: supersedes: ADR-0001")

    // Old nygard file: ONLY the status line changed — body byte-stable
    const updatedContent = readFileSync(oldAdr.fullPath, "utf-8")
    const updatedLines = updatedContent.split("\n")
    assert(updatedLines.length === originalLines.length, "old nygard file line count unchanged (no wholesale rewrite)")
    const diffLines = updatedLines.filter((l, i) => l !== originalLines[i])
    assert(diffLines.length === 1 && /status:\s*Superseded by ADR-0002/i.test(diffLines[0] ?? ""), "exactly ONE line changed: the status line")
    assert(updatedContent.includes("style: nygard"), "old file keeps its nygard style declaration")
    assert(updatedContent.includes("## Decision"), "old nygard body sections untouched")

    // The normalized model records the chain across styles
    const records = getNormalizedAdrs(sandbox)
    const oldRecord = records.find((r) => r.id === "ADR-0001")
    const newRecord = records.find((r) => r.id === "ADR-0002")
    assert(JSON.stringify(oldRecord?.supersededBy) === JSON.stringify(["ADR-0002"]), "old nygard record: supersededBy ADR-0002")
    assert(JSON.stringify(newRecord?.supersedes) === JSON.stringify(["ADR-0001"]), "successor record: supersedes ADR-0001")

    // Index regeneration covers the chain; integrity stays clean
    const index = readFileSync(join(sandbox, "docs/adr/INDEX.md"), "utf-8")
    assert(index.includes("[ADR-0001]") && index.includes("[ADR-0002]"), "index lists both ends of the chain")
    const issues = checkAdrIntegrity(sandbox)
    assert(issues.length === 0, `cross-style supersession chain integrity clean (got ${issues.length}: ${issues.map((i) => i.message).join("; ")})`)
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ─── Language parentheticals (every style) ────────────────────────────────

function test11_LanguageParentheticals() {
  section("11: language parentheticals — display-only notes, grammar unchanged")
  // The LLM fills a per-team language note after any canonical heading;
  // every parser and validator must ignore it (single English grammar
  // authority).
  const nygardWithNote = [
    "---",
    "style: nygard",
    "status: proposed",
    "created: 2026-09-18",
    "date: 2026-09-18",
    "layer: system",
    "---",
    "",
    "# 0007. Cache scheme (cache)",
    "",
    "## Context (context)",
    "",
    "Forces at play.",
    "",
    "## Decision (decision)",
    "",
    "We decided.",
    "",
    "## Consequences (consequences)",
    "",
    "Easier and harder.",
    "",
  ].join("\n")
  const nygardDoc = makeDoc(nygardWithNote, "0007-cache.md")
  const nygardRecord = nygardAdapter.parse(nygardDoc)
  assert(
    nygardAdapter.validate(nygardDoc, nygardRecord).filter((i) => i.severity === "error").length === 0,
    "nygard: parenthetical headings validate error-free",
  )
  assert(nygardAdapter.detect(nygardWithNote, "0007-cache.md"), "nygard: parenthetical doc still detected")

  const madrWithNote = [
    "---",
    "style: madr",
    "status: proposed",
    "created: 2026-09-18",
    "date: 2026-09-18",
    "layer: system",
    "---",
    "",
    "# 0008. Ledger precision",
    "",
    "## Context and Problem Statement (context)",
    "",
    "The problem.",
    "",
    "## Considered Options (options)",
    "",
    "- **Option A**: Decimal — pros: exact; cons: migration cost",
    "- **Option B**: keep Float — cons: tail differences",
    "",
    "## Decision Outcome (decision)",
    "",
    "Chosen option: **Option A**, because exactness wins.",
    "",
  ].join("\n")
  const madrDoc = makeDoc(madrWithNote, "0008-ledger.md")
  const madrRecord = madrAdapter.parse(madrDoc)
  assert(
    madrAdapter.validate(madrDoc, madrRecord).filter((i) => i.severity === "error").length === 0,
    "madr: parenthetical canonical sections validate error-free (incl. system-layer Considered Options)",
  )
  assert(madrAdapter.detect(madrWithNote, "0008-ledger.md"), "madr: parenthetical doc still detected")
}

// ─── Main entry ───────────────────────────────────────────────────────────

function main() {
  console.log("╔══════════════════════════════════════════╗")
  console.log("║  Multi-style ADL — Nygard Adapter Tests  ║")
  console.log("╚══════════════════════════════════════════╝")

  const origDir = process.cwd()
  try {
    test01_Scaffold()
    test02_Parse()
    test03_Detect()
    test04_Validate()
    test05_StatusAndSupersession()
    test06_FormatAndIndexEntry()
    test07_CreateFlow()
    test08_Coexistence()
    test09_NoCrosstalk()
    test10_CrossStyleSupersede()
    test11_LanguageParentheticals()
  } finally {
    setProjectDir(origDir)
  }

  console.log(`\n${"═".repeat(60)}`)
  console.log(`  Result: ${passed} passed / ${failed} failed`)
  console.log(`${"═".repeat(60)}`)
  if (failed > 0) process.exit(1)
}

main()
