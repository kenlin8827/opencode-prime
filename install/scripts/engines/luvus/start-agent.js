#!/usr/bin/env node
// install/scripts/engines/luvus/start-agent.js
//
// `ocp tui` (luvus mode) pre-launch step 3: guarantee an opencode agent is
// running in the just-opened workspace before the TUI attaches.
//
// Why a launch step at all — isn't the hook enough? The bundled
// `ocp.auto-opencode` module (linked at install time via `luvus module
// link`) handles `pane.created` events — the Luvus counterpart of the herdr
// auto-opencode plugin. But it fires on CREATION only: `workspace open` on
// an already-existing workspace emits no events, so a warm workspace may or
// may not still be running opencode. This step closes that gap — it starts
// opencode in the focused pane unless something already covers it.
//
// Do NOT replace the `pane run` below with `agent start <name> --kind
// opencode`: on Windows its launch line reaches PowerShell quoted
// ('opencode'), which echoes the string instead of executing it — the agent
// never boots, the call blocks the 30s readiness wait, and the bound name is
// left as a zombie that makes every later start fail with name_in_use.
// `pane run` sends the argv unquoted and luvus auto-detects the process
// (authority: process_tree).
//
// Failure to start is soft (exit 2): the user still gets their workspace,
// with a plain shell plus instructions to run `opencode` manually.

const { cliJson, ctx } = require('../lib/ocp-cli');

const { cwd } = ctx();

/** Field lookup with the same double fallback the original launcher used. */
function pick(data, key) { return data?.result?.[key] ?? data?.[key]; }

/** The focused pane id in the currently focused workspace, or null. */
function focusedPaneId() {
  const res = cliJson(['pane', 'list']);
  if (!res.ok) return null;
  const panes = pick(res.data, 'panes') ?? [];
  const pane = panes.find((p) => p?.focused === true) ?? panes[0];
  const id = pane?.pane ?? pane?.pane_id ?? pane?.id;
  return id != null ? String(id) : null;
}

/** True when `pane status <id>` already attributes the pane to opencode. */
function paneRunsOpencode(paneId) {
  const res = cliJson(['pane', 'status', paneId]);
  if (!res.ok) return false;
  const agent = String(pick(res.data, 'agent') ?? '');
  return /opencode/i.test(agent);
}

/**
 * True when `luvus agent list` positively confirms an opencode agent rooted at
 * (or below) `cwd`. Conservative by design: any missing binary, non-zero exit,
 * unparseable JSON, or absent cwd field yields false, so the pane-run start
 * above remains the reliable fallback.
 */
function hasOpencodeAgentInWorkspace() {
  const res = cliJson(['agent', 'list']);
  if (!res.ok || !res.data) return false;
  const agents = pick(res.data, 'agents') ?? [];
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const target = norm(cwd);
  return agents.some((a) => {
    if ((a?.kind ?? a?.agent) !== 'opencode') return false;
    const agentCwd = typeof a?.cwd === 'string' ? norm(a.cwd) : '';
    return agentCwd !== '' && (agentCwd === target || agentCwd.startsWith(target + '/'));
  });
}

if (hasOpencodeAgentInWorkspace()) {
  console.log('[ocp] opencode is already running in this workspace — attaching.');
  process.exit(0);
}

const paneId = focusedPaneId();
if (paneId && !paneRunsOpencode(paneId)) {
  const run = cliJson(['pane', 'run', paneId, 'opencode']);
  if (run.ok) {
    // Best-effort name for `=`-mentioning; a zombie name from an old
    // session is silently ignored (the agent works unnamed).
    cliJson(['pane', 'name', 'opencode', '--pane', paneId]);
  } else {
    console.warn('[ocp] ⚠ Could not auto-start opencode in the focused pane — it stays a plain shell. Run `opencode` there manually.');
    process.exit(2);
  }
}
