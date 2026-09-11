#!/usr/bin/env node
// install/scripts/engines/herdr/ensure-server.js
//
// `ocp herdr` pre-launch step 1: make sure the headless herdr server is up
// before anything touches the API. Without this, the very first
// `ocp herdr` after install / reboot would fail at workspace registration
// with `server_not_running` and only succeed on the next invocation (whose
// TUI attach would finally spawn the server). This step makes one
// invocation enough.
//
//   1. Probe `herdr agent list` — succeeds ⇒ server is up, exit 0.
//   2. Otherwise spawn `herdr server` detached (headless, no TUI attached)
//      and poll for up to 15s (override: OCP_HERDR_SERVER_TIMEOUT_MS).
//   3. Exit 1 on timeout; the runner aborts before attaching.
//
// Race note: two concurrent `ocp herdr` invocations may both reach step 2;
// herdr is single-instance so only one spawn binds the socket. The loser's
// detached spawn exits silently — we don't surface that as an error, just
// keep polling.
//
// Debug: `--probe` checks readiness only, never starts a server.

const { cli, pollUntil, startDetached } = require('../lib/ocp-cli');

function probe() {
  const res = cli(['agent', 'list'], { json: true, timeout: 5000 });
  return !res.error && res.status === 0;
}

if (probe()) process.exit(0);

if (process.argv.includes('--probe')) {
  console.log('[ocp] herdr server is not running.');
  process.exit(1);
}

// Cold start: detached headless server. Don't surface spawn errors here —
// a parallel `ocp herdr` may have already won the socket race.
startDetached(['server']);

const timeoutMs = Number(process.env.OCP_HERDR_SERVER_TIMEOUT_MS) || 15000;
if (pollUntil(probe, { timeoutMs, intervalMs: 500 })) process.exit(0);

console.error('[ocp] ✗ Could not start the Herdr server.');
console.error('    Try `herdr server` manually to see why it fails to boot.');
process.exit(1);
