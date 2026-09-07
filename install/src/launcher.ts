import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isBinaryOnPath } from './installer';
import { getOpencodeExecutable } from './shared/opencode-command';
import type { BackendResult } from '../../plugins/project-manager/project-manager-index';
import type { HookResult } from '../../plugins/project-manager/project-manager-hooks';
import { initProject } from '../../plugins/project-manager/project-manager-operations';
import type { ScaffoldResult } from '../../plugins/project-manager/project-manager-scaffold';
import {
  DESKTOP_NOT_FOUND_HINT,
  ensureOpenChamberVscodeExtension,
  findLinuxDesktopBin,
  findVscodeCli,
  findWindowsDesktopExe,
  VSCODE_CLI_CANDIDATES,
} from './openchamber';

// Runtime launchers behind the `ocp tui` / `ocp serve` / `ocp desktop`
// (= `ocp ui`) / `ocp web` (OpenChamber web mode) / `ocp code` (VS Code with
// the OpenChamber editor extension) subcommands. They exec the underlying
// binary directly — no config files are touched.

function launchBinary(
  binName: string,
  installHint: string,
  extraArgs: string[],
  options?: { cwd?: string; skipPathCheck?: boolean; shell?: boolean }
): number {
  if (!options?.skipPathCheck && !isBinaryOnPath(binName)) {
    console.error(`✗ ${binName} was not found on PATH.`);
    console.error(installHint);
    return 1;
  }

  const res = spawnSync(binName, extraArgs, {
    stdio: 'inherit',
    shell: options?.shell ?? process.platform === 'win32',
    cwd: options?.cwd,
  });

  if (res.error) {
    console.error(`✗ Failed to launch ${binName}: ${res.error.message}`);
    return 1;
  }
  return res.status ?? 0;
}

/** `ocp tui` — launch the OpenCode terminal UI. */
export function launchTui(extraArgs: string[]): number {
  const executable = getOpencodeExecutable();
  if (!executable) {
    console.error('✗ opencode CLI was not found.');
    console.error('  Install OpenCode first: https://opencode.ai (or re-run `ocp install`).');
    return 1;
  }
  return launchBinary(
    executable,
    '  Install OpenCode first: https://opencode.ai (or re-run `ocp install`).',
    stripOcpTuiControlArgs(extraArgs),
    { skipPathCheck: true, shell: false }
  );
}

/**
 * `ocp herdr` — launch Herdr (terminal workspace manager for AI coding agents)
 * rooted at the current working directory. Passthrough args (e.g. `--session`,
 * `--no-session`) are forwarded verbatim.
 *
 * Sequence (each step best-effort; failures are logged, never thrown):
 *   1. `herdr workspace create --cwd <cwd> --label <basename> --focus`
 *      → registers cwd as a workspace + focuses it. Also emits `pane.created`
 *      for the new root pane, which our `ocp.auto-opencode` plugin listens
 *      to and auto-starts opencode in the root pane. So we don't have to
 *      do that here — the plugin handles it.
 *   2. `herdr` → attaches the interactive TUI to the running server.
 *
 * If the herdr server isn't running yet (cold start), step 1 fails and the
 * user is told how to bootstrap (`run herdr once`); step 2 then starts the
 * server when the user runs `ocp herdr` again, and the next run creates
 * the workspace.
 */
