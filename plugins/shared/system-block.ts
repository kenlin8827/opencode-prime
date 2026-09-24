/**
 * Shared system-prompt block injection helpers — used by every plugin that
 * appends a marker-guarded fragment to the assembled system parts
 * (`e.system` in the v2 "context" hook; plain strings are still accepted).
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

/** Read a system entry's text. Accepts v1 plain strings and v2
 *  SystemPart-like objects ({ type:"text", text }) alike. */
function entryText(entry: unknown): string | null {
  if (typeof entry === "string") return entry
  if (entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string")
    return (entry as { text: string }).text
  return null
}

/** Write `text` into a system entry in place: replace a string slot,
 *  mutate a SystemPart object slot so the array element identity (and
 *  non-text fields like `cache`) survive. */
function setEntryText(system: Array<unknown>, i: number, text: string): void {
  const entry = system[i]
  if (entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string") {
    ;(entry as { text: string }).text = text
    return
  }
  system[i] = text
}

/** Append `block` to the last text entry of `system`. If no text entry
 * exists (empty array, or a runtime passing all non-text entries —
 * opencode has done both in observed versions), push a fresh string entry
 * instead of silently dropping the block: the model needs the capability
 * state regardless of array shape, and the worst case is a duplicate
 * marker which the caller's marker-presence check absorbs on the next step.
 *
 * Pure function — mutates `system` in place, returns whether anything
 * changed. Exported for unit tests, no I/O.
 * V2 note: `ctx.session.hook("context")` carries `system: SystemPart[]`;
 * object parts are updated through their `.text` field, so injected text
 * rides the platform's own part objects (cache hints stay intact). */
export function appendBlock(system: Array<unknown>, block: string): boolean {
  for (let i = system.length - 1; i >= 0; i--) {
    const text = entryText(system[i])
    if (text === null) continue
    setEntryText(system, i, text + block)
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
    const entry = entryText(system[i])
    if (entry === null) continue
    const idx = entry.search(re)
    if (idx === -1) continue
    setEntryText(system, i, entry.substring(0, idx).replace(/\s+$/, ""))
    changed = true
  }
  return changed
}

/** Mutable-text view of a v2 `SystemPart[]` (or a v1 `string[]`): returns a
 *  plain string array plugins can run their existing string logic over.
 *  Call `writeBackSystem` afterwards to flush changes into the parts. */
export function toSystemView(system: Array<unknown>): string[] {
  const out: string[] = []
  for (const entry of system) out.push(entryText(entry) ?? "")
  return out
}

/** Flush a `toSystemView` result back into the original parts array.
 *  Object parts keep their identity and non-text fields (`type`, `cache`,
 *  `metadata`) — only `.text` is rewritten. Entries appended past the
 *  original length become fresh `{ type: "text", text }` parts; entries
 *  removed by a rewrite truncate the array. */
export function writeBackSystem(system: Array<unknown>, view: string[]): void {
  for (let i = 0; i < Math.min(system.length, view.length); i++) {
    const entry = system[i]
    const current = entryText(entry)
    if (current === view[i]) continue
    if (entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string")
      (entry as { text: string }).text = view[i]
    else system[i] = view[i]
  }
  if (view.length > system.length) {
    for (let i = system.length; i < view.length; i++) system.push({ type: "text", text: view[i] })
  } else if (view.length < system.length) {
    system.length = view.length
  }
}
