/**
 * Multi-style ADL — Phase 4: Multi-view ADL & AI context recovery
 * (§9.1 progressive disclosure, §9.3 indexes, §9.4 tree/history/context).
 *
 * Coverage (§13 Phase 4 acceptance + §14 integration checks):
 *   - one fixture project with BOTH styles (madr + nygard, nested dirs)
 *     produces deterministic index / tree / history / context output
 *     (generation run twice → identical bytes)
 *   - root + nested INDEX.md mirror the fixture directory structure;
 *     local indexes list ONLY their own records (no unrelated descendants)
 *   - `/adr tree --by path|layer|domain|iteration` deterministic logical views
 *   - `/adr history <ADR-ID>` traverses the cross-style supersession chain
 *   - bounded `/adr context` for ID / domain / iteration targets: selected
 *     records + direct relations only, retrieval path disclosed, never the
 *     full corpus
 *   - physical flat / hierarchical layout behavior independent of style
 *   - fixture purity: no non-canonical headings, no emoji, no hand-maintained
 *     quick-reference sections
 *
 * Run: bun run tests/test-adr-adl-integration.ts
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { setProjectDir } from "../plugins/adr/adr-config"
import {
  checkAdrIntegrity,
  createAdr,
  getAllAdrs,
  getNormalizedAdrs,
  regenerateAdlIndexes,
  updateAdrIndex,
} from "../plugins/adr/adr-engine"
import type { NormalizedAdrRecord } from "../plugins/adr/adr-types"
import {
  ADR_TREE_GROUP_BY,
  buildAdrContext,
  buildAdrHistory,
  renderAdrContext,
  renderAdrHistory,
  renderTreeView,
} from "../plugins/adr/adr-views"
import { makeCommandHandler } from "../plugins/adr/adr-command"

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "adr", "mixed-adl")

const FIXTURE_IDS = ["ADR-0001", "ADR-0002", "ADR-0003", "ADR-0004", "ADR-0005"]
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u

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
  const dir = mkdtempSync(join(tmpdir(), `adr-adl-${tag}-`))
  setProjectDir(dir)
  return dir
}

/** Copy the mixed-style fixtures into <sandbox>/docs/adr and config there. */
function sandboxWithFixtures(tag: string, layout: "hierarchical" | "auto" | "flat" = "hierarchical"): string {
  const sandbox = makeSandbox(tag)
  cpSync(FIXTURE_DIR, join(sandbox, "docs", "adr"), { recursive: true })
  mkdirSync(join(sandbox, ".ocp"), { recursive: true })
  writeFileSync(join(sandbox, ".ocp", "ocp.json"), `${JSON.stringify({ adrLayout: layout }, null, 2)}\n`, "utf-8")
  return sandbox
}

function fixtureRecords(sandbox: string): NormalizedAdrRecord[] {
  return getNormalizedAdrs(sandbox)
}

// ═════════════════════════════════════════════════════════════════════════
//  00. Fixture sanity: one record per file, mixed styles, clean integrity
// ═════════════════════════════════════════════════════════════════════════