export function launchHerdr(extraArgs: string[]): number {
  extraArgs = stripOcpTuiControlArgs(extraArgs);
  const cwd = process.cwd();
  const label = path.basename(cwd) || 'workspace';

  // 1. Register cwd as a Herdr workspace + focus it. The emitted
  //    `pane.created` event triggers the auto-opencode plugin (linked at
  //    install time) to start opencode in the new root pane.
  //
  //    herdr's `workspace create` does NOT dedupe — calling it twice with
  //    the same label creates two workspaces. To avoid that, we first ask
  //    herdr for the existing workspace list; if one already has this label
  //    AND its root pane's cwd matches our target, we just focus it.
  const existing = findWorkspaceByLabel(label);
  if (existing) {
    console.log(`[ocp] Reusing existing workspace "${label}" (${existing}) at ${cwd}`);
    const focusRes = spawnSync('herdr', ['workspace', 'focus', existing], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    if (focusRes.status !== 0) {
      // Fall back to create — better than nothing.
      console.log(`[ocp] workspace focus failed (exit ${focusRes.status}); falling back to create`);
    } else {
      console.log(`[ocp] opencode will start automatically in the focused pane`);
    }
  } else {
    const createRes = spawnSync(
      'herdr',
      ['workspace', 'create', '--cwd', cwd, '--label', label, '--focus'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Windows resolves .cmd / .bat shims (npm globals) only through the shell.
        shell: process.platform === 'win32',
      }
    );

    if (createRes.status === 0 && createRes.stdout) {
      try {
        const json = JSON.parse(createRes.stdout.toString());
        const workspaceId = json?.result?.workspace?.workspace_id ?? null;
        console.log(`[ocp] Workspace "${label}" opened at ${cwd} (${workspaceId ?? '?'}); opencode will start automatically in the root pane`);
      } catch {
        // herdr returned non-JSON; treat as success-without-metadata.
        console.log(`[ocp] Workspace "${label}" opened at ${cwd}`);
      }
    } else {
      // Most common cause: herdr server isn't running yet. The next `herdr`
      // call below will start it; the user just needs to run `ocp herdr`
      // once more after the TUI exits.
      const stderr = createRes.stderr?.toString().trim() ?? '';
      const hint = /server_not_running/i.test(stderr)
        ? `herdr server not running — it'll start on this launch; run \`ocp herdr\` again afterwards to register the workspace.`
        : `workspace registration skipped (exit ${createRes.status ?? '?'}${stderr ? `: ${stderr}` : ''})`;
      console.log(`[ocp] ${hint}`);
    }
  }

  // 2. Launch herdr TUI (attaches to the server, showing the focused workspace).
  return launchBinary(
    'herdr',
    '  Install Herdr first: https://herdr.dev (or re-run `ocp install`).',
    extraArgs,
    { cwd }
  );
}

/** Drop OCP-only TUI controls that opencode/herdr CLIs do not understand. */
function stripOcpTuiControlArgs(args: string[]): string[] {
  return args.filter((a) => a !== '--init' && a !== '.');
}

/**
 * Look up an existing herdr workspace with the given label. Returns the
 * workspace id on hit, null otherwise. Used by launchHerdr() to avoid
 * creating a duplicate workspace on every `ocp herdr` invocation.
 *
 * Dedupe by label alone is sufficient in practice: each `ocp herdr` from
 * a directory produces one workspace with `label = basename(cwd)`, and
 * the same directory will keep using the same label. (If the user has
 * two different directories with the same basename, they end up sharing
 * a workspace — a known trade-off; cleaner dedup would require a cwd
 * round-trip via tab get + pane get, which is fragile because herdr
 * surfaces stale entries in `workspace list` for closed workspaces.)
 *
 * Cost: 1 herdr CLI call. On any error (server not running, parse
 * failure, etc.) we return null — caller falls back to creating a fresh
 * workspace.
 */
function findWorkspaceByLabel(targetLabel: string): string | null {
  const shellOpt = process.platform === 'win32';
  const listRes = spawnSync('herdr', ['workspace', 'list'], {
    encoding: 'utf8', timeout: 10000, shell: shellOpt,
  });
  if (listRes.status !== 0 || !listRes.stdout) return null;
  let listJson: any;
  try { listJson = JSON.parse(listRes.stdout); } catch { return null; }
  const workspaces: any[] = listJson?.result?.workspaces ?? [];
  const match = workspaces.find((w) => w.label === targetLabel);
  return match?.workspace_id ?? null;
}

/**
 * `ocp serve` — launch the headless opencode server. Pure passthrough;
 * opencode's own --port defaults to 0 (auto-assigned random port).
 */
export function launchServe(extraArgs: string[]): number {
  const executable = getOpencodeExecutable();
  if (!executable) {
    console.error('✗ opencode CLI was not found.');
    console.error('  Install OpenCode first: https://opencode.ai (or re-run `ocp install`).');
    return 1;
  }
  return launchBinary(
    executable,
    '  Install OpenCode first: https://opencode.ai (or re-run `ocp install`).',
    ['serve', ...extraArgs],
    { skipPathCheck: true, shell: false }
  );
}

/**
 * `ocp web` — launch OpenChamber in web mode: the browser UI is served on
 * localhost, protected by a UI password (official quick-start pattern).
 * A user-supplied `--ui-password` in the passthrough args wins; otherwise
 * a random one is generated and printed before launch.
 *
 * If an instance is already running, a fresh password launch would fail
 * (and leak a useless password), so stop the running instances first and
 * then start a fresh session with the new password.
 */
export function launchWeb(extraArgs: string[]): number {
  if (!isBinaryOnPath('openchamber')) {
    console.error('✗ openchamber was not found on PATH.');
    console.error(
      '  Install OpenChamber first: `npm install -g @openchamber/web`\n' +
        '  or download the native app from https://openchamber.dev/download'
    );
    return 1;
  }

  if (extraArgs[0] === 'stop') {
    return stopWeb();
  }

  // `ocp web restart` is just an explicit spelling of `ocp web`.
  if (extraArgs[0] === 'restart') {
    extraArgs = extraArgs.slice(1);
  }

  const daemon = isDaemonMode(extraArgs);
  extraArgs = stripDaemonArg(extraArgs);

  // `openchamber status --quiet` prints a `port <n> ...` line per running
  // instance and the single word `stopped` when idle.
  const status = spawnSync('openchamber', ['status', '--quiet'], {
    encoding: 'utf8',
    timeout: 15000,
    // Windows resolves .cmd / .bat shims (npm globals) only through the shell.
    shell: process.platform === 'win32',
  });
  const statusText = `${status.stdout ?? ''}${status.stderr ?? ''}`;
  if (/^port \d+/im.test(statusText)) {
    console.log('  OpenChamber instance(s) already running — stopping for a fresh web session:');
    console.log(statusText.trim().replace(/^/gm, '    '));
    spawnSync('openchamber', ['stop'], {
      stdio: 'ignore',
      timeout: 15000,
      // Windows resolves .cmd / .bat shims (npm globals) only through the shell.
      shell: process.platform === 'win32',
    });
  }

  // Port policy: an explicit --port passes through as-is (we only try to
  // reclaim it from zombie daemons); without one, pick the first free port
  // starting at 3000 so stale listeners never block startup.
  let args = [...extraArgs];
  const explicitPort = parseWebPort(extraArgs);
  if (explicitPort === null || explicitPort === 0) {
    const picked = findFreeWebPort(3000);
    if (picked < 0) {
      console.error('✗ No free port found in range 3000-3199.');
      return 1;
    }
    console.log(`  Using free port ${picked}`);
    args = [...stripPortArgs(args), '--port', String(picked)];
  } else if (isPortBusy(explicitPort)) {
    // Zombie / orphan daemons keep holding the port even after stop (pid
    // file gone, HTTP shutdown unresponsive) — reclaim it BEFORE generating
    // a password, otherwise the fresh daemon dies with EADDRINUSE and the
    // printed password is useless.
    console.log(`  Port ${explicitPort} is still occupied — reclaiming it for the new session...`);
    spawnSync('openchamber', ['stop', '--port', String(explicitPort)], {
      stdio: 'ignore',
      timeout: 15000,
      // Windows resolves .cmd / .bat shims (npm globals) only through the shell.
      shell: process.platform === 'win32',
    });
    if (!waitPortFree(explicitPort)) {
      console.error(`✗ Port ${explicitPort} is still occupied and could not be reclaimed.`);
      console.error('  Kill the listener manually or let OCP pick a free port: `ocp web` (no --port)');
      return 1;
    }
  }

  if (!args.includes('--ui-password')) {
    const password = randomBytes(18).toString('base64url');
    console.log(`🔑 OpenChamber web UI password: ${password}`);
    args.push('--ui-password', password);
  }

  const actualPort = parseWebPort(args) ?? 0;
  if (daemon) {
    const child = spawn('openchamber', ['serve', ...args], {
      detached: true,
      stdio: 'ignore',
      // Windows resolves .cmd / .bat shims (npm globals) only through the shell.
      shell: process.platform === 'win32',
    });
    child.on('error', (err) => console.error(`✗ Failed to launch openchamber: ${err.message}`));
    child.unref();
    const portMsg = actualPort ? `port ${actualPort}` : 'a background port';
    console.log(`  OpenChamber web UI running in daemon mode on ${portMsg}.`);
    console.log(`  Use 'ocp web stop' to shut it down.`);
    return 0;
  }

  return launchBinary(
    'openchamber',
    '  Install OpenChamber first: `npm install -g @openchamber/web`\n' +
      '  or download the native app from https://openchamber.dev/download',
    ['serve', ...args]
  );
}

/**
 * `ocp web stop` — stop any running OpenChamber web instance without
 * starting a new one.
 */
function stopWeb(): number {
  const status = spawnSync('openchamber', ['status', '--quiet'], {
    encoding: 'utf8',
    timeout: 15000,
    // Windows resolves .cmd / .bat shims (npm globals) only through the shell.
    shell: process.platform === 'win32',
  });
  const statusText = `${status.stdout ?? ''}${status.stderr ?? ''}`;
  if (!/^port \d+/im.test(statusText)) {
    console.log('  No OpenChamber web instance is currently running.');
    return 0;
  }

  console.log('  Stopping OpenChamber web instance(s):');
  console.log(statusText.trim().replace(/^/gm, '    '));
  const res = spawnSync('openchamber', ['stop'], {
    stdio: 'ignore',
    timeout: 15000,
    // Windows resolves .cmd / .bat shims (npm globals) only through the shell.
    shell: process.platform === 'win32',
  });
  if (res.error) {
    console.error(`✗ Failed to stop openchamber: ${res.error.message}`);
    return 1;
  }
  return 0;
}

/** Drop the --daemon flag before passing args to openchamber serve. */
function stripDaemonArg(args: string[]): string[] {
  return args.filter((a) => a !== '--daemon');
}

/** True when the user wants the web UI to run detached from the terminal. */
function isDaemonMode(args: string[]): boolean {
  return args.includes('--daemon');
}

/**
 * Parse the serve port from passthrough args (--port N / -p N / --port=N).
 * Returns null when the caller did not pin a port.
 */
function parseWebPort(args: string[]): number | null {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--port' || args[i] === '-p') && /^\d+$/.test(args[i + 1] ?? '')) {
      return Number(args[i + 1]);
    }
    const m = args[i].match(/^--port=(\d+)$/);
    if (m) return Number(m[1]);
  }
  return null;
}

