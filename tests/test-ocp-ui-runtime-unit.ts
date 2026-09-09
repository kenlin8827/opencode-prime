import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { resolveBunExecutable } from '../install/src/ui/runtime'
import { runProjectWizard } from '../install/src/project-wizard'

const repoDir = process.cwd()
const installDir = path.join(repoDir, 'install')
assert.ok(existsSync(path.join(installDir, 'src', 'ui', 'entry.tsx')))
assert.ok(existsSync(path.join(installDir, 'node_modules', '@opentui', 'solid', 'scripts', 'preload.js')))
const resolved = resolveBunExecutable('Z:\\deleted\\bun.exe', process.env.BUN_INSTALL, Bun.which('bun'), process.env.USERPROFILE ?? process.env.HOME ?? '')
assert.ok(existsSync(resolved), 'stale process.execPath falls back to an installed Bun executable')
assert.equal(typeof runProjectWizard, 'function', 'project wizard accepts the OCP repo root separately from the target project root')
console.log('ocp OpenTUI runtime entry and preload are available')
