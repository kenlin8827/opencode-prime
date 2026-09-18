/**
 * Unit test for install/src/installer.ts warnInstallTargetMismatch().
 *
 * Run: bun tests/test-warn-install-target-mismatch-unit.ts
 *
 * The function only warns on *detectable* divergence:
 *   - happy path: no env, no running opencode → silent
 *   - user-intentional: env set, targetDir resolves to env, no
 *     opencode --config-dir override → silent
 *   - mismatch A: env set but --target explicit AND disagree → WARNING
 *   - mismatch B: running opencode.exe with --config-dir ≠ target → WARNING
 *   - shell+runtime same dir → silent
 *
 * The Windows-only `wmic` probe is injected so the test runs anywhere
 * (Bun on macOS/Linux/Windows). Production callers omit the second arg
 * and get the live probe (see installer.ts probeRunningOpencodeConfigDir).
 *
 * Cases the function does NOT cover (handled by ocp-doctor.ts instead):
 *   - shell has env, opencode runs without --config-dir (probe can't see
 *     env vars of other processes — only CommandLine). ocp-doctor scans
 *     candidate install dirs directly and reports divergence.
 */
import { warnInstallTargetMismatch } from '../install/src/installer'

interface Scenario {
  name: string
  envOverride: string | null
  runtimeConfigDir: string | null
  expectWarning: boolean
  expectMessageContains?: string
}

const DEFAULT_TARGET = 'C:\\Users\\kings\\.config\\opencode'

const scenarios: Scenario[] = [
  {
    name: 'happy path: no env, no running opencode → silent',
    envOverride: null,
    runtimeConfigDir: null,
    expectWarning: false,
  },
  {
    name: 'user-intentional: env set, no opencode running, target resolves to env → silent',
    envOverride: 'D:\\custom\\opencode-config',
    runtimeConfigDir: null,
    expectWarning: false,
  },
  {
    name: 'mismatch: env set in shell, opencode runs elsewhere → WARNING',
    envOverride: 'C:\\Users\\kings\\AppData\\Roaming\\orca\\opencode-hooks\\shared',
    runtimeConfigDir: 'C:\\Users\\kings\\.config\\opencode',
    expectWarning: true,
    expectMessageContains: 'orca',
  },
  {
    name: 'mismatch: no env in shell, opencode runs with --config-dir elsewhere → WARNING',
    envOverride: null,
    runtimeConfigDir: 'D:\\dev\\opencode-config',
    expectWarning: true,
    expectMessageContains: 'dev',
  },
  {
    name: 'env set + opencode also uses the same dir → silent',
    envOverride: 'C:\\Users\\kings\\.config\\opencode',
    runtimeConfigDir: 'C:\\Users\\kings\\.config\\opencode',
    expectWarning: false,
  },
  {
    name: 'both diverge to different places → both warnings shown',
    envOverride: 'C:\\shell-only',
    runtimeConfigDir: 'D:\\runtime-only',
    expectWarning: true,
    expectMessageContains: 'shell-only',
  },
]

let passed = 0
let failed = 0

for (const s of scenarios) {
  const originalEnv = process.env.OPENCODE_CONFIG_DIR
  if (s.envOverride === null) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = s.envOverride

  // Mirror what executeInstall() does: targetDir = env ? env : default
  const targetDir = s.envOverride ?? DEFAULT_TARGET
  const warning = warnInstallTargetMismatch(targetDir, s.runtimeConfigDir)

  if (s.expectWarning) {
    if (warning === null) {
      console.error(`✗ FAIL: ${s.name}\n  expected a warning, got null`)
      failed++
    } else if (s.expectMessageContains && !warning.includes(s.expectMessageContains)) {
      console.error(`✗ FAIL: ${s.name}\n  warning did not contain "${s.expectMessageContains}":\n${warning}`)
      failed++
    } else {
      console.log(`✓ PASS: ${s.name}`)
      passed++
    }
  } else {
    if (warning !== null) {
      console.error(`✗ FAIL: ${s.name}\n  expected no warning, got:\n${warning}`)
      failed++
    } else {
      console.log(`✓ PASS: ${s.name}`)
      passed++
    }
  }

  if (originalEnv === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = originalEnv
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)