/** Drop any port selector (--port N / -p N / --port=N) before re-injecting one. */
function stripPortArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' || args[i] === '-p') {
      if (/^\d+$/.test(args[i + 1] ?? '')) i++;
      continue;
    }
    if (/^--port=\d+$/.test(args[i])) continue;
    out.push(args[i]);
  }
  return out;
}

/** First free port at or above the base, or -1 when the range is exhausted. */
function findFreeWebPort(base: number): number {
  for (let p = base; p < base + 200; p++) {
    if (!isPortBusy(p)) return p;
  }
  return -1;
}

/** Synchronous TCP probe: true when something listens on 127.0.0.1:port. */
function isPortBusy(port: number): boolean {
  const probe =
    `const n=require('net');const s=n.connect(${port},'127.0.0.1');` +
    `s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));` +
    `setTimeout(()=>process.exit(1),700);`;
  const r = spawnSync(process.execPath, ['-e', probe], { timeout: 3000 });
  return r.status === 0;
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitPortFree(port: number, ms = 5000): boolean {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isPortBusy(port)) return true;
    sleepMs(500);
  }
  return !isPortBusy(port);
}

const OCP_ACTIVATION_TIMEOUT_MS = 30_000;
const OCP_ACTIVATION_POLL_MS = 500;

