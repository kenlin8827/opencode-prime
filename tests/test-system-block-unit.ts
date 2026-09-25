/**
 * Unit tests for plugins/shared/system-block.ts — the shared helpers used
 * by every plugin that appends a marker-guarded fragment to output.system.
 * Run: bun tests/test-system-block-unit.ts
 */
import { appendBlock, escapeRegExp, stripBlockByLine, stripBlockByPrefix } from "../plugins/shared/system-block"

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

// All-text-part array (V2 SystemPart[]): appends THROUGH the last part's
// .text in place — part identity (and cache hints) must survive.
{
  const sys: unknown[] = [{ type: "text", text: "root" }, { type: "text", text: "extra" }]
  appendBlock(sys, "[BLOCK]")
  check("appendBlock: text-part array appends through the last part text", (sys[1] as any).text === "extra[BLOCK]")
  check("appendBlock: text-part array does not push or replace entries", sys.length === 2 && typeof sys[0] === "object" && typeof sys[1] === "object")
}

// All-non-text array: pushes block as a fresh entry (defensive fallback).
{
  const sys: unknown[] = [{ role: "x" }]
  appendBlock(sys, "[BLOCK]")
  check("appendBlock: non-text entries are skipped, block pushed", sys.length === 2 && sys[1] === "[BLOCK]")
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

// ── stripBlockByPrefix: prefix-family marker removal ───────────────────
// Substring match on the prefix (not line-start anchored): prefix-family
// injectors append the full marker at line start but need variant-tolerant
// removal — e.g. a locale change produces [SESSION LANGUAGE: en] after
// [SESSION LANGUAGE: zh-CN], and only the shared prefix is stable.

// Marker present: cuts at the prefix occurrence, trims trailing whitespace.
{
  const sys: unknown[] = ["ROOT\n[SESSION LANGUAGE: zh-CN]\nSession language: 中文 — stale"]
  const r = stripBlockByPrefix(sys, "[SESSION LANGUAGE:")
  check("stripBlockByPrefix: returns true when prefix is present", r === true)
  check("stripBlockByPrefix: removes the marker and its body", !(sys[0] as string).includes("SESSION LANGUAGE") && !(sys[0] as string).includes("stale"))
  check("stripBlockByPrefix: preserves text before the marker", (sys[0] as string) === "ROOT")
}

// Variant tolerance: a DIFFERENT full marker sharing the prefix is also cut
// (the property stripBlockByLine's exact-match anchor cannot provide).
{
  const sys: unknown[] = ["base\n[SESSION LANGUAGE: zh-CN]\nold"]
  stripBlockByPrefix(sys, "[SESSION LANGUAGE:")
  appendBlock(sys, "\n[SESSION LANGUAGE: en]\nSession language: English — fresh")
  check("stripBlockByPrefix + appendBlock: variant round-trip leaves one marker",
    (sys[0] as string).split("[SESSION LANGUAGE:").length === 2)
  check("stripBlockByPrefix + appendBlock: variant round-trip carries fresh body",
    (sys[0] as string).includes("English — fresh") && !(sys[0] as string).includes("old"))
}

// No marker: idempotent no-op.
{
  const sys: unknown[] = ["ROOT", "Lite content"]
  const before = JSON.stringify(sys)
  const r = stripBlockByPrefix(sys, "[SESSION LANGUAGE:")
  check("stripBlockByPrefix: returns false when prefix is absent", r === false)
  check("stripBlockByPrefix: no-op when prefix absent", JSON.stringify(sys) === before)
}

// L0-style inline reference: output-protocol.md NAMES the marker mid-line in
// prose; the strip must anchor at line starts so such references are never
// truncated (regression for the substring-match P0).
{
  const sys: unknown[] = [
    "- **Session lock.** (3) the `[SESSION LANGUAGE: …]` marker in this system prompt — the pre-prose default.\n- **Overrides.** Keep the result for the entire session.",
  ]
  const r = stripBlockByPrefix(sys, "[SESSION LANGUAGE:")
  check("stripBlockByPrefix: mid-line marker reference is untouched", r === false)
  check("stripBlockByPrefix: quoted reference and later rules survive",
    (sys[0] as string).includes("`[SESSION LANGUAGE: …]` marker") && (sys[0] as string).includes("Keep the result"))
}

// Object entries: mutated through .text, identity preserved; non-text skipped.
{
  const sys: unknown[] = [{ type: "text", text: "a\n[SESSION LANGUAGE: ja]\n旧" }, { role: "x" }]
  const r = stripBlockByPrefix(sys, "[SESSION LANGUAGE:")
  check("stripBlockByPrefix: text-part mutated through .text", (sys[0] as any).text === "a")
  check("stripBlockByPrefix: non-text entries skipped", typeof sys[1] === "object" && !(sys[1] as any).text)
  check("stripBlockByPrefix: returns true when a part changed", r === true)
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
