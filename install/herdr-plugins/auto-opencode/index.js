#!/usr/bin/env node
// Auto-start OpenCode in every new tab/pane.
//
// Triggered by herdr's `tab.created` / `pane.created` plugin events. Reads the
// new pane ID from HERDR_PLUGIN_CONTEXT_JSON (pane.created gives pane.id
// directly; tab.created gives tab.id — we fetch its root pane). Skips the pane
// if opencode is already running, and uses a unique agent name per pane so
// herdr's per-pane name uniqueness rule is satisfied.
//
// Runtime prerequisites — these are NOT validated by the plugin manager, and
// silently failing here is the most common cause of "the plugin doesn't
// seem to fire":
//
//   1. herdr server must be running. The plugin only runs in response to
//      `tab.created` / `pane.created` events emitted by the headless server.
//      After any `herdr server stop` (e.g. protocol-mismatch restart, upgrade,
//      manual stop) the plugin stays registered on disk but cannot fire until
//      the server is restarted — open `herdr` or run `ocp herdr` to bring it
//      back. Verify with `herdr agent list` (should return JSON, not
//      `server_not_running`).
//
//   2. The plugin fires on CREATION events only — existing panes from a
//      restored session are NOT reprocessed. To cover a pane, focus it and
//      split it (`Ctrl+B` / `Cmd+D` in herdr) or open a new tab. The
//      pane.created handler will fire and start opencode there.
//
//   3. opencode must be installed and on PATH (the agent.start handler will
//      still try even if missing, but the resulting pane will sit at a
//      shell prompt with the failure swallowed — see the log file below).
//
// All errors are written to stderr AND appended to a log file at
//   ~/.config/opencode/logs/ocp-auto-opencode.log
// so failures are never silent. Exit codes:
//   0 = skipped (no pane, server not running, opencode already there, …)
//   2 = recoverable error (logged; next event will retry)

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const herdr = process.env.HERDR_BIN_PATH || 'herdr';
const event = process.env.HERDR_PLUGIN_EVENT || '';
const ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || '{}');

// --- logging --------------------------------------------------------------
function logPath() {
  // Honor OCP_LOG_DIR if set (lets tests / power users redirect), then fall
  // back to a known config dir so the log survives across herdr restarts.
  const dir =
    process.env.OCP_LOG_DIR ||
    (process.env.XDG_CONFIG_HOME
      ? path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'logs')
      : path.join(os.homedir(), '.config', 'opencode', 'logs'));
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
  return path.join(dir, 'ocp-auto-opencode.log');
}

function log(level, msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] [ocp-auto-opencode] [${event || '?'}] ${msg}`;
  // stderr first — survives even if the log file is locked / unwritable.
  try { process.stderr.write(line + '\n'); } catch { /* noop */ }
  try { fs.appendFileSync(logPath(), line + '\n'); } catch { /* best effort */ }
}

// Distinguish "not running / stale" from "real error" — only the former is
// normal enough to skip without colouring the log red.
function isServerUnavailable(err) {
  const msg = String((err && err.message) || '');
  return /server_not_running|no herdr server is running|protocol_mismatch/i.test(msg);
}

// --- pane resolution -------------------------------------------------------
function resolvePaneId() {
  // pane.created: herdr sets focused_pane_id directly on the context.
  if (ctx.focused_pane_id) return ctx.focused_pane_id;
  // tab.created: herdr gives tab_id + workspace_id. We have to ask for
  // the tab's root pane via the CLI.
  if (ctx.tab_id) {
    try {
      const out = execFileSync(herdr, ['tab', 'get', ctx.tab_id], { encoding: 'utf8' });
      const j = JSON.parse(out);
      return j.result.tab.root_pane.pane_id;
    } catch (err) {
      if (isServerUnavailable(err)) {
        log('INFO', 'skip: herdr server not running — restart with `herdr` or `ocp herdr`');
        return null;
      }
      log('ERROR', `tab.get failed: ${err && err.message}`);
      process.exitCode = 2;
      return null;
    }
  }
  return null;
}

const paneId = resolvePaneId();
if (!paneId && !process.exitCode) process.exit(0);

// --- skip if opencode is already in this pane ----------------------------
try {
  const out = execFileSync(herdr, ['agent', 'list'], { encoding: 'utf8' });
  const j = JSON.parse(out);
  const agents = (j.result && j.result.agents) || [];
  if (agents.some((a) => a.pane_id === paneId && (a.kind === 'opencode' || a.agent === 'opencode'))) {
    process.exit(0);
  }
} catch (err) {
  // agent list failure is informational — let agent start decide.
  if (isServerUnavailable(err)) {
    log('INFO', 'skip: herdr server not running (agent.list)');
    process.exit(0);
  }
  log('WARN', `agent.list failed (continuing): ${err && err.message}`);
}

// --- start opencode ------------------------------------------------------
// Generate a unique agent name (herdr requires `[a-z][a-z0-9_-]{0,31}`).
const safe = paneId.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(-12);
const name = `oc-${safe}`.slice(0, 32);

try {
  execFileSync(
    herdr,
    ['agent', 'start', name, '--kind', 'opencode', '--pane', paneId],
    { stdio: 'ignore' }
  );
  log('INFO', `started opencode in pane ${paneId} as ${name}`);
} catch (err) {
  // Herdr returns JSON envelopes even on failure, so we surface the parsed
  // error code when we can — far more useful than a raw spawn error.
  let detail = (err && err.message) || String(err);
  try {
    const j = JSON.parse((err.stdout || '').toString().trim());
    if (j && j.error) detail = `${j.error.code || ''} ${j.error.message || ''}`.trim();
  } catch { /* not JSON — keep raw */ }
  log('ERROR', `agent.start failed for ${name} in ${paneId}: ${detail}`);
  process.exitCode = 2;
}