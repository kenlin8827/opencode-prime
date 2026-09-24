// i18n cross-window refresh wiring — static source check.
//
// A language switch persists to ~/.config/opencode/ocp.json, but each TUI
// plugin process caches the locale in memory (`initI18n` is one-shot behind
// its `initialized` guard). Server-side surfaces re-read via `refreshLocale()`
// before composing output; the four TUI entry points must do the same or an
// already-running second window keeps rendering the OLD language until
// restart. Also guards the category-header fix: profile/provider compute
// their `tr()` group headers INSIDE the menu loop so an in-wizard
// switchLanguage re-renders them too.
//
// Static (string/comment-aware brace scan), no plugin loading — a behavioral
// harness would need a full TUI Context for four wizards to prove one line.
//
// Run: bun tests/test-i18n-refresh-wiring-unit.ts

import { readFileSync } from "node:fs"
import { join } from "node:path"

let passed = 0
let failed = 0
function assert(cond: unknown, label: string): void {
  if (cond) {
    passed++
  } else {
    failed++
    console.error(`  ✗ FAIL: ${label}`)
  }
}

const ROOT = join(import.meta.dir, "..")

/**
 * Extract the source of the function opened at `marker` by brace matching.
 * Skips string literals and comments so braces inside prose/templates do
 * not skew the depth. Known limitation: a REGEX literal containing an
 * unbalanced brace inside one of these bodies would break the scan — none
 * of the four entry functions have one; if a future edit adds one, this
 * test fails loudly and the scanner needs a regex state.
 */
function functionBody(src: string, marker: string): string | null {
  const start = src.indexOf(marker)
  if (start < 0) return null
  const open = src.indexOf("{", start)
  if (open < 0) return null

  let depth = 0
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    const next = src[i + 1]
    if (ch === "/" && next === "/") {
      i = src.indexOf("\n", i)
      if (i < 0) return null
      continue
    }
    if (ch === "/" && next === "*") {
      i = src.indexOf("*/", i)
      if (i < 0) return null
      i += 1 // +1 because the loop's i++ lands past "*"
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < src.length; i++) {
        if (src[i] === "\\") {
          i++
          continue
        }
        if (src[i] === ch) break
      }
      if (i >= src.length) return null
      continue
    }
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return null
}

interface Wiring {
  file: string
  label: string
  marker: string
  /** Category header const that must be declared after the menu loop opens. */
  headerAfterLoop?: string
}

const WIRING: Wiring[] = [
  {
    file: "plugins/tui/profile-wizard/tui.ts",
    label: "/profile startWizard",
    marker: "async function startWizard(ctx: Context): Promise<void>",
    headerAfterLoop: "const selectionCat",
  },
  {
    file: "plugins/tui/provider-wizard/tui.ts",
    label: "/provider startWizard",
    marker: "async function startWizard(ctx: Context): Promise<void>",
    headerAfterLoop: "const setupCat",
  },
  {
    file: "plugins/tui/project-wizard/tui.ts",
    label: "/project startProjectWizard",
    marker: "export async function startProjectWizard(",
  },
  {
    file: "plugins/tui/usage/tui.ts",
    label: "/usage openDimension (single funnel)",
    marker: "const openDimension = (dim: UsageDimension) => {",
  },
]

for (const { file, label, marker, headerAfterLoop } of WIRING) {
  const src = readFileSync(join(ROOT, file), "utf8")

  // Imported from the shared module — otherwise refreshLocale() is a
  // runtime ReferenceError the moment the wizard opens.
  assert(
    /import \{[^}]*\brefreshLocale\b[^}]*\} from "\.\.\/i18n"/.test(src),
    `${label}: imports refreshLocale from ../i18n`,
  )

  const body = functionBody(src, marker)
  assert(body !== null, `${label}: entry function found (marker drift?)`)
  if (body === null) continue

  assert(body.includes("refreshLocale()"), `${label}: body calls refreshLocale()`)

  // Placement: the re-read must happen BEFORE any tr() composition in the
  // body — refreshing after the first render still shows stale text.
  const refreshAt = body.indexOf("refreshLocale()")
  const firstTr = body.indexOf("tr(")
  assert(
    firstTr < 0 || refreshAt < firstTr,
    `${label}: refreshLocale() precedes the first tr() call`,
  )

  if (headerAfterLoop !== undefined) {
    const loopAt = body.indexOf("for (;;)")
    const headerAt = body.indexOf(headerAfterLoop)
    assert(loopAt >= 0, `${label}: has the main menu loop`)
    assert(
      headerAt > loopAt,
      `${label}: category header "${headerAfterLoop}" declared inside the loop (follows in-wizard language switch)`,
    )
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
