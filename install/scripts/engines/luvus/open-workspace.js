#!/usr/bin/env node
// install/scripts/engines/luvus/open-workspace.js
//
// `ocp tui` (luvus mode) pre-launch step 2: open the launch directory as a
// Luvus workspace. Unlike herdr, luvus' `workspace open` is already
// idempotent (open-or-focus semantics), so this step is a thin call — no
// list/dedupe round-trip needed. Output is inherited; failures abort the
// launch exactly as before.

const { cli, ctx } = require('../lib/ocp-cli');

const { cwd } = ctx();

// No timeout: `workspace open` waits on the server; must not be cut off.
const res = cli(['workspace', 'open', cwd], { timeout: 0 });
if (res.error || (res.status ?? 1) !== 0) {
  console.error('✗ Failed to open the current directory as a Luvus workspace.');
  process.exit(res.status ?? 1);
}
