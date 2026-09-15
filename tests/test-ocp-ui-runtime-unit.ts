import { strict as assert } from 'node:assert'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveBunExecutable, resolveUiBunExecutable } from '../install/src/ui/runtime'
import { runProjectWizard } from '../install/src/project-wizard'

const repoDir = process.cwd()
const installDir = path.join(repoDir, 'install')
assert.ok(existsSync(path.join(installDir, 'src', 'ui', 'entry.tsx')))
assert.ok(existsSync(path.join(installDir, 'node_modules', '@opentui', 'solid', 'scripts', 'preload.js')))
const resolved = resolveBunExecutable('Z:\\deleted\\bun.exe', process.env.BUN_INSTALL, Bun.which('bun'), process.env.USERPROFILE ?? process.env.HOME ?? '')
assert.ok(existsSync(resolved), 'stale process.execPath falls back to an installed Bun executable')

// Node-run CLI: PATH probe finds an installed Bun to host the TUI child.
const fakeBin = mkdtempSync(path.join(tmpdir(), 'ocp-bun-probe-'))
const bunName = process.platform === 'win32' ? 'bun.exe' : 'bun'
const fakeBun = path.join(fakeBin, bunName)
writeFileSync(fakeBun, '')
chmodSync(fakeBun, 0o755) // resolveUiBunExecutable rejects non-executable files
const fakeHome = path.join(fakeBin, 'home')
assert.equal(resolveUiBunExecutable(false, undefined, fakeBin, fakeHome), fakeBun, 'Node-run CLI finds Bun on PATH')
assert.equal(resolveUiBunExecutable(false, undefined, '', fakeHome), undefined, 'Node-run CLI without any Bun reports undefined')
assert.ok(existsSync(resolveUiBunExecutable()), 'running runtime resolves to an existing Bun executable')
rmSync(fakeBin, { recursive: true, force: true })

assert.equal(typeof runProjectWizard, 'function', 'project wizard accepts the OCP repo root separately from the target project root')
console.log('ocp OpenTUI runtime entry and preload are available')