function test00_FixtureDiscovery() {
  section("00: mixed-style fixture discovery (hierarchical + flat)")
  const sandbox = sandboxWithFixtures("discovery")
  try {
    const records = fixtureRecords(sandbox)
    assert(records.length === 5, `fixture ADL parses 5 records (got ${records.length})`)
    for (const id of FIXTURE_IDS) {
      assert(records.some((r) => r.id === id), `${id} discovered`)
    }
    assert(records.find((r) => r.id === "ADR-0001")?.style === "madr", "root record is madr")
    assert(records.find((r) => r.id === "ADR-0002")?.style === "nygard", "commission predecessor is nygard")
    assert(records.find((r) => r.id === "ADR-0003")?.style === "madr", "commission successor is madr")
    assert(records.find((r) => r.id === "ADR-0005")?.style === "nygard", "billing record is nygard")

    // Normalized relationships across styles (§9.5 rule 4)
    const successor = records.find((r) => r.id === "ADR-0003")
    assert(successor?.supersedes.includes("ADR-0002"), "madr successor carries normalized nygard ID in supersedes")
    const predecessor = records.find((r) => r.id === "ADR-0002")
    assert(predecessor?.supersededBy.includes("ADR-0003"), "nygard predecessor resolves madr successor from status line")
    assert(successor?.parentIds.includes("ADR-0001"), "parent reference resolves by ID across directories")

    const issues = checkAdrIntegrity(sandbox)
    assert(issues.length === 0, `fixture ADL passes integrity with zero issues (got ${issues.length}: ${issues.map((i) => i.message).join(" | ")})`)

    // Flat layout: discovery is restricted to the root, regardless of style.
    const flatSandbox = sandboxWithFixtures("flat-discovery", "flat")
    try {
      const flatRecords = fixtureRecords(flatSandbox)
      assert(flatRecords.length === 1 && flatRecords[0]?.id === "ADR-0001", "flat mode discovers only root records (style-independent)")
    } finally {
      rmSync(flatSandbox, { recursive: true, force: true })
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  01. Generated index tree (§9.3): root + local indexes, idempotent
// ═════════════════════════════════════════════════════════════════════════

function test01_IndexTree() {
  section("01: generated INDEX.md tree mirrors the ADR directory structure")
  const sandbox = sandboxWithFixtures("index")
  try {
    const written = regenerateAdlIndexes(sandbox)
    const expected = [
      "docs/adr/INDEX.md",
      "docs/adr/domains/commission/INDEX.md",
      "docs/adr/domains/billing/INDEX.md",
    ]
    for (const rel of expected) {
      assert(written.includes(rel), `regenerateAdlIndexes writes ${rel}`)
      assert(existsSync(join(sandbox, rel)), `${rel} exists on disk`)
    }
    // `domains/` itself holds no records → no index there (§9.3)
    assert(!existsSync(join(sandbox, "docs/adr/domains/INDEX.md")), "intermediate directory without records gets no INDEX.md")

    // ── Root index: global/system records first + child scope summaries ──
    const root = readFileSync(join(sandbox, "docs/adr/INDEX.md"), "utf-8")
    assert(root.includes("GENERATED INDEX — DO NOT EDIT BY HAND"), "root index states it is generated, not hand-edited")
    assert(root.includes("`docs/adr`"), "root index names its directory")
    assert(root.includes("[ADR-0001](./0001-use-postgresql.md)"), "root index lists the global record with a style-aware link")
    assert(!root.includes("[ADR-0002]") && !root.includes("[ADR-0005]"), "root index does NOT flatten nested records")
    assert(root.includes("`madr`"), "root index row carries the style column")
    assert(root.includes("domains/commission") && root.includes("domains/billing"), "root index summarizes both child scopes")
    const commissionSummary = /domains\/commission.*\| (\d+) \|/.exec(root)
    assert(commissionSummary?.[1] === "3", `child scope summary counts 3 commission records (got ${commissionSummary?.[1]})`)

    // ── Local index: direct records only, parent link, no unrelated data ──
    const commission = readFileSync(join(sandbox, "docs/adr/domains/commission/INDEX.md"), "utf-8")
    assert(commission.includes("[ADR-0002]") && commission.includes("[ADR-0003]") && commission.includes("[ADR-0004]"), "commission index lists its 3 direct records")
    assert(!commission.includes("[ADR-0001]"), "commission index does NOT duplicate the root record")
    assert(!commission.includes("[ADR-0005]"), "commission index does NOT duplicate the unrelated billing descendant's sibling")
    assert(commission.includes("[docs/adr](../../INDEX.md)"), "commission index carries a parent link to the root index")
    assert(commission.includes("`nygard`") && commission.includes("`madr`"), "commission index mixes both styles in one table")
    assert(commission.includes("0.2.61") && commission.includes("commission") && commission.includes("audit"), "commission index rows expose iteration + domain columns")

    const billing = readFileSync(join(sandbox, "docs/adr/domains/billing/INDEX.md"), "utf-8")
    assert(billing.includes("[ADR-0005]") && !billing.includes("[ADR-0002]"), "billing index lists only its own record")
    assert(billing.includes("[docs/adr](../../INDEX.md)"), "billing index carries a parent link")

    // ── Idempotency: regenerate + single-dir update → identical bytes ──
    regenerateAdlIndexes(sandbox)
    const root2 = readFileSync(join(sandbox, "docs/adr/INDEX.md"), "utf-8")
    assert(root2 === root, "second regenerateAdlIndexes run is byte-identical")
    updateAdrIndex(sandbox, "docs/adr/domains/commission")
    const commission2 = readFileSync(join(sandbox, "docs/adr/domains/commission/INDEX.md"), "utf-8")
    assert(commission2 === commission, "updateAdrIndex regeneration is byte-identical (idempotent)")

    // ── Generated indexes are never discovered as records ──
    const discovered = getAllAdrs(sandbox).map((a) => a.filename)
    assert(!discovered.some((f) => f === "INDEX.md"), "generated INDEX.md files are not ADR records")
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  02. Layout independence: flat ADL with mixed styles (§13 Phase 4 task 6)
// ═════════════════════════════════════════════════════════════════════════

function test02_FlatMixedStyle() {
  section("02: flat layout behaves the same for every style")
    const sandbox = makeSandbox("flat-mixed")
  try {
    mkdirSync(join(sandbox, ".ocp"), { recursive: true })
    writeFileSync(join(sandbox, ".ocp", "ocp.json"), `{\n  "adrLayout": "flat"\n}\n`, "utf-8")
    const ny = createAdr({ projectDir: sandbox, title: "Use PostgreSQL", targetDir: "docs/adr", style: "nygard" })
    const ma = createAdr({ projectDir: sandbox, title: "Adopt Outbox", targetDir: "docs/adr", style: "madr" })
    assert(ny.id === "0001" && ma.id === "0002", "flat global counter is style-agnostic")

    const written = regenerateAdlIndexes(sandbox)
    assert(written.length === 1 && written[0] === "docs/adr/INDEX.md", "flat layout generates exactly the root index")
    const index = readFileSync(join(sandbox, "docs/adr/INDEX.md"), "utf-8")
    assert(index.includes("[ADR-0001]") && index.includes("[ADR-0002]"), "flat index lists both styles")
    assert(index.includes("`nygard`") && index.includes("`madr`"), "flat index rows carry style labels")

    const byLayer = renderTreeView(getNormalizedAdrs(sandbox), "docs/adr", "layer")
    assert(byLayer.includes("ADR-0001") && byLayer.includes("ADR-0002"), "flat tree view covers both styles")

    const issues = checkAdrIntegrity(sandbox)
    assert(issues.length === 0, `flat mixed-style ADL integrity clean (got ${issues.length})`)
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  03. Tree views (§9.4): deterministic `--by path|layer|domain|iteration`
// ═════════════════════════════════════════════════════════════════════════

function test03_TreeViews() {
  section("03: tree --by logical views are deterministic")
  const sandbox = sandboxWithFixtures("tree")
  try {
    const records = fixtureRecords(sandbox)

    for (const by of ADR_TREE_GROUP_BY) {
      const a = renderTreeView(records, "docs/adr", by)
      const b = renderTreeView(fixtureRecords(sandbox), "docs/adr", by)
      assert(a === b, `tree --by ${by} renders byte-identical across runs`)
      assert(a.includes("ADR-0001") && a.includes("ADR-0005"), `tree --by ${by} covers all 5 records`)
    }

    const byPath = renderTreeView(records, "docs/adr", "path")
    assert(byPath.includes("docs/adr/ (1 record)"), "path view shows root dir with its direct record")
    assert(byPath.includes("docs/adr/domains/commission/ (3 records)"), "path view shows commission dir with 3 records")
    assert(byPath.indexOf("docs/adr/domains/billing") < byPath.indexOf("docs/adr/domains/commission"), "path view orders child dirs deterministically (alphabetical)")

    const byLayer = renderTreeView(records, "docs/adr", "layer")
    assert(byLayer.includes("#### system (1)") && byLayer.includes("#### domain (4)"), "layer view groups system + domain")
    assert(byLayer.indexOf("#### system") < byLayer.indexOf("#### domain"), "layer view orders coarse-to-fine (system first)")

    const byDomain = renderTreeView(records, "docs/adr", "domain")
    assert(byDomain.includes("`audit`") && byDomain.includes("`billing`") && byDomain.includes("`commission`"), "domain view groups by domain metadata")
    assert(byDomain.indexOf("`audit`") < byDomain.indexOf("`billing`"), "domain groups sort alphabetically")
    assert(byDomain.includes("(no domain) (1)"), "records without domain metadata fall into the trailing ungrouped section")
    assert(!byDomain.split("(no domain)")[1]?.includes("ADR-0003"), "grouped records never leak into the ungrouped section")

    const byIteration = renderTreeView(records, "docs/adr", "iteration")
    assert(byIteration.includes("Iteration `0.2.54` (1)") && byIteration.includes("Iteration `0.2.61` (2)"), "iteration view groups by metadata (not ID parsing)")
    assert(byIteration.indexOf("`0.2.54`") < byIteration.indexOf("`0.2.61`"), "iteration groups order numerically-aware")
    assert(byIteration.includes("No iteration metadata (2)"), "records without iteration metadata fall into the trailing group")
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  04. History traversal (§9.4): cross-style supersession chain
// ═════════════════════════════════════════════════════════════════════════

function test04_History() {
  section("04: history traverses the normalized cross-style chain")
  const sandbox = sandboxWithFixtures("history")
  try {
    const records = fixtureRecords(sandbox)

    // Backward from the successor: reaches the nygard predecessor.
    const backward = buildAdrHistory(records, "ADR-0003")
    assert(backward !== null, "history resolves an ID-form reference")
    assert(backward?.entries.length === 2, `chain has predecessor + target (got ${backward?.entries.length})`)
    assert(backward?.entries[0]?.record.id === "ADR-0002" && backward?.entries[0]?.relation === "predecessor", "predecessor is ADR-0002 (nygard)")
    assert(backward?.entries[1]?.record.id === "ADR-0003" && backward?.entries[1]?.relation === "target", "target ADR-0003 is marked")
    assert((backward?.unresolved.length ?? 1) === 0, "no unresolved edges in the fixture chain")

    // Forward from the predecessor: reaches the madr successor.
    const forward = buildAdrHistory(records, "0002")
    assert(forward?.entries.some((e) => e.relation === "successor" && e.record.id === "ADR-0003"), "forward traversal finds the madr successor from a bare ID")
    assert(forward?.entries[0]?.relation === "target", "chronological chain starts at the target when it has no predecessors")

    // Unrelated records stay out of the chain.
    assert(!backward?.entries.some((e) => e.record.id === "ADR-0005"), "history does not include unrelated records")

    // Determinism + rendering
    const renderA = renderAdrHistory(buildAdrHistory(records, "ADR-0003")!)
    const renderB = renderAdrHistory(buildAdrHistory(fixtureRecords(sandbox), "ADR-0003")!)
    assert(renderA === renderB, "history rendering is byte-deterministic")
    assert(renderA.includes("ADR-0002") && renderA.includes("ADR-0003") && renderA.includes("← target"), "history render shows the chain and marks the target")

    // Unknown reference → null
    assert(buildAdrHistory(records, "ADR-9999") === null, "unknown ID resolves to null")
    assert(buildAdrHistory(records, "docs/adr/domains/billing/0005-stripe-webhooks.md") !== null, "source-path reference resolves")
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  05. Bounded context (§9.1): ID / domain / iteration targets
// ═════════════════════════════════════════════════════════════════════════

function test05_Context() {
  section("05: bounded context bundles disclose the retrieval path")
  const sandbox = sandboxWithFixtures("context")
  try {
    const records = fixtureRecords(sandbox)

    // ── ID target: target + direct parent + supersession + same-iteration ──
    const byId = buildAdrContext(records, { kind: "id", value: "ADR-0003" })
    assert(byId !== null, "ID context resolves")
    assert(byId?.matched.length === 1 && byId.matched[0]?.id === "ADR-0003", "ID context matches exactly the target record")
    const relatedIds = (byId?.related ?? []).map((r) => r.record.id)
    assert(relatedIds.includes("ADR-0001"), "ID context includes the direct parent (cross-directory)")
    assert(relatedIds.includes("ADR-0002"), "ID context includes the supersession predecessor (cross-style)")
    assert(relatedIds.includes("ADR-0004"), "ID context includes the same-iteration record")
    assert(!relatedIds.includes("ADR-0005"), "ID context does NOT include the unrelated billing record")
    assert((byId?.retrievalPath.length ?? 0) > 0 && byId?.retrievalPath[0]?.startsWith("index:"), "retrieval path starts with the nearest index read")
    assert(byId?.retrievalPath.some((p) => p.includes("ADR-0002")), "retrieval path discloses the supersession edge read")

    const renderedId = renderAdrContext(byId!)
    assert(renderedId.includes("Retrieval path"), "rendered context discloses the retrieval path")
    assert(renderedId.includes("**Target records (1)**"), "rendered context has a bounded target section")
    assert(renderedId.includes("constraint (accepted)") && renderedId.includes("open proposal"), "rendered context lists constraints & open proposals (§9.4 item 4)")
    assert(renderedId.includes("Bounded bundle"), "rendered context states the bundle is bounded")
    assert(!renderedId.includes("ADR-0005"), "rendered context never dumps unrelated corpus entries")

    // ── Domain target ──
    const byDomain = buildAdrContext(records, { kind: "domain", value: "commission" })
    assert(byDomain !== null && byDomain.matched.length === 2, "domain context matches the 2 commission records")
    const domainRelated = (byDomain?.related ?? []).map((r) => r.record.id)
    assert(domainRelated.includes("ADR-0002") || domainRelated.includes("ADR-0001"), "domain context deepens into direct relations")
    assert(!(byDomain?.related ?? []).some((r) => r.record.id === "ADR-0005"), "domain context excludes unrelated billing records")
    assert(byDomain?.retrievalPath[0] === "index:docs/adr/INDEX.md (ADL root index)", "domain retrieval path starts at the ADL root index")
    assert(buildAdrContext(records, { kind: "domain", value: "nonexistent" }) === null, "unknown domain → null")

    // ── Bounded: a query that would fan out stays capped ──
    const bounded = buildAdrContext(records, { kind: "id", value: "ADR-0001" }, { maxRelated: 1 })
    assert((bounded?.related.length ?? 99) <= 1, "maxRelated bound caps the related set")

    // ── Iteration selector (same algorithm as the Phase 3 bundle) ──
    const byIteration = buildAdrContext(records, { kind: "iteration", value: "0.2.61" })
    assert(byIteration !== null && byIteration.matched.length === 2, "iteration context matches both 0.2.61 records")
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  06. Fixture purity: canonical headings only, no emoji, no quick-reference
// ═════════════════════════════════════════════════════════════════════════

function test06_FixturePurity() {
  section("06: fixture output is style-pure (§13 Phase 4 acceptance)")
  const files = [
    "0001-use-postgresql.md",
    "domains/commission/0002-integer-minor-units.md",
    "domains/commission/0003-decimal-snapshots.md",
    "domains/commission/0004-audit-event-log.md",
    "domains/billing/0005-stripe-webhooks.md",
  ]
  const canonical: Record<string, string[]> = {
    madr: ["Context and Problem Statement", "Considered Options", "Decision Outcome", "Consequences"],
    nygard: ["Context", "Decision", "Consequences"],
  }
  for (const rel of files) {
    const content = readFileSync(join(FIXTURE_DIR, rel), "utf-8")
    assert(!EMOJI_RE.test(content), `${rel} contains no emoji`)
    assert(!/quick.?reference/i.test(content), `${rel} has no hand-maintained quick-reference section`)
    const style = content.includes("style: nygard") ? "nygard" : "madr"
    const headings = content
      .split(/\r?\n/)
      .filter((l) => l.startsWith("## "))
      .map((l) => l.slice(3).trim())
    for (const heading of headings) {
      assert(
        canonical[style].includes(heading),
        `${rel} heading '## ${heading}' is canonical for ${style}`,
      )
    }
    if (style === "nygard") {
      assert(headings.length === 3, `${rel} nygard body has exactly the 3 canonical sections (got ${headings.length})`)
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  07. Command layer: /adr tree --by · /adr history · /adr context
// ═════════════════════════════════════════════════════════════════════════

// V2: announce surface is shared/notify (console "[ocp:notify]..." lines;
// v1 was client.tui.showToast). makeHookSink spies console during a command
// run and collects the message texts. makeCommandHandler() consumes the
// command by RETURNING (v1's HANDLED 204-throw is gone).
function makeHookSink() {
  const toasts: string[] = []
  const hook = makeCommandHandler()
  const run = async (args: string): Promise<void> => {
    const origLog = console.log
    const origWarn = console.warn
    const spy = (orig: (...a: unknown[]) => void) => (...a: unknown[]): void => {
      const m = /\[ocp:notify\]\[\w+\]\s*([\s\S]*)/.exec(String(a[0] ?? ""))
      if (m) { toasts.push(m[1]); return }
      orig(...a)
    }
    console.log = spy(origLog)
    console.warn = spy(origWarn)
    try {
      await hook({ command: "adr", arguments: args })
    } finally {
      console.log = origLog
      console.warn = origWarn
    }
  }
  return { toasts, run }
}

async function test07_Commands() {
  section("07: command layer — tree --by / history / context")
  const sandbox = sandboxWithFixtures("cmd")
  try {
    const { toasts, run } = makeHookSink()

    await run("tree --by domain")
    const treeToast = toasts[toasts.length - 1] ?? ""
    assert(treeToast.includes("ADR tree — by domain") && treeToast.includes("`commission`"), "tree --by domain renders the deterministic view")
    await run("tree --by bogus")
    assert(/Unknown tree view|未知的树视图/.test(toasts[toasts.length - 1] ?? ""), "tree --by bogus → invalid-view toast")
    await run("tree")
    assert((toasts[toasts.length - 1] ?? "").includes("Architecture Decision Map"), "bare /adr tree keeps the legacy decision map")

    await run("history ADR-0002")
    const historyToast = toasts[toasts.length - 1] ?? ""
    assert(historyToast.includes("History — ADR-0002") && historyToast.includes("ADR-0003"), "history renders the cross-style chain")
    await run("history")
    assert(/Usage: `\/adr history|用法：`\/adr history/.test(toasts[toasts.length - 1] ?? ""), "bare /adr history → usage toast")
    await run("history ADR-9999")
    assert(/No ADR matches|没有任何 ADR 匹配/.test(toasts[toasts.length - 1] ?? ""), "unknown history target → not-found toast")

    await run("context ADR-0003")
    const ctxToast = toasts[toasts.length - 1] ?? ""
    assert(ctxToast.includes("Context — ADR-0003") && ctxToast.includes("Retrieval path"), "context by ID renders the bounded bundle")
    assert(ctxToast.includes("ADR-0002") && !ctxToast.includes("ADR-0005"), "context by ID bundles relations only, not the corpus")
    assert(existsSync(join(sandbox, "docs/adr/INDEX.md")), "context command refreshes the generated index tree")

    await run("context --domain commission")
    const domainToast = toasts[toasts.length - 1] ?? ""
    assert(domainToast.includes("Context — domain `commission`") && domainToast.includes("ADR-0003"), "context --domain renders the bounded bundle")

    await run("context --iteration 0.2.61")
    assert((toasts[toasts.length - 1] ?? "").includes("Iteration `0.2.61`"), "context --iteration keeps the Phase 3 bundle")

    await run("context --domain nonexistent")
    assert(/No records match|没有任何记录匹配/.test(toasts[toasts.length - 1] ?? ""), "unknown domain → not-found toast")

    await run("context")
    assert(/`\/adr context --iteration <id>`/.test(toasts[toasts.length - 1] ?? ""), "bare /adr context → usage toast (keeps the iteration form)")
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ─── Main entry ───────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗")
  console.log("║  Multi-style ADL — Phase 4 ADL Integration Tests         ║")
  console.log("╚══════════════════════════════════════════════════════════╝")

  const origDir = process.cwd()
  try {
    test00_FixtureDiscovery()
    test01_IndexTree()
    test02_FlatMixedStyle()
    test03_TreeViews()
    test04_History()
    test05_Context()
    test06_FixturePurity()
    await test07_Commands()
  } finally {
    setProjectDir(origDir)
  }

  console.log(`\n${"═".repeat(60)}`)
  console.log(`  Result: ${passed} passed / ${failed} failed`)
  console.log(`${"═".repeat(60)}`)
  if (failed > 0) process.exit(1)
}

await main()