/** Format one backend result for the project command report. */
function formatBackendLine(r: BackendResult): string {
  if (r.status === 'ran') return `  ✅ ${r.backend}: ${r.detail}`;
  if (r.status === 'failed') return `  ❌ ${r.backend}: ${r.detail}`;
  return `  ⏭️ ${r.backend}: ${r.detail}`;
}

/** Format one scaffold result for the project command report. */
function formatScaffoldLine(r: ScaffoldResult): string {
  if (r.status === 'created') return `  ✅ created ${r.relPath}`;
  if (r.status === 'updated') return `  ♻️ updated ${r.relPath} (template switches appended)`;
  if (r.status === 'invalid') return `  ⚠️ malformed ${r.relPath}`;
  return `  ⏭️ kept ${r.relPath}`;
}

function formatHookLine(r: HookResult): string {
  if (r.status === 'registered') return `  ✅ ${r.hook}: ${r.detail}`;
  if (r.status === 'updated') return `  ♻️ ${r.hook}: ${r.detail}`;
  if (r.status === 'failed') return `  ❌ ${r.hook}: ${r.detail}`;
  return `  ⏭️ ${r.hook}: skipped — ${r.detail}`;
}

/**
 * Run the same OCP project scaffolding/indexing that `ocp project init` does.
 * This keeps `ocp desktop --init` / `ocp ui .` self-contained in TypeScript.
 */
