/**
 * Guard the Luvus cold-start sequence: workspace commands need a running
 * Luvus server, so the launcher must bootstrap it before opening the cwd.
 *
 * Run: bun run tests/test-ocp-luvus-server-start-unit.ts
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve(import.meta.dir, '../install/src/launcher.ts'), 'utf8')
const start = source.indexOf("spawnSync('luvus', ['server', 'start']")
const open = source.indexOf("spawnSync('luvus', ['workspace', 'open', cwd]")

assert.ok(start >= 0, 'Luvus launcher starts the background server')
assert.ok(open >= 0, 'Luvus launcher opens the current directory as a workspace')
assert.ok(start < open, 'Luvus server starts before the workspace is opened')

console.log('ocp Luvus server cold-start sequence test passed')
