/** Dev-only synthetic evidence benchmark. Emits text to the tokenizer companion,
 * never invokes a model or changes repository ADRs. Run via benchmark-adr-compaction.py.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setProjectDir } from "../plugins/adr/adr-config"
import { takeSnapshot, recordEvidence, evidencePage, queryAdrContext, CONTEXT_BUDGET, type EvidencePage } from "../plugins/adr/adr-context"
import { planPublication } from "../plugins/adr/adr-publication"
import { atomicWrite } from "../plugins/adr/adr-storage"
import { buildAdrContext, renderAdrContext } from "../plugins/adr/adr-views"

const output = []
for (const count of [10, 100, 1000]) {
  const dir = mkdtempSync(join(tmpdir(), "adr-benchmark-"))
  try {
    setProjectDir(dir)
    mkdirSync(join(dir, ".ocp")); mkdirSync(join(dir, "docs/adr"), { recursive: true })
    writeFileSync(join(dir, ".ocp/ocp.json"), JSON.stringify({ adr: { style: "nygard", layout: "flat" } }))
    const constraints = new Map<string, string>()
    for (let n = 1; n <= count; n++) {
      const id = String(n).padStart(4, "0")
      const constraint = `Service ${n} must validate requests before persistence, redact credentials from logs, and bound retries to three attempts with idempotency keys.`
      constraints.set(`ADR-${id}`, constraint)
      const background = Array.from({ length: n % 20 === 0 ? 35 : 9 }, (_, k) => `Alternative ${k + 1} for service ${n} used implicit middleware. It reduced local boilerplate but hid failure ownership across process boundaries. Operators needed request tracing and explicit retry budgets to diagnose partial failures. The rejected design depended on shared mutable state and made independent deployment risky.`).join("\n\n")
      writeFileSync(join(dir, `docs/adr/${id}-service-policy.md`), `---\nstyle: nygard\nstatus: accepted\ndate: 2026-09-19\nlayer: ${n === 1 ? "system" : "domain"}\ndomain: service-${n % 10}\n---\n\n# ${id}. Service policy\n\n## Context\n\n${background}\n\n## Decision\n\n${constraint}\n\n## Consequences\n\nValidation increases latency; use contract tests and a bounded deadline. Historical experiments remain evidence, not additional current requirements.\n`)
    }
    const snapshot = takeSnapshot(dir)
    const evidence = snapshot.records.map(r => recordEvidence(r))
    const draftPages: string[] = []
    let cursor: string | undefined
    do {
      const page = evidencePage(evidence, snapshot.fingerprint, "benchmark", cursor)
      draftPages.push(JSON.stringify(page)); cursor = page.next
    } while (cursor)
    // Controlled oracle summary, NOT an AI semantic-quality experiment.
    const summary = [...constraints].map(([id, text]) => ({ text: `${text} Validation adds latency; retain contract tests and bounded deadlines.`, sources: [id] }))
    for (const change of planPublication(dir, snapshot, summary)) atomicWrite(dir, change.path, change.after!)
    const pages: EvidencePage[] = []
    do {
      const page = queryAdrContext(dir, { domain: "service-0", cursor })
      if (Array.from(JSON.stringify(page)).length > CONTEXT_BUDGET) throw new Error("Response budget regression")
      pages.push(page); cursor = page.next
    } while (cursor)
    const needed = snapshot.records.filter(r => r.domain === "service-0" || r.layer === "system")
    const currentText = pages.map(p => p.entries.map(e => e.excerpt).join("\n")).join("\n")
    const recalled = needed.filter(r => currentText.includes(constraints.get(r.id)!)).length
    const legacy = buildAdrContext(snapshot.records, { kind: "domain", value: "service-0" })!
    output.push({ count, draftPages, summary: JSON.stringify(summary),
      raw: snapshot.records.map(r => r.rawContent).join("\n"),
      targetedBaseline: renderAdrContext(legacy) + "\n" + needed.map(r => r.rawContent).join("\n"),
      warmPages: pages.map(p => JSON.stringify(p)),
      recalled, needed: needed.length, maxPageCharacters: Math.max(...pages.map(p => Array.from(JSON.stringify(p)).length)),
    })
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
console.log(JSON.stringify(output))
