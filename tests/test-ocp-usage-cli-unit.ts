import { strict as assert } from 'node:assert'
import { resolveUsageMode } from '../install/src/usage'

assert.equal(resolveUsageMode([]), 'all')
assert.equal(resolveUsageMode(['--all']), 'all')
assert.equal(resolveUsageMode(['.']), 'current')
assert.equal(resolveUsageMode(['ses_123']), 'session')
assert.equal(resolveUsageMode(['--help']), 'usage')
assert.equal(resolveUsageMode(['first', 'second']), 'usage')
console.log('ocp usage CLI tests passed')
