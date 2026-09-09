import { existsSync, readFileSync, unlinkSync } from 'node:fs'
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

function ensureOpenTuiRuntime(repoDir: string): boolean {
  const installDir = path.join(repoDir, 'install')
  const preload = path.join(installDir, 'node_modules', '@opentui', 'solid', 'scripts', 'preload.js')
  if (existsSync(preload)) return true

  let result: ReturnType<typeof Bun.spawnSync>
  try {
    result = Bun.spawnSync({
      cmd: [resolveBunExecutable(), 'install', '--production'],
      cwd: installDir,
      stdout: 'ignore',
      stderr: 'ignore',
    })
  } catch (error) {
    console.error(`[ocp] OpenTUI runtime install could not start with Bun ${bunResolutionDiagnostic()}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
  if (result.exitCode === 0 && existsSync(preload)) return true

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

function bunResolutionDiagnostic(): string {
  const executable = resolveBunExecutable()
  return `${executable} (${existsSync(executable) ? 'found' : 'missing'})`
}

export async function runOcpUi(initialRoute: OcpRoute = 'home', context: OcpUiRuntimeContext = { repoDir: process.cwd() }): Promise<OcpUiRunResult> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('[ocp] Interactive UI requires an interactive terminal.')
    return { code: 1 }
  }
  if (!process.versions.bun) {
    console.error('[ocp] Interactive OpenTUI UI requires Bun. Use a plain subcommand or install Bun.')
    return { code: 1 }
  }
  if (!ensureOpenTuiRuntime(context.repoDir)) return { code: 1 }
  const installDir = path.join(context.repoDir, 'install')
  const preload = path.join(installDir, 'node_modules', '@opentui', 'solid', 'scripts', 'preload.js')
  const entry = path.join(installDir, 'src', 'ui', 'entry.tsx')
  // Sidecar for the child's install handoff (see app.tsx requestInstall):
  // unique per spawn, read+deleted after the child exits.
  const resultFile = path.join(os.tmpdir(), `ocp-ui-request-${randomUUID()}.json`)
  const child = Bun.spawn({
    cmd: [resolveBunExecutable(), '--preload', preload, entry, initialRoute, context.repoDir, context.root ?? '', context.sessionId ?? '', context.root ? 'current' : 'all'],
    // A project wizard operates on its requested project root; all other
    // surfaces continue to run from the OCP repository directory.
    cwd: initialRoute === 'project' ? (context.root ?? context.repoDir) : context.repoDir,
    env: { ...process.env, [OCP_UI_RESULT_ENV]: resultFile },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await child.exited
  const request = readOcpUiRequestFile(resultFile)
  try { unlinkSync(resultFile) } catch { /* already gone */ }
  return { code, request }
}
