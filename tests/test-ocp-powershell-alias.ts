/** Regression test: `ocp install` must not forward a phantom empty argument. */
import fs from 'node:fs'
import path from 'node:path'

const alias = fs.readFileSync(path.resolve(import.meta.dir, '../bin/ocp.ps1'), 'utf8')

if (!alias.includes('if ($Rest.Count -gt 0)') || !alias.includes('& $Dispatcher $Subcommand')) {
  console.error('❌ PowerShell ocp alias must omit an empty Rest argument array.')
  process.exit(1)
}

console.log('✅ PowerShell ocp alias omits a phantom empty argument.')
