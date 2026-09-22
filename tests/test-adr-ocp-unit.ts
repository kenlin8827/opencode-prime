/**
 * OCP container style adapter tests (ADR-0007 §7 amendment).
 *
 * Coverage:
 *   - ID grammar: container form (`ADR-0.2.54`) normalization + filename stems
 *   - adapter: scaffold / scaffoldSection / detect / parse / validate /
 *     format / renderIndexEntry
 *   - section parsing: five-part fields, emoji status mapping, rejected
 *     option/reason split, optional language parentheticals ignored
 *   - namespace discipline: container reserves `<baseline>.<iteration>.*`;
 *     per-decision allocation refuses an occupied iteration; a container
 *     never claims an iteration holding per-decision records
 *   - engine: createAdrContainer + appendAdrSection on a temp project
 *   - registry: ocp registered; declared-style dispatch
 *
 * Run: bun run tests/test-adr-ocp-unit.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { setProjectDir } from "../plugins/adr/adr-config"
import {
  allocateAdrIterationId,
  appendAdrSection,
  checkAdrIntegrity,
  createAdr,
  createAdrContainer,
  getNormalizedAdrs,
  supersedeAdr,
} from "../plugins/adr/adr-engine"
import { getAdrStyleAdapter, listAdrStyles, resolveDocumentAdapter } from "../plugins/adr/adr-style-registry"
import type { AdrDocument } from "../plugins/adr/adr-types"
import { adrIdFromFilename, normalizeAdrId } from "../plugins/adr/adr-types"
import { buildAdrHistory, buildSectionEdges, renderAdrHistory, resolveRecordByRef } from "../plugins/adr/adr-views"
import { ocpAdapter } from "../plugins/adr/styles/ocp"

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++
    console.log(`  ✅ ${msg}`)
  } else {
    failed++
    console.error(`  ❌ ${msg}`)
  }
}

function makeDoc(rawContent: string, filename = "0.2.54-test.md", relPath = `docs/adr/${filename}`): AdrDocument {
  return { fullPath: `/tmp/${filename}`, relPath, filename, rawContent, frontmatter: {} }
}

// ─── ID grammar ───────────────────────────────────────────────────────

console.log("\n■ ID grammar: container form")
assert(normalizeAdrId("0.2.54") === "ADR-0.2.54", "bare 3-segment normalizes to container ID")
assert(normalizeAdrId("ADR-0.2.54") === "ADR-0.2.54", "prefixed container ID round-trips")
assert(normalizeAdrId("0.2.54.01") === "ADR-0.2.54.01", "4-segment per-decision form unchanged")
assert(normalizeAdrId("0001") === "ADR-0001", "sequential form unchanged")
assert(normalizeAdrId("0.2") === null, "2-segment rejected (no such grammar)")
assert(normalizeAdrId("0.2.54#1") === "ADR-0.2.54#01", "bare section form pads seq to two")
assert(normalizeAdrId("ADR-0042#2") === "ADR-0042#02", "sequential container section form canonicalizes")
assert(normalizeAdrId("ADR-0.2.54.01") === "ADR-0.2.54.01", "dotted 4-segment stays the PER-DECISION record grammar")
assert(adrIdFromFilename("0.2.54-calc-mode.md") === "ADR-0.2.54", "container stem parses from filename")
assert(adrIdFromFilename("0.2.54.01-calc-mode.md") === "ADR-0.2.54.01", "4-segment stem wins over container prefix")
assert(adrIdFromFilename("0001-use-postgresql.md") === "ADR-0001", "sequential stem unchanged")

// ─── Registry ─────────────────────────────────────────────────────────

console.log("\n■ registry dispatch")
assert(listAdrStyles().includes("ocp"), "ocp is a registered style")
const declaredOcp = makeDoc(`---\nstyle: ocp\nstatus: proposed\n---\n\n# T\n`)
assert(resolveDocumentAdapter(declaredOcp).adapter.style === "ocp", "declared style: ocp dispatches to the ocp adapter")
assert(resolveDocumentAdapter(declaredOcp).declaredStyle === "ocp", "declaredStyle reported as ocp")

// ─── detect ───────────────────────────────────────────────────────────

console.log("\n■ detect")
const FIXTURE = readFileSync(join(__dirname, "fixtures/adr/ocp/0.2.54-commission-calc-mode.md"), "utf-8")
assert(ocpAdapter.detect(FIXTURE, "0.2.54-commission-calc-mode.md"), "fixture container detected as ocp")
assert(!ocpAdapter.detect(`---\nstyle: madr\n---\n\n# 1. T\n\n## Context and Problem Statement\n\nx\n`, "0001-t.md"), "madr doc not detected as ocp")
assert(
  !ocpAdapter.detect(`# 0.2.54.01. T\n\n## Context and Problem Statement\n\nx\n`, "0.2.54.01-t.md"),
  "per-decision dotted doc (no H3 sections) not detected as ocp",
)

// ─── parse ────────────────────────────────────────────────────────────

console.log("\n■ parse: container + section payload")
const parsed = ocpAdapter.parse(makeDoc(FIXTURE, "0.2.54-commission-calc-mode.md"))
assert(parsed.id === "ADR-0.2.54", "container ID from stem")
assert(parsed.style === "ocp", "style ocp")
assert(parsed.status === "accepted", "file-level status")
assert(parsed.baseline === "0.2" && parsed.iteration === "54", "baseline/iteration frontmatter")
assert(parsed.domain === "commission", "domain frontmatter")
assert(parsed.title === "Iteration 0.2.54 · Commission dual calc mode", "H1 title")
assert((parsed.sections ?? []).length === 2, "two sections parsed")
const [s1, s2] = parsed.sections ?? []
assert(s1.id === "ADR-0.2.54#01" && s1.seq === "01", "section 1 canonical sub-ID is the # fragment form")
assert(s1.status === "accepted", "✅ maps to accepted")
assert(s2.status === "proposed", "🟡 maps to proposed")
assert((s1.decision ?? "").includes("calcMode"), "Decision field extracted")
assert((s1.rationale ?? "").includes("Expressiveness"), "Rationale field extracted")
assert((s1.background ?? "").includes("rate"), "Background field extracted")
assert((s1.rejected ?? []).length === 2, "Rejected bullets parsed")
assert(s1.rejected?.[0].option.includes("fixedAmount") && s1.rejected?.[0].reason.includes("CHECK"), "rejected split into option + reason")
assert((s1.impact ?? []).length === 3, "Impact bullets parsed")
assert(s1.impact?.[0].includes("CommissionLine"), "impact item content preserved")

console.log("\n■ parse: language parentheticals are display-only")
const withParenthetical = makeDoc(
  FIXTURE.replace("**Decision**: Introduce", "**Decision** （decision）: Introduce"),
  "0.2.54-commission-calc-mode.md",
)
const ppParsed = ocpAdapter.parse(withParenthetical)
assert((ppParsed.sections ?? [])[0].decision?.includes("calcMode"), "parenthetical after label is ignored, value still extracted")
assert(
  ocpAdapter.validate(withParenthetical, ppParsed).filter((i) => i.severity === "error").length === 0,
  "parenthetical form validates error-free",
)

console.log("\n■ parse: legacy full-ID headings keep their IDs")
const legacyFull = makeDoc(
  FIXTURE.replace("### 01. calcMode + value replaces rate", "### ADR-0.2.54.01: calcMode + value replaces rate"),
  "0.2.54-commission-calc-mode.md",
)
const legacyParsed = ocpAdapter.parse(legacyFull)
assert(legacyParsed.sections?.[0].id === "ADR-0.2.54#01", "legacy dotted full-ID heading canonicalizes to the # form")

// ─── validate ─────────────────────────────────────────────────────────

console.log("\n■ validate")
const issues = ocpAdapter.validate(makeDoc(FIXTURE, "0.2.54-commission-calc-mode.md"), parsed)
assert(!issues.some((i) => i.severity === "error"), "fixture validates with zero errors")
assert(!issues.some((i) => i.message.includes("no reason")), "no rejected-without-reason warnings on fixture")

const noBaseline = ocpAdapter.parse(makeDoc(`---\nstyle: ocp\nstatus: proposed\ndate: 2026-09-18\n---\n\n# T\n`))
assert(
  ocpAdapter.validate(makeDoc(`---\nstyle: ocp\nstatus: proposed\ndate: 2026-09-18\n---\n\n# T\n`), noBaseline).some((i) => i.message.includes("baseline")),
  "missing baseline/iteration → error",
)

const emptyContainerRaw = `---\nstyle: ocp\nstatus: proposed\ndate: 2026-09-18\nbaseline: "0.2"\niteration: "55"\n---\n\n# T\n`
const emptyContainer = ocpAdapter.parse(makeDoc(emptyContainerRaw))
assert(
  ocpAdapter.validate(makeDoc(emptyContainerRaw), emptyContainer).some((i) => i.message.includes("no sections yet")),
  "zero-section container → warn",
)

const badNamespace = makeDoc(
  FIXTURE.replace("### 02. Ledger snapshots to Decimal + backfill", "### ADR-0.2.55.02: Ledger snapshots to Decimal + backfill"),
  "0.2.54-commission-calc-mode.md",
)
assert(
  ocpAdapter.validate(badNamespace, ocpAdapter.parse(badNamespace)).some((i) => i.severity === "error" && i.message.includes("namespace")),
  "section outside container namespace → error",
)

const missingReason = makeDoc(
  FIXTURE.replace(": mutual exclusion cannot be enforced in CHECK, semantics tear", ""),
  "0.2.54-commission-calc-mode.md",
)
assert(
  ocpAdapter.validate(missingReason, ocpAdapter.parse(missingReason)).some((i) => i.message.includes("no reason")),
  "rejected bullet without reason → warn",
)

const dupSeq = makeDoc(
  FIXTURE.replace("### 02. Ledger snapshots to Decimal + backfill", "### 01. Ledger snapshots to Decimal + backfill"),
  "0.2.54-commission-calc-mode.md",
)
assert(
  ocpAdapter.validate(dupSeq, ocpAdapter.parse(dupSeq)).some((i) => i.severity === "error" && i.message.includes("duplicate")),
  "duplicate section sequence → error",
)

// ─── scaffold round-trips ─────────────────────────────────────────────

console.log("\n■ scaffold / scaffoldSection / format")
const scaffolded = ocpAdapter.scaffold({
  id: "0.2.60",
  title: "Notification completion",
  status: "proposed",
  date: "2026-09-18",
  created: "2026-09-18",
  layer: "system",
  baseline: "0.2",
  iteration: "60",
  domain: "notification",
})
const scaffoldDoc = makeDoc(scaffolded, "0.2.60-notification.md")
const scaffoldRecord = ocpAdapter.parse(scaffoldDoc)
assert(scaffoldRecord.id === "ADR-0.2.60", "scaffolded container ID")
assert(scaffoldRecord.sections?.length === 0, "scaffolded container starts with zero sections")
assert(
  ocpAdapter.validate(scaffoldDoc, scaffoldRecord).filter((i) => i.severity === "error").length === 0,
  "scaffolded container has no errors (zero-section warn only)",
)
assert(ocpAdapter.detect(scaffolded, "x.md"), "scaffolded container self-detects")
assert(scaffolded.includes("reader's primary entry"), "scaffold drafter note points at the cheatsheet as the reading surface")

const block = ocpAdapter.scaffoldSection?.({ id: "ADR-0.2.60#01", title: "Entity identity boundary" }) ?? ""
assert(block.startsWith("### 01. Entity identity boundary"), "scaffoldSection renders short heading")
assert(block.includes("**Status**: 🟡 Proposed"), "scaffoldSection renders emoji status line")
const withSection = scaffolded.replace(/\s+$/, "") + `\n\n${block}`
const withSectionDoc = makeDoc(withSection, "0.2.60-notification.md")
const roundTrip = ocpAdapter.parse(withSectionDoc)
assert(roundTrip.sections?.length === 1 && roundTrip.sections[0].id === "ADR-0.2.60#01", "appended section parses back")
assert(
  ocpAdapter.validate(withSectionDoc, roundTrip).filter((i) => i.severity === "error").length === 0,
  "placeholder section validates error-free",
)
assert(ocpAdapter.format(scaffoldDoc) === scaffolded.replace(/\s+$/, "") + "\n", "format is whitespace-only normalization")

// ─── index entry ──────────────────────────────────────────────────────

console.log("\n■ renderIndexEntry")
const row = ocpAdapter.renderIndexEntry(parsed)
assert(row.startsWith("| [ADR-0.2.54](./0.2.54-commission-calc-mode.md) |"), "index row links container ID to file")
assert(row.includes("`ocp`"), "index row declares style")
assert(row.includes("(2 sections)"), "index row carries section count")

// ─── engine: container creation + namespace reservation ───────────────

console.log("\n■ engine: createAdrContainer / appendAdrSection / namespace guards")
const tmp = mkdtempSync(join(tmpdir(), "adr-ocp-"))
setProjectDir(tmp)
try {
  mkdirSync(join(tmp, "docs/adr"), { recursive: true })

  const created = createAdrContainer({ projectDir: tmp, title: "Commission dual calc mode", baseline: "0.2", iteration: "54", domain: "commission" })
  assert(existsSync(created.fullPath), "container file written")
  assert(created.id === "ADR-0.2.54", "allocated container ID")
  assert(/0\.2\.54-.+\.md$/.test(created.relPath), `filename carries container stem (got ${created.relPath})`)

  let threw = false
  try {
    createAdrContainer({ projectDir: tmp, title: "Double claim", baseline: "0.2", iteration: "54" })
  } catch {
    threw = true
  }
  assert(threw, "double-claiming a container iteration throws")

  const app1 = appendAdrSection(tmp, "ADR-0.2.54", "calcMode dual mode")
  assert(app1.id === "ADR-0.2.54#01", "first section allocates seq 01 (# fragment form)")
  const app2 = appendAdrSection(tmp, "0.2.54", "ledger Decimal migration")
  assert(app2.id === "ADR-0.2.54#02", "second section allocates seq 02 (bare container ref accepted)")

  const containerRaw = readFileSync(created.fullPath, "utf-8")
  assert(containerRaw.indexOf("### 01.") < containerRaw.indexOf("### 02."), "sections appended in order")

  const normalized = getNormalizedAdrs(tmp)
  const container = normalized.find((r) => r.id === "ADR-0.2.54")
  assert(container !== undefined, "container discovered as a normalized record")
  assert(container?.style === "ocp", "container record style ocp")
  assert((container?.sections ?? []).length === 2, "both sections parsed on rediscovery")
  assert((container?.sections ?? [])[1].id === "ADR-0.2.54#02", "rediscovered section seq 02")

  threw = false
  try {
    allocateAdrIterationId(tmp, "0.2", "54")
  } catch {
    threw = true
  }
  assert(threw, "per-decision allocation refuses an iteration claimed by a container")

  // An iteration with per-decision records cannot be claimed by a container.
  createAdr({ projectDir: tmp, title: "Standalone decision", baseline: "0.2", iteration: "70", numbering: "iteration" })
  threw = false
  try {
    createAdrContainer({ projectDir: tmp, title: "Claim occupied", baseline: "0.2", iteration: "70" })
  } catch {
    threw = true
  }
  assert(threw, "container refuses an iteration holding per-decision records")

  threw = false
  try {
    appendAdrSection(tmp, "ADR-0.2.70.01", "cannot section a per-decision record")
  } catch {
    threw = true
  }
  assert(threw, "section append refuses a per-decision record")

  threw = false
  try {
    createAdrContainer({ projectDir: tmp, title: "Missing params", baseline: "", iteration: "80" })
  } catch {
    threw = true
  }
  assert(threw, "half-given baseline/iteration throws (never invent the missing half)")

  threw = false
  try {
    createAdr({ projectDir: tmp, title: "ocp via per-record path", style: "ocp" })
  } catch {
    threw = true
  }
  assert(threw, "createAdr refuses style 'ocp' — containers go through createAdrContainer")

  const integrity = checkAdrIntegrity(tmp)
  assert(
    !integrity.some((i) => i.severity === "error" && i.file.includes("0.2.54")),
    `container passes full integrity check (got: ${integrity.filter((i) => i.severity === "error" && i.file.includes("0.2.54")).map((i) => i.message).join("; ") || "none"})`,
  )

  // Sequential containers: numbering is orthogonal to the container
  // style (§6). No baseline/iteration → ADR-NNNN, no namespace ceremony,
  // sections are still `#`-form fragments of the container.
  const seqContainer = createAdrContainer({ projectDir: tmp, title: "Multi-decision batch" })
  assert(seqContainer.id === "ADR-0001", "sequential container allocates the next sequential ID")
  assert(/^0001-.+\.md$/.test(seqContainer.relPath.split("/").pop() ?? ""), "sequential container filename carries the 4-digit stem")
  const seqSection = appendAdrSection(tmp, "ADR-0001", "first batch decision")
  assert(seqSection.id === "ADR-0001#01", "sequential container section is ADR-NNNN#NN")
  const seqRediscovered = getNormalizedAdrs(tmp).find((r) => r.id === "ADR-0001")
  assert(seqRediscovered !== undefined, "sequential container discovered as a record")
  assert(
    ocpAdapter.validate(makeDoc(readFileSync(seqContainer.fullPath, "utf-8"), "0001-multi-decision-batch.md"), ocpAdapter.parse(makeDoc(readFileSync(seqContainer.fullPath, "utf-8"), "0001-multi-decision-batch.md"))).filter((i) => i.severity === "error").length === 0,
    "sequential container validates without baseline/iteration metadata",
  )
  createAdr({ projectDir: tmp, title: "Ordinary sequential record" })
  const seqApp2 = appendAdrSection(tmp, "ADR-0001", "second batch decision")
  assert(seqApp2.id === "ADR-0001#02", "container section seq is container-local, independent of record allocation")

  // Supersession: a container's successor uses the safe per-decision style
  // (a container successor would need a baseline/iteration, never invented).
  const sup = supersedeAdr(tmp, "ADR-0.2.54", "Commission model v2")
  assert(sup.newAdr.id !== "ADR-0.2.54", "successor carries a new ID")
  assert(!sup.newAdr.id.includes("#"), "successor is not a fabricated container section")
  const flipped = readFileSync(sup.oldAdr.fullPath, "utf-8")
  assert(/status:\s*superseded by ADR-.+/i.test(flipped), "container status line flipped to superseded-by")

  assert(getAdrStyleAdapter("ocp") === ocpAdapter, "getAdrStyleAdapter resolves ocp")
} finally {
  rmSync(tmp, { recursive: true, force: true })
  setProjectDir("")
}

// ─── section-level refs + annotation edges (§7 amendment) ─────────────

console.log("\n■ section-level history: container-granular graph, annotation-grade edges")
const withEdgeRef = FIXTURE.replace(
  "**Decision**: Move ledger snapshot columns to Decimal; backfill existing rows.",
  "**Decision**: Move ledger snapshot columns to Decimal; backfill existing rows. This supersedes ADR-0.2.53#01 decision 2 and amends ADR-0.2.54#01 rationale.",
)
const edgeDoc = makeDoc(withEdgeRef, "0.2.54-commission-calc-mode.md")
const edgeRecords = [ocpAdapter.parse(edgeDoc)]
const sectionResolved = resolveRecordByRef(edgeRecords, "ADR-0.2.54#01")
assert(sectionResolved?.id === "ADR-0.2.54", "#-form section ref resolves to its container record")
assert(resolveRecordByRef(edgeRecords, "ADR-0.2.54.01") === null, "dotted 4-seg is the record grammar — no record, no fallback, no guessing")
assert(resolveRecordByRef(edgeRecords, "ADR-0.2.99#01") === null, "unknown section ref resolves to nothing")
const historyViaSection = buildAdrHistory(edgeRecords, "ADR-0.2.54#02")
assert(historyViaSection?.target.id === "ADR-0.2.54", "/adr history accepts a section ID and targets the container")

const edges = buildSectionEdges(edgeRecords)
assert(edges.length === 2, `two annotation edges extracted (got ${edges.length})`)
assert(edges[0].from === "ADR-0.2.54#02" && edges[0].to === "ADR-0.2.53#01" && edges[0].relation === "supersedes", "supersedes edge with relation + target")
assert(edges.some((e) => e.relation === "amends" && e.to === "ADR-0.2.54#01"), "amends edge extracted")
assert(edges.every((e) => e.toContainer === `ADR-${e.to.replace(/^ADR-/, "").split("#")[0]}`), "every edge carries its target container")
const renderedHistory = renderAdrHistory(historyViaSection!, edges)
assert(renderedHistory.includes("Section-level cross-references"), "history render surfaces the annotation edge block")
assert(renderedHistory.includes("ADR-0.2.54#02 → supersedes ADR-0.2.53#01"), "rendered edge line is human-readable")
const noEdges = renderAdrHistory(historyViaSection!)
assert(!noEdges.includes("Section-level cross-references"), "edge block omitted when no edges are passed")

// ─── result ───────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}\n  RESULT: ${passed} passed / ${failed} failed\n${"═".repeat(60)}`)
process.exit(failed > 0 ? 1 : 0)