async function runOcpProjectInit(): Promise<number> {
  const rootDir = process.cwd();
  try {
    const result = await initProject({ root: rootDir, refreshExistingIndexes: true });
    console.log(result.configExisted
      ? `[ocp] Activating existing OCP project in ${rootDir}...`
      : `[ocp] No OCP project detected in ${rootDir} — creating one...`);
    console.log(`[ocp] project ${result.configExisted ? 'activated' : 'created'} in ${rootDir}`);
    console.log('');
    console.log('Files:');
    for (const r of result.files) console.log(formatScaffoldLine(r));
    console.log('');
    console.log('Backends:');
    for (const r of result.backends) console.log(formatBackendLine(r));
    console.log('');
    console.log('Hooks:');
    for (const r of result.hooks) console.log(formatHookLine(r));
    return 0;
  } catch (err: any) {
    console.error(`[ocp] project init failed: ${err?.message ?? String(err)}`);
    return 1;
  }
}

interface OpenChamberSettings {
  desktopLocalPort?: number;
  desktopLocalClientToken?: string;
}

function getOpenChamberSettingsPath(): string {
  const dataDir = process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR.trim())
    : path.join(os.homedir(), '.config', 'openchamber');
  return path.join(dataDir, 'settings.json');
}

function readOpenChamberSettings(): OpenChamberSettings {
  try {
    const raw = fs.readFileSync(getOpenChamberSettingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    const port = parsed?.desktopLocalPort;
    const token = parsed?.desktopLocalClientToken;
    return {
      desktopLocalPort: Number.isFinite(port) && port > 0 && port <= 65535 ? port : undefined,
      desktopLocalClientToken: typeof token === 'string' && token.trim().length > 0 ? token.trim() : undefined,
    };
  } catch {
    return {};
  }
}

async function fetchJson(port: number, endpoint: string, options: RequestInit & { timeoutMs?: number } = {}): Promise<{ ok: boolean; status: number; body: any }> {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 4000;
  const url = `http://127.0.0.1:${port}${endpoint}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const settings = readOpenChamberSettings();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    };
    if (settings.desktopLocalClientToken && settings.desktopLocalPort === port) {
      headers.Authorization = `Bearer ${settings.desktopLocalClientToken}`;
    }
    const response = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body };
  } catch (error: any) {
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
      return { ok: false, status: 0, body: { error: `Request to ${endpoint} timed out after ${timeoutMs}ms` } };
    }
    return { ok: false, status: 0, body: { error: error?.message ?? String(error) } };
  } finally {
    clearTimeout(timer);
  }
}

/** True when the on-disk settings.json already lists the directory. */
function isProjectInSettingsFile(dir: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(getOpenChamberSettingsPath(), 'utf8'));
    const projects = Array.isArray(parsed?.projects) ? parsed.projects : [];
    const normalized = normalizeDirForCompare(dir);
    return projects.some((p: any) =>
      typeof p?.path === 'string' && normalizeDirForCompare(p.path) === normalized);
  } catch {
    return false;
  }
}

async function isDesktopServerReady(port: number): Promise<boolean> {
  const { ok, body } = await fetchJson(port, '/health', { method: 'GET', timeoutMs: 1500 });
  return ok && body?.runtime === 'desktop';
}

async function activateDirectory(port: number, dir: string): Promise<boolean> {
  const { ok, body } = await fetchJson(port, '/api/opencode/directory', {
    method: 'POST',
    body: JSON.stringify({ path: dir }),
    timeoutMs: 8000,
  });
  if (ok && body?.success === true) {
    console.log(`  OpenChamber project activated: ${dir}`);
    return true;
  }
  const message = body?.error ?? `HTTP ${body?.status ?? 'unknown'}`;
  console.error(`  ✗ Failed to activate project in OpenChamber: ${message}`);
  console.error('    Add the project manually in OpenChamber if it does not appear.');
  return false;
}

const normalizeDirForCompare = (value: string): string =>
  value.replace(/\\/g, '/').replace(/\/+$/, '');

/** Desktop process pid from /api/system/info (runtime already verified as desktop). */
async function getDesktopPid(port: number): Promise<number | null> {
  const { ok, body } = await fetchJson(port, '/api/system/info', { method: 'GET', timeoutMs: 2000 });
  return ok && Number.isFinite(body?.pid) ? Number(body.pid) : null;
}

/** Y/N prompt; false on non-consent, EOF, or 15s silence. */
function promptRestart(): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write('  Restart OpenChamber now so it opens with this project? [y/N] ');
    const finish = (answer: boolean) => {
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.pause();
      resolve(answer);
    };
    const onData = (buf: Buffer) => finish(/^y(es)?$/i.test(buf.toString().trim()));
    const onEnd = () => finish(false);
    const timer = setTimeout(() => finish(false), 15_000);
    process.stdin.resume();
    process.stdin.once('data', onData);
    process.stdin.once('end', onEnd);
  });
}

function killDesktopProcess(pid: number): void {
  if (process.platform === 'win32') {
    // /T: the desktop manages the OpenCode server as a child; the relaunch
    // brings both back, so take the tree down cleanly.
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

function waitProcessGone(pid: number, ms = 8000): boolean {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const probe = spawnSync(
      process.execPath,
      ['-e', `try{process.kill(${pid},0);process.exit(0)}catch{process.exit(1)}`],
      { timeout: 2000 },
    );
    if (probe.status !== 0) return true;
    sleepMs(300);
  }
  return false;
}

/**
 * True when the server's current settings still list the directory. A running
 * OpenChamber UI saves the WHOLE projects array from its in-memory copy, so a
 * stale window can silently wipe an externally registered project — this is
 * how we detect that.
 */
async function isProjectRegistered(port: number, dir: string): Promise<boolean> {
  const { ok, body } = await fetchJson(port, '/api/config/settings', { method: 'GET', timeoutMs: 4000 });
  if (!ok) return false;
  const normalized = normalizeDirForCompare(dir);
  const projects = Array.isArray(body?.projects) ? body.projects : [];
  return projects.some((p: any) =>
    typeof p?.path === 'string' && normalizeDirForCompare(p.path) === normalized);
}

async function waitForDesktopServer(timeoutMs: number): Promise<{ port: number; token?: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const settings = readOpenChamberSettings();
    if (settings.desktopLocalPort) {
      if (await isDesktopServerReady(settings.desktopLocalPort)) {
        return { port: settings.desktopLocalPort, token: settings.desktopLocalClientToken };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, OCP_ACTIVATION_POLL_MS));
  }
  return null;
}

/**
 * Replicate OpenChamber's project id: `path_` + base64url of the path with
 * backslashes normalized to forward slashes and trailing slashes stripped
 * (see openchamber server/lib/projects/project-id.js).
 */
function buildOpenChamberProjectId(dir: string): string {
  const normalized = dir.replace(/\\/g, '/').replace(/\/+$/g, '') || dir;
  return `path_${Buffer.from(normalized, 'utf8').toString('base64url')}`;
}

/**
 * Write the project directly into OpenChamber's settings.json so the desktop
 * app boots with it already in the project list (and active). The server-side
 * API only persists settings — it never notifies running UI clients — so
 * seeding BEFORE launch is the only way the project shows up immediately.
 * Only safe while no OpenChamber server is running (it owns the file then).
 */
function seedOpenChamberProject(dir: string): boolean {
  const normalizedDir = dir.replace(/\\/g, '/').replace(/\/+$/g, '');
  const settingsPath = getOpenChamberSettingsPath();
  let settings: any = {};
  try {
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
    }
  } catch {
    return false;
  }

  const projects: any[] = Array.isArray(settings.projects)
    ? settings.projects.filter((p: any) => p && typeof p === 'object')
    : [];
  const id = buildOpenChamberProjectId(normalizedDir);
  const existing = projects.find((p: any) =>
    p.id === id ||
    (typeof p.path === 'string' && p.path.replace(/\\/g, '/').replace(/\/+$/g, '') === normalizedDir));
  if (existing) {
    existing.lastOpenedAt = Date.now();
  } else {
    projects.push({ id, path: normalizedDir, addedAt: Date.now(), lastOpenedAt: Date.now() });
  }
  settings.projects = projects;
  settings.activeProjectId = existing?.id ?? id;
  settings.lastDirectory = normalizedDir;

  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * `ocp desktop` / `ocp ui` — launch the OpenChamber native desktop app.
 * The app is a Tauri GUI and normally not on PATH, so each platform gets
 * its own probe (install dirs on Windows, `open -a` on macOS, PATH +
 * common locations on Linux).
 *
 * With `--init` (or when the caller passes `.` which the shell normalizes to
 * `--init`), this also scaffolds an OCP project in the current directory and
 * registers that directory as an OpenChamber project. Plain `ocp desktop` /
 * `ocp ui` still just launches the app.
 */
export async function launchDesktop(extraArgs: string[]): Promise<number> {
  // `.` (current directory) means the same as --init wherever it appears as
  // the first argument — bin dispatchers normalize it too, this covers direct
  // `bun install/src/index.ts desktop .` invocations.
  const hasInit = extraArgs.includes('--init') || extraArgs[0] === '.';
  const launchArgs = extraArgs.filter((a, i) => a !== '--init' && !(i === 0 && a === '.'));

  if (hasInit) {
    const initCode = await runOcpProjectInit();
    if (initCode !== 0) return initCode;
  }

  if (!hasInit) return startDesktop(launchArgs);

  const projectDir = process.cwd();

  const settings = readOpenChamberSettings();
  const serverReady = settings.desktopLocalPort
    ? await isDesktopServerReady(settings.desktopLocalPort)
    : false;

  // Fast path: already registered (server view or on-disk settings) means the
  // project is in the running UI's memory too — nothing to activate, no wipe
  // risk, no prompts. Just open the app.
  const alreadyRegistered = serverReady && settings.desktopLocalPort
    ? await isProjectRegistered(settings.desktopLocalPort, projectDir)
    : isProjectInSettingsFile(projectDir);
  if (alreadyRegistered) {
    const startCode = startDesktop(launchArgs);
    if (startCode !== 0) return startCode;
    console.log(`  OpenChamber project already registered: ${projectDir}`);
    return 0;
  }

  // A running desktop server owns settings.json and never pushes project-list
  // changes to the UI — register through its API and tell the user about the
  // restart caveat. Otherwise seed the file BEFORE launch so the project is
  // in the very first render.
  if (serverReady && settings.desktopLocalPort) {
    await activateDirectory(settings.desktopLocalPort, projectDir);

    // Activation is now on disk, so a fresh window loads it race-free. A
    // running window keeps its project list in memory (seeded from a
    // localStorage snapshot) and can PUT that stale array back whole when the
    // user touches the sidebar — wiping the external registration. Offer a
    // restart (the deterministic fix); otherwise verify-and-restore briefly.
    if (process.stdin.isTTY) {
      const port = settings.desktopLocalPort;
      if (await promptRestart()) {
        const pid = await getDesktopPid(port);
        if (pid && (killDesktopProcess(pid), waitProcessGone(pid))) {
          const startCode = startDesktop(launchArgs);
          if (startCode === 0) {
            console.log(`  ✓ OpenChamber restarted — ${projectDir} is the active project.`);
            return 0;
          }
          return startCode;
        }
        console.error('  ✗ Could not stop the running OpenChamber process; falling back to verify.');
      }
    }

    // Restart declined / unavailable — still open (or focus) the app.
    const startCode = startDesktop(launchArgs);
    if (startCode !== 0) return startCode;

    // The store becomes fresh after its first settings echo, so the dangerous
    // window is the first few seconds: verify and restore if wiped.
    let registered = await isProjectRegistered(settings.desktopLocalPort, projectDir);
    for (let check = 0; check < 3 && registered; check++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (!(await isProjectRegistered(settings.desktopLocalPort, projectDir))) {
        console.log('  OpenChamber UI overwrote the project list — re-registering...');
        await activateDirectory(settings.desktopLocalPort, projectDir);
      }
      registered = await isProjectRegistered(settings.desktopLocalPort, projectDir);
    }
    if (registered) {
      console.log('  ✓ Project registration confirmed in the running OpenChamber instance.');
      console.log('    Press Ctrl+R in the window to load it now; if it ever disappears');
      console.log('    after sidebar edits, re-run this command or restart OpenChamber.');
    } else {
      console.error('  ⚠️ Could not confirm the registration — the running OpenChamber window');
      console.error('     keeps overwriting the project list from its stale in-memory copy.');
      console.error('     Restart OpenChamber first, then re-run this command.');
    }
    return 0;
  }

  if (!seedOpenChamberProject(projectDir)) {
    // Could not seed (missing/corrupt settings) — fall back to the API path.
    const startCode = startDesktop(launchArgs);
    if (startCode !== 0) return startCode;
    console.log('[ocp] Waiting for OpenChamber desktop server to register the project...');
    const server = await waitForDesktopServer(OCP_ACTIVATION_TIMEOUT_MS);
    if (!server) {
      console.error('  ✗ OpenChamber desktop server did not become ready in time.');
      console.error('    The desktop app is still launching; add the project manually once it opens.');
      return 0;
    }
    await activateDirectory(server.port, projectDir);
    return 0;
  }

  const startCode = startDesktop(launchArgs);
  if (startCode !== 0) return startCode;
  console.log(`  OpenChamber project registered: ${projectDir} (active on launch)`);
  return 0;
}

/** Start the OpenChamber desktop app without waiting for its server. */
function startDesktop(extraArgs: string[]): number {
  if (process.platform === 'win32') {
    const exe = findWindowsDesktopExe();
    if (!exe) {
      console.error('✗ The OpenChamber desktop app was not found.');
      console.error(DESKTOP_NOT_FOUND_HINT);
      return 1;
    }
    const child = spawn(exe, extraArgs, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => console.error(`✗ Failed to launch ${exe}: ${err.message}`));
    child.unref();
    return 0;
  }
  if (process.platform === 'darwin') {
    // .app bundles are not on PATH — let LaunchServices resolve it.
    // `open -a` returns quickly; the desktop server will start asynchronously.
    const res = spawnSync('open', ['-a', 'OpenChamber', ...extraArgs], { stdio: 'ignore' });
    if (res.error || res.status !== 0) {
      console.error('✗ The OpenChamber desktop app was not found.');
      console.error(DESKTOP_NOT_FOUND_HINT);
      return 1;
    }
    return 0;
  }
  const bin = findLinuxDesktopBin();
  if (!bin) {
    console.error('✗ The OpenChamber desktop app was not found.');
    console.error(DESKTOP_NOT_FOUND_HINT);
    return 1;
  }
  const child = spawn(bin, extraArgs, { detached: true, stdio: 'ignore' });
  child.on('error', (err) => console.error(`✗ Failed to launch ${bin}: ${err.message}`));
  child.unref();
  return 0;
}

/**
 * `ocp code` — open the current project in VS Code (or a compatible fork:
 * code-insiders / VSCodium / Cursor / Windsurf — the first CLI found on PATH
 * wins), making sure the OpenChamber editor extension is present first. The
 * extension powers the same OpenChamber review UI inside the editor.
 *
 * With `--init`, the OCP project in the current directory is scaffolded or
 * re-activated first (same as `ocp ui --init`). A bare `.` is NOT swallowed:
 * VS Code itself interprets it as "open the current folder", so it passes
 * through. Every other argument is forwarded verbatim (`ocp code -n` opens a
 * new window, `ocp code <dir>` opens that folder, etc.).
 *
 * A failed extension install must not block opening the editor (offline
 * marketplace, restricted network) — it is reported and the launch proceeds.
 */
export async function launchCode(
  extraArgs: string[],
  options: { ensureExtension?: boolean } = {}
): Promise<number> {
  const cli = findVscodeCli();
  if (!cli) {
    console.error(
      `✗ No VS Code-compatible CLI found on PATH (tried: ${VSCODE_CLI_CANDIDATES.join(', ')}).`,
    );
    console.error('  Install VS Code first: https://code.visualstudio.com');
    return 1;
  }

  if (options.ensureExtension !== false) {
    console.log(ensureOpenChamberVscodeExtension(cli).message);
  }

  const hasInit = extraArgs.includes('--init');
  const args = extraArgs.filter((a) => a !== '--init');
  if (hasInit) {
    const initCode = await runOcpProjectInit();
    if (initCode !== 0) return initCode;
  }

  // findVscodeCli already resolved the CLI through where/which, so skip
  // launchBinary's isBinaryOnPath re-check (a 1s-timeout execSync that
  // occasionally flakes on slow `where.exe` runs).
  return launchBinary(
    cli,
    '  Install VS Code first: https://code.visualstudio.com',
    args,
    { skipPathCheck: true }
  );
}
