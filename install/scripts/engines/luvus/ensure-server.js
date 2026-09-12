#!/usr/bin/env node
// install/scripts/engines/luvus/ensure-server.js
//
// `ocp tui` (luvus mode) pre-launch step 1: start the Luvus background
// server. `workspace open` is a client command and requires the
// server/socket to exist. `server start` is idempotent, so run it on every
// launch — this makes first use and post-reboot launches work without a
// manual bootstrap command.
//
// Luvus' own output goes straight to the terminal (stdio inherited), same
// as the pre-engine launcher did. Any failure aborts the launch (exit ≠ 0).

const { cli } = require('../lib/ocp-cli');

// No timeout: first cold boot may legitimately take longer than any cap.
const res = cli(['server', 'start'], { timeout: 0 });
if (res.error || (res.status ?? 1) !== 0) {
  console.error('✗ Failed to start the Luvus server.');
  process.exit(res.status ?? 1);
}
