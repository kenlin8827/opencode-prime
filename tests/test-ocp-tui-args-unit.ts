/**
 * OCP TUI argument normalization — Unit Tests (no launcher dependency)
 *
 * Covers the regression where `ocp tui .` in herdr mode forwarded `.` to the
 * herdr TUI, producing: `unknown command: .`.
 *
 * Run: bun run tests/test-ocp-tui-args-unit.ts
 */

import { normalizeTuiPassthrough } from '../install/src/tui-args'

let passed = 0
let failed = 0

function assertEq(actual: unknown, expected: unknown, label: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    console.log(`  ✅ ${label}`)
    passed++
  } else {
    console.error(`  ❌ ${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
    failed++
  }
}

assertEq(
  normalizeTuiPassthrough(['.']),
  { initRequested: true, passthrough: [] },
  '`ocp tui .` requests init and strips dot',
)

assertEq(
  normalizeTuiPassthrough(['--herdr', '.']),
  { initRequested: true, passthrough: ['--herdr'] },
  '`ocp tui --herdr .` strips dot before herdr launch',
)

assertEq(
  normalizeTuiPassthrough(['--init', '--direct', '--session', 'abc']),
  { initRequested: true, passthrough: ['--direct', '--session', 'abc'] },
  '`--init` requests init and is not forwarded',
)

assertEq(
  normalizeTuiPassthrough(['--session', 'abc']),
  { initRequested: false, passthrough: ['--session', 'abc'] },
  'ordinary passthrough args are preserved',
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
