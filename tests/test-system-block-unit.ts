/**
 * Unit tests for plugins/shared/system-block.ts — the shared helpers used
 * by every plugin that appends a marker-guarded fragment to output.system.
 * Run: bun tests/test-system-block-unit.ts
 */
import { appendBlock, escapeRegExp, stripBlockByLine } from "../plugins/shared/system-block"

let pass = 0
let fail = 0
function check(name: string, ok: boolean) {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.error(`  FAIL  ${name}`) }
}

// ── appendBlock: defensive coverage ────────────────────────────────────
// The pre-2026-09-11 per-plugin copies of this loop silently dropped
// the block when output.system was empty or contained only non-string
// entries. The shared helper fixes both cases by pushing the block as
// a new string entry. These checks lock the contract so a future
// "optimization" can't reintroduce the silent-drop bug.

// Happy path: appends to last string entry.
{
  const sys: unknown[] = ["ROOT", "<!-- lite-mode -->\nLite content"]
  const r = appendBlock(sys, "[BLOCK]")
  check("appendBlock: returns true on append", r === true)
  check("appendBlock: appends to last string entry", sys[1] === "<!-- lite-mode -->\nLite content[BLOCK]")
  check("appendBlock: does not push when a string entry exists", sys.length === 2)
}

// Empty array: pushes block as sole entry.
{
  const sys: unknown[] = []
  appendBlock(sys, "[BLOCK]")
  check("appendBlock: empty array pushes block as sole entry", sys.length === 1 && sys[0] === "[BLOCK]")
}

// All-object array: pushes block at the end.
{
  const sys: unknown[] = [{ type: "text", text: "root" }, { type: "text", text: "extra" }]
  appendBlock(sys, "[BLOCK]")
  check("appendBlock: all-object array keeps objects and appends block", sys.length === 3 && sys[2] === "[BLOCK]")
  check("appendBlock: object entries are not mutated", typeof sys[0] === "object" && typeof sys[1] === "object")
}

// Mixed array: appends to the LAST string entry, leaves objects alone.
{
  const sys: unknown[] = ["ROOT", { type: "text", text: "extra" }, "Lite"]
  appendBlock(sys, "[BLOCK]")
  check("appendBlock: mixed array appends to last string entry", sys[2] === "Lite[BLOCK]")
  check("appendBlock: mixed array leaves objects untouched", typeof sys[1] === "object")
}

// ── stripBlockByLine: marker line removal ──────────────────────────────
// Marker matches at line-start only (so inline prose is safe); trailing
// whitespace before the cut is trimmed so the stripped entry restores
// cleanly to its pre-injection shape.

// Marker present: cuts at the marker line, trims trailing whitespace.
{
  const marker = "[PROJECT CAPABILITIES]"
  const block = `\n---\n${marker}\nline1\nline2\n`
  const sys: unknown[] = ["ROOT\n<!-- lite-mode -->\nLite content" + block]
  const r = stripBlockByLine(sys, marker)
  check("stripBlockByLine: returns true when marker is present", r === true)
  check("stripBlockByLine: cuts at the marker line", !(sys[0] as string).includes(marker))
  check("stripBlockByLine: preserves everything before the marker line",
    (sys[0] as string).startsWith("ROOT\n<!-- lite-mode -->\nLite content"))
}

// No marker: idempotent no-op.
{
  const sys: unknown[] = ["ROOT", "Lite content"]
  const before = JSON.stringify(sys)
  const r = stripBlockByLine(sys, "[SOME MARKER]")
  check("stripBlockByLine: returns false when marker is absent", r === false)
  check("stripBlockByLine: no-op when marker absent", JSON.stringify(sys) === before)
}

// Object entries: passed through unchanged.
{
  const sys: unknown[] = [{ type: "text", text: "root" }]
  const r = stripBlockByLine(sys, "[SOME MARKER]")
  check("stripBlockByLine: object-only array returns false", r === false)
  check("stripBlockByLine: object entries are not mutated", typeof sys[0] === "object")
}

// Round-trip strip + append: no marker stacking, content updated.
{
  const marker = "[CYCLE]"
  // Realistic shape: developer policy text, then an injected block. The
  // block starts with "\n" + marker on its own line (the canonical block
  // format every OCP injector uses), so stripBlockByLine's line-start
  // regex finds it.
  const sys: unknown[] = [
    "prefix\n<!-- lite-mode -->\nLite content" + `\n---\n${marker}\nstale text\n`,
  ]
  stripBlockByLine(sys, marker)
  appendBlock(sys, `\n---\n${marker}\nfresh text\n`)
  check("stripBlockByLine + appendBlock: round-trip leaves exactly one marker",
    (sys[0] as string).split(marker).length === 2)
  check("stripBlockByLine + appendBlock: round-trip carries fresh content",
    (sys[0] as string).includes("fresh text"))
  check("stripBlockByLine + appendBlock: round-trip drops stale content",
    !(sys[0] as string).includes("stale text"))
}

// Bracket characters in marker: must not break the line-start regex.
{
  const marker = "[BRACKETED]"
  const sys: unknown[] = [`text\n${marker}\nbody\n`]
  stripBlockByLine(sys, marker)
  check("stripBlockByLine: handles markers with bracket characters",
    !(sys[0] as string).includes(marker))
}

// ── escapeRegExp: keeps RegExp construction safe across the codebase ──

check("escapeRegExp: escapes square brackets",
  escapeRegExp("[X]") === "\\[X\\]")
check("escapeRegExp: escapes parentheses and plus",
  escapeRegExp("(a)+b") === "\\(a\\)\\+b")
check("escapeRegExp: escapes dot, star, question mark",
  escapeRegExp("a.b*c?") === "a\\.b\\*c\\?")
check("escapeRegExp: passes plain text through unchanged",
  escapeRegExp("plain") === "plain")
check("escapeRegExp: round-trips through RegExp construction",
  new RegExp(escapeRegExp("[A]")).test("see [A] here") === true)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
