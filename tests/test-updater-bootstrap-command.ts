/** Regression test: self-upgrade must invoke the bootstrap default action. */
import fs from 'node:fs'
import path from 'node:path'

const updater = fs.readFileSync(path.resolve(import.meta.dir, '../install/src/updater.ts'), 'utf8')
const hasWindowsDefaultAction = /spawnSync\('pwsh', \['-NoProfile', '-File', script, \.\.\.rest\]/.test(updater)
const hasUnixDefaultAction = /spawnSync\('bash', \[script, \.\.\.rest\]/.test(updater)
const passesExplicitInstall = /spawnSync\((?:'pwsh'|'bash'), \[[^\]]*['"]install['"]/.test(updater)

if (!hasWindowsDefaultAction || !hasUnixDefaultAction || passesExplicitInstall) {
  console.error('❌ Upgrade bootstrap must not pass an explicit install action.')
  process.exit(1)
}

console.log('✅ Upgrade bootstrap uses the installer default action.')
