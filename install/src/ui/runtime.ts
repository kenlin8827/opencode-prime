import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { OcpRoute } from './router'

interface OcpUiRuntimeContext {
  repoDir: string
  root?: string
  sessionId?: string
}

/** What a TUI child asks the parent CLI to do after it exits. */
export interface OcpUiInstallRequest {
  action: 'install'
  /** Install target chosen in the UI; absent → parent uses the default target. */
  target?: string
}

export interface OcpUiRunResult {
  code: number
  request?: OcpUiInstallRequest
}

/** Env var carrying the child→parent request sidecar path into the TUI process. */
const OCP_UI_RESULT_ENV = 'OCP_UI_RESULT_FILE'

/**
 * Parse the request sidecar a TUI child wrote before exiting. Missing or
 * corrupt file → undefined (the parent then decides from the exit code alone).
 */
export function readOcpUiRequestFile(file: string): OcpUiInstallRequest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && parsed.action === 'install') {
      return { action: 'install', ...(typeof parsed.target === 'string' && parsed.target ? { target: parsed.target } : {}) }
    }
  } catch { /* no request */ }
  return undefined
}

function ensureOpenTuiRuntime(repoDir: string, bunExe: string): boolean {
  const installDir = path.join(repoDir, 'install')
  const preload = path.join(installDir, 'node_modules', '@opentui', 'solid', 'scripts', 'preload.js')
  if (existsSync(preload)) return true

  let result: ReturnType<typeof spawnSync>
  try {
    // This is a first-run recovery path; keep Bun's output visible so network,
    // registry, and lockfile failures explain why the UI runtime stays missing.
    result = spawnSync(bunExe, ['install', '--production'], { cwd: installDir, stdio: 'inherit' })
  } catch (error) {
    console.error(`[ocp] OpenTUI runtime install could not start with Bun ${bunExe}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
  if (!result.error && result.status === 0 && existsSync(preload)) return true

  console.error('[ocp] OpenTUI runtime is unavailable. Run `bun install --production` in the package\'s install directory, then retry the command.')
  return false
}

/** Resolve an existing Bun executable when process.execPath is stale after a Windows upgrade. */
export function resolveBunExecutable(
  current = process.execPath,
  bunInstall = process.env.BUN_INSTALL,
  pathBun = Bun.which('bun'),
  home = os.homedir(),
): string {
  const executable = process.platform === 'win32' ? 'bun.exe' : 'bun'
  const candidates = [
    current,
    bunInstall ? path.join(bunInstall, 'bin', executable) : undefined,
    pathBun,
    path.join(home, '.bun', 'bin', executable),
  ]
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? current
}

/**
 * Find a Bun able to host the OpenTUI child process. Under Bun that is the
 * running runtime itself (with stale-path fallbacks); under Node the CLI still
 * works, so probe the standard install locations + PATH for an installed Bun —
 * the TUI runs in a fresh child process and does not require the CLI itself
 * to run under Bun. Returns undefined when no usable Bun exists.
 */
export function resolveUiBunExecutable(
  isBun = Boolean(process.versions.bun),
  bunInstall = process.env.BUN_INSTALL,
  pathEnv = process.env.PATH,
  home = os.homedir(),
): string | undefined {
  const executable = process.platform === 'win32' ? 'bun.exe' : 'bun'
  if (isBun) return resolveBunExecutable(undefined, bunInstall, undefined, home)
  const candidates = [
    bunInstall ? path.join(bunInstall, 'bin', executable) : undefined,
    path.join(home, '.bun', 'bin', executable),
  ]
  for (const dir of (pathEnv ?? '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, executable))
  }
  return candidates.find((candidate): candidate is string => Boolean(candidate && isExecutableFile(candidate)))
}

// existsSync alone would accept a directory named `bun` or a half-installed
// non-executable file, and a false positive crashes the spawn below.
function isExecutableFile(p: string): boolean {
  try {
    const st = statSync(p)
    return st.isFile() && (process.platform === 'win32' || (st.mode & 0o111) !== 0)
  } catch {
    return false
  }
}

export async function runOcpUi(initialRoute: OcpRoute = 'home', context: OcpUiRuntimeContext = { repoDir: process.cwd() }): Promise<OcpUiRunResult> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('[ocp] Interactive UI requires an interactive terminal.')
    return { code: 1 }
  }
  const bunExe = resolveUiBunExecutable()
  if (!bunExe) {
    console.error('[ocp] The interactive OpenTUI UI (dashboard / wizard / provider / profile / usage) needs the Bun runtime — npm/Node cannot host it.')
    console.error('  Install Bun, reopen the terminal, then retry:')
    if (process.platform === 'win32') {
      console.error('    powershell -c "irm bun.sh/install.ps1 | iex"')
    } else {
      console.error('    curl -fsSL https://bun.sh/install | bash')
    }
    return { code: 1 }
  }
  if (!ensureOpenTuiRuntime(context.repoDir, bunExe)) return { code: 1 }
  const installDir = path.join(context.repoDir, 'install')
  const preload = path.join(installDir, 'node_modules', '@opentui', 'solid', 'scripts', 'preload.js')
  const entry = path.join(installDir, 'src', 'ui', 'entry.tsx')
  // Sidecar for the child's install handoff (see app.tsx requestInstall):
  // unique per spawn, read+deleted after the child exits.
  const resultFile = path.join(os.tmpdir(), `ocp-ui-request-${randomUUID()}.json`)
  // node:child_process on purpose: the CLI parent may itself run under Node.
  const child = spawn(bunExe, ['--preload', preload, entry, initialRoute, context.repoDir, context.root ?? '', context.sessionId ?? '', context.root ? 'current' : 'all'], {
    // A project wizard operates on its requested project root; all other
    // surfaces continue to run from the OCP repository directory.
    cwd: initialRoute === 'project' ? (context.root ?? context.repoDir) : context.repoDir,
    env: { ...process.env, [OCP_UI_RESULT_ENV]: resultFile },
    stdio: 'inherit',
  })
  // 'error' fires (and 'exit' may never) when the resolved Bun vanishes
  // between probe and spawn or isn't launchable — settle gracefully instead
  // of throwing an unhandled exception out of the CLI.
  const code = (await new Promise<number | null>(resolve => {
    child.on('error', err => { console.error(`[ocp] Failed to launch Bun (${bunExe}): ${err.message}`); resolve(null) })
    child.on('exit', code => resolve(code))
  })) ?? 1
  const request = readOcpUiRequestFile(resultFile)
  try { unlinkSync(resultFile) } catch { /* already gone */ }
  return { code, request }
}
