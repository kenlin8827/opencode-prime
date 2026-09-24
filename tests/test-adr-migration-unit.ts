/**
 * Multi-style ADL — Phase 5: Explicit migration and documentation (§13).
 *
 * Coverage (§13 acceptance + §14 integration check 10):
 *   - style audit: `/adr check --report-style` reports every document's
 *     resolved style incl. the `legacy` flag (Phase 1 style-less files
 *     dispatch to madr and are reported, never silently rewritten)
 *   - migration dry-run reports: source path, destination path, frozen
 *     record-ID mapping, link-rewrite list, and unconvertible-content
 *     warnings (MADR-only sections dropped for nygard; empty additions
 *     for nygard→madr) — deterministic (same input → same report bytes)
 *   - dry-run NEVER writes; `--confirm` writes only the declared paths
 *   - written results re-parse as the target style, pass the target
 *     adapter's validation, and keep the ADL integrity check error-free
 *   - `date`/`created` are preserved verbatim (a style conversion is not
 *     a status change); IDs are frozen (§9.5 rule 3)
 *
 * Run: bun run tests/test-adr-migration-unit.ts
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { setProjectDir } from "../plugins/adr/adr-config"
import { checkAdrIntegrity, getAllAdrs } from "../plugins/adr/adr-engine"
import {
  auditAdrStyles,
  EN_MIGRATION_LABELS,
  executeAdrStyleMigration,
  planAdrStyleMigration,
  renderMigrationReport,
  rewriteStyleFrontmatter,
} from "../plugins/adr/adr-migration"
import { resolveDocumentAdapter } from "../plugins/adr/adr-style-registry"
import { extractFrontmatter } from "../plugins/adr/adr-types"
import { makeCommandHandler } from "../plugins/adr/adr-command"

const FIXTURES = join(import.meta.dir, "fixtures", "adr")
const LEGACY_FIXTURE = join(FIXTURES, "legacy")
const NYGARD_FIXTURE = join(FIXTURES, "nygard")
const MIXED_FIXTURE = join(FIXTURES, "mixed-adl")

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
  const dir = mkdtempSync(join(tmpdir(), `adr-mig-${tag}-`))
  setProjectDir(dir)
  mkdirSync(join(dir, ".ocp"), { recursive: true })
  writeFileSync(join(dir, ".ocp", "ocp.json"), `${JSON.stringify({ adrLayout: "hierarchical" }, null, 2)}\n`, "utf-8")
  return dir
}

function sandboxWith(tag: string, fixture: string): string {
  const sandbox = makeSandbox(tag)
  cpSync(fixture, join(sandbox, "docs", "adr"), { recursive: true })
  return sandbox
}

/** Snapshot every file under root (rel path → bytes) for no-write proofs. */
function snapshot(root: string): Map<string, string> {
  const map = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else map.set(full.replace(/\\/g, "/"), readFileSync(full, "utf-8"))
    }
  }
  walk(root)
  return map
}

function snapshotsEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false
  }
  return true
}

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

// ═════════════════════════════════════════════════════════════════════════
//  01. Style audit — auditAdrStyles + --report-style
// ═════════════════════════════════════════════════════════════════════════

