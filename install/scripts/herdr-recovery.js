#!/usr/bin/env node
// install/scripts/herdr-recovery.js
//
// Thin wrapper around any `herdr` CLI invocation that auto-recovers from the
// `protocol_mismatch` error.
//
// Background
// ----------
// When the herdr CLI binary is upgraded on disk but the running herdr server
// was launched by the older binary, every CLI call returns:
//
//   {"error":{"code":"protocol_mismatch",
//             "message":"client protocol X is newer than server protocol Y;
//                        restart the Herdr server before using this command.
//                        Stop the old server to use the new version.
//                        Stopping exits pane processes.
//                        Run `herdr server stop`, then run `herdr` again."}}
//
// The fix is mechanical: `herdr server stop` (kills the stale server) then
// retry the original command. The next `herdr` invocation will launch a fresh
// server on the new protocol.
//
// Why a wrapper instead of patching the installer
// ------------------------------------------------
// The installer already has retry-friendly scaffolding (`runPostInstall`
// captures stdout/stderr, classifies failures). Adding protocol-aware retry
// logic there is invasive: it would need to special-case one tool's error
// code in generic plumbing. A thin wrapper keeps the policy local to the
// tool that owns it (herdr) and lets the installer treat this step like any
// other post_install.
//
// Why Node
// --------
// - Cross-platform (Windows + POSIX) without separate .ps1 / .sh variants.
// - `node` is already on PATH for ocp installs (verified: opencode-prime
//   ships node-powered tooling).
// - Lets us poll for the socket disappearance without shell-portable hacks.
//
// Usage
// -----
//   node herdr-recovery.js <herdr-args...>
//
// Exit code:
//   0  — original command succeeded (possibly after recovery).
//   1  — original command failed and recovery was either not applicable or
//        did not help.
//   2  — usage error (no args).

const { spawnSync } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('[herdr-recovery] usage: node herdr-recovery.js <herdr-args...>');
  process.exit(2);
}

const herdr = process.env.HERDR_BIN_PATH || 'herdr';

// Resolve the herdr socket path the same way herdr does — single source of
// truth is %APPDATA%/herdr/herdr.sock on Windows, ~/.local/share/herdr/...
// elsewhere. Falling back to the Windows path is fine for now; the OCP
// installer primarily targets Windows.
function resolveSockPath() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA
      || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'herdr', 'herdr.sock');
  }
  // POSIX best-effort: herdr uses XDG_DATA_HOME when set.
  const xdg = process.env.XDG_DATA_HOME
    || path.join(process.env.HOME || os.homedir(), '.local', 'share');
  return path.join(xdg, 'herdr', 'herdr.sock');
}

const sockPath = resolveSockPath();
const RECOVERY_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 250;

function isProtocolMismatch(stdout) {
  if (!stdout || !stdout.trim()) return false;
  try {
    const j = JSON.parse(stdout);
    return j && j.error && j.error.code === 'protocol_mismatch';
  } catch {
    return false;
  }
}

async function socketExists() {
  try { await fs.access(sockPath); return true; }
  catch { return false; }
}

async function waitForSocketGone() {
  const start = Date.now();
  while (Date.now() - start < RECOVERY_TIMEOUT_MS) {
    if (!(await socketExists())) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

function runHerdr(args, capture) {
  return spawnSync(herdr, args, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
}

(async () => {
  // 1. First attempt — capture stdout to inspect for protocol_mismatch.
  const first = runHerdr(args, true);
  const firstOut = (first.stdout || '').toString();
  const firstErr = (first.stderr || '').toString();

  if (first.status === 0 && !isProtocolMismatch(firstOut)) {
    // Happy path — passthrough.
    process.stdout.write(firstOut);
    if (firstErr) process.stderr.write(firstErr);
    process.exit(0);
  }

  if (!isProtocolMismatch(firstOut)) {
    // Some other failure — passthrough so the installer's post_install
    // runner can log the original error verbatim.
    process.stdout.write(firstOut);
    if (firstErr) process.stderr.write(firstErr);
    process.exit(first.status ?? 1);
  }

  // 2. protocol_mismatch detected — recover.
  console.error('[herdr-recovery] detected protocol_mismatch; stopping stale server...');
  const stop = spawnSync(herdr, ['server', 'stop'], {
    encoding: 'utf8', stdio: 'inherit',
  });
  // `herdr server stop` exits 0 even when no server is running, so a
  // non-zero status here is genuinely unexpected.
  if (stop.status !== 0) {
    console.error('[herdr-recovery] `herdr server stop` failed; aborting retry');
    process.stdout.write(firstOut);
    if (firstErr) process.stderr.write(firstErr);
    process.exit(first.status ?? 1);
  }

  // 3. Wait for the server socket to disappear. herdr server stop is
  //    synchronous from the CLI's perspective, but the actual process exit
  //    can lag a few hundred ms on Windows. We poll instead of guessing.
  if (!(await waitForSocketGone())) {
    console.error(`[herdr-recovery] socket still present at ${sockPath} after ${RECOVERY_TIMEOUT_MS}ms; aborting`);
    process.stdout.write(firstOut);
    if (firstErr) process.stderr.write(firstErr);
    process.exit(first.status ?? 1);
  }

  // 4. Retry the original command. Next `herdr` invocation will start a
  //    fresh server on the new protocol; this one (e.g. `plugin link`)
  //    starts the server inline if needed.
  console.error('[herdr-recovery] server stopped; retrying original command...');
  const retry = runHerdr(args, true);
  const retryOut = (retry.stdout || '').toString();
  const retryErr = (retry.stderr || '').toString();
  process.stdout.write(retryOut);
  if (retryErr) process.stderr.write(retryErr);
  process.exit(retry.status ?? 1);
})();