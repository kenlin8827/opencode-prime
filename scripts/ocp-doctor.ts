/**
 * ocp-doctor — diagnose and repair the OCP install state vs source repo.
 *
 * Run: bun scripts/ocp-doctor.ts
 * Flags: --fix          apply the recommended fix in-place
 *        --fix-and-install  apply fix + run `ocp install --force --default-config` + emit restart hint
 *
 * Root cause this script exists for:
 *   `ocp --version` reads source/install/version.json; the opencode sidebar
 *   reads $OPENCODE_CONFIG_DIR/installed.version. When those two paths
 *   diverge, the user sees "version mismatch" with no obvious culprit.
 *   Common divergence points:
 *
 *   1. `ocp install` was never run after `git pull` (source newer).
 *   2. `OPENCODE_CONFIG_DIR` is set differently in the shell vs the
 *      opencode process — install writes to one place, opencode reads
 *      another. This is the most common cause in dev-env setups with a
 *      wrapper that injects the env var per-process (orca's
 *      opencode-hooks is the canonical Windows example).
 *   3. The `installed.version` exists but was written by a previous
 *      OCP version that had a stale `repoRoot` resolution.
 *
 *   The script probes each point, reports OK / MISMATCH, and (with --fix
 *   or --fix-and-install) writes `installed.version` to the directory the
 *   *opencode process* actually reads, then optionally runs `ocp install
 *   --force --default-config` with that env var cleared so both sides
 *   converge.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = new Set(process.argv.slice(2))
const FIX = args.has('--fix') || args.has('--fix-and-install')
const FIX_AND_INSTALL = args.has('--fix-and-install')

const IS_WIN = process.platform === 'win32'
const home = os.homedir()

interface Divergence {
  id: string
  severity: 'info' | 'warn' | 'error'
  message: string
  fix: (() => void) | null
}

const results: Divergence[] = []
const log = (s: string): void => console.log(s)

function sh(cmd: string): string {
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8' })
  return (r.stdout ?? '') + (r.stderr ?? '')
}

function firstLine(s: string): string {
  return s.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('INFO')) ?? ''
}

function resolveOcpShim(): { source: string; repoRoot: string } | null {
  const exe = IS_WIN ? 'ocp.cmd' : 'ocp'
  const out = sh(IS_WIN ? `where ${exe}` : `which ${exe}`)
  const first = firstLine(out)
  if (!first) return null
  if (first.endsWith(`bin${path.sep}${exe}`) || first.endsWith(`/bin/${exe}`)) {
    return { source: first, repoRoot: path.dirname(path.dirname(first)) }
  }
  // Trampoline (e.g. opencode-prime-trampoline → pwsh -File <repoRoot>/bin/<shim>)
  if (existsSync(first)) {
    const content = readFileSync(first, 'utf8')
    const m = content.match(/['"]([A-Za-z]:[\\/][^'"]*?)bin[\\/][^'"]+['"]/)
    if (m) return { source: first, repoRoot: path.normalize(m[1]!) }
  }
  return null
}

function probeRepoVersion(repoDir: string): { value: string | null; file: string | null } {
  for (const file of [
    path.join(repoDir, 'install', 'version.json'),
    path.join(repoDir, 'install', 'VERSION'),
  ]) {
    if (!existsSync(file)) continue
    const raw = readFileSync(file, 'utf8').trim()
    if (!raw) continue
    if (file.endsWith('version.json')) {
      const m = raw.match(/"version"\s*:\s*"([^"]+)"/)
      return { value: m?.[1] ?? raw, file }
    }
    return { value: raw, file }
  }
  return { value: null, file: null }
}

function probeInstalledVersion(targetDir: string): { value: string | null; file: string; mtime: Date | null } {
  const file = path.join(targetDir, 'installed.version')
  if (!existsSync(file)) return { value: null, file, mtime: null }
  const raw = readFileSync(file, 'utf8').trim()
  return { value: raw || null, file, mtime: statSync(file).mtime }
}

function resolveConfigDirs(): {
  shellConfigDir: string
  defaultConfigDir: string
  shellHasOverride: boolean
} {
  const shellOverride = process.env.OPENCODE_CONFIG_DIR
    ? path.resolve(process.env.OPENCODE_CONFIG_DIR)
    : null
  const defaultDir = path.join(home, '.config', 'opencode')
  return {
    shellConfigDir: shellOverride ?? defaultDir,
    defaultConfigDir: defaultDir,
    shellHasOverride: Boolean(shellOverride),
  }
}

interface OpencodeProc {
  pid: number
  configDir: string | null
  cmdline: string
}

function probeRunningOpencode(): OpencodeProc[] {
  const procs: OpencodeProc[] = []
  if (IS_WIN) {
    const r = sh('wmic process where "name=\'opencode.exe\'" get ProcessId,CommandLine /format:list')
    const blocks = r.split(/\r?\n\r?\n/)
    for (const block of blocks) {
      const pidMatch = block.match(/ProcessId=(\d+)/)
      if (!pidMatch) continue
      const cmd = block.split(/\r?\n/).filter((l) => l.startsWith('CommandLine=')).join(' ')
      const envMatch = cmd.match(/OPENCODE_CONFIG_DIR=([^\s"]+)/)
      procs.push({ pid: Number(pidMatch[1]), configDir: envMatch?.[1] ?? null, cmdline: cmd.slice('CommandLine='.length) })
    }
  } else {
    const r = sh('pgrep -af opencode')
    for (const line of r.split(/\n/)) {
      const m = line.match(/^(\d+)\s+(.*)$/)
      if (!m) continue
      const envMatch = m[2].match(/OPENCODE_CONFIG_DIR=([^\s"]+)/)
      procs.push({ pid: Number(m[1]), configDir: envMatch?.[1] ?? null, cmdline: m[2] })
    }
  }
  return procs
}

function main(): void {
  log('=== OCP doctor ===\n')

  const ocp = resolveOcpShim()
  if (!ocp) {
    results.push({ id: 'ocp-shim', severity: 'error', message: '`ocp` not found on PATH.', fix: null })
  } else {
    log(`ocp shim:     ${ocp.source}`)
    log(`ocp repoRoot: ${ocp.repoRoot}`)
  }

  let repoVersion: string | null = null
  if (ocp) {
    const v = probeRepoVersion(ocp.repoRoot)
    repoVersion = v.value
    log(`source version: ${v.value ?? '<missing>'}  (${v.file})`)
    if (!v.value) {
      results.push({ id: 'repo-version', severity: 'error', message: 'Repo has no version file.', fix: null })
    }
  }

  const cfg = resolveConfigDirs()
  log(`\nshell OPENCODE_CONFIG_DIR: ${cfg.shellHasOverride ? cfg.shellConfigDir : '(unset)'}`)
  log(`default config dir:        ${cfg.defaultConfigDir}`)

  const procs = probeRunningOpencode()
  if (procs.length === 0) {
    log('\nrunning opencode:  (none)')
  } else {
    log(`\nrunning opencode:  ${procs.length} process(es)`)
    for (const p of procs) {
      log(`  pid ${p.pid}  OPENCODE_CONFIG_DIR=${p.configDir ?? '<unset, uses default>'}`)
      log(`    cmd: ${p.cmdline.slice(0, 200)}${p.cmdline.length > 200 ? '…' : ''}`)
    }
  }

  const targets = new Set<string>([cfg.shellConfigDir, cfg.defaultConfigDir])
  for (const p of procs) if (p.configDir) targets.add(p.configDir)
  log('\ninstalled.version per candidate dir:')
  for (const dir of targets) {
    const v = probeInstalledVersion(dir)
    if (!v.value) {
      log(`  ${dir}:  <missing>`)
    } else {
      log(`  ${dir}:  ${v.value}  (mtime ${v.mtime?.toISOString()})`)
    }
  }

  let authoritativeDir = cfg.defaultConfigDir
  if (procs.length > 0) {
    const dirs = new Set(procs.map((p) => p.configDir ?? cfg.defaultConfigDir))
    if (dirs.size > 1) {
      results.push({
        id: 'multi-config',
        severity: 'error',
        message: `Running opencode processes use ${dirs.size} different config dirs: ${[...dirs].join(', ')}. They will not see each other's files.`,
        fix: null,
      })
    }
    authoritativeDir = procs[0]!.configDir ?? cfg.defaultConfigDir
  } else if (cfg.shellHasOverride) {
    authoritativeDir = cfg.shellConfigDir
  }
  log(`\nauthoritative target dir (where to write installed.version): ${authoritativeDir}`)

  const auth = probeInstalledVersion(authoritativeDir)
  if (!auth.value && repoVersion) {
    results.push({
      id: 'installed-version',
      severity: 'warn',
      message: `${auth.file} missing or empty. opencode sidebar will show "unknown".`,
      fix: () => writeFileSync(auth.file, `${repoVersion}\n`, 'utf8'),
    })
  } else if (auth.value && repoVersion && auth.value !== repoVersion) {
    results.push({
      id: 'installed-version',
      severity: 'warn',
      message: `${auth.file} says ${auth.value}, source says ${repoVersion}. Sidebar will lag source until reinstall.`,
      fix: () => writeFileSync(auth.file, `${repoVersion}\n`, 'utf8'),
    })
  } else if (auth.value && repoVersion) {
    log(`\nOK — authoritative installed.version (${auth.value}) matches source (${repoVersion})`)
  }

  if (targets.size > 1) {
    const versions = [...targets].map((d) => probeInstalledVersion(d).value)
    const distinct = new Set(versions)
    if (distinct.size > 1) {
      results.push({
        id: 'cross-dir',
        severity: 'info',
        message: `Multiple install dirs exist with different versions (${[...distinct].join(', ')}). ` +
                 `Authoritative dir (${authoritativeDir}) will be kept in sync; other dirs are harmless leftovers unless opencode is started with a different OPENCODE_CONFIG_DIR.`,
        fix: null,
      })
    }
  }

  if (cfg.shellHasOverride && cfg.shellConfigDir !== cfg.defaultConfigDir) {
    results.push({
      id: 'orca-hooks',
      severity: 'warn',
      message: `OPENCODE_CONFIG_DIR is set in this shell to ${cfg.shellConfigDir}, which differs from the canonical default ${cfg.defaultConfigDir}. ` +
               `If you want to install to the default (the dir the running opencode TUI actually reads), pass --default-config/-D, OR run \`bun scripts/ocp-doctor.ts --fix-and-install\` which does it for you.`,
      fix: null,
    })
  }

  log('\n=== summary ===')
  if (results.length === 0) {
    log('OK — no divergence detected.')
  } else {
    for (const r of results) {
      log(`[${r.severity.toUpperCase()}] ${r.id}: ${r.message}`)
      if (r.fix) log(`  fix available${FIX ? ' (applying now)' : ' (use --fix to apply)'}`)
    }
  }

  if (FIX) {
    log('\n=== applying fixes ===')
    let applied = 0
    for (const r of results) {
      if (!r.fix) continue
      try {
        r.fix()
        applied++
        log(`  ✓ fixed ${r.id}`)
      } catch (e) {
        log(`  ✗ failed to fix ${r.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (applied === 0) log('  (nothing to apply)')
  }

  if (FIX_AND_INSTALL && ocp) {
    log('\n=== running `ocp install --force --default-config` ===')
    log('  (--default-config bypasses OPENCODE_CONFIG_DIR — installs to ~/.config/opencode/)')
    const env = { ...process.env } as NodeJS.ProcessEnv
    delete env.OPENCODE_CONFIG_DIR
    const cmd = IS_WIN ? 'ocp.cmd' : 'ocp'
    const res = spawnSync(cmd, ['install', '--force', '--default-config'], {
      cwd: ocp.repoRoot,
      stdio: 'inherit',
      shell: true,
      env,
    })
    log(`\nocp install exited with code ${res.status ?? 'unknown'}`)
  }

  if (procs.length > 0) {
    log('\nRestart hint: `taskkill /F /IM opencode.exe` then `ocp tui` to pick up new files.')
  }
}

main()