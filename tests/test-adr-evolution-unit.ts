/**
 * Multi-style ADL — Phase 3: Evolution metadata, iteration views &
 * validation profiles (§7.3 / §13).
 *
 * Coverage:
 *   - evolution frontmatter (baseline/iteration/domain) parsed & exposed
 *     on normalized records of ANY style + shape-sanity warnings
 *   - generated INDEX.by-iteration.md (metadata grouping, created→path
 *     ordering, generated-view header, idempotency, never an ADR)
 *   - cross-style reference by ID (MADR supersedes Nygard, §9.5 rule 4)
 *   - duplicate dotted IDs fail integrity checking
 *   - iteration context bundling: active records + supersession chains,
 *     bounded, with a reported retrieval path
 *   - `evolution` validation profile flags missing rejected-alternative
 *     content while default `/adr check` does not; Nygard gets only
 *     canonical-section checks (no MADR requirements forced on)
 *   - bare `/adr new` under numbering:iteration without context →
 *     sequential fallback + visible warning (§6.1 rule 8)
 *   - command layer: /adr context --iteration, /adr check --profile
 *
 * Fixtures: tests/fixtures/adr/evolution/ (copied into a sandbox docs/adr)
 *
 * Run: bun run tests/test-adr-evolution-unit.ts
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { setProjectDir } from "../plugins/adr-guard/adr-guard-config"
import { makeCommandHook } from "../plugins/adr-guard/adr-guard-command"
import {
  checkAdrIntegrity,
  createAdr,
  getAllAdrs,
  getNormalizedAdrs,
  regenerateIterationIndex,
  resolveAdrRef,
} from "../plugins/adr-guard/adr-engine"
import {
  buildIterationContext,
  byCreatedThenPath,
  checkEvolutionProfile,
  groupByIteration,
  matchesIteration,
  renderIterationContext,
  EVOLUTION_PROFILE_NAME,
  EVOLUTION_RISK_FLAG_KEY,
  EVOLUTION_RISK_FLAG_VALUE,
  type IterationContext,
} from "../plugins/adr-guard/adr-evolution"
import { renderTreeView } from "../plugins/adr-guard/adr-views"
import type { NormalizedAdrRecord } from "../plugins/adr-guard/adr-types"

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "adr", "evolution")

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
  const dir = mkdtempSync(join(tmpdir(), `adr-evo-${tag}-`))
  setProjectDir(dir)
  return dir
}

function writeAdr(dir: string, relPath: string, content: string): string {
  const full = join(dir, relPath)
  mkdirSync(join(full, ".."), { recursive: true })
  writeFileSync(full, content, "utf-8")
  return full
}

/** Copy the evolution fixtures into <sandbox>/docs/adr and chdir-config there. */
function sandboxWithFixtures(tag: string): string {
  const sandbox = makeSandbox(tag)
  cpSync(FIXTURE_DIR, join(sandbox, "docs", "adr"), { recursive: true })
  return sandbox
}

function fixtureRecords(sandbox: string): NormalizedAdrRecord[] {
  return getNormalizedAdrs(sandbox)
}

function evolutionFm(id: string, title: string, style: "madr" | "nygard", created: string, extraFm = ""): string {
  const body =
    style === "madr"
      ? `## Context and Problem Statement\n\nX\n\n## Decision Outcome\n\nY\n`
      : `## Context\n\nX\n\n## Decision\n\nY\n\n## Consequences\n\nZ\n`
  return `---\nstyle: ${style}\nstatus: accepted\ncreated: ${created}\ndate: ${created}\nlayer: system\n${extraFm}---\n\n# ${id}. ${title}\n\n${body}`
}

// ═════════════════════════════════════════════════════════════════════════
//  00. Fixture ADL sanity + evolution metadata exposure on any style
// ═════════════════════════════════════════════════════════════════════════

