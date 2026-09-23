/**
 * Unit tests for install/src/shared/opencode-detect.ts (pure path
 * classification + snapshot structure) and the @pm: package-manager
 * resolution chain (resolvePmForSpec in install/src/package-manager.ts).
 *
 * No network, no real PATH dependence: installMethodFromPath is pure, and
 * resolvePmForSpec is exercised with injected isAvailable /
 * resolveBinaryPath / opencodeMethod. The detectOpencode() block pins the
 * snapshot's STRUCTURE only — never machine-specific values.
 *
 * Run: bun tests/test-opencode-detect-unit.ts
 */

import path from 'node:path'
import { detectOpencode, installMethodFromPath, type InstallMethod } from '../install/src/shared/opencode-detect'
import { resolvePmForSpec } from '../install/src/package-manager'

let passed = 0
let failed = 0

function assert(cond: unknown, label: string) {
  if (cond) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.error(`  ❌ ${label}`)
  }
}

function assertMethod(binPath: string, expected: InstallMethod, why: string) {
  assert(installMethodFromPath(binPath) === expected, `${why} → ${expected} [${binPath}]`)
}

console.log('installMethodFromPath — bun')
assertMethod('C:\\Users\\me\\.bun\\bin\\opencode.exe', 'bun', 'win32 .bun\\bin')
assertMethod('C:/Users/me/.bun/bin/opencode.exe', 'bun', 'win32 forward slashes')
assertMethod('/home/me/.bun/bin/opencode', 'bun', 'posix ~/.bun/bin')
assertMethod('C:\\USERS\\ME\\.BUN\\BIN\\OPENCODE.EXE', 'bun', 'case-insensitive')
assertMethod('C:\\Users\\Bunny\\.bun\\bin\\tool.exe', 'bun', 'Bunny home WITH .bun\\bin is bun')

console.log('installMethodFromPath — the C:\\Users\\Bunny false-positive class')
assertMethod('C:\\Users\\Bunny\\bin\\tool.exe', 'unknown', 'naive substring would call this bun')
assertMethod('C:\\Users\\Bunny\\tools\\opencode.exe', 'unknown', 'no marker anywhere')
assertMethod('/home/rabbit/.bin/tool', 'unknown', 'near-miss segment names')

console.log('installMethodFromPath — pnpm')
assertMethod('C:\\Users\\me\\AppData\\Local\\pnpm\\openchamber.cmd', 'pnpm', 'win32 %LOCALAPPDATA%\\pnpm')
assertMethod('/home/me/.local/share/pnpm/opencode', 'pnpm', 'posix ~/.local/share/pnpm')

console.log('installMethodFromPath — npm')
assertMethod('C:\\Users\\me\\AppData\\Roaming\\npm\\openchamber.cmd', 'npm', 'win32 %APPDATA%\\npm shim')
assertMethod(
  'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe',
  'npm',
  'win32 shim-resolved package binary',
)
assertMethod('/usr/local/lib/node_modules/.bin/opencode', 'npm', 'posix system npm (/usr/local/lib)')
assertMethod('/usr/lib/node_modules/opencode-ai/bin/opencode', 'npm', 'posix system npm (/usr/lib)')
assertMethod('/home/me/.npm-global/bin/opencode', 'npm', 'custom npm prefix')
assertMethod('/home/me/.nvm/versions/node/v20.11.0/bin/opencode', 'npm', 'nvm-managed node')

console.log('installMethodFromPath — official (checked after the pm dirs)')
assertMethod('C:\\Users\\me\\.opencode\\bin\\opencode.exe', 'official', 'win32 official installer dir')
assertMethod('/home/me/.opencode/bin/opencode', 'official', 'posix official installer dir')
assertMethod('/home/me/.local/bin/opencode', 'official', 'generic ~/.local/bin')
assertMethod('/home/me/.local/share/pnpm/opencode', 'pnpm', 'pnpm wins over the generic .local prefix')

console.log('installMethodFromPath — unknown')
assertMethod('/usr/bin/opencode', 'unknown', 'system package manager dir is not in the table')
assertMethod('C:\\Windows\\System32\\tool.exe', 'unknown', 'system dir')
assertMethod('', 'unknown', 'empty path')

console.log('resolvePmForSpec — decision chain (injected, no PATH dependence)')

const anyAvailable = () => true

// 1. Per-tool ownership wins over opencode's own install method.
const owned = resolvePmForSpec('@openchamber/web@latest', {
  binary: 'openchamber',
  resolveBinaryPath: () => 'C:\\Users\\me\\AppData\\Roaming\\npm\\openchamber.cmd',
  opencodeMethod: 'bun',
  isAvailable: anyAvailable,
})
assert(owned?.bin === 'npm', 'npm-owned binary wins even when opencode itself is bun-installed')
assert(
  JSON.stringify(owned?.args) === JSON.stringify(['install', '-g', '@openchamber/web@latest']),
  'npm global-add args carry the scoped spec + dist-tag',
)

