/**
 * Unit tests for the in-memory "skip when unchanged" pattern used by all
 * four system-inject plugins: auto-advisor, adr-guard, e2e-guard, and
 * project-manager. Each plugin owns one pure decision function; this
 * file verifies the common contract and per-plugin specifics.
 *
 * The pattern is documented in ADR 0002 and applied identically across
 * plugins because opencode's verified Scenario-A runtime rebuilds
 * `output.system` per chat request — meaning the marker-presence
 * fast-path inside each hook body never fires on its own under steady
 * state. The pure functions here are the testable extraction; the
 * hooks integrate them via module-level state.
 *
 * Run:
 *   bun tests/test-system-inject-fast-path-unit.ts
 */

import { shouldInjectMode } from "../plugins/auto-advisor/auto-advisor-system-inject"
import { shouldRunGuardHook } from "../plugins/adr-guard/adr-guard-system-inject"
import { shouldRunE2EHook } from "../plugins/e2e-guard/e2e-guard-system-inject"
import { shouldRunPointerHook } from "../plugins/project-manager/project-manager-system-inject"

let failures = 0
function check(condition: boolean, message: string): void {
  if (condition) return
  failures++
  console.error(`FAIL: ${message}`)
}

// ── Shared contract ───────────────────────────────────────────────────
//
// Every decision function follows the same shape:
//
//   shouldRun(currentState: T, lastState: T | undefined): boolean {
//     return currentState !== lastState
//   }
//
// The exhaustive truth table for any T is:
//
//   lastState  currentState  →  result  meaning
//   undefined  X             →  true    first call ever, must run
//   X          X             →  false   steady state, fast path
//   X          Y (X !== Y)   →  true    state changed, must run
//
// The specific tests below verify each function obeys this contract
// against its actual state type.

interface Case<T> {
  current: T
  last: T | undefined
  expected: boolean
  label: string
}

function runCases<T>(name: string, fn: (current: T, last: T | undefined) => boolean, cases: Case<T>[]): void {
  for (const c of cases) {
    check(fn(c.current, c.last) === c.expected, `${name}: ${c.label}`)
  }
}

// ── shouldInjectMode — auto-advisor ───────────────────────────────────

runCases<"off" | "lite" | "full">(
  "shouldInjectMode",
  shouldInjectMode,
  [
    // first call ever → run
    { current: "off", last: undefined, expected: true, label: "first call, off" },
    { current: "lite", last: undefined, expected: true, label: "first call, lite" },
    { current: "full", last: undefined, expected: true, label: "first call, full" },
    // steady state → skip (the actual fast path under Scenario A)
    { current: "off", last: "off", expected: false, label: "steady off" },
    { current: "lite", last: "lite", expected: false, label: "steady lite" },
    { current: "full", last: "full", expected: false, label: "steady full" },
    // state change → run
    { current: "off", last: "lite", expected: true, label: "lite → off" },
    { current: "lite", last: "off", expected: true, label: "off → lite" },
    { current: "off", last: "full", expected: true, label: "full → off" },
    { current: "lite", last: "full", expected: true, label: "full → lite" },
    { current: "full", last: "off", expected: true, label: "off → full" },
    { current: "full", last: "lite", expected: true, label: "lite → full" },
  ],
)

// ── shouldRunGuardHook — adr-guard ────────────────────────────────────
//
// State is binary on/off. The hook handles two distinct operations:
//   state=false → strip marker (if any), update lastState=false
//   state=true  → inject protocol (if absent), update lastState=true
//
// Either way, when the current state matches the last, the hook is a
// no-op. This is the contract that makes the "prompt-cache warm"
// promise in the doc comment true under Scenario A.

runCases<boolean>(
  "shouldRunGuardHook",
  shouldRunGuardHook,
  [
    { current: false, last: undefined, expected: true, label: "first call, off" },
    { current: true, last: undefined, expected: true, label: "first call, on" },
    { current: false, last: false, expected: false, label: "steady off → skip" },
    { current: true, last: true, expected: false, label: "steady on → skip (the fast path)" },
    { current: true, last: false, expected: true, label: "off → on (transition)" },
    { current: false, last: true, expected: true, label: "on → off (transition)" },
  ],
)

// ── shouldRunE2EHook — e2e-guard ──────────────────────────────────────
//
// State is shouldInject = isEnabled && isPrimaryAgent. The same
// binary contract as adr-guard — the only difference is what feeds
// the boolean (two sources instead of one).