function test00_FixtureMetadata() {
  section("00: evolution metadata exposure (any style) + clean fixture ADL")
  const sandbox = sandboxWithFixtures("meta")
  try {
    const records = fixtureRecords(sandbox)
    assert(records.length === 4, `fixture ADL parses 4 records (got ${records.length})`)

    const nygard = records.find((r) => r.id === "ADR-0.2.54.01")
    assert(nygard?.style === "nygard", "nygard fixture record dispatches to nygard adapter")
    assert(nygard?.baseline === "0.2" && nygard?.iteration === "54", "nygard record exposes baseline/iteration (composite form)")
    assert(nygard?.domain === "commission", "nygard record exposes domain")
    assert(String(nygard?.status).includes("superseded"), "nygard fixture status line parsed")

    const madr = records.find((r) => r.id === "ADR-0.2.61.01")
    assert(madr?.style === "madr", "madr fixture record dispatches to madr adapter")
    assert(madr?.iteration === "0.2.61", "madr record exposes direct iteration metadata")
    assert(madr?.domain === "commission", "madr record exposes domain")

    const issues = checkAdrIntegrity(sandbox)
    assert(issues.length === 0, `fixture ADL passes default integrity with zero issues (got ${issues.length}: ${issues.map((i) => i.message).join(" | ")})`)

    // Scaffold wiring: /adr new --baseline/--iteration/--domain writes the keys.
    const created = createAdr({
      projectDir: sandbox,
      title: "Scaffolded evolution record",
      targetDir: "docs/adr",
      numbering: "iteration",
      baseline: "0.3",
      iteration: "70",
      domain: "billing",
      status: "accepted",
    })
    assert(created.id === "0.3.70.01", `scaffold mints dotted ID (got ${created.id})`)
    const content = readFileSync(created.fullPath, "utf-8")
    assert(content.includes('baseline: "0.3"') || content.includes("baseline: 0.3"), "scaffolded file carries baseline frontmatter")
    assert(content.includes("iteration:") && content.includes("domain:"), "scaffolded file carries iteration + domain frontmatter")
    const reloaded = fixtureRecords(sandbox).find((r) => r.id === "ADR-0.3.70.01")
    assert(reloaded?.baseline === "0.3" && reloaded?.iteration === "70" && reloaded?.domain === "billing", "normalized scaffolded record exposes all evolution metadata")
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  01. Evolution metadata shape sanity (§7.3)
// ═════════════════════════════════════════════════════════════════════════

function test01_ShapeValidation() {
  section("01: evolution metadata shape validation")
  const sandbox = makeSandbox("shape")
  try {
    writeAdr(sandbox, "docs/adr/0001-clean.md", evolutionFm("0001", "Clean", "madr", "2026-09-01", `iteration: "0.2.54"\ndomain: commission\n`))
    writeAdr(sandbox, "docs/adr/0002-bad-iteration.md", evolutionFm("0002", "Bad iteration", "nygard", "2026-09-02", `iteration: "0.2.x"\n`))
    writeAdr(sandbox, "docs/adr/0003-bad-baseline.md", evolutionFm("0003", "Bad baseline", "madr", "2026-09-03", `baseline: "v2"\niteration: "1"\n`))
    writeAdr(sandbox, "docs/adr/0004-bad-domain.md", evolutionFm("0004", "Bad domain", "nygard", "2026-09-04", `domain: "Commission Ledger"\n`))

    const issues = checkAdrIntegrity(sandbox).filter((i) => i.type === "invalid-field")
    assert(issues.length === 3, `exactly 3 invalid-field warnings (got ${issues.length})`)
    assert(issues.every((i) => i.severity === "warn"), "shape violations are warnings, not errors")
    assert(issues.some((i) => i.file.includes("0002") && i.message.includes("'iteration: 0.2.x'")), "bad iteration flagged with key + value")
    assert(issues.some((i) => i.file.includes("0003") && i.message.includes("'baseline: v2'")), "bad baseline flagged")
    assert(issues.some((i) => i.file.includes("0004") && i.message.includes("'domain: Commission Ledger'")), "bad domain flagged")
    assert(!issues.some((i) => i.file.includes("0001")), "clean evolution metadata produces no warnings")
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  02. Generated iteration view (INDEX.by-iteration.md)
// ═════════════════════════════════════════════════════════════════════════

function test02_IterationView() {
  section("02: generated INDEX.by-iteration.md")
  const sandbox = makeSandbox("view")
  try {
    // Group 0.2.54 — created-order beats path order; created tie breaks by path.
    writeAdr(sandbox, "docs/adr/0.2.54.02-zeta.md", evolutionFm("0.2.54.02", "Zeta", "madr", "2026-09-10", `baseline: "0.2"\niteration: "54"\n`))
    writeAdr(sandbox, "docs/adr/0.2.54.01-alpha.md", evolutionFm("0.2.54.01", "Alpha", "nygard", "2026-09-01", `baseline: "0.2"\niteration: "54"\n`))
    writeAdr(sandbox, "docs/adr/0.2.54.00-early.md", evolutionFm("0.2.54.00", "Early", "nygard", "2026-09-01", `baseline: "0.2"\niteration: "54"\n`))
    // Sequential ID but carrying iteration metadata → grouped by metadata, not ID (§6.1 rule 6).
    writeAdr(sandbox, "docs/adr/0007-sidecar.md", evolutionFm("0007", "Sidecar", "madr", "2026-09-05", `iteration: "54"\n`))
    // Second group.
    writeAdr(sandbox, "docs/adr/0.2.61.01-first.md", evolutionFm("0.2.61.01", "First", "nygard", "2026-09-20", `baseline: "0.2"\niteration: "61"\n`))
    // No iteration metadata → absent from the view.
    writeAdr(sandbox, "docs/adr/0008-plain.md", evolutionFm("0008", "Plain", "madr", "2026-09-21"))

    const relPath = regenerateIterationIndex(sandbox)
    assert(relPath === "docs/adr/INDEX.by-iteration.md", `returns the view path (got ${relPath})`)
    const view = readFileSync(join(sandbox, "docs/adr/INDEX.by-iteration.md"), "utf-8")
    assert(view.includes("GENERATED VIEW — DO NOT EDIT"), "header states the view is generated, not hand-edited")
    assert(view.includes("`iteration` metadata field, never ID-string parsing"), "header documents metadata-based grouping")

    // Group headers in numeric-aware order.
    const g54 = view.indexOf("## Iteration `54`")
    const g61 = view.indexOf("## Iteration `61`")
    assert(g54 !== -1 && g61 !== -1 && g54 < g61, "both iteration groups present in order")

    // Records inside group 54: created (then path) order — 0.2.54.00, 0.2.54.01, 0007, 0.2.54.02.
    const rows = view.split("\n").filter((l) => l.startsWith("| [ADR-"))
    const ids = rows.map((l) => /\[ADR-([^\]]+)\]/.exec(l)?.[1])
    assert(ids.join(",") === "0.2.54.00,0.2.54.01,0007,0.2.54.02,0.2.61.01", `view orders by created then path (got ${ids.join(",")})`)
    assert(rows[0]?.includes("`nygard`") && rows[2]?.includes("`madr`"), "rows carry style labels across styles")

    // Idempotent regeneration.
    regenerateIterationIndex(sandbox)
    const view2 = readFileSync(join(sandbox, "docs/adr/INDEX.by-iteration.md"), "utf-8")
    assert(view2 === view, "regeneration is byte-identical (idempotent)")

    // The generated view is never discovered as an ADR.
    assert(!getAllAdrs(sandbox).some((a) => a.filename === "INDEX.by-iteration.md"), "generated view is not an ADR record")

    // No iteration metadata anywhere → nothing written.
    const empty = makeSandbox("view-empty")
    try {
      writeAdr(empty, "docs/adr/0001-plain.md", evolutionFm("0001", "Plain", "madr", "2026-09-01"))
      assert(regenerateIterationIndex(empty) === null, "no iteration metadata → null, no file written")
      assert(!existsSync(join(empty, "docs/adr/INDEX.by-iteration.md")), "no file created for metadata-free ADL")
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  03. Cross-style reference by ID (§9.5 rule 4)
// ═════════════════════════════════════════════════════════════════════════

function test03_CrossStyleRef() {
  section("03: evolution record referenced by ID across styles")
  const sandbox = sandboxWithFixtures("xref")
  try {
    const records = fixtureRecords(sandbox)
    const successor = records.find((r) => r.id === "ADR-0.2.61.01")
    assert(successor?.supersedes.includes("ADR-0.2.54.01"), "MADR successor carries normalized Nygard ID in supersedes")
    assert(successor?.style === "madr", "successor is MADR")

    const predecessor = records.find((r) => r.id === "ADR-0.2.54.01")
    assert(predecessor?.style === "nygard", "predecessor is Nygard")
    assert(predecessor?.supersededBy.includes("ADR-0.2.61.01"), "Nygard predecessor resolves MADR successor ID from status line")

    const byId = resolveAdrRef("ADR-0.2.54.01", getAllAdrs(sandbox))
    assert(byId?.style === "nygard", "ID-form reference resolves across styles")
    const byBare = resolveAdrRef("0.2.54.01", getAllAdrs(sandbox))
    assert(byBare?.id === "0.2.54.01", "bare dotted ID resolves")
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  04. Duplicate dotted IDs fail integrity
// ═════════════════════════════════════════════════════════════════════════

function test04_DuplicateDottedIds() {
  section("04: duplicate IDs across files fail integrity (dotted included)")
  const sandbox = sandboxWithFixtures("dup")
  try {
    assert(!checkAdrIntegrity(sandbox).some((i) => i.type === "duplicate-id"), "fixture ADL starts duplicate-free")
    writeAdr(
      sandbox,
      "docs/adr/0.2.61.03-duplicate-stem.md",
      evolutionFm("0.2.61.03", "Duplicate stem", "madr", "2026-09-14", `iteration: "0.2.61"\n`),
    )
    const issues = checkAdrIntegrity(sandbox).filter((i) => i.type === "duplicate-id")
    assert(issues.length === 1 && issues[0].severity === "error", "duplicate dotted ID is an integrity error")
    assert(
      issues[0].message.includes("0.2.61.03") && issues[0].message.includes("0.2.61.03-event-sourced-audit.md") && issues[0].message.includes("0.2.61.03-duplicate-stem.md"),
      "error names the colliding ID and both files",
    )
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  05. Iteration context bundling (bounded, retrieval path)
// ═════════════════════════════════════════════════════════════════════════

function test05_IterationContext() {
  section("05: /adr context --iteration bundling")
  const sandbox = sandboxWithFixtures("ctx")
  try {
    const records = fixtureRecords(sandbox)

    assert(matchesIteration(records.find((r) => r.id === "ADR-0.2.54.01")!, "0.2.54"), "composite baseline.iteration matches query")
    assert(matchesIteration(records.find((r) => r.id === "ADR-0.2.61.01")!, "0.2.61"), "direct iteration metadata matches query")
    assert(!matchesIteration(records.find((r) => r.id === "ADR-0.2.61.01")!, "0.2.54"), "other iteration does not match")

    // Forward: iteration 0.2.61 bundles its 3 active records + the cross-style chain to the superseded Nygard record.
    const ctx = buildIterationContext(records, "0.2.61")
    assert(ctx.matched.length === 3, `3 records carry iteration 0.2.61 (got ${ctx.matched.length})`)
    assert(ctx.active.length === 3, "all 3 are active (none superseded)")
    const chainIds = ctx.chains.map((c) => c.record.id)
    assert(chainIds.includes("ADR-0.2.54.01"), "supersession chain reaches the superseded Nygard record")
    assert(ctx.chains.find((c) => c.record.id === "ADR-0.2.54.01")?.record.style === "nygard", "chain crosses into the nygard style")
    assert(ctx.retrievalPath.join(" ").includes("supersedes ADR-0.2.54.01"), "retrieval path reports the supersession hop")
    assert(!ctx.truncated, "fixture chain is within bounds — no truncation")

    // Reverse: querying the old iteration still surfaces the chain to its successor.
    const ctxOld = buildIterationContext(records, "0.2.54")
    assert(ctxOld.matched.length === 1 && ctxOld.active.length === 0, "superseded record is matched but not active")
    assert(ctxOld.chains.some((c) => c.record.id === "ADR-0.2.61.01"), "old iteration chains forward to the MADR successor")

    // Bounded: zero chain budget → truncated flag, no chains.
    const ctxBounded = buildIterationContext(records, "0.2.61", { maxChainRecords: 0 })
    assert(ctxBounded.chains.length === 0 && ctxBounded.truncated, "chain bound truncates output visibly")

    const rendered = renderIterationContext(ctx)
    assert(rendered.includes("Retrieval path"), "rendered bundle reports the retrieval path")
    assert(rendered.includes("**Active records (3)**"), "rendered bundle lists active records")
    assert(rendered.includes("Bounded bundle"), "rendered bundle states its bounds")
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  06. `evolution` validation profile vs default check
// ═════════════════════════════════════════════════════════════════════════

function test06_EvolutionProfile() {
  section("06: evolution profile vs default /adr check")
  const sandbox = sandboxWithFixtures("profile")
  try {
    const records = fixtureRecords(sandbox)

    // Default structural check: the under-specified record is NOT flagged.
    const defaultIssues = checkAdrIntegrity(sandbox)
    assert(defaultIssues.length === 0, "default check passes the whole fixture ADL (no findings at all)")
    assert(
      !defaultIssues.some((i) => i.file.includes("0.2.61.02")),
      "default check does NOT flag the record missing rejected-alternative content",
    )

    // Evolution profile: flags exactly the under-specified MADR record, 3 rule hits.
    const findings = checkEvolutionProfile(records)
    const flagged = findings.filter((f) => f.file.includes("0.2.61.02"))
    assert(flagged.length === 3, `evolution profile flags 0.2.61.02 three times (got ${flagged.length}: ${flagged.map((f) => f.message).join(" | ")})`)
    assert(flagged.every((f) => f.type === "profile" && f.severity === "warn"), "profile findings are typed 'profile', severity warn")
    assert(
      findings.some((f) => f.message.includes("Considered Options") && f.message.includes("no options")),
      "profile flags missing rejected-alternative content (empty Considered Options)",
    )
    assert(
      findings.some((f) => f.message.includes("Consequences") && f.message.includes("good and bad")),
      "profile flags consequences without a good/bad split",
    )
    assert(
      findings.some(
        (f) => f.message.includes(`${EVOLUTION_RISK_FLAG_KEY}: ${EVOLUTION_RISK_FLAG_VALUE}`) && f.message.includes("Confirmation"),
      ),
      `profile flags '${EVOLUTION_RISK_FLAG_KEY}: ${EVOLUTION_RISK_FLAG_VALUE}' record without Confirmation`,
    )

    // Clean records pass every profile rule.
    assert(!findings.some((f) => f.file.includes("0.2.61.01")), "complete MADR record (cons per option, split consequences, Confirmation) passes")
    assert(!findings.some((f) => f.file.includes("0.2.54.01")), "nygard record passes (no MADR requirements forced on)")
    assert(!findings.some((f) => f.file.includes("0.2.61.03")), "second nygard record passes")

    // Per-option cons rule: an option bullet without 'Cons:' is flagged.
    const noCons = makeSandbox("profile-cons")
    try {
      writeAdr(
        noCons,
        "docs/adr/0001-no-cons.md",
        `---\nstyle: madr\nstatus: accepted\ncreated: 2026-09-01\ndate: 2026-09-01\nlayer: system\n---\n\n# 0001. No cons\n\n## Context and Problem Statement\n\nX\n\n## Considered Options\n\n- **Option A**: fast but risky\n- **Option B**: slow and safe\n\n## Decision Outcome\n\nA\n\n### Consequences\n\n- **Positive**: good\n- **Negative**: bad\n`,
      )
      const consFindings = checkEvolutionProfile(getNormalizedAdrs(noCons))
      assert(consFindings.length === 2, `each option without 'Cons:' flagged (got ${consFindings.length})`)
      assert(consFindings.every((f) => f.message.includes("no cons")), "findings name the per-option cons rule")
    } finally {
      rmSync(noCons, { recursive: true, force: true })
    }

    // Nygard mapping is minimal: only EMPTY canonical sections are flagged.
    const nygardEmpty = makeSandbox("profile-nygard")
    try {
      writeAdr(
        nygardEmpty,
        "docs/adr/0001-empty-nygard.md",
        `---\nstyle: nygard\nstatus: accepted\ncreated: 2026-09-01\ndate: 2026-09-01\nlayer: system\n---\n\n# 0001. Empty consequences\n\n## Context\n\nHas content.\n\n## Decision\n\nHas content.\n\n## Consequences\n\n`,
      )
      const nygardFindings = checkEvolutionProfile(getNormalizedAdrs(nygardEmpty))
      assert(nygardFindings.length === 1 && nygardFindings[0].message.includes("## Consequences") && nygardFindings[0].message.includes("empty"), "empty Nygard section flagged")
      assert(checkAdrIntegrity(nygardEmpty).filter((i) => i.type === "profile").length === 0, "default check still carries no profile findings")
    } finally {
      rmSync(nygardEmpty, { recursive: true, force: true })
    }

    // Language parentheticals are display-only: an LLM-filled note after
    // a canonical heading must not break profile section extraction.
    const parenthetical = makeSandbox("profile-paren")
    try {
      writeAdr(
        parenthetical,
        "docs/adr/0001-parenthetical.md",
        `---\nstyle: madr\nstatus: accepted\ncreated: 2026-09-01\ndate: 2026-09-01\nlayer: system\n---\n\n# 0001. With notes\n\n## Context and Problem Statement (note)\n\nX\n\n## Considered Options (note)\n\n- **Option A**: chosen — cons: cost\n- **Option B**: rejected — cons: risk\n\n## Decision Outcome (note)\n\nA\n\n### Consequences (note)\n\n- **Positive**: good\n- **Negative**: bad\n`,
      )
      const parenFindings = checkEvolutionProfile(getNormalizedAdrs(parenthetical))
      assert(parenFindings.length === 0, `parenthetical headings pass the evolution profile (got ${parenFindings.length}: ${parenFindings.map((f) => f.message).join("; ")})`)
    } finally {
      rmSync(parenthetical, { recursive: true, force: true })
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  07. Command layer: /adr context --iteration + /adr check --profile
// ═════════════════════════════════════════════════════════════════════════

const HANDLED = Symbol("handled")

function makeHookSink() {
  const toasts: string[] = []
  const fakeClient = {
    app: { log: async () => {} },
    tui: { showToast: async (x: { body: { message: string } }) => void toasts.push(x.body.message) },
  }
  const hook = makeCommandHook(fakeClient as never, () => {
    throw HANDLED
  })
  const run = async (args: string): Promise<void> => {
    try {
      await hook({ command: "adr", arguments: args })
    } catch (e) {
      if (e !== HANDLED) throw e
    }
  }
  return { toasts, run }
}

async function test07_Commands() {
  section("07: command layer — context + check --profile")
  const sandbox = sandboxWithFixtures("cmd")
  try {
    const { toasts, run } = makeHookSink()

    await run("context --iteration 0.2.61")
    const ctxToast = toasts[toasts.length - 1] ?? ""
    assert(ctxToast.includes("Iteration `0.2.61`"), "context toast names the iteration")
    assert(ctxToast.includes("Retrieval path"), "context toast reports the retrieval path")
    assert(ctxToast.includes("ADR-0.2.54.01"), "context toast bundles the cross-style supersession chain")
    assert(existsSync(join(sandbox, "docs/adr/INDEX.by-iteration.md")), "context command refreshes the generated iteration view")

    await run("context --iteration 9.9.9")
    assert((toasts[toasts.length - 1] ?? "").includes("9.9.9"), "unknown iteration → not-found toast")

    await run("context")
    assert(/`\/adr context --iteration <id>`/.test(toasts[toasts.length - 1] ?? ""), "bare /adr context → usage toast")

    // NOTE: announce text is i18n-localized (this machine may run zh-CN);
    // assert bilingual regexes, English-only for generated artifacts.
    const RE_INTEGRITY_OK = /Integrity Check Passed|完整性检查通过/
    const RE_PROFILE_FINDINGS = /Evolution profile findings|evolution 配置文件发现/

    await run("check --profile evolution")
    const profileToast = toasts[toasts.length - 1] ?? ""
    assert(RE_INTEGRITY_OK.test(profileToast), "integrity part still reported under a profile run")
    assert(RE_PROFILE_FINDINGS.test(profileToast), "profile findings reported")
    assert(profileToast.includes("0.2.61.02-empty-options.md"), "profile toast names the flagged record")

    await run("check")
    const defaultToast = toasts[toasts.length - 1] ?? ""
    assert(RE_INTEGRITY_OK.test(defaultToast), "default check passes the fixture ADL")
    assert(!RE_PROFILE_FINDINGS.test(defaultToast), "default check does NOT apply the evolution profile")

    await run("check --profile bogus")
    assert(/Unknown validation profile|未知的校验配置文件/.test(toasts[toasts.length - 1] ?? "") && (toasts[toasts.length - 1] ?? "").includes("bogus"), "unknown profile rejected with available names")
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  08. Bare /adr new under numbering:iteration → sequential + warning
// ═════════════════════════════════════════════════════════════════════════

function test08_SequentialFallback() {
  section("08: bare /adr new under numbering:iteration (§6.1 rule 8)")
  const sandbox = makeSandbox("fallback")
  try {
    mkdirSync(join(sandbox, ".ocp"), { recursive: true })
    writeFileSync(
      join(sandbox, ".ocp", "ocp.json"),
      `{\n  "adr": {\n    "style": "madr",\n    "numbering": "iteration",\n    "suite": "evolution"\n  }\n}\n`,
      "utf-8",
    )

    const created = createAdr({ projectDir: sandbox, title: "Unversioned fix", targetDir: "docs/adr" })
    assert(/^\d{4}$/.test(created.id), `bare creation falls back to sequential (got ${created.id})`)
    assert(created.warnings.length === 1 && created.warnings[0].includes("fell back to sequential"), "visible fallback warning emitted")
    const content = readFileSync(created.fullPath, "utf-8")
    assert(!content.includes("iteration:") && !content.includes("baseline:"), "no iteration value invented in frontmatter")

    // Explicit context still mints dotted IDs under the same config.
    const dotted = createAdr({ projectDir: sandbox, title: "Versioned record", targetDir: "docs/adr", baseline: "0.2", iteration: "54" })
    assert(dotted.id === "0.2.54.01" && dotted.warnings.length === 0, "explicit --baseline/--iteration mints a dotted ID without warning")

    // Generated view appears once iteration metadata exists.
    const rel = regenerateIterationIndex(sandbox)
    assert(rel === "docs/adr/INDEX.by-iteration.md", "iteration view generated after first evolution record")
    const view = readFileSync(join(sandbox, "docs/adr/INDEX.by-iteration.md"), "utf-8")
    assert(view.includes("0.2.54.01") && !view.includes("ADR-0001"), "view groups only the iteration-numbered record")
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

// ─── Main entry ───────────────────────────────────────────────────────────

/** Minimal record for pure view/grouping functions (no file IO). */
function bareRecord(id: string, extra: Partial<NormalizedAdrRecord> = {}): NormalizedAdrRecord {
  return {
    id,
    style: "madr",
    sourcePath: `docs/adr/${id}.md`,
    title: id,
    status: "accepted",
    parentIds: [],
    supersedes: [],
    supersededBy: [],
    rawContent: "",
    ...extra,
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  09. Pinned-locale collation — deterministic ordering across hosts
// ═════════════════════════════════════════════════════════════════════════

function test09_PinnedLocaleCollation() {
  section("09: pinned-locale collation (cross-environment determinism)")
  // "ibis" vs "Icon" discriminates: en collates i before I on the base
  // tie (b < o), tr maps I → dotless ı which sorts BEFORE i.
  const trWouldFlip = new Intl.Collator("tr", { sensitivity: "variant" }).compare("Icon.md", "ibis.md") < 0
  assert(trWouldFlip, "fixture pair discriminates — a tr host locale would order Icon before ibis")

  // (a) created-tie path tiebreak must follow pinned-en, not host locale.
  const tieRecords = [
    bareRecord("ADR-0001", { sourcePath: "docs/adr/ibis.md" }),
    bareRecord("ADR-0002", { sourcePath: "docs/adr/Icon.md" }),
  ]
  const sorted = tieRecords.slice().sort(byCreatedThenPath)
  assert(
    sorted[0]?.sourcePath === "docs/adr/ibis.md",
    `created-tie path order pins en collation (ibis before Icon, got ${sorted.map((r) => r.sourcePath).join(", ")})`,
  )

  // (a) Domain group display order in the tree view — same pinned-en order.
  const domainView = renderTreeView(
    [bareRecord("ADR-0001", { domain: "Icon" }), bareRecord("ADR-0002", { domain: "ibis" })],
    "docs/adr",
    "domain",
  )
  const iconAt = domainView.indexOf("#### `Icon`")
  const ibisAt = domainView.indexOf("#### `ibis`")
  assert(iconAt !== -1 && ibisAt !== -1 && ibisAt < iconAt, "domain groups render in pinned-en order (ibis before Icon)")

  // (b) Iteration group display order stays numeric on the pinned locale.
  const groups = groupByIteration([bareRecord("ADR-0001", { iteration: "0.2.10" }), bareRecord("ADR-0002", { iteration: "0.2.9" })])
  assert(
    groups.map((g) => g.iteration).join(",") === "0.2.9,0.2.10",
    `iteration groups sort numerically on pinned locale (got ${groups.map((g) => g.iteration).join(",")})`,
  )
}

// ─── Main entry ───────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗")
  console.log("║  Multi-style ADL — Phase 3 Evolution Tests               ║")
  console.log("╚══════════════════════════════════════════════════════════╝")

  const origDir = process.cwd()
  try {
    test00_FixtureMetadata()
    test01_ShapeValidation()
    test02_IterationView()
    test03_CrossStyleRef()
    test04_DuplicateDottedIds()
    test05_IterationContext()
    test06_EvolutionProfile()
    await test07_Commands()
    test08_SequentialFallback()
    test09_PinnedLocaleCollation()
  } finally {
    setProjectDir(origDir)
  }

  console.log(`\n${"═".repeat(60)}`)
  console.log(`  Result: ${passed} passed / ${failed} failed`)
  console.log(`${"═".repeat(60)}`)
  if (failed > 0) process.exit(1)
}

await main()