// 2. Ownership that classifies non-pm (official) falls through to opencode's method.
const officialOwned = resolvePmForSpec('herdr-cli', {
  binary: 'opencode',
  resolveBinaryPath: () => '/home/me/.opencode/bin/opencode',
  opencodeMethod: 'pnpm',
  isAvailable: anyAvailable,
})
assert(officialOwned?.bin === 'pnpm', 'official binary ownership falls through to the opencode method proxy')

// 3. Binary not on PATH → ownership layer skipped.
const ghostBinary = resolvePmForSpec('herdr-cli', {
  binary: 'ghost',
  resolveBinaryPath: () => null,
  opencodeMethod: 'yarn',
  isAvailable: (m) => m === 'yarn',
})
assert(ghostBinary?.bin === 'yarn', 'missing binary skips the ownership layer')

// 4. Opencode method as proxy.
assert(
  resolvePmForSpec('pkg', { opencodeMethod: 'bun', isAvailable: (m) => m === 'bun' })?.bin === 'bun',
  'opencode bun method selects bun',
)

// 5. official / unknown opencode → npm fallback.
assert(
  resolvePmForSpec('pkg', { opencodeMethod: 'official', isAvailable: (m) => m === 'npm' })?.bin === 'npm',
  'official opencode → npm fallback',
)
assert(
  resolvePmForSpec('pkg', { opencodeMethod: 'unknown', isAvailable: (m) => m === 'npm' })?.bin === 'npm',
  'unknown opencode → npm fallback',
)

// 6. Selected manager not on PATH → degrade to npm.
assert(
  resolvePmForSpec('pkg', { opencodeMethod: 'bun', isAvailable: (m) => m === 'npm' })?.bin === 'npm',
  'bun selected but missing → degrade to npm',
)

// 7. Owned manager missing → the availability gate applies to layer 1 too.
const ownedMissing = resolvePmForSpec('pkg', {
  binary: 'tool',
  resolveBinaryPath: () => '/home/me/.bun/bin/tool',
  opencodeMethod: 'npm',
  isAvailable: (m) => m === 'npm',
})
assert(ownedMissing?.bin === 'npm', 'bun-owned binary with bun missing → npm')

// 8. npm also missing → null (caller prints the manual hint).
assert(
  resolvePmForSpec('pkg', { opencodeMethod: 'bun', isAvailable: () => false }) === null,
  'no manager on PATH → null',
)
assert(
  resolvePmForSpec('pkg', {
    binary: 'tool',
    resolveBinaryPath: () => '/home/me/.bun/bin/tool',
    isAvailable: () => false,
  }) === null,
  'owned-but-missing + npm missing → null',
)

// 9. Scoped-spec parsing through the manager command shapes.
const bunScoped = resolvePmForSpec('@openchamber/web@latest', { opencodeMethod: 'bun', isAvailable: anyAvailable })
assert(
  bunScoped?.bin === 'bun' && bunScoped.args.join(' ') === 'add -g @openchamber/web@latest',
  'bun global-add carries the scoped spec verbatim',
)
const yarnScoped = resolvePmForSpec('@scope/pkg', { opencodeMethod: 'yarn', isAvailable: anyAvailable })
assert(yarnScoped?.args.join(' ') === 'global add @scope/pkg', 'yarn global-add carries the scoped spec verbatim')

// 10. Empty spec → null.
assert(resolvePmForSpec('', { opencodeMethod: 'npm', isAvailable: anyAvailable }) === null, 'empty spec → null')

console.log('detectOpencode — snapshot structure (machine-independent invariants)')

const snap = detectOpencode()
assert(typeof snap.configDir === 'string' && snap.configDir.length > 0, 'configDir is a non-empty string')
assert(
  ['bun', 'pnpm', 'yarn', 'npm', 'official', 'unknown'].includes(snap.installMethod),
  'installMethod is a valid InstallMethod',
)
assert(typeof snap.installed === 'boolean', 'installed is a boolean')
assert(snap.installed === (snap.executable !== null), 'installed is derived from executable (executable !== null)')
assert(
  snap.executable === null
    ? snap.binDir === null && snap.version === null && snap.installMethod === 'unknown'
    : snap.binDir === path.dirname(snap.executable) &&
        (snap.version === null || typeof snap.version === 'string') &&
        snap.installMethod === installMethodFromPath(snap.executable),
  'snapshot fields are mutually consistent',
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
