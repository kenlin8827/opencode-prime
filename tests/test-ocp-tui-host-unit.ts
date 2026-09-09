import { strict as assert } from 'node:assert'
import { createTuiHost } from '../install/src/ui/tui-host'

const host = createTuiHost(new Map([['locale', 'en']]))
let closed = 0
host.replace({ kind: 'alert', title: 'first', message: 'first' }, () => closed++)
host.replace({ kind: 'alert', title: 'second', message: 'second' }, () => closed++)
// replace() fires the replaced frame's onClose — mirrors opencode's dialog stack
assert.equal(closed, 1)
host.close()
assert.equal(closed, 2)
// close() with no frame onClose falls back to the route-level default
let defaults = 0
host.setDefaultOnClose(() => defaults++)
host.replace({ kind: 'alert', title: 'root', message: 'root' })
host.close()
assert.equal(defaults, 1)
assert.equal(closed, 2, 'default must not stack on top of an explicit onClose')
// clear() drops the stack silently (apply/reset flows)
host.replace({ kind: 'alert', title: 'x', message: 'x' }, () => closed++)
host.clear()
host.close()
assert.equal(closed, 2, 'cleared stack must not fire the stale onClose')
let input = ''
host.register('test.command', (value) => { input = value ?? '' })
assert.equal(host.dispatch('test.command', 'run'), true)
assert.equal(host.dispatch('missing'), false)
assert.equal(input, 'run')
assert.equal(host.kvGet('locale'), 'en')
// setSize: plugin-managed width tiers; replace() resets so frames that never
// call setSize fall back to the Modal default instead of inheriting stale tiers
host.setSize('xlarge')
assert.equal(host.size(), 'xlarge')
host.replace({ kind: 'alert', title: 'sized', message: 'sized' })
assert.equal(host.size(), undefined, 'replace must reset a stale size tier')
host.setSize('medium')
host.clear()
assert.equal(host.dialog(), undefined)
console.log('ocp tui host dialog-stack semantics and command dispatch tests passed')
