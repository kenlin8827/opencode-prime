/**
 * Hierarchical ADR Engine — Unit Tests
 *
 * Coverage:
 *   - Hierarchical multi-path discovery
 *   - Auto-increment sequential ID assignment per directory
 *   - MADR scaffolding with layer-specific templates (L1/L2/L3)
 *   - Decision lifecycle & atomic superseding
 *   - Decision tree & Mermaid DAG generation
 *   - ADR integrity and link validator
 *   - Command parser & Git status multi-directory matcher
 *
 * Run: bun run tests/test-adr-hierarchical-unit.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  analyzeAdrComplexity,
  checkAdrIntegrity,
  createAdr,
  discoverAdrDirectories,
  executeAdrMigration,
  generateDecisionMap,
  getAllAdrs,
  getNextAdrNumber,
  parseAdrFile,
  planAdrMigration,
  slugify,
  supersedeAdr,
} from "../plugins/adr-guard/adr-engine"
import { normalizeAdrLayout, setProjectDir } from "../plugins/adr-guard/adr-guard-config"
import { hasAdrChanges } from "../plugins/adr-guard/adr-guard-runtime"

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

function runTests() {
  console.log("\n🧪 Running Hierarchical ADR Engine Unit Tests...\n")

  // 1. Slugify helper
  assert(slugify("Event Bus & Streaming") === "event-bus-streaming", "slugify basic")
  assert(slugify("  Modular---Monolith v2.0  ") === "modular-monolith-v20", "slugify clean")

  // Setup temporary test sandbox
  const sandbox = mkdtempSync(join(tmpdir(), "adr-test-"))
  setProjectDir(sandbox)
  writeFileSync(join(sandbox, "opencode.jsonc"), JSON.stringify({ adrLayout: "hierarchical" }, null, 2))

  try {
    // 2. Discover directories & calculate next numbers
    const rootAdrDir = join(sandbox, "docs/adr")
    const subAdrDir = join(sandbox, "packages/payment/docs/adr")
    mkdirSync(rootAdrDir, { recursive: true })
    mkdirSync(subAdrDir, { recursive: true })

    const dirs = discoverAdrDirectories(sandbox)
    assert(dirs.includes("docs/adr"), "discovered root docs/adr")
    assert(dirs.includes("packages/payment/docs/adr"), "discovered subsystem docs/adr")

    assert(getNextAdrNumber(sandbox, "docs/adr") === "0001", "first ADR is 0001")

    // 3. Create L1 System ADR
    const adr1 = createAdr({
      projectDir: sandbox,
      title: "Global Modular Monolith",
      layer: "system",
      targetDir: "docs/adr",
    })

    assert(adr1.id === "0001", "created ADR-0001")
    assert(existsSync(adr1.fullPath), "ADR-0001 file exists")
    assert(existsSync(join(rootAdrDir, "INDEX.md")), "INDEX.md auto-generated")

    const content1 = readFileSync(adr1.fullPath, "utf-8")
    assert(content1.includes("layer: system"), "contains system layer frontmatter")
    assert(content1.includes("## Considered Options"), "L1 template includes considered options")

    // Check next number in root vs subsystem
    assert(getNextAdrNumber(sandbox, "docs/adr") === "0002", "next root ADR is 0002")
    assert(getNextAdrNumber(sandbox, "packages/payment/docs/adr") === "0001", "subsystem starts at 0001")

    // 4. Create L2 Subsystem ADR
    const adr2 = createAdr({
      projectDir: sandbox,
      title: "Payment Idempotency Standard",
      layer: "domain",
      scope: "payment",
      targetDir: "packages/payment/docs/adr",
      parent: adr1.relPath,
    })

    assert(adr2.id === "0001", "created subsystem ADR-0001")
    const content2 = readFileSync(adr2.fullPath, "utf-8")
    assert(content2.includes("layer: domain"), "contains domain layer frontmatter")
    assert(content2.includes(`parent: ${adr1.relPath}`), "contains parent link")

    // 5. Parse ADRs and test getAllAdrs
    const all = getAllAdrs(sandbox)
    assert(all.length === 2, `retrieved ${all.length}/2 ADRs across workspace`)
    const parsed1 = parseAdrFile(adr1.fullPath, sandbox)
    assert(parsed1?.title === "Global Modular Monolith", "parsed ADR-0001 title correctly")

    // 6. Test Supersede Lifecycle
    const { newAdr, oldAdr } = supersedeAdr(
      sandbox,
      "0001",
      "Event-Driven Architecture",
      { targetDir: "docs/adr" },
    )

    assert(newAdr.id === "0002", "new superseding ADR has id 0002")
    const updatedOldContent = readFileSync(oldAdr.fullPath, "utf-8")
    assert(
      updatedOldContent.includes("status: superseded by 0002"),
      "old ADR marked as superseded by 0002",
    )

    // 7. Test Decision Map & DAG Generation
    const map = generateDecisionMap(sandbox)
    assert(map.includes("Architecture Decision Map"), "decision map generated")
    assert(map.includes("L1: System & Macro Decisions"), "includes L1 section")
    assert(map.includes("L2: Domain & Subsystem Decisions"), "includes L2 section")
    assert(map.includes("mermaid"), "includes Mermaid diagram")
    assert(map.includes("ADR_0001 -.->|superseded by| ADR_0002"), "Mermaid includes superseded edge")

    // 8. Integrity Checker (Clean state)
    let issues = checkAdrIntegrity(sandbox)
    assert(issues.length === 0, `clean integrity check has 0 issues (got ${issues.length})`)

    // 9. Integrity Checker (Broken parent reference)
    const brokenAdr = createAdr({
      projectDir: sandbox,
      title: "Broken Link ADR",
      targetDir: "docs/adr",
      parent: "docs/adr/9999-non-existent.md",
    })
    issues = checkAdrIntegrity(sandbox)
    assert(
      issues.some((i) => i.type === "broken-parent"),
      "detected broken parent link error",
    )

    // 10. Git changes detection across multi-dirs
    assert(
      typeof hasAdrChanges(sandbox, ["docs/adr", "packages/payment/docs/adr"]) === "boolean",
      "hasAdrChanges multi-path check executes safely",
    )

    // 11. adrLayout testing (flat vs hierarchical)
    const flatDirs = discoverAdrDirectories(sandbox, "docs/adr", "flat")
    assert(
      flatDirs.length === 1 && flatDirs[0] === "docs/adr",
      "flat mode strictly restricts discovery to root docs/adr",
    )

    const flatMap = generateDecisionMap(sandbox, "flat")
    assert(
      flatMap.includes("#### Decisions"),
      "flat mode renders clean linear list without DAG",
    )
    assert(
      !flatMap.includes("mermaid"),
      "flat mode skips mermaid DAG for lightweight simplicity",
    )

    const flatAdr = createAdr({
      projectDir: sandbox,
      title: "Flat Decision",
      layer: "domain", // should be forced to system in flat mode
      scope: "ignored-in-flat",
      layout: "flat",
    })
    assert(flatAdr.relPath.startsWith("docs/adr/"), "flat mode routes creation strictly to docs/adr")

    // 11b. Short alias normalization for modes
    assert(normalizeAdrLayout("h") === "hierarchical", "normalizeAdrLayout handles 'h'")
    assert(normalizeAdrLayout("hierarchy") === "hierarchical", "normalizeAdrLayout handles 'hierarchy'")
    assert(normalizeAdrLayout("tree") === "hierarchical", "normalizeAdrLayout handles 'tree'")
    assert(normalizeAdrLayout("f") === "flat", "normalizeAdrLayout handles 'f'")
    assert(normalizeAdrLayout("single") === "flat", "normalizeAdrLayout handles 'single'")
    assert(normalizeAdrLayout("a") === "auto", "normalizeAdrLayout handles 'a'")


    // 12. Complexity analysis
    const complexity = analyzeAdrComplexity(sandbox)
    assert(typeof complexity.totalAdrs === "number", "complexity analysis computes total ADRs")
    assert(complexity.discoveredPackages.includes("packages/payment"), "discovered payment package")

    // 13. Automated Migration Planning & Execution
    // Create an ADR in root mentioning "payment"
    createAdr({
      projectDir: sandbox,
      title: "Payment Gateway Integration",
      targetDir: "docs/adr",
    })

    const migPlan = planAdrMigration(sandbox, "hierarchical")
    assert(migPlan.moves.length > 0, "planAdrMigration finds relocatable package ADRs")
    assert(
      migPlan.moves.some((m) => m.toRelPath.startsWith("packages/payment/docs/adr/")),
      "plan routes payment decision to packages/payment/docs/adr/",
    )

    const migResult = executeAdrMigration(sandbox, migPlan)
    assert(migResult.executedCount > 0, "executeAdrMigration moves files successfully")
    assert(
      existsSync(join(sandbox, "packages/payment/docs/adr/INDEX.md")),
      "updated target directory index",
    )

    // Test reverse migration (hierarchical -> flat)
    const reversePlan = planAdrMigration(sandbox, "flat")
    assert(reversePlan.moves.length > 0, "plan reverse migration back to flat")
    const reverseResult = executeAdrMigration(sandbox, reversePlan)
    assert(reverseResult.executedCount > 0, "executed reverse migration to docs/adr/")
    assert(
      existsSync(join(sandbox, "docs/adr/INDEX.md")),
      "root index updated after reverse migration",
    )

  } finally {
    // Cleanup temporary files
    try {
      rmSync(sandbox, { recursive: true, force: true })
    } catch {}
  }

  console.log(`\n========================================`)
  console.log(`Results: ${passed} passed, ${failed} failed`)
  console.log(`========================================\n`)

  if (failed > 0) {
    process.exit(1)
  }
}

runTests()