runCases<boolean>(
  "shouldRunE2EHook",
  shouldRunE2EHook,
  [
    { current: false, last: undefined, expected: true, label: "first call, don't inject" },
    { current: true, last: undefined, expected: true, label: "first call, inject" },
    { current: false, last: false, expected: false, label: "steady no-inject → skip" },
    { current: true, last: true, expected: false, label: "steady inject → skip (the fast path)" },
    { current: true, last: false, expected: true, label: "don't inject → inject (transition)" },
    { current: false, last: true, expected: true, label: "inject → don't inject (transition)" },
  ],
)

// ── shouldRunPointerHook — project-manager ────────────────────────────
//
// State is hasConventionFile(). The hook handles two distinct
// operations:
//   filePresent=false → strip marker (if any), update lastState=false
//   filePresent=true  → inject pointer (if absent), update lastState=true
//
// Either way, when the current state matches the last, the hook is a
// no-op.

runCases<boolean>(
  "shouldRunPointerHook",
  shouldRunPointerHook,
  [
    { current: false, last: undefined, expected: true, label: "first call, file missing" },
    { current: true, last: undefined, expected: true, label: "first call, file present" },
    { current: false, last: false, expected: false, label: "steady missing → skip" },
    { current: true, last: true, expected: false, label: "steady present → skip (the fast path)" },
    { current: true, last: false, expected: true, label: "missing → present (transition)" },
    { current: false, last: true, expected: true, label: "present → missing (transition)" },
  ],
)

// ── Behavioral: lifecycle simulation ─────────────────────────────────
//
// Walk through a realistic sequence of turn-by-turn decisions and
// verify only the necessary work fires. This is the same shape as the
// behavioral test in test-auto-advisor-mode-inject-unit.ts, generalized
// across all 4 plugins.

function simulate<T>(
  name: string,
  fn: (current: T, last: T | undefined) => boolean,
  sequence: { current: T; lastStateExpected: T | undefined }[],
): void {
  let last: T | undefined
  for (let i = 0; i < sequence.length; i++) {
    const step = sequence[i]
    const decided = fn(step.current, last)
    if (decided) {
      // simulate "successfully handled this turn" — update last to current
      last = step.current
    }
    check(last === step.lastStateExpected, `${name} turn ${i + 1}: last=${String(last)} expected=${String(step.lastStateExpected)}`)
  }
}

// auto-advisor: user starts in lite, stays in lite for 3 turns, switches to full, back to lite
simulate<"off" | "lite" | "full">(
  "shouldInjectMode",
  shouldInjectMode,
  [
    { current: "lite", lastStateExpected: "lite" },  // first injection
    { current: "lite", lastStateExpected: "lite" },  // fast path
    { current: "lite", lastStateExpected: "lite" },  // fast path
    { current: "lite", lastStateExpected: "lite" },  // fast path
    { current: "full", lastStateExpected: "full" },  // mode change
    { current: "full", lastStateExpected: "full" },  // fast path
    { current: "lite", lastStateExpected: "lite" },  // mode change
  ],
)

// adr-guard: off, then on, then on, then off
simulate<boolean>(
  "shouldRunGuardHook",
  shouldRunGuardHook,
  [
    { current: false, lastStateExpected: false },  // first: strip (if any) + record
    { current: false, lastStateExpected: false },  // fast path
    { current: true, lastStateExpected: true },    // switched on
    { current: true, lastStateExpected: true },    // fast path
    { current: false, lastStateExpected: false },  // switched off
  ],
)

// e2e-guard: false (subagent), true (primary), true, false (off)
simulate<boolean>(
  "shouldRunE2EHook",
  shouldRunE2EHook,
  [
    { current: false, lastStateExpected: false },  // first: strip (if any)
    { current: false, lastStateExpected: false },  // fast path
    { current: true, lastStateExpected: true },    // now primary + on
    { current: true, lastStateExpected: true },    // fast path
    { current: false, lastStateExpected: false },  // subagent again
  ],
)

// project-manager: file present, file present, file deleted, file added back
simulate<boolean>(
  "shouldRunPointerHook",
  shouldRunPointerHook,
  [
    { current: true, lastStateExpected: true },    // first injection
    { current: true, lastStateExpected: true },    // fast path
    { current: false, lastStateExpected: false },  // file removed
    { current: false, lastStateExpected: false },  // fast path
    { current: true, lastStateExpected: true },    // file restored
  ],
)

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: system-inject fast-path — ${failures === 0 ? "all checks passed" : `${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)