#!/usr/bin/env node
// Auto-start OpenCode in every new tab/pane.
//
// Triggered by herdr's `tab.created` / `pane.created` plugin events. Reads
// the new pane ID from HERDR_PLUGIN_CONTEXT_JSON (pane.created gives
// pane.id directly; tab.created gives tab.id — we fetch its root pane).
// Skips the pane if opencode is already running there, and uses a unique
// agent name per pane so herdr's per-pane name uniqueness rule is satisfied.
//
// Why this is so defensive
// ------------------------
// Two failure modes used to be invisible:
//
//   1. tab.created and pane.created both fire for the *same* initial tab
//      when a workspace opens. The first call wins; the second call's
//      `agent start` fails because the name `oc-<pane>` is taken. We now
//      treat `name_in_use` / `agent_already_present` as a successful
//      no-op so the second invocation doesn't error.
//
//   2. Earlier versions used bare `catch {}` everywhere, swallowing
//      real failures (e.g. node missing from PATH, herdr server down,
//      wrong pane ID, kind not supported). Every error now lands in
//      `%APPDATA%/herdr/logs/ocp-auto-opencode.log` *and* on stderr so
//      herdr-server.log can correlate it with the dispatched event.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const herdr = process.env.HERDR_BIN_PATH || 'herdr';
const event = process.env.HERDR_PLUGIN_EVENT || '?';
const ctxRaw = process.env.HERDR_PLUGIN_CONTEXT_JSON || '{}';
let ctx;
try { ctx = JSON.parse(ctxRaw); }
catch (e) { logErr('context JSON parse failed:', e.message, '— raw:', ctxRaw.slice(0, 200)); process.exit(0); }

// 1. Resolve the target pane ID for this event.
function resolvePaneId() {
  if (ctx.focused_pane_id) return ctx.focused_pane_id;
  if (ctx.tab_id) {
    try {
      const out = execFileSync(herdr, ['tab', 'get', ctx.tab_id], { encoding: 'utf8' });
      const j = JSON.parse(out);
      const pid = j?.result?.tab?.root_pane?.pane_id;
      if (!pid) logErr('tab.get returned no root_pane.pane_id');
      return pid || null;
    } catch (e) {
      logErr('resolvePaneId via tab.get failed:', errMsg(e));
      return null;
    }
  }
  return null;
}

const paneId = resolvePaneId();
if (!paneId) {
  logErr('could not resolve pane ID; skipping');
  process.exit(0);
}

// 2. Generate a unique agent name (herdr requires `[a-z][a-z0-9_-]{0,31}`).
const safe = paneId.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(-12);
const name = `oc-${safe}`.slice(0, 32);

// 3. Skip if opencode already running in this pane, OR if our derived name
//    is already in use anywhere (handles the tab.created → pane.created
//    double-fire race cleanly without needing agent.start to fail).
try {
  const out = execFileSync(herdr, ['agent', 'list'], { encoding: 'utf8' });
  const j = JSON.parse(out);
  const agents = (j?.result?.agents) || [];
  if (agents.some((a) => a.pane_id === paneId && (a.kind === 'opencode' || a.agent === 'opencode'))) {
    process.exit(0);
  }
  if (agents.some((a) => a.name === name)) {
    process.exit(0);
  }
} catch (e) {
  // Agent list failing is unusual but recoverable — proceed and let the
  // start attempt surface the real error.
  logErr('agent list precheck failed (proceeding anyway):', errMsg(e));
}

// 4. Start opencode in the pane. Herdr's agent start waits (default 30s)
//    for the agent to reach `idle`, which is what we want — the next tab
//    only finishes booting once opencode is actually ready.
try {
  execFileSync(
    herdr,
    ['agent', 'start', name, '--kind', 'opencode', '--pane', paneId],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
} catch (e) {
  // Distinguish the idempotent race from a real failure.
  const stdout = e.stdout ? e.stdout.toString() : '';
  let code = null;
  try { code = JSON.parse(stdout)?.error?.code; } catch {}
  if (code === 'name_in_use' || code === 'agent_already_present') {
    // Another plugin invocation (or manual user action) already started
    // this agent. Treat as success.
    process.exit(0);
  }
  logErr(
    'agent start failed:',
    'code=' + (code || '?'),
    'stderr=' + (e.stderr ? e.stderr.toString().trim() : '(none)'),
    'stdout=' + stdout.trim().slice(0, 300)
  );
}

// --- helpers ---------------------------------------------------------------

function errMsg(e) {
  // node's spawn error has .code/.signal/.message; stdioerror wraps the
  // captured stdout/stderr — surface both.
  const parts = [e.message];
  if (e.code) parts.push('code=' + e.code);
  if (e.signal) parts.push('signal=' + e.signal);
  return parts.join(' ');
}

function logErr(...parts) {
  const line = `[${new Date().toISOString()}] [${event}] pane=${paneId || '?'} name=${name || '?'} ` +
    parts.join(' ') + '\n';
  try {
    const dir = logDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'ocp-auto-opencode.log'), line);
  } catch { /* best-effort — never let logging break the plugin */ }
  try { process.stderr.write(line); } catch {}
}

function logDir() {
  const base = process.env.APPDATA
    || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'herdr', 'logs');
}