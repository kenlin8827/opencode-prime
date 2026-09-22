/** Process-death matrix over real storage writes; no provider/model calls. */
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startCompaction, compactionEvidence, submitCandidate, loadPlan, applyPlan } from "../plugins/adr/adr-compaction"
import { currentState, pendingRecovery, queryAdrContext, takeSnapshot } from "../plugins/adr/adr-context"

const points = ["approval", "lifecycle-start", "ledger", "successor", "predecessor", "lifecycle-complete", "current-body", "views-complete", "archive-destination", "archive-source-removed", "archive-complete", "relocated-current-body", "relocated-views-complete", "complete"]
const record = (id: string, status: string) => `---\nstyle: nygard\nstatus: ${status}\ndate: 2026-09-20\nlayer: system\n---\n\n# ${id}. Boundaries\n\n## Context\n\nNeed isolation.\n\n## Decision\n\nUse explicit boundaries.\n\n## Consequences\n\nValidate calls.\n`
for (const point of points) {
  const dir = mkdtempSync(join(tmpdir(), "adr-fault-"))
  try {
    mkdirSync(join(dir, "docs/adr"), { recursive: true }); mkdirSync(join(dir, ".ocp"))
    writeFileSync(join(dir, ".ocp/ocp.json"), JSON.stringify({ adr: { style: "nygard", numbering: "sequential", governance: "strict", layout: "flat" } }))
    for (const id of ["0001", "0002"]) writeFileSync(join(dir, `docs/adr/${id}-original.md`), record(id, "accepted"))
    writeFileSync(join(dir, "README.md"), "[First](docs/adr/0001-original.md) and [Second](docs/adr/0002-original.md)\n")
    const p = startCompaction(dir, "s", { mode: "consolidate", archive: true })
    let cursor: string | undefined
    do { cursor = compactionEvidence(dir, p.id, "s", cursor).next } while (cursor)
    const ready = submitCandidate(dir, p.id, "s", {
      summary: [{ text: "Use explicit boundaries and validate calls.", sources: [p.slots[0].id] }],
      replacements: [{ id: p.slots[0].id, title: "Consolidated", content: record("0003", "proposed") }],
      coverage: p.selected.map(source => ({ source, disposition: "replace", targets: [p.slots[0].id], note: "Preserve meaning." })),
    })
    const competing = point === "approval" ? startCompaction(dir, "s", { mode: "summary" }) : undefined
    let competingSeal: string | undefined
    if (competing) {
      compactionEvidence(dir, competing.id, "s")
      competingSeal = submitCandidate(dir, competing.id, "s", {
        summary: [{ text: "Use explicit boundaries and validate calls.", sources: competing.selected }], replacements: [],
        coverage: competing.selected.map(source => ({ source, disposition: "retain", targets: [], note: "Retain original." })),
      }).seal
    }
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures/adr-compaction-crash.ts"), dir, p.id, ready.seal!, point], { stdout: "pipe", stderr: "pipe" })
    assert.ok(existsSync(join(dir, "fault-fired")), `${point}: ${child.stderr.toString()}`)
    const interrupted = loadPlan(dir, p.id)
    assert.equal(interrupted.state, point === "complete" ? "complete" : "applying")
    assert.equal(JSON.parse(readFileSync(join(dir, ".ocp/adr-compaction/lock"), "utf8")).pid, Number(readFileSync(join(dir, "fault-fired"), "utf8")))
    // spawnSync has reaped the killed owner; only now can the operator remove its lock.
    unlinkSync(join(dir, ".ocp/adr-compaction/lock"))
    if (point !== "complete") {
      assert.throws(() => applyPlan(dir, p.id, ready.seal!, "recovery-operator", "cancel"), /exact authorized choice/)
      if (competing) assert.throws(() => applyPlan(dir, competing.id, competingSeal!, "other-operator", "accept"), /unfinished/)
      assert.ok(pendingRecovery(dir).length, `Stage gap must remain visible: ${point}`)
      assert.throws(() => queryAdrContext(dir), /recovery/)
      assert.throws(() => startCompaction(dir, "another-session", { mode: "summary" }), /unfinished/)
    }
    const result = applyPlan(dir, p.id, ready.seal!, "recovery-operator", "accept")
    assert.equal(result.state, "complete")
    assert.deepEqual(result.approval, interrupted.approval)
    assert.equal(pendingRecovery(dir).length, 0)
    assert.equal(currentState(dir).status, "fresh")
    const records = takeSnapshot(dir).records
    assert.equal(records.length, 3)
    assert.equal(records.filter(r => r.status.toLowerCase() === "accepted").length, 1)
    assert.ok(existsSync(join(dir, "docs/adr/archive/0001-original.md")))
    assert.ok(existsSync(join(dir, "docs/adr/archive/0002-original.md")))
    assert.match(readFileSync(join(dir, "README.md"), "utf8"), /adr\/archive\/0001/)
    const ledger = readFileSync(join(dir, ".ocp/adr-decisions.log"), "utf8")
    assert.equal(ledger.trim().split("\n").length, 1)
    assert.match(ledger, /verified-fixture-user/)
    applyPlan(dir, p.id, ready.seal!, "replay", "accept")
    assert.equal(readFileSync(join(dir, ".ocp/adr-decisions.log"), "utf8"), ledger)
    console.log(`PASS crash/recovery: ${point}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
console.log(`${points.length} process-death boundaries recovered without duplicate acceptance or lost sources`)
