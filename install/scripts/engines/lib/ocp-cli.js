#!/usr/bin/env node
// install/scripts/engines/lib/ocp-cli.js
//
// Shared plumbing for the TUI engine pre-launch scripts
// (install/scripts/engines/<id>/*.js), executed by install/src/tui-engine.ts.
//
// Conventions:
//   - The engine binary name comes from OCP_ENGINE_BIN (set by the runner).
//   - Working context comes from OCP_CWD / OCP_LABEL / OCP_TUI_ARGS (JSON).
//   - Exit codes: 0 = ok · 2 = warn but continue the launch · other = abort.
//   - Node (not shell) so one copy serves Windows + macOS + Linux — same
//     reasoning documented in install/scripts/herdr-recovery.js.
//   - Windows: `shell: true` so .cmd/.bat shims (npm globals) resolve; plain
//     binaries work the same way (spawners previously mirrored this per-call).

const { spawnSync, spawn } = require('node:child_process');
const path = require('node:path');

function engineBin() {
  // OCP_ENGINE_BIN is set by the runner; OCP_ENGINE_ID (registry key, which
  // equals the binary name for herdr/luvus) is the standalone-run fallback.
  const bin = process.env.OCP_ENGINE_BIN || process.env.OCP_ENGINE_ID;
  if (!bin) {
    console.error('[ocp-cli] OCP_ENGINE_BIN/OCP_ENGINE_ID is not set — engine scripts run via `ocp tui`/`ocp herdr` (tui-engine), or standalone with one of them exported.');
    process.exit(1);
  }
  return bin;
}

const isWin = () => process.platform === 'win32';

/**
 * Run one engine CLI call.
 *   opts.json=true  → capture stdout/stderr as utf8 (caller parses).
 *   otherwise       → inherit stdio (tool output goes straight to the user).
 *   opts.timeout    → ms; pass 0 for no timeout (some calls must not be cut off).
 *   opts.cwd        → spawn cwd; defaults to OCP_CWD.
 */
function cli(args, opts = {}) {
  return spawnSync(engineBin(), args, {
    encoding: opts.json ? 'utf8' : undefined,
    stdio: opts.json ? 'pipe' : 'inherit',
    shell: isWin(),
    timeout: opts.timeout === 0 ? undefined : opts.timeout ?? 30000,
    cwd: opts.cwd ?? process.env.OCP_CWD ?? process.cwd(),
  });
}

/** cli() + JSON envelope parsing. Never throws; `data` is null on bad JSON. */
function cliJson(args, opts = {}) {
  const res = cli(args, { ...opts, json: true });
  let data = null;
  try { data = JSON.parse(String(res.stdout ?? '')); } catch { /* non-JSON */ }
  return {
    ok: !res.error && res.status === 0,
    status: res.status,
    error: res.error,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    data,
  };
}

/** Unwrap herdr/luvus `{ "result": ... }` envelopes; tolerate bare payloads. */
function unwrap(envelope) {
  return (envelope && envelope.result) || envelope || {};
}

/** Launch context provided by tui-engine.ts (sane fallbacks for standalone runs). */
function ctx() {
  const cwd = process.env.OCP_CWD || process.cwd();
  return {
    cwd,
    label: process.env.OCP_LABEL || path.basename(cwd) || 'workspace',
    tuiArgs: (() => { try { return JSON.parse(process.env.OCP_TUI_ARGS || '[]'); } catch { return []; } })(),
  };
}

/** Synchronous sleep (Atomics.wait — works in CJS scripts without timers). */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Poll `fn()` every intervalMs until true or timeoutMs elapses. */
function pollUntil(fn, { timeoutMs, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    sleepMs(intervalMs);
    if (fn()) return true;
  }
  return false;
}

/** Start a detached headless background process (fire-and-forget). */
function startDetached(args) {
  const child = spawn(engineBin(), args, {
    detached: true,
    stdio: 'ignore',
    shell: isWin(),
    cwd: process.env.OCP_CWD ?? process.cwd(),
  });
  // A parallel launch may already own the singleton socket — the loser exits
  // silently; the caller's poll loop tolerates it. Never surface as an error.
  child.on('error', () => {});
  child.unref();
}

module.exports = { cli, cliJson, unwrap, ctx, sleepMs, pollUntil, startDetached, isWin };