function test01_StyleAudit() {
  section("01: style audit — resolved style + legacy flag")
  const sandbox = sandboxWith("audit", LEGACY_FIXTURE)
  try {
    const audit = auditAdrStyles(sandbox)
    assert(audit.length === 2, `legacy fixture yields 2 audit entries (got ${audit.length})`)
    assert(audit.every((e) => e.isLegacy), "every style-less document is flagged legacy")
    assert(audit.every((e) => e.declaredStyle === null), "legacy documents declare no style")
    assert(audit.every((e) => e.resolvedStyle === "madr"), "legacy documents dispatch to the madr adapter (Phase 1)")
    const sorted = [...audit].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath))
    assert(
      audit.map((e) => e.sourcePath).join() === sorted.map((e) => e.sourcePath).join(),
      "audit output is deterministically sorted by source path",
    )

    const mixed = sandboxWith("auditmix", MIXED_FIXTURE)
    try {
      const mixedAudit = auditAdrStyles(mixed)
      assert(mixedAudit.length === 5, `mixed fixture yields 5 audit entries (got ${mixedAudit.length})`)
      assert(mixedAudit.every((e) => !e.isLegacy), "declared-style documents are not flagged legacy")
      const nygardCount = mixedAudit.filter((e) => e.resolvedStyle === "nygard").length
      assert(nygardCount === 3, `mixed fixture resolves 3 nygard documents (got ${nygardCount})`)
    } finally {
      rmSync(mixed, { recursive: true, force: true })
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  02. Migration plan — dry-run report content
// ═════════════════════════════════════════════════════════════════════════

function test02_PlanReports() {
  section("02: migration plan — source/destination/ID/links/warnings")
  const sandbox = sandboxWith("plan", LEGACY_FIXTURE)
  try {
    // legacy → madr: grammar identical, only the style declaration is added.
    const toMadr = planAdrStyleMigration(sandbox, "madr")
    assert(toMadr.records.length === 2, `legacy→madr plans 2 records (got ${toMadr.records.length})`)
    assert(toMadr.skippedPaths.length === 0, "no skipped records when nothing declares the target style")
    assert(toMadr.records.every((r) => r.frontmatterOnly), "legacy→madr is frontmatter-only (madr grammar already)")
    assert(toMadr.records.every((r) => r.destinationPath === r.sourcePath), "destination path equals source path")
    assert(
      toMadr.records.map((r) => r.id).join() === "ADR-0001,ADR-0002",
      "record-ID mapping is frozen (ADR-0001, ADR-0002)",
    )
    assert(toMadr.records.every((r) => r.linkRewrites.length === 0), "link-rewrite list empty when no paths move")
    assert(
      toMadr.records.every((r) => r.warnings.length === 0),
      "no unconvertible-content warnings for a grammar-identical conversion",
    )

    // ocp is not a conversion target: the container grammar (namespace +
    // section payload) is not reachable by per-file conversion.
    let ocpThrew = false
    try {
      planAdrStyleMigration(sandbox, "ocp")
    } catch {
      ocpThrew = true
    }
    assert(ocpThrew, "planAdrStyleMigration throws for target style 'ocp'")

    // legacy → nygard: MADR-only optional sections warn as dropped content.
    const toNygard = planAdrStyleMigration(sandbox, "nygard")
    const rec1 = toNygard.records.find((r) => r.id === "ADR-0001")
    const rec2 = toNygard.records.find((r) => r.id === "ADR-0002")
    assert(!!rec1 && !!rec2, "both records planned for nygard conversion")
    assert(rec1?.frontmatterOnly === false, "madr→nygard rebuilds the body")
    const dropped = (rec1?.warnings ?? []).filter((w) => w.kind === "dropped-section").map((w) => w.section)
    assert(
      dropped.includes("Decision Drivers") && dropped.includes("Considered Options"),
      `ADR-0001 warns that Decision Drivers & Considered Options content would be dropped (got ${JSON.stringify(dropped)})`,
    )
    assert(
      (rec2?.warnings ?? []).every((w) => w.kind !== "dropped-section"),
      "lean record ADR-0002 has no MADR-only section content to lose",
    )
    // The path-form parent reference resolves; with no rename there is no rewrite.
    assert(
      rec2?.linkRewrites.length === 0,
      "path-form parent reference produces no rewrite while filenames stay unchanged",
    )

    // nygard → madr (system layer): nothing lost; empty sections added.
    const nySandbox = sandboxWith("planny", NYGARD_FIXTURE)
    try {
      const toMadrFromNygard = planAdrStyleMigration(nySandbox, "madr")
      assert(toMadrFromNygard.records.length === 1, "nygard fixture plans 1 record")
      const added = toMadrFromNygard.records[0]?.warnings.filter((w) => w.kind === "empty-additions") ?? []
      assert(
        added.length === 1 && (added[0]?.sections ?? []).includes("Considered Options"),
        "system-layer nygard→madr notes the empty section additions (no content lost)",
      )
      assert(
        toMadrFromNygard.records[0]?.warnings.every((w) => w.kind !== "dropped-section"),
        "nygard→madr never reports dropped content",
      )
    } finally {
      rmSync(nySandbox, { recursive: true, force: true })
    }

    // Mixed ADL: only the opposite-style records are planned; same-style skipped.
    const mixedSandbox = sandboxWith("planmix", MIXED_FIXTURE)
    try {
      const mixedPlan = planAdrStyleMigration(mixedSandbox, "madr")
      assert(mixedPlan.records.length === 3, `mixed→madr plans the 3 nygard records (got ${mixedPlan.records.length})`)
      assert(mixedPlan.skippedPaths.length === 2, `mixed→madr skips the 2 madr records (got ${mixedPlan.skippedPaths.length})`)
    } finally {
      rmSync(mixedSandbox, { recursive: true, force: true })
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  03. Determinism — same input → same report bytes
// ═════════════════════════════════════════════════════════════════════════

function test03_Determinism() {
  section("03: dry-run report determinism")
  const sandbox = sandboxWith("det", LEGACY_FIXTURE)
  try {
    const renderA = renderMigrationReport(planAdrStyleMigration(sandbox, "nygard"), EN_MIGRATION_LABELS)
    const renderB = renderMigrationReport(planAdrStyleMigration(sandbox, "nygard"), EN_MIGRATION_LABELS)
    assert(renderA === renderB, "two plans of the same ADL render byte-identical reports")
    assert(renderA.length > 0, "report is non-empty")
    assert(
      renderA.includes("ADR-0001") && renderA.includes("Source:") && renderA.includes("Destination:"),
      "report contains per-record source and destination paths",
    )
    assert(renderA.includes("Record ID:"), "report contains the record-ID mapping")
    assert(renderA.includes("Decision Drivers"), "report names the unconvertible MADR-only sections")
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  04. Dry-run NEVER writes (module level + command level)
// ═════════════════════════════════════════════════════════════════════════

async function test04_DryRunNoWrite() {
  section("04: dry-run writes nothing")
  const sandbox = sandboxWith("dryrun", LEGACY_FIXTURE)
  try {
    const before = snapshot(sandbox)
    const plan = planAdrStyleMigration(sandbox, "nygard")
    renderMigrationReport(plan, EN_MIGRATION_LABELS)
    assert(snapshotsEqual(before, snapshot(sandbox)), "plan + render leave every file byte-identical")

    const { toasts, run } = makeHookSink()
    await run("migrate --to nygard")
    const toast = toasts[toasts.length - 1] ?? ""
    assert(/dry-run|未写入任何文件/.test(toast), "command dry-run announces the preview")
    assert(
      toast.includes("ADR-0001") && toast.includes("Decision Drivers"),
      "command dry-run report carries per-record paths and drop warnings",
    )
    assert(
      /migrate --to nygard --confirm/.test(toast),
      "command dry-run prints the exact --confirm command needed to execute",
    )
    assert(snapshotsEqual(before, snapshot(sandbox)), "command dry-run (no --confirm) writes nothing")
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  05. Confirm path — writes only declared paths, verifies the result
// ═════════════════════════════════════════════════════════════════════════

function test05_ExecuteAndVerify() {
  section("05: confirm writes + post-migration verification")
  const sandbox = sandboxWith("exec", LEGACY_FIXTURE)
  try {
    const before = snapshot(sandbox)
    const plan = planAdrStyleMigration(sandbox, "nygard")
    const result = executeAdrStyleMigration(sandbox, plan)

    assert(result.verification.ok, `verification passes (issues: ${JSON.stringify(result.verification.issues)})`)
    assert(
      result.written.join() === plan.records.map((r) => r.destinationPath).join(),
      "execute writes exactly the declared destination paths — nothing else",
    )

    // Every written file re-parses as the target style and validates clean.
    for (const rec of plan.records) {
      const raw = readFileSync(join(sandbox, rec.sourcePath), "utf-8")
      const document = {
        fullPath: join(sandbox, rec.sourcePath),
        relPath: rec.sourcePath,
        filename: rec.sourcePath.split("/").pop() ?? "",
        rawContent: raw,
        frontmatter: extractFrontmatter(raw),
      }
      const { adapter, declaredStyle } = resolveDocumentAdapter(document)
      assert(declaredStyle === "nygard", `${rec.id} re-parses with declared style nygard`)
      assert(adapter.style === "nygard", `${rec.id} dispatches to the nygard adapter after conversion`)
      const issues = adapter.validate(document, adapter.parse(document))
      assert(issues.filter((i) => i.severity === "error").length === 0, `${rec.id} passes nygard validation`)
    }

    const integrityErrors = checkAdrIntegrity(sandbox).filter((i) => i.severity === "error")
    assert(integrityErrors.length === 0, "ADL integrity check passes after conversion")

    // IDs frozen: filenames unchanged; only declared paths differ from the snapshot.
    const after = snapshot(sandbox)
    const changed = [...after.keys()].filter((k) => before.get(k) !== after.get(k))
    assert(
      changed.length === plan.records.length && changed.every((k) => k.endsWith(".md") && !k.endsWith("INDEX.md")),
      "only the declared ADR documents changed — IDs/filenames frozen (§9.5 rule 3)",
    )

    // Semantic content mapped; MADR-only sections dropped as warned.
    const rec1Raw = after.get(join(sandbox, "docs/adr/0001-event-driven-sync.md").replace(/\\/g, "/")) ?? ""
    assert(/^## Context$/m.test(rec1Raw) && /^## Decision$/m.test(rec1Raw) && /^## Consequences$/m.test(rec1Raw), "converted body carries the 3 canonical Nygard sections")
    assert(
      rec1Raw.includes("partition tolerance outweighs the consistency window"),
      "Decision Outcome substance survives in ## Decision",
    )
    assert(
      !rec1Raw.includes("Two-phase commit") && !rec1Raw.includes("Decision Drivers"),
      "warned MADR-only section content is dropped from the nygard body",
    )
    assert(rec1Raw.includes("reconciliation jobs must be built and monitored"), "Consequences substance survives")

    // date/created preserved verbatim — a style conversion is not a status change.
    const fm1 = extractFrontmatter(rec1Raw)
    assert(fm1["date"] === "2026-09-01", `date preserved as-is (got ${fm1["date"]})`)
    assert(fm1["status"] === "accepted", "status preserved")
    const fm2 = extractFrontmatter(after.get(join(sandbox, "docs/adr/0002-idempotent-consumers.md").replace(/\\/g, "/")) ?? "")
    assert(fm2["parent"] === "docs/adr/0001-event-driven-sync.md", "path-form parent reference preserved verbatim")
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  06. Nygard → madr execution
// ═════════════════════════════════════════════════════════════════════════

function test06_NygardToMadr() {
  section("06: nygard → madr conversion")
  const sandbox = sandboxWith("ny2madr", NYGARD_FIXTURE)
  try {
    const plan = planAdrStyleMigration(sandbox, "madr")
    const result = executeAdrStyleMigration(sandbox, plan)
    assert(result.verification.ok, "nygard→madr verification passes")

    const raw = readFileSync(join(sandbox, "docs/adr/0001-use-postgresql.md"), "utf-8")
    const fm = extractFrontmatter(raw)
    assert(fm["style"] === "madr", "style frontmatter written")
    assert(fm["date"] === "2026-09-02" && fm["created"] === "2026-09-02", "date and created preserved")
    assert(/^## Context and Problem Statement$/m.test(raw), "Context mapped to MADR canonical heading")
    assert(/^## Decision Outcome$/m.test(raw), "Decision mapped to Decision Outcome")
    assert(/^### Consequences$/m.test(raw), "Consequences mapped to the MADR H3 subsection")
    assert(/^## Considered Options$/m.test(raw) && /^## Decision Drivers$/m.test(raw), "system-layer empty additions present")
    assert(
      raw.includes("Adopt PostgreSQL as the single primary store") && raw.includes("Strong transactional guarantees"),
      "all Nygard section content survives (nothing lost)",
    )
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  07. Frontmatter rewrite helper
// ═════════════════════════════════════════════════════════════════════════

function test07_FrontmatterRewrite() {
  section("07: rewriteStyleFrontmatter — order & verbatim preservation")
  const withStyle = rewriteStyleFrontmatter("---\nstyle: madr\nstatus: accepted\ndate: 2026-09-01\n---\n\n# 0001. X\n", "nygard")
  assert(withStyle.startsWith("---\nstyle: nygard\nstatus: accepted"), "existing style line replaced in place")
  const withoutStyle = rewriteStyleFrontmatter("---\nstatus: proposed\ndate: 2026-09-10\n---\n\n# 0002. Y\n", "madr")
  assert(withoutStyle.startsWith("---\nstyle: madr\nstatus: proposed"), "missing style line inserted at the top")
  assert(withoutStyle.includes("# 0002. Y"), "body untouched by frontmatter rewrite")
}

// ═════════════════════════════════════════════════════════════════════════
//  08. Command layer — --confirm gate, invalid style, --report-style
// ═════════════════════════════════════════════════════════════════════════

async function test08_Commands() {
  section("08: command layer — confirm gate + report-style")
  const sandbox = sandboxWith("cmd", LEGACY_FIXTURE)
  try {
    const { toasts, run } = makeHookSink()

    await run("migrate --to bogus")
    assert(/Unknown ADR style|未知的 ADR 样式/.test(toasts[toasts.length - 1] ?? ""), "unknown target style rejected")

    // --confirm executes; the toast reports converted paths.
    await run("migrate --to nygard --confirm")
    const doneToast = toasts[toasts.length - 1] ?? ""
    assert(
      /Completed|完成/.test(doneToast) && doneToast.includes("0001-event-driven-sync.md"),
      "confirm toast lists the converted documents",
    )
    const raw = readFileSync(join(sandbox, "docs/adr/0001-event-driven-sync.md"), "utf-8")
    assert(extractFrontmatter(raw)["style"] === "nygard", "confirm path actually converted the document")

    // Idempotent second run: everything already nygard.
    await run("migrate --to nygard --confirm")
    assert(/nothing to convert|无需转换/.test(toasts[toasts.length - 1] ?? ""), "re-running on a converted ADL is a no-op")

    // --report-style on a converted ADL: no legacy left.
    await run("check --report-style")
    const styleToast = toasts[toasts.length - 1] ?? ""
    assert(/Style Report|样式报告/.test(styleToast), "check --report-style renders the audit")
    assert(!/\| `madr` \| (yes|是)/.test(styleToast), "converted ADL reports zero legacy documents")
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }

  // Fresh legacy sandbox: --report-style flags both documents as legacy.
  const sandbox2 = sandboxWith("cmd2", LEGACY_FIXTURE)
  try {
    const { toasts, run } = makeHookSink()
    await run("check --report-style")
    const toast = toasts[toasts.length - 1] ?? ""
    assert(toast.includes("0001-event-driven-sync.md") && toast.includes("0002-idempotent-consumers.md"), "style report lists every document")
    const legacyRowCount = (toast.match(/\| `madr` \| (yes|是)/g) ?? []).length
    assert(legacyRowCount === 2, `both legacy documents flagged (got ${legacyRowCount})`)
  } finally {
    rmSync(sandbox2, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════

async function main() {
  test01_StyleAudit()
  test02_PlanReports()
  test03_Determinism()
  await test04_DryRunNoWrite()
  test05_ExecuteAndVerify()
  test06_NygardToMadr()
  test07_FrontmatterRewrite()
  await test08_Commands()

  console.log(`\n${"═".repeat(60)}`)
  console.log(`  RESULT: ${passed} passed, ${failed} failed`)
  console.log(`${"═".repeat(60)}`)
  if (failed > 0) process.exit(1)
}

await main()
