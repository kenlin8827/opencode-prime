#!/usr/bin/env node
// Auto-start OpenCode in every new tab/pane (Luvus edition).
//
// Triggered by luvus's `tab.created` / `pane.created` module events.
// Reads the new pane ID from LUVUS_MODULE_EVENT_JSON; falls back to the
// injected LUVUS_PANE_ID context (a freshly created tab/pane is focused, so
// the snapshot points at it). Skips the pane if opencode is already running
// there, then launches `opencode` via `pane run` and gives the pane a unique
// name so it can be `=`-mentioned.
//
// Why `pane run` instead of `agent start --kind opencode`: on Windows the
// kind launcher types the command quoted ('opencode') into PowerShell, which
// echoes the string instead of executing it — the agent never boots, the
// start blocks the readiness wait, and the bound name lingers as a zombie
// that breaks later starts with name_in_use. `pane run` sends the argv
// unquoted, and luvus auto-detects the process (authority: process_tree).
//
// The luvus CLI is the module API (https://luvus.dev/docs/extend/writing-modules/).

const { execFileSync } = require('node:child_process');

const luvus = process.env.LUVUS_BIN_PATH || 'luvus';
let payload = {};
try {
  payload = JSON.parse(process.env.LUVUS_MODULE_EVENT_JSON || '{}');
} catch {
  // Malformed payload — the context fallback below still applies.
}

function luvusJson(args) {
  try {
    return JSON.parse(execFileSync(luvus, args, { encoding: 'utf8', timeout: 15000 }));
  } catch {
    return null;
  }
}

function luvusOk(args) {
  try {
    execFileSync(luvus, args, { stdio: 'ignore', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

// 1. Resolve the target pane ID for this event.
function resolvePaneId() {
  // pane.created: the payload names the pane that actually changed. Luvus
  // event payloads carry ids as plain strings (e.g. {"pane":"4", ...} for
  // agent_status_changed); tolerate an { id } object just in case.
  const p = payload.pane;
  if (typeof p === 'string' && p) return p;
  if (p && typeof p === 'object' && p.id != null) return String(p.id);
  // tab.created (or an unexpected payload shape): fall back to the focused
  // pane from the context snapshot. New tabs focus their root pane. Safe
  // even when the snapshot points at an older pane — step 2 skips panes
  // that already run opencode.
  if (process.env.LUVUS_PANE_ID) return process.env.LUVUS_PANE_ID;
  return null;
}

const paneId = resolvePaneId();
if (!paneId) process.exit(0);

// 2. Skip if opencode is already running in this pane (manual start, the
//    ocp tui launcher bootstrap, etc.). Check the fleet view first, then the
//    pane's own detection state.
try {
  const j = luvusJson(['agent', 'list']);
  const agents = (j?.result && j.result.agents) || j?.agents || [];
  if (
    agents.some(
      (a) =>
        String(a?.pane ?? a?.pane_id ?? '') === String(paneId) &&
        (a?.kind === 'opencode' || a?.agent === 'opencode')
    )
  ) {
    process.exit(0);
  }
} catch {
  /* fall through to the pane-level check */
}
{
  const s = luvusJson(['pane', 'status', paneId]);
  const agent = String(s?.result?.agent ?? s?.agent ?? '');
  if (/opencode/i.test(agent)) process.exit(0);
}

// 3. Give the fresh pane's shell a moment to be ready for input.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);

// 4. Launch opencode in the pane, then name the pane (best effort — a zombie
//    name from an old session must not block the launch or noisily fail; the
//    agent works fine unnamed).
if (!luvusOk(['pane', 'run', paneId, 'opencode'])) process.exit(0);

const safe = String(paneId).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(-12);
const name = `oc-${safe}`.slice(0, 32);
luvusOk(['pane', 'name', name, '--pane', String(paneId)]);
