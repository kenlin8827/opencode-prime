/** End-to-end service and native-plugin contracts; no paid model calls.
 * Run: bun tests/test-adr-compaction-unit.ts
 */
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setProjectDir, setAdrConfigKey } from "../plugins/adr/adr-config"
import { createAdr, getAllAdrs, regenerateAdlIndexes } from "../plugins/adr/adr-engine"
import { analyzeCompaction, startCompaction, compactionEvidence, submitCandidate, stageCandidate, candidateBatchPage, applyPlan, loadPlan, planArchive, checkCompaction, type Candidate, type Plan } from "../plugins/adr/adr-compaction"
import { currentState, isArchived, recordRoot, queryAdrContext, takeSnapshot, CONTEXT_BUDGET } from "../plugins/adr/adr-context"
import { createCompactionRuntime, parseCompactionArgs } from "../plugins/adr/adr-compaction-runtime"
import { createReadGuard } from "../plugins/adr/adr-read-guard"
import { digest, maintenanceDir, projectPath, readOptional, applyJournal, withMaintenanceLock } from "../plugins/adr/adr-storage"
import { readDecidedIds, decisionLedgerEntry } from "../plugins/adr/adr-governance"

let passed = 0
async function test(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log(`PASS ${name}`) }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "adr-compaction-")); setProjectDir(dir)
  mkdirSync(join(dir, ".ocp"), { recursive: true })
  writeFileSync(join(dir, ".ocp/ocp.json"), JSON.stringify({ adr: { style: "nygard", numbering: "sequential", layout: "flat", governance: "strict" } }))
  return dir
}
function content(id: string, status = "accepted", decision = "Use explicit boundaries.") {
  return `---\nstyle: nygard\nstatus: ${status}\ndate: 2026-09-19\nlayer: system\ndomain: runtime\n---\n\n# ${id.replace("ADR-", "")}. Runtime boundaries\n\n## Context\n\nWe need predictable integration.\n\n## Decision\n\n${decision}\n\n## Consequences\n\nExtra validation preserves boundaries.\n`
}
function source(dir: string, id: string, status = "accepted", decision?: string) {
  mkdirSync(join(dir, "docs/adr"), { recursive: true })
  writeFileSync(join(dir, `docs/adr/${id}-runtime.md`), content(id, status, decision))
}
function readAll(dir: string, p: Plan) {
  let cursor: string | undefined
  do { const page = compactionEvidence(dir, p.id, p.sessionID, cursor); cursor = page.next } while (cursor)
}
function candidate(p: Plan, selected: string[], untouched: string[] = []): Candidate {
  const id = p.slots[0]?.id
  return {
    replacements: id ? [{ id, title: "Consolidated runtime", content: content(id, "proposed") }] : [],
    summary: [...(id ? [{ text: "Use explicit boundaries. Accepted current constraints.", sources: [id] }] : selected.map(source => ({ text: "Use explicit boundaries.", sources: [source] }))), ...untouched.map(source => ({ text: "Retained independent constraint.", sources: [source] }))],
    coverage: [...selected.map(source => ({ source, disposition: id ? "replace" as const : "retain" as const, targets: id ? [id] : [], note: "Preserved without semantic change." })), ...untouched.map(source => ({ source, disposition: "retain" as const, targets: [], note: "Unchanged independent decision." }))],
  }
}
const client = { tui: { showToast: async () => ({}) }, session: { prompt: async () => ({}), get: async () => ({ data: {} }) }, app: { log: async () => ({}) } } as any
const ctx = { sessionID: "s", messageID: "m", agent: "build", directory: "", worktree: "", abort: new AbortController().signal, ask: async () => {}, metadata: () => {} } as any

await test("strict CLI, mutually exclusive options and safe default", () => {
  assert.equal(parseCompactionArgs("").action, "analyze")
  assert.equal(parseCompactionArgs("--mode consolidate --dry-run --archive").action, "analyze")
  assert.equal(parseCompactionArgs("--mode=summary").action, "draft")
  for (const raw of ["--force", "--mode x", "--mode summary --archive", "--sources x --domain y", "--confirm cp-x --archive", "--sources", "--mode summary --mode summary", "archive restore"]) assert.throws(() => parseCompactionArgs(raw))
})

