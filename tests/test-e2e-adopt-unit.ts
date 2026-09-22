/**
 * Unit tests for the e2e-adopt plugin (successor of the retired
 * e2e-guard plugin, owner decision 2026-09-22).
 *
 * Covers:
 *   1. Detection — stack-agnostic by design: conventional e2e dirs +
 *      runner-config hints ONLY; the E2E command is NEVER guessed
 *   2. Template — {{E2E_COMMAND}} stays a placeholder (agent/user fills
 *      the doc); AGENTS.md section carries no placeholders at all
 *      (command single-sourced in docs/e2e-redline.md)
 *   3. Apply — upsertAgentsSection insert/update/identical (pure),
 *      applyAdoption on temp dirs: doc create-only, AGENTS.md insert,
 *      idempotent re-run, missing-AGENTS.md posture
 *   4. Status — adoptionStatus read-only report
 *
 * Run: bun tests/test-e2e-adopt-unit.ts
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { detectE2eSetup, templateValuesFrom } from "../plugins/e2e-adopt/e2e-adopt-detect"
import {
  AGENTS_MARKER_END,
  AGENTS_MARKER_START,
  PLACEHOLDERS,
  renderAgentsSection,
  renderRedlineDoc,
  unfilledPlaceholders,
} from "../plugins/e2e-adopt/e2e-adopt-template"
import {
  E2E_REDLINE_DOC_REL,
  adoptionStatus,
  applyAdoption,
  upsertAgentsSection,
} from "../plugins/e2e-adopt/e2e-adopt-apply"

let failures = 0
function check(condition: boolean, message: string): void {
  if (condition) return
  failures++
  console.error(`FAIL: ${message}`)
}

function section(label: string): void {
  console.log(`\n== ${label} ==`)
}

// ── 1. Detection (stack-agnostic — no command guessing) ─────────────

section("01: conventional e2e dir detection")
{
  const root = mkdtempSync(join(tmpdir(), "e2e-adopt-"))
  try {
    mkdirSync(join(root, "tests/e2e"), { recursive: true })
    const d = detectE2eSetup(root)
    check(d.e2eDir === "tests/e2e", "tests/e2e detected")
    check(d.runnerConfig === null, "no runner config → null")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

section("02: runner-config hint detection")
{
  const root = mkdtempSync(join(tmpdir(), "e2e-adopt-"))
  try {
    writeFileSync(join(root, "playwright.config.ts"), "", "utf-8")
    const d = detectE2eSetup(root)
    check(d.runnerConfig === "playwright.config.ts", "playwright config reported as hint")
    check(d.e2eDir === null, "no conventional dir → null")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

section("03: empty project → nothing detected")
{
  const root = mkdtempSync(join(tmpdir(), "e2e-adopt-"))
  try {
    const d = detectE2eSetup(root)
    check(d.e2eDir === null && d.runnerConfig === null, "both null on bare dir")
    const values = templateValuesFrom(d)
    check(values.e2eDir === undefined, "no dir value derived")
    check(!("e2eCommand" in values), "PIN: command is NEVER derived (no stack guessing)")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

section("04: dir detection is stack-agnostic (no manifest required)")
{
  const root = mkdtempSync(join(tmpdir(), "e2e-adopt-"))
  try {
    // A Go project with a conventional dir — no package.json anywhere.
    writeFileSync(join(root, "go.mod"), "module x\n", "utf-8")
    mkdirSync(join(root, "test/e2e"), { recursive: true })
    const d = detectE2eSetup(root)
    check(d.e2eDir === "test/e2e", "dir found without any node manifest")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

section("04b: runnerConfig is display-only — never leaks into rendered artifacts")
{
  const root = mkdtempSync(join(tmpdir(), "e2e-adopt-"))
  try {
    writeFileSync(join(root, "playwright.config.ts"), "", "utf-8")
    const d = detectE2eSetup(root)
    check(d.runnerConfig === "playwright.config.ts", "hint detected")
    const values = templateValuesFrom(d)
    check(!("runnerConfig" in values) && !("e2eCommand" in values), "PIN: template values carry neither the hint nor any command")
    const doc = renderRedlineDoc(values)
    const agentsSection = renderAgentsSection(values)
    check(!doc.includes("playwright.config.ts"), "PIN: hint never enters the doc")
    check(!agentsSection.includes("playwright.config.ts"), "PIN: hint never enters the AGENTS.md section")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ── 2. Template ──────────────────────────────────────────────────────

section("05: renderRedlineDoc — command always a placeholder, dir fills")
{
  const doc = renderRedlineDoc({ e2eDir: "tests/e2e/" })
  check(doc.includes("{{E2E_COMMAND}}"), "PIN: command placeholder always present (never guessed)")
  check(doc.includes("tests/e2e/"), "detected dir filled")
  check(!doc.includes("{{E2E_DIR}}"), "no dir placeholder left when detected")
  check(doc.includes("{{CRITICAL_JOURNEYS}}"), "critical journeys stays a placeholder (business knowledge)")
  check(doc.includes("Confirmation loop"), "element 2: confirmation loop present")
  check(doc.includes("Trigger discipline"), "element 3: trigger discipline present")
  check(doc.includes("Coverage mandate"), "element 4: coverage mandate present")
  check(doc.includes("Counter-examples"), "checklist + counter-examples present")
  check(doc.includes("ask the agent to inspect the repo"), "header points at the agent-fill path")
}

section("06: unfilled placeholder reporting")
{
  const doc = renderRedlineDoc({})
  check(JSON.stringify(unfilledPlaceholders(doc)) === JSON.stringify(["{{E2E_COMMAND}}", "{{E2E_DIR}}", "{{CRITICAL_JOURNEYS}}"]), "empty values → all three placeholders reported")
  check(JSON.stringify(PLACEHOLDERS).includes("E2E_COMMAND"), "placeholder registry intact")
}

section("07: renderAgentsSection — markers, no placeholders, doc link")
{
  const s = renderAgentsSection({})
  check(s.startsWith(AGENTS_MARKER_START), "section starts with start marker")
  check(s.trim().endsWith(AGENTS_MARKER_END), "section ends with end marker")
  check(s.includes("docs/e2e-redline.md"), "links the detailed doc")
  check(s.includes("question tool"), "confirmation loop referenced in the row")
  check(unfilledPlaceholders(s).length === 0, "PIN: AGENTS.md section carries NO placeholders (command single-sourced in the doc)")
}

// ── 3. Apply ─────────────────────────────────────────────────────────

section("08: upsertAgentsSection (pure)")
{
  const sectionText = renderAgentsSection({})
  const base = "# My project\n\nSome content.\n"
  const inserted = upsertAgentsSection(base, sectionText)
  check(inserted.startsWith("# My project"), "existing content preserved (head)")
  check(inserted.includes("Some content."), "existing content preserved (body)")
  check(inserted.includes(AGENTS_MARKER_START), "section inserted")

  // Simulate project drift: a hand-edited section updates in place.
  const drifted = sectionText.replace("docs/e2e-redline.md", "docs/custom-e2e.md")
  const updated = upsertAgentsSection(inserted, drifted)
  check(updated.includes("docs/custom-e2e.md"), "section updated in place")
  check((updated.match(new RegExp(AGENTS_MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length === 1, "no marker duplication")

  const identical = upsertAgentsSection(inserted, sectionText)
  check(identical === inserted + "\n" || identical.trimEnd() === inserted.trimEnd(), "re-insert of identical section is effectively a no-op")
}

section("08b: malformed marker framing → upsert refuses (null), nothing spliced")
{
  const sectionText = renderAgentsSection({})
  const base = "# P\n\ncontent\n"

  // Crossed markers (END before START) — splice would duplicate content.
  const crossed = `${base}<!-- e2e-redline:end -->\nmiddle\n<!-- e2e-redline:start -->\n`
  check(upsertAgentsSection(crossed, sectionText) === null, "crossed markers → null")

  // Duplicated START (user copy-pasted the section).
  const duplicated = `${base}${sectionText}\n${sectionText}`
  check(upsertAgentsSection(duplicated, sectionText) === null, "duplicated markers → null")

  // Inline prose mention of the marker text is NOT the framing — the
  // append path fires (a real section is added; prose stays untouched).
  const prose = `${base}Uninstall: delete the <!-- e2e-redline:start --> ... <!-- e2e-redline:end --> section.\n`
  const proseResult = upsertAgentsSection(prose, sectionText)
  check(proseResult !== null && proseResult.includes(sectionText), "inline prose mention → append path, no splice")
  check(proseResult!.indexOf("Uninstall: delete") < proseResult!.indexOf(AGENTS_MARKER_START), "prose line untouched before the appended section")

  // Empty AGENTS.md — no leading blank line (nit fix).
  const empty = upsertAgentsSection("", sectionText)
  check(empty !== null && !empty.startsWith("\n"), "empty file → no leading blank line")
  check(empty === sectionText + "\n", "empty file → section is the whole content")
}

section("09: applyAdoption on a fresh temp project (with AGENTS.md)")
{
  const root = mkdtempSync(join(tmpdir(), "e2e-adopt-"))
  try {
    writeFileSync(join(root, "AGENTS.md"), "# Project\n", "utf-8")
    const doc = renderRedlineDoc({ e2eDir: "tests/e2e/" })
    const agentsSection = renderAgentsSection({})

    const r1 = applyAdoption(root, doc, agentsSection)
    check(r1.docWritten && !r1.docSkippedExisting, "doc written on first run")
    check(r1.agentsSectionWritten, "AGENTS.md section inserted")
    check(!r1.agentsMissing, "AGENTS.md present → no missing flag")
    check(existsSync(join(root, E2E_REDLINE_DOC_REL)), "doc exists on disk")
    const agentsAfter = readFileSync(join(root, "AGENTS.md"), "utf-8")
    check(agentsAfter.startsWith("# Project\n"), "AGENTS.md original content untouched")
    check(agentsAfter.includes(AGENTS_MARKER_START), "section present in AGENTS.md")

    // Idempotent re-run: doc NOT overwritten, section identical.
    const r2 = applyAdoption(root, doc, agentsSection)
    check(r2.docSkippedExisting && !r2.docWritten, "second run skips existing doc")
    check(r2.agentsSectionIdentical, "second run detects identical section")

    // Update path: drifted section → updated in place, still one marker pair.
    const drifted = renderAgentsSection({}).replace("docs/e2e-redline.md", "docs/custom-e2e.md")
    const r3 = applyAdoption(root, doc, drifted)
    check(r3.agentsSectionUpdated, "drifted section → update path")
    const agentsFinal = readFileSync(join(root, "AGENTS.md"), "utf-8")
    check(agentsFinal.includes("docs/custom-e2e.md"), "updated content landed")
    check((agentsFinal.match(/e2e-redline:start/g) ?? []).length === 1, "still exactly one marker pair")

    const st = adoptionStatus(root)
    check(st.docExists && st.agentsExists && st.agentsHasSection, "status: fully adopted")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

section("10: applyAdoption without AGENTS.md → doc written, section refused")
{
  const root = mkdtempSync(join(tmpdir(), "e2e-adopt-"))
  try {
    const r = applyAdoption(root, renderRedlineDoc({}), renderAgentsSection({}))
    check(r.docWritten, "doc still written")
    check(r.agentsMissing && !r.agentsSectionWritten, "section refused when AGENTS.md missing")
    check(!existsSync(join(root, "AGENTS.md")), "no minimal AGENTS.md created (init keeps its baseline)")
    const st = adoptionStatus(root)
    check(st.docExists && !st.agentsHasSection, "status: doc yes, section no")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: e2e-adopt — ${failures === 0 ? "all checks passed" : `${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
