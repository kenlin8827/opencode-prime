import { strict as assert } from 'node:assert'
import { resolveProviderMode, runProviderCli } from '../install/src/provider-wizard'
import { resolveProfileMode } from '../install/src/profile-wizard'

assert.equal(resolveProviderMode([]), 'wizard')
assert.equal(resolveProviderMode(['list']), 'list')
assert.equal(resolveProviderMode(['apply']), 'usage')
assert.equal(resolveProviderMode(['list', 'extra']), 'usage')
const errors: string[] = []
const originalError = console.error
console.error = (...args: unknown[]) => { errors.push(args.join(' ')) }
try {
  assert.equal(await runProviderCli(process.cwd(), []), 1)
} finally {
  console.error = originalError
}
assert.deepEqual(errors, ['[ocp] Interactive UI requires an interactive terminal.'])
assert.equal(resolveProfileMode([], true), 'wizard')
assert.equal(resolveProfileMode(['list'], false), 'list')
assert.equal(resolveProfileMode(['apply', 'anthropic'], false), 'apply')
assert.equal(resolveProfileMode(['reset'], true), 'reset-interactive')
assert.equal(resolveProfileMode(['reset'], false), 'usage')
assert.equal(resolveProfileMode(['reset', '--yes'], false), 'reset-force')
assert.equal(resolveProfileMode(['reset', '--no'], true), 'usage')
console.log('ocp wizard CLI routing tests passed')
