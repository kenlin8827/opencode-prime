/**
 * Cross-platform unit test for the --config-dir regex shared by all
 * per-platform probes in install/src/shared/opencode-detect.ts.
 *
 * Run: bun tests/test-probe-opencode-configdir-unit.ts
 *
 * Why this exists: opencode-detect.ts has three platform-specific probe
 * functions (probeWindows via wmic, probeLinux via /proc, probeDarwin
 * via ps -wwE). The shared bit — the regex that parses `--config-dir=X`
 * out of any of those outputs — is platform-agnostic and MUST accept:
 *
 *   - Windows: `--config-dir=C:\Users\me\.config\opencode`
 *   - Windows: `--config-dir "C:\Users\me\.config\opencode"`
 *   - Windows: `--config-dir=C:\Users\me\.config\opencode`
 *   - POSIX:   `--config-dir=/home/me/.config/opencode`
 *   - POSIX:   `--config-dir "/home/me/.config/opencode"`
 *   - wmic:    `CommandLine=...\opencode.exe --config-dir="D:\foo" ...`
 *
 * The regex lives in shared/opencode-detect.ts (private
 * `matchConfigDirFromString`; moved verbatim from installer.ts).
 * To keep the test cross-platform-portable without monkey-patching
 * spawnSync or /proc, this test re-declares the EXACT same regex here
 * AND asserts that the source file's regex literal is character-for-
 * character identical. If the source drifts without updating the test,
 * the test fails loud — that's the contract.
 */
import fs from 'node:fs'
import path from 'node:path'

// Mirror — keep in lock-step with install/src/shared/opencode-detect.ts.
const REGEX = /--config-dir(?:=|\s+)?["']?((?:[A-Za-z]:[\\\/][^\s"']+|\/[^\s"']+))["']?/

// Read opencode-detect.ts and pull the regex literal out of the source.
const detectSrc = fs.readFileSync(
  path.join(import.meta.dir, '..', 'install', 'src', 'shared', 'opencode-detect.ts'),
  'utf8',
)
// Extract the literal in matchConfigDirFromString — capture from `--config-dir`
// to the closing slash + flags. Source line:
//   const m = s.match(/--config-dir(?:=|\s+)?["']?((?:[A-Za-z]:[\\\/][^\s"']+|\/[^\s"']+))["']?/)
const m = detectSrc.match(/matchConfigDirFromString\(s:\s*string\)[^}]+const m = s\.match\((\/[^\n]+\/)\)/)
if (!m) {
  console.error('✗ FAIL: could not locate matchConfigDirFromString regex in opencode-detect.ts')
  process.exit(1)
}
const sourceRegexLiteral = m[1]!.trim()

// Assert the test mirror matches the source — this is the cross-platform
// invariant. If the source regex changes, this fails loud and forces an
// explicit test update.
if (sourceRegexLiteral !== REGEX.toString()) {
  console.error('✗ FAIL: regex in opencode-detect.ts drifted from the test mirror.')
  console.error('  source: ' + sourceRegexLiteral)
  console.error('  test:   ' + REGEX.toString())
  console.error('  Update tests/test-probe-opencode-configdir-unit.ts to match.')
  process.exit(1)
}
console.log(`✓ Regex matches opencode-detect.ts (${REGEX.toString()})`)

interface Case {
  input: string
  expected: string | null
  why: string
}

const cases: Case[] = [
  // Windows paths
  { input: `opencode.exe --config-dir=C:\\Users\\me\\.config\\opencode`, expected: 'C:\\Users\\me\\.config\\opencode', why: 'Windows = form' },
  { input: `opencode.exe --config-dir "D:\\custom\\opencode-config"`, expected: 'D:\\custom\\opencode-config', why: 'Windows space form + quotes' },
  { input: `CommandLine=C:\\dev\\bun\\bin\\opencode.exe --config-dir=C:\\Users\\me\\.config\\opencode `, expected: 'C:\\Users\\me\\.config\\opencode', why: 'wmic CommandLine= prefix' },
  // POSIX paths
  { input: `/usr/local/bin/opencode --config-dir=/home/me/.config/opencode`, expected: '/home/me/.config/opencode', why: 'POSIX = form' },
  { input: `/usr/local/bin/opencode --config-dir "/Users/me/.config/opencode"`, expected: '/Users/me/.config/opencode', why: 'POSIX space + quotes' },
  // Negatives
  { input: `opencode.exe`, expected: null, why: 'no flag → null' },
  { input: `opencode.exe --session ses_abc123`, expected: null, why: 'unrelated flag → null' },
]

let passed = 0
let failed = 0
for (const c of cases) {
  const mm = c.input.match(REGEX)
  // Compare without path.normalize — `path.normalize` is platform-dependent
  // and would turn "/home/me" into "\home\me" on Windows even though the
  // regex matched correctly. The installer.ts caller applies normalize;
  // here we only assert the regex extracts the right substring.
  const got = mm ? mm[1]! : null
  if (got === c.expected) {
    console.log(`✓ PASS: ${c.why}`)
    passed++
  } else {
    console.error(`✗ FAIL: ${c.why}`)
    console.error(`    input:    ${JSON.stringify(c.input)}`)
    console.error(`    expected: ${JSON.stringify(c.expected)}`)
    console.error(`    got:      ${JSON.stringify(got)}`)
    failed++
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)