await test("analysis makes no writes and namespace allocation includes all sources", () => {
  const dir = fixture()
  try {
    source(dir, "0001"); source(dir, "0002")
    assert.match(analyzeCompaction(dir), /selected: 2/)
    assert.ok(!existsSync(join(dir, maintenanceDir)))
    const p = startCompaction(dir, "s", { mode: "consolidate" })
    assert.equal(p.slots[0].id, "ADR-0003")
    assert.throws(() => submitCandidate(dir, p.id, "s", candidate(p, p.selected)), /not fully retrieved/)
    assert.throws(() => compactionEvidence(dir, p.id, "other"), /another session/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await test("bounded Unicode evidence, complete range receipts and stale cursors", () => {
  const dir = fixture()
  try {
    source(dir, "0001", "accepted", "中文\\\"\n".repeat(16000))
    const p = startCompaction(dir, "s", { mode: "summary" })
    let cursor: string | undefined, pages = 0
    do {
      const page = compactionEvidence(dir, p.id, "s", cursor)
      assert.ok(Array.from(JSON.stringify(page)).length <= CONTEXT_BUDGET)
      cursor = page.next; pages++
    } while (cursor)
    assert.ok(pages > 5)
    const initial = queryAdrContext(dir, { id: "ADR-0001" })
    assert.ok(initial.next)
    source(dir, "0002")
    assert.throws(() => queryAdrContext(dir, { id: "ADR-0001", cursor: initial.next }), /stale/)
    assert.throws(() => submitCandidate(dir, p.id, "s", candidate(p, p.selected)), /changed/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await test("N-to-one acceptance, ledger, CURRENT, archive links, identity, restore", () => {
  const dir = fixture()
  try {
    source(dir, "0001"); source(dir, "0002")
    mkdirSync(join(dir, "docs/adr/zh"), { recursive: true })
    writeFileSync(join(dir, "docs/adr/zh/reader.md"), "---\ntranslation_of: docs/adr/0001-runtime.md\n---\n[Source](../0001-runtime.md)\n")
    writeFileSync(join(dir, "README.md"), "[Record](docs/adr/0001-runtime.md)\n")
    const p = startCompaction(dir, "s", { mode: "consolidate", archive: true })
    readAll(dir, p)
    const ready = submitCandidate(dir, p.id, "s", candidate(p, p.selected))
    assert.equal(getAllAdrs(dir).length, 2)
    const done = applyPlan(dir, ready.id, ready.seal!, "test-native-question", "accept")
    assert.equal(done.state, "complete")
    const records = takeSnapshot(dir).records
    assert.equal(records.length, 3)
    assert.equal(records.filter(r => r.sourcePath.includes("/archive/")).length, 2)
    assert.equal(records.find(r => r.id === "ADR-0003")!.supersedes.length, 2)
    assert.ok(records.filter(r => r.id !== "ADR-0003").every(r => r.supersededBy.includes("ADR-0003")))
    assert.ok(readDecidedIds(dir).has("ADR-0003"))
    assert.equal(currentState(dir).status, "fresh")
    assert.match(readFileSync(join(dir, "README.md"), "utf8"), /archive\/0001/)
    assert.match(readFileSync(join(dir, "docs/adr/zh/reader.md"), "utf8"), /archive\/0001/)
    assert.match(readFileSync(join(dir, "docs/adr/INDEX.md"), "utf8"), /archive/)
    assert.equal(applyPlan(dir, ready.id, ready.seal!, "retry", "accept").state, "complete")
    const q = queryAdrContext(dir, { id: "ADR-0001" })
    assert.ok(q.entries.some(e => e.id === "ADR-0003"))
    assert.ok(q.entries.every(e => !e.path.includes("/archive/")))
    const restored = planArchive(dir, "s", undefined, p.id)
    const redraft = { summary: [{ text: "Unreviewed semantic redraft", sources: ["ADR-0003"] }], replacements: [], coverage: [] }
    assert.throws(() => submitCandidate(dir, restored.id, "s", redraft), /cannot accept semantic candidates/)
    assert.throws(() => stageCandidate(dir, restored.id, "s", "redraft", redraft), /not open/)
    applyPlan(dir, restored.id, restored.seal!, "restore-command", "accept")
    assert.ok(existsSync(join(dir, "docs/adr/0001-runtime.md")))
    assert.match(readFileSync(join(dir, "docs/adr/0001-runtime.md"), "utf8"), /status: superseded/)
    assert.equal(currentState(dir).status, "fresh")
    const archive = planArchive(dir, "s", ["ADR-0001"])
    assert.throws(() => submitCandidate(dir, archive.id, "s", redraft), /cannot accept semantic candidates/)
    assert.equal(createAdr({ projectDir: dir, title: "Next", targetDir: "docs/adr" }).id, "0004")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await test("summary refresh, ordinary mutation invalidation and ownership refusal", () => {
  const dir = fixture()
  try {
    source(dir, "0001")
    const p = startCompaction(dir, "s", { mode: "summary" }); readAll(dir, p)
    const ready = submitCandidate(dir, p.id, "s", candidate(p, p.selected))
    applyPlan(dir, ready.id, ready.seal!, "question", "accept")
    assert.equal(currentState(dir).status, "fresh")
    assert.ok(queryAdrContext(dir, {}).entries[0].id.startsWith("CURRENT"))
    const manifestPath = join(dir, "docs/adr/CURRENT.sources.json"), originalManifest = readFileSync(manifestPath, "utf8")
    const tampered = JSON.parse(originalManifest); tampered.sources[0].hash = "wrong"
    writeFileSync(manifestPath, JSON.stringify(tampered))
    assert.equal(currentState(dir).status, "invalid")
    writeFileSync(manifestPath, originalManifest)
    source(dir, "0002", "proposed")
    assert.equal(currentState(dir).status, "stale")
    writeFileSync(join(dir, "docs/adr/CURRENT.md"), "hand edited")
    assert.equal(currentState(dir).status, "invalid")
    const p2 = startCompaction(dir, "s", { mode: "summary" }); readAll(dir, p2)
    const blocked = submitCandidate(dir, p2.id, "s", candidate(p2, p2.selected))
    assert.match(blocked.blockers!.join(" "), /user-owned/)
    assert.throws(() => applyPlan(dir, blocked.id, blocked.seal!, "question", "accept"), /execution blockers/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await test("partial scope retains unrelated CURRENT constraints; save-drafts never retires", () => {
  const dir = fixture()
  try {
    source(dir, "0001"); source(dir, "0002")
    const p = startCompaction(dir, "s", { mode: "consolidate", sources: ["ADR-0001"] }); readAll(dir, p)
    assert.throws(() => submitCandidate(dir, p.id, "s", candidate(p, p.selected)), /every source decision unit/)
    const ready = submitCandidate(dir, p.id, "s", candidate(p, p.selected, ["ADR-0002"]))
    applyPlan(dir, ready.id, ready.seal!, "question", "drafts")
    assert.equal(takeSnapshot(dir).records.find(r => r.id === "ADR-0001")!.status, "accepted")
    assert.equal(takeSnapshot(dir).records.find(r => r.id === "ADR-0003")!.status, "proposed")
    assert.equal(readDecidedIds(dir).size, 0)
    assert.ok(!existsSync(join(dir, "docs/adr/CURRENT.md")))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await test("journal recovery refuses unrelated edits and retries completed operations", () => {
  const dir = fixture()
  try {
    writeFileSync(join(dir, "a.md"), "before")
    const changes = [{ path: "a.md", before: "before", after: "after" }, { path: "b.md", before: null, after: "created" }]
    const path = `${maintenanceDir}/cp-0000000000000000.lifecycle.json`
    mkdirSync(join(dir, maintenanceDir), { recursive: true })
    writeFileSync(join(dir, path), JSON.stringify({ version: 1, complete: false, changes }))
    writeFileSync(join(dir, "a.md"), "after")
    writeFileSync(join(dir, "b.md"), "user edit")
    assert.throws(() => withMaintenanceLock(dir, () => applyJournal(dir, path)), /unexpected edit/)
    rmSync(join(dir, "b.md"))
    withMaintenanceLock(dir, () => applyJournal(dir, path))
    assert.equal(readFileSync(join(dir, "b.md"), "utf8"), "created")
    withMaintenanceLock(dir, () => applyJournal(dir, path))
    assert.throws(() => withMaintenanceLock(dir, () => applyJournal(dir, path, [...changes, { path: "unrelated.md", before: null, after: "not authorized" }])), /authorized transaction/)
    assert.throws(() => projectPath(dir, "../escape"), /Unsafe/)
    assert.throws(() => projectPath(dir, "/absolute"), /Unsafe/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await test("Ask requires matching native call, request, session, exact answer; replay is inert", async () => {
  const dir = fixture()
  try {
    source(dir, "0001")
    const runtime = createCompactionRuntime(dir, client)
    const p = startCompaction(dir, "s", { mode: "summary" }); readAll(dir, p)
    const output = await runtime.tools.adr_compaction.execute({ plan: p.id, action: "submit", candidate: candidate(p, p.selected) }, ctx)
    const ask = JSON.parse(String(output))
    await runtime.event({ type: "question.replied", properties: { sessionID: "s", requestID: "forged", answers: [[ask.questions[0].options[0].label]] } })
    assert.equal(loadPlan(dir, p.id).state, "review")
    await runtime.before({ tool: "question", sessionID: "s", callID: "call" }, { args: { questions: ask.questions } })
    await runtime.event({ type: "question.asked", properties: { sessionID: "s", id: "q", tool: { callID: "call" }, questions: ask.questions } })
    await runtime.event({ type: "question.replied", properties: { sessionID: "wrong", requestID: "q", answers: [[ask.questions[0].options[0].label]] } })
    assert.equal(loadPlan(dir, p.id).state, "review")
    const event = { type: "question.replied", properties: { sessionID: "s", requestID: "q", answers: [[ask.questions[0].options[0].label]] } }
    await runtime.event(event)
    assert.equal(loadPlan(dir, p.id).state, "complete")
    const first = readOptional(dir, "docs/adr/CURRENT.md")
    await runtime.event(event)
    assert.equal(readOptional(dir, "docs/adr/CURRENT.md"), first)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await test("guard is opt-in; supported archive reads block, code reads and discovery do not", async () => {
  const dir = fixture()
  try {
    source(dir, "0001", "deprecated")
    mkdirSync(join(dir, "docs/adr/archive")); writeFileSync(join(dir, "docs/adr/archive/0002-old.md"), content("0002", "deprecated"))
    const guard = createReadGuard(dir, client)
    await guard({ tool: "read", sessionID: "s" }, { args: { filePath: "docs/adr/archive/0002-old.md" } })
    assert.ok(setAdrConfigKey("readGuard", "guard"))
    await assert.rejects(guard({ tool: "read", sessionID: "s" }, { args: { filePath: "docs/adr/archive/0002-old.md" } }), /ADR-READ-GUARD/)
    await assert.rejects(guard({ tool: "grep", sessionID: "s" }, { args: { path: ".", pattern: "decision" } }), /ADR-READ-GUARD/)
    await guard({ tool: "grep", sessionID: "s" }, { args: { path: ".", output_mode: "files_with_matches", pattern: "decision" } })
    await guard({ tool: "read", sessionID: "s" }, { args: { filePath: "src/app.ts" } })
    await assert.rejects(guard({ tool: "bash", sessionID: "s" }, { args: { command: "cat docs/adr/archive/0002-old.md" } }), /ADR-READ-GUARD/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await test("OCP section evidence, complete replacement and mixed-container refusal", () => {
  const dir = fixture()
  const ocp = (id: string, status: string) => `---\nstyle: ocp\nstatus: ${status}\ndate: 2026-09-19\nlayer: system\n---\n\n# Runtime\n\n## Cheatsheet\n\n1. Keep explicit boundaries.\n\n## Quick view\n\n| Topic | Choice |\n| --- | --- |\n| Boundary | Explicit |\n\n### 01. Boundary\n**Status**: ${status === "accepted" ? "✅" : "🟡"} ${status}\n**Background**: Isolation is needed.\n**Decision**: Use explicit boundaries.\n**Rationale**: Avoid hidden coupling.\n**Rejected**:\n- Implicit calls: Hidden coupling.\n**Impact**:\n- Tests: Validate boundaries.\n`
  try {
    source(dir, "0001")
    const rejectedSection = ocp("0001", "accepted").split("### 01.")[1].replace("**Status**: ✅ accepted", "**Status**: rejected")
    writeFileSync(join(dir, "docs/adr/0001-runtime.md"), ocp("0001", "accepted") + "\n### 02." + rejectedSection)
    const section = queryAdrContext(dir, { id: "ADR-0001#01" })
    assert.ok(section.entries.some(e => e.id === "ADR-0001#01" && e.excerpt.startsWith("### 01.")))
    const p = startCompaction(dir, "s", { mode: "consolidate", style: "ocp", archive: true }); readAll(dir, p)
    const c: Candidate = { replacements: [{ id: p.slots[0].id, title: "Consolidated runtime", content: ocp("0002", "proposed") }], coverage: [{ source: "ADR-0001#01", disposition: "replace", targets: ["ADR-0002"], note: "Unchanged." }, { source: "ADR-0001#02", disposition: "historical", targets: [], note: "Rejected alternative remains rejected." }], summary: [{ text: "Use explicit boundaries.", sources: ["ADR-0002#01"] }] }
    const ready = submitCandidate(dir, p.id, "s", c)
    applyPlan(dir, ready.id, ready.seal!, "question", "accept")
    assert.equal(takeSnapshot(dir).records.find(r => r.id === "ADR-0001")!.sections![0].status, "superseded")
    assert.equal(takeSnapshot(dir).records.find(r => r.id === "ADR-0002")!.sections![0].status, "accepted")
    assert.equal(takeSnapshot(dir).records.find(r => r.id === "ADR-0001")!.sections![1].status, "rejected")
    const raw = ocp("0003", "accepted").replace("**Status**: ✅ accepted", "**Status**: 🟡 proposed")
    writeFileSync(join(dir, "docs/adr/0003-mixed.md"), raw)
    const mixed = startCompaction(dir, "s", { mode: "consolidate", sources: ["ADR-0003"], style: "ocp" }); readAll(dir, mixed)
    const invalid: Candidate = { replacements: [{ id: mixed.slots[0].id, title: "Mixed", content: ocp("0004", "proposed") }], summary: [{ text: "Constraints", sources: ["ADR-0002#01", "ADR-0004#01"] }], coverage: [{ source: "ADR-0002#01", disposition: "retain", targets: [], note: "Unchanged" }, { source: "ADR-0003#01", disposition: "replace", targets: [mixed.slots[0].id], note: "Cannot accept implicitly" }] }
    assert.throws(() => submitCandidate(dir, mixed.id, "s", invalid), /resolved accepted/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await test("custom roots, module evidence, namespace collision and OCP state override", () => {
  const dir = fixture(), old = process.env.OCP_PROJECT_DIR
  try {
    process.env.OCP_PROJECT_DIR = ".state"
    mkdirSync(join(dir, ".state"))
    writeFileSync(join(dir, ".state/ocp.json"), JSON.stringify({ adrDir: "architecture/decisions", adr: { style: "nygard", layout: "hierarchical" } }))
    mkdirSync(join(dir, "architecture/decisions"), { recursive: true })
    writeFileSync(join(dir, "architecture/decisions/0001-base.md"), content("0001"))
    mkdirSync(join(dir, "packages/pay/docs/adr"), { recursive: true })
    writeFileSync(join(dir, "packages/pay/docs/adr/0002-pay.md"), content("0002"))
    const p = startCompaction(dir, "s", { mode: "summary", sources: ["ADR-0001"] })
    assert.equal(p.evidencePaths.length, 2)
    assert.ok(existsSync(join(dir, `.state/adr-compaction/${p.id}.json`)))
    readAll(dir, p)
    const c = candidate(p, ["ADR-0001"], ["ADR-0002"])
    const ready = submitCandidate(dir, p.id, "s", c)
    applyPlan(dir, ready.id, ready.seal!, "question", "accept")
    assert.equal(currentState(dir).status, "fresh")
    assert.ok(existsSync(join(dir, "architecture/decisions/CURRENT.md")))
    assert.ok(existsSync(join(dir, "packages/pay/docs/adr/CURRENT.md")))
    assert.match(readFileSync(join(dir, "architecture/decisions/CURRENT.md"), "utf8"), /packages\/pay/)
    assert.throws(() => startCompaction(dir, "s", { mode: "consolidate", baseline: "0.40" }), /approved/)
    assert.equal(isArchived("packages/archive/docs/adr/0001-example.md", "architecture/decisions"), false)
    assert.equal(isArchived("docs/archive/0001-example.md", "docs/archive"), false)
    assert.equal(recordRoot("docs/archive/archive/0001-example.md", "docs/archive"), "docs/archive")
    const consolidated = startCompaction(dir, "s", { mode: "consolidate", sources: ["ADR-0001"], archive: true }); readAll(dir, consolidated)
    const approved = submitCandidate(dir, consolidated.id, "s", candidate(consolidated, ["ADR-0001"], ["ADR-0002"]))
    applyPlan(dir, approved.id, approved.seal!, "question", "accept")
    assert.ok(takeSnapshot(dir).records.some(r => r.sourcePath === "architecture/decisions/archive/0001-base.md"))
    assert.ok(existsSync(join(dir, ".state/adr-decisions.log")))
    assert.equal(currentState(dir).status, "fresh")
  } finally { if (old === undefined) delete process.env.OCP_PROJECT_DIR; else process.env.OCP_PROJECT_DIR = old; rmSync(dir, { recursive: true, force: true }) }
})

await test("unknown relationships, ambiguous IDs, cycles and proposal retirement are rejected", () => {
  const dir = fixture()
  try {
    source(dir, "0001", "proposed")
    const p = startCompaction(dir, "s", { mode: "consolidate" }); readAll(dir, p)
    assert.throws(() => submitCandidate(dir, p.id, "s", candidate(p, p.selected)), /resolved accepted/)
    source(dir, "0002")
    writeFileSync(join(dir, "docs/adr/0001-runtime.md"), content("0001").replace("status: accepted", "status: accepted\nparent: ADR-9999"))
    assert.throws(() => startCompaction(dir, "s", { mode: "summary" }), /missing|ambiguous/)
    writeFileSync(join(dir, "docs/adr/0001-runtime.md"), content("0001").replace("status: accepted", "status: superseded\nsuperseded_by: ADR-0002"))
    writeFileSync(join(dir, "docs/adr/0002-runtime.md"), content("0002").replace("status: accepted", "status: superseded\nsuperseded_by: ADR-0001"))
    assert.throws(() => startCompaction(dir, "s", { mode: "summary" }), /cycle/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await test("stale native Ask, cancel, modified choice, reordered Question event and rejection", async () => {
  for (const kind of ["stale", "cancel", "modify", "reject"] as const) {
    const dir = fixture()
    try {
      source(dir, "0001")
      const runtime = createCompactionRuntime(dir, client)
      const p = startCompaction(dir, "s", { mode: "summary" }); readAll(dir, p)
      const ask = JSON.parse(String(await runtime.tools.adr_compaction.execute({ plan: p.id, action: "submit", candidate: candidate(p, p.selected) }, ctx)))
      await runtime.before({ tool: "question", sessionID: "s", callID: "call" }, { args: { questions: ask.questions } })
      const q = ask.questions[0]
      const reordered = { question: q.question, header: q.header, options: q.options, multiple: q.multiple }
      await runtime.event({ type: "question.asked", data: { sessionID: "s", id: "q", tool: { callID: "call" }, questions: [reordered] } })
      if (kind === "stale") source(dir, "0002")
      const label = kind === "cancel" ? q.options.at(-1).label : kind === "modify" ? q.options[1].label : q.options[0].label
      await runtime.event({ type: kind === "reject" ? "question.rejected" : "question.replied", data: { sessionID: "s", requestID: "q", answers: [[label]] } })
      assert.ok(!existsSync(join(dir, "docs/adr/CURRENT.md")))
      assert.equal(loadPlan(dir, p.id).state, kind === "cancel" ? "cancelled" : "review")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

await test("interrupted accepted lifecycle preserves current view; unplanned recovery edits stop", () => {
  const dir = fixture()
  try {
    source(dir, "0001")
    const p = startCompaction(dir, "s", { mode: "consolidate", archive: true }); readAll(dir, p)
    const ready = submitCandidate(dir, p.id, "s", candidate(p, p.selected))
    // A directory at the archive path is a recoverable environmental failure,
    // but it must be detected before any approved source is retired.
    mkdirSync(join(dir, "docs/adr/archive/0001-runtime.md"), { recursive: true })
    assert.throws(() => applyPlan(dir, ready.id, ready.seal!, "question", "accept"))
    assert.equal(takeSnapshot(dir).records.find(r => r.id === "ADR-0001")!.status, "accepted")
    rmSync(join(dir, "docs/adr/archive"), { recursive: true })
    // Simulate a crash after the reviewed lifecycle writes, before view publication.
    ready.state = "applying"; ready.approval = { actor: "question", choice: "accept", seal: ready.seal!, at: new Date().toISOString() }; ready.ledgerBefore = null
    writeFileSync(join(dir, `${maintenanceDir}/${ready.id}.json`), JSON.stringify(ready))
    const lifecycle = [...ready.changes!].sort((a, b) => Number(a.before !== null) - Number(b.before !== null))
    const entry = decisionLedgerEntry("ADR-0002", "docs/adr/0002-consolidated-runtime.md", `compaction ${p.id}; question`, ready.approval.at)
    lifecycle.unshift({ path: ".ocp/adr-decisions.log", before: null, after: entry })
    for (const c of lifecycle) { if (c.after !== null) writeFileSync(join(dir, c.path), c.after) }
    writeFileSync(join(dir, `${maintenanceDir}/${ready.id}.lifecycle.json`), JSON.stringify({ version: 1, complete: true, changes: lifecycle }))
    source(dir, "0099")
    assert.throws(() => applyPlan(dir, ready.id, ready.seal!, "resume", "accept"), /New ADR/)
    rmSync(join(dir, "docs/adr/0099-runtime.md"))
    assert.equal(applyPlan(dir, ready.id, ready.seal!, "resume", "accept").state, "complete")
    assert.equal(currentState(dir).status, "fresh")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


await test("N-to-M MADR successors retain an independent record and refresh reviewed indexes", () => {
  const dir = fixture()
  try {
    source(dir, "0001"); source(dir, "0002"); source(dir, "0003")
    regenerateAdlIndexes(dir)
    const p = startCompaction(dir, "s", { mode: "consolidate", sources: ["ADR-0001", "ADR-0002"], style: "madr", archive: true }); readAll(dir, p)
    const madr = (id: string) => content(id, "proposed").replace("style: nygard", "style: madr").replace("## Context", "## Context and Problem Statement").replace("## Decision\n\n", "## Considered Options\n\n- Explicit boundaries\n- Implicit calls\n\n## Decision Outcome\n\nChosen option: explicit boundaries, because isolation matters. ").replace("## Consequences", "### Consequences")
    const c: Candidate = { replacements: p.slots.map(slot => ({ id: slot.id, title: "Separate responsibility", content: madr(slot.id) })), coverage: ["ADR-0001", "ADR-0002"].map(source => ({ source, disposition: "replace", targets: p.slots.map(s => s.id), note: "Split responsibilities without dropping constraints." })), summary: [{ text: "Preserve all boundary controls.", sources: [...p.slots.map(s => s.id), "ADR-0003"] }] }
    c.coverage.push({ source: "ADR-0003", disposition: "retain", targets: [], note: "Independent decision unchanged." })
    const original = readFileSync(join(dir, "docs/adr/0003-runtime.md"), "utf8")
    const ready = submitCandidate(dir, p.id, "s", c)
    assert.ok(ready.viewChanges!.some(c => c.path === "docs/adr/INDEX.md"))
    const result = applyPlan(dir, ready.id, ready.seal!, "question", "accept")
    assert.equal(result.state, "complete")
    assert.equal(readFileSync(join(dir, "docs/adr/0003-runtime.md"), "utf8"), original)
    const records = takeSnapshot(dir).records
    assert.deepEqual(records.find(r => r.id === "ADR-0001")!.supersededBy, ["ADR-0004", "ADR-0005"])
    assert.deepEqual(records.find(r => r.id === "ADR-0004")!.supersedes, ["ADR-0001", "ADR-0002"])
    const context = queryAdrContext(dir, { id: "ADR-0001" })
    assert.ok(!context.entries.some(e => e.id === "ADR-0001"))
    assert.ok(context.entries.some(e => e.id === "ADR-0004") && context.entries.some(e => e.id === "ADR-0005"))
    assert.deepEqual(JSON.parse(checkCompaction(dir)).issues, [])
    assert.equal(currentState(dir).status, "fresh")
    const inverse = planArchive(dir, "s", undefined, p.id)
    applyPlan(dir, inverse.id, inverse.seal!, "question", "accept")
    assert.equal(currentState(dir).status, "fresh")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await test("iteration identities are explicit; stale reviewed indexes and symlinks cannot be overwritten", () => {
  const dir = fixture()
  try {
    source(dir, "0001")
    assert.ok(setAdrConfigKey("numbering", "iteration"))
    assert.throws(() => startCompaction(dir, "s", { mode: "consolidate" }), /baseline|iteration/i)
    const p = startCompaction(dir, "s", { mode: "consolidate", baseline: "0.40", iteration: "2" }); readAll(dir, p)
    assert.equal(p.slots[0].id, "ADR-0.40.2.01")
    const ready = submitCandidate(dir, p.id, "s", candidate(p, p.selected))
    writeFileSync(join(dir, "docs/adr/INDEX.md"), "editor content")
    assert.throws(() => applyPlan(dir, ready.id, ready.seal!, "question", "accept"), /Reviewed view changed/)
    assert.equal(takeSnapshot(dir).records.length, 1)
    symlinkSync(join(dir, "docs/adr/0001-runtime.md"), join(dir, "docs/adr/0002-alias.md"))
    assert.throws(() => projectPath(dir, "docs/adr/0002-alias.md"), /symlink/i)
    symlinkSync(join(dir, "missing-target"), join(dir, "dangling"))
    assert.throws(() => projectPath(dir, "dangling/new.md"), /symlink/i)
    assert.equal(takeSnapshot(dir).records.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await test("cost gate cannot be skipped, expires, and cancellation authorizes no source ingestion", async () => {
  const dir = fixture()
  try {
    source(dir, "0001")
    const runtime = createCompactionRuntime(dir, client), p = startCompaction(dir, "s", { mode: "summary" })
    await assert.rejects(() => runtime.tools.adr_compaction.execute({ plan: p.id, action: "evidence" }, ctx), /not authorized/)
    await assert.rejects(() => runtime.tools.adr_compaction.execute({ plan: p.id, action: "stage", batch: "premature", candidate: candidate(p, p.selected) }, ctx), /not authorized/)
    const ask = JSON.parse(String(await runtime.tools.adr_compaction.execute({ plan: p.id, action: "ask" }, ctx)))
    await runtime.before({ tool: "question", sessionID: "s", callID: "cost" }, { args: ask })
    await runtime.event({ type: "question.asked", data: { sessionID: "s", id: "cost-q", tool: { callID: "cost" }, questions: ask.questions } })
    await runtime.event({ type: "question.replied", data: { sessionID: "s", requestID: "cost-q", answers: [[ask.questions[0].options[1].label]] } })
    assert.equal(loadPlan(dir, p.id).state, "cancelled")
    assert.equal(loadPlan(dir, p.id).read.length, 0)
    const next = startCompaction(dir, "s", { mode: "summary" })
    const expiry = JSON.parse(String(await runtime.tools.adr_compaction.execute({ plan: next.id, action: "ask" }, ctx)))
    const now = Date.now
    try {
      Date.now = () => now() + 31 * 60_000
      await assert.rejects(() => runtime.before({ tool: "question", sessionID: "s", callID: "late" }, { args: expiry }), /expired/)
    } finally { Date.now = now }
    assert.equal(loadPlan(dir, next.id).costApproval, undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


await test("publication blockers remove acceptance without preventing proposed draft storage", async () => {
  const dir = fixture()
  try {
    source(dir, "0001")
    writeFileSync(join(dir, "docs/adr/CURRENT.md"), "user-owned architecture notes")
    const p = startCompaction(dir, "s", { mode: "consolidate" }); readAll(dir, p)
    const runtime = createCompactionRuntime(dir, client)
    const ask = JSON.parse(String(await runtime.tools.adr_compaction.execute({ plan: p.id, action: "submit", candidate: candidate(p, p.selected) }, ctx)))
    assert.equal(ask.questions[0].options.length, 3)
    const ready = loadPlan(dir, p.id)
    assert.throws(() => applyPlan(dir, ready.id, ready.seal!, "question", "accept"), /blockers/)
    applyPlan(dir, ready.id, ready.seal!, "question", "drafts")
    assert.match(readFileSync(join(dir, "docs/adr/0002-consolidated-runtime.md"), "utf8"), /status: proposed/)
    assert.equal(readFileSync(join(dir, "docs/adr/CURRENT.md"), "utf8"), "user-owned architecture notes")
    assert.equal(takeSnapshot(dir).records.find(r => r.id === "ADR-0001")!.status, "accepted")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


await test("candidate batches persist, retry idempotently, invalidate Ask and cannot bypass full coverage", () => {
  const dir = fixture()
  try {
    source(dir, "0001"); source(dir, "0002")
    const p = startCompaction(dir, "s", { mode: "consolidate" }); readAll(dir, p)
    const c = candidate(p, p.selected)
    const first = { summary: c.summary, replacements: c.replacements, coverage: [] }
    assert.throws(() => stageCandidate(dir, p.id, "s", "../invalid", first), /Batch key/)
    assert.throws(() => stageCandidate(dir, p.id, "s", "oversized", { ...first, summary: [{ text: "x".repeat(12000), sources: c.summary[0].sources }] }), /12,000/)
    assert.throws(() => stageCandidate(dir, p.id, "s", "unknown", { ...first, coverage: [{ source: "ADR-9999", disposition: "retain", note: "Unknown" }] }), /unknown source/)
    const staged = stageCandidate(dir, p.id, "s", "decisions", first)
    assert.equal(stageCandidate(dir, p.id, "s", "decisions", first).revision, staged.revision)
    assert.throws(() => submitCandidate(dir, p.id, "s"), /Coverage/)
    stageCandidate(dir, p.id, "s", "coverage", { summary: [], replacements: [], coverage: c.coverage })
    assert.throws(() => stageCandidate(dir, p.id, "other", "bad", first), /another session/)
    assert.throws(() => stageCandidate(dir, p.id, "s", "duplicate", first), /Duplicate/)
    const page = candidateBatchPage(dir, p.id, "s")
    assert.equal(page.total, 2)
    const ready = submitCandidate(dir, p.id, "s")
    assert.equal(ready.candidate!.coverage.length, 2)
    const oldSeal = ready.seal!
    stageCandidate(dir, p.id, "s", "decisions", { ...first, summary: [{ text: "Preserve boundaries and validation.", sources: c.summary[0].sources }] })
    assert.equal(loadPlan(dir, p.id).seal, undefined)
    assert.throws(() => applyPlan(dir, p.id, oldSeal, "late-question", "accept"), /changed/)
    const revised = submitCandidate(dir, p.id, "s")
    assert.notEqual(revised.seal, oldSeal)
    assert.ok(!existsSync(join(dir, "docs/adr/0003-consolidated-runtime.md")))
    applyPlan(dir, p.id, revised.seal!, "new-question", "accept")
    assert.throws(() => stageCandidate(dir, p.id, "s", "late", first), /not open/)
    assert.equal(currentState(dir).status, "fresh")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await test("large summary submission is assembled from bounded batches, without echoing the corpus", () => {
  const dir = fixture()
  try {
    for (let i = 1; i <= 100; i++) source(dir, String(i).padStart(4, "0"))
    const p = startCompaction(dir, "s", { mode: "summary" }); readAll(dir, p)
    for (let offset = 0; offset < p.selected.length; offset += 5) {
      const c = candidate(p, p.selected.slice(offset, offset + 5))
      assert.ok(Array.from(JSON.stringify(c)).length <= CONTEXT_BUDGET)
      stageCandidate(dir, p.id, "s", `batch-${String(offset).padStart(4, "0")}`, c)
    }
    const before = loadPlan(dir, p.id)
    assert.equal(Object.keys(before.batches!).length, 20)
    const page = candidateBatchPage(dir, p.id, "s")
    assert.ok(page.next)
    assert.ok(Array.from(JSON.stringify(page)).length <= CONTEXT_BUDGET)
    const ready = submitCandidate(dir, p.id, "s")
    assert.equal(ready.candidate!.summary.length, 100)
    assert.equal(ready.candidate!.coverage.length, 100)
    assert.ok(Array.from(JSON.stringify(ready.candidate)).length > CONTEXT_BUDGET)
    stageCandidate(dir, p.id, "s", "batch-0000", { summary: [], replacements: [], coverage: [] })
    assert.throws(() => candidateBatchPage(dir, p.id, "s", page.next), /stale/)
    assert.throws(() => submitCandidate(dir, p.id, "s"), /Coverage/)
    source(dir, "0101")
    assert.throws(() => stageCandidate(dir, p.id, "s", "stale", candidate(p, [])), /changed/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


await test("serialized lifecycle is reparsed before approval, never inferred from optimistic metadata", () => {
  for (const malformed of ["candidate-status", "candidate-indent", "source-status"]) {
    const dir = fixture()
    try {
      source(dir, "0001")
      const path = "docs/adr/0001-runtime.md"
      if (malformed === "source-status") writeFileSync(join(dir, path), readFileSync(join(dir, path), "utf8").replace("status: accepted", "status: proposed\nstatus: accepted"))
      const before = readFileSync(join(dir, path), "utf8")
      const p = startCompaction(dir, "s", { mode: "consolidate" }); readAll(dir, p)
      const data = candidate(p, p.selected)
      if (malformed === "candidate-status") data.replacements[0].content = data.replacements[0].content.replace("status: proposed", "status: accepted\nstatus: proposed")
      if (malformed === "candidate-indent") data.replacements[0].content = data.replacements[0].content.replace("status: proposed", " status : proposed")
      const ready = submitCandidate(dir, p.id, "s", data)
      assert.ok(ready.blockers?.some(b => b.includes("Serialized lifecycle")), `${malformed}: ${JSON.stringify(ready.blockers)}; ${data.replacements[0].content.slice(0,100)}`)
      assert.throws(() => applyPlan(dir, ready.id, ready.seal!, "question", "accept"), /blockers/)
      assert.equal(readFileSync(join(dir, path), "utf8"), before)
      assert.ok(!existsSync(join(dir, ".ocp/adr-decisions.log")))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

console.log(`\n${passed} ADR compaction test groups passed`)
