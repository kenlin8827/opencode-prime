/**
 * Guard the Luvus cold-start sequence: workspace commands need a running
 * Luvus server, so the launch plan must bootstrap it before opening the cwd.
 *
 * Re-anchored (ADR-0004 phase 4, pre-existing staleness from de0022f's
 * engine refactor): the sequence is no longer inline spawnSync calls in
 * launcher.ts — it is data. The contract now lives in three files:
 *   install/tools.jsonc            luvus "tui".pre_launch ORDER
 *   .../engines/luvus/ensure-server.js   runs `luvus server start`
 *   .../engines/luvus/open-workspace.js  runs `luvus workspace open <cwd>`
 *
 * Run: bun run tests/test-ocp-luvus-server-start-unit.ts
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dir, '..')
const tools = readFileSync(join(repo, 'install/tools.jsonc'), 'utf8')
const ensure = readFileSync(join(repo, 'install/scripts/engines/luvus/ensure-server.js'), 'utf8')
const open = readFileSync(join(repo, 'install/scripts/engines/luvus/open-workspace.js'), 'utf8')

assert.ok(ensure.includes("cli(['server', 'start']"), 'ensure-server step starts the background server')
assert.ok(open.includes("cli(['workspace', 'open', cwd]"), 'open-workspace step opens the current directory')

// The ORDER that matters: server before workspace (workspace open is a
// client command that needs the socket). Assert via the tools.jsonc plan.
const ensurePos = tools.indexOf('"name": "ensure-server"')
const openPos = tools.indexOf('"name": "open-workspace"')
assert.ok(ensurePos >= 0, 'luvus tui plan declares ensure-server')
assert.ok(openPos >= 0, 'luvus tui plan declares open-workspace')
assert.ok(ensurePos < openPos, 'Luvus server starts before the workspace is opened')

console.log('ocp Luvus server cold-start sequence test passed')
