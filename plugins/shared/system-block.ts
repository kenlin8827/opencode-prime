/**
 * Shared system-prompt block injection helpers — used by every plugin that
 * appends a marker-guarded fragment to `output.system`.
 *
 * Why this lives in `shared/` rather than duplicated per-plugin: the three
 * existing injectors (`project-profiler`, `project-manager`, `auto-advisor`)
 * each carry their own near-identical copy of the "find last string entry
 * and append" loop. The pre-2026-09-11 copies silently dropped the fragment
 * whenever the runtime passed an empty array or an all-object array — a
 * shape that observed opencode versions do produce. Centralizing the
 * append path makes the defensive push-fallback a single fix instead of
 * a per-plugin hunt, and gives the strip / escape primitives one home
 * to keep the marker pattern in sync across plugins.
 *
 * Marker checks themselves (`hasMarker` style) stay per-plugin: the
 * three callers differ in whether they use substring match or a strict
 * line-start regex, and forcing a shared shape would change semantics.
 */

export { escapeRegExp }

/** Escape a literal string for embedding inside a `RegExp` constructor.
 * `[` and `]` are the only regex metacharacters in the current markers
 * used by OCP injectors; covering the full set keeps the helper correct
 * if a marker ever gains more punctuation.
 *
 * Pure function — exported for unit tests, no I/O, no module state. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Append `block` to the last string entry of `system`. If no string entry
 * exists (empty array, or a runtime passing all non-string entries —
 * opencode has done both in observed versions), push a fresh string entry
 * instead of silently dropping the block: the model needs the capability
 * state regardless of array shape, and the worst case is a duplicate
 * marker which the caller's marker-presence check absorbs on the next step.
 *
 * Pure function — mutates `system` in place, returns whether anything
 * changed. Exported for unit tests, no I/O. */
export function appendBlock(system: Array<unknown>, block: string): boolean {
  for (let i = system.length - 1; i >= 0; i--) {
    const entry = system[i]
    if (typeof entry !== "string") continue
    system[i] = entry + block
    return true
  }
  system.push(block)
  return true
}

/** Cut a marker line off every string entry of `system`. The marker is
 * matched at line-start (`\n${marker}`) so inline prose that happens to
 * contain the marker text is not affected. Trailing whitespace before
 * the cut is trimmed so the stripped entry restores cleanly to its
 * pre-injection shape. Idempotent — no-op when the marker is absent.
 *
 * Pure function — mutates `system` in place, returns whether anything
 * was stripped. Exported for unit tests, no I/O. */
export function stripBlockByLine(system: Array<unknown>, marker: string): boolean {
  const re = new RegExp(`\\n${escapeRegExp(marker)}`)
  let changed = false
  for (let i = 0; i < system.length; i++) {
    const entry = system[i]
    if (typeof entry !== "string") continue
    const idx = entry.search(re)
    if (idx === -1) continue
    system[i] = entry.substring(0, idx).replace(/\s+$/, "")
    changed = true
  }
  return changed
}
