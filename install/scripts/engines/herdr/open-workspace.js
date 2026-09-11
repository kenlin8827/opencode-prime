#!/usr/bin/env node
// install/scripts/engines/herdr/open-workspace.js
//
// `ocp herdr` pre-launch step 2: register the launch directory as a Herdr
// workspace and focus it, so the TUI attach (step 3, the engine) lands the
// user in the right place.
//
// herdr's `workspace create` does NOT dedupe — calling it twice with the
// same label creates two workspaces. So we first ask herdr for the existing
// workspace list; if one already has this label we just focus it. Either
// way, creating a workspace emits `pane.created` for the new root pane,
// which the ocp.auto-opencode plugin (linked at install time) listens to
// and auto-starts opencode there — this step does NOT start agents itself.
//
// Dedupe by label alone is sufficient in practice: each `ocp herdr` from a
// directory produces one workspace with `label = basename(cwd)`, and the
// same directory will keep using the same label. (If the user has two
// different directories with the same basename, they end up sharing a
// workspace — a known trade-off; cleaner dedup would require a cwd
// round-trip via tab get + pane get, which is fragile because herdr
// surfaces stale entries in `workspace list` for closed workspaces.)
//
// All registration failures are soft (exit 2 — the TUI attach still works,
// just without a guaranteed focused workspace). On any server-not-running
// error the user gets a re-run hint instead of a wall of JSON.

const { cli, cliJson, unwrap, ctx } = require('../lib/ocp-cli');

const { cwd, label } = ctx();

/** Existing workspace id for `label`, or null on any miss/error. */
function findWorkspaceByLabel(targetLabel) {
  const res = cliJson(['workspace', 'list'], { timeout: 10000 });
  if (!res.ok || !res.data) return null;
  const workspaces = unwrap(res.data).workspaces ?? [];
  const match = workspaces.find((w) => w.label === targetLabel);
  return match?.workspace_id ?? null;
}

/** Focus the workspace; returns herdr's exit status (0 = success).
 *  30s cap (lib default) — intentional drift: the old inline call had no
 *  timeout and could stall the launch forever. */
function focusWorkspace(workspaceId) {
  return cliJson(['workspace', 'focus', workspaceId]).status;
}

/** Create + focus. Returns true (registered) — soft-failure paths exit inline. */
function createWorkspace() {
  const res = cliJson(
    ['workspace', 'create', '--cwd', cwd, '--label', label, '--focus'],
    { timeout: 0 }, // must not be cut off mid-registration
  );
  if (res.status === 0 && res.stdout) {
    if (res.data) {
      const workspaceId = unwrap(res.data).workspace?.workspace_id ?? null;
      console.log(`[ocp] Workspace "${label}" opened at ${cwd} (${workspaceId ?? '?'}); opencode will start automatically in the root pane`);
    } else {
      // herdr returned non-JSON; treat as success-without-metadata.
      console.log(`[ocp] Workspace "${label}" opened at ${cwd}`);
    }
    process.exit(0);
  }
  // Most common cause: herdr server isn't running (probe raced a stop).
  // The next `herdr` attach starts it; the user runs `ocp herdr` once more.
  const stderr = (res.stderr ?? '').toString().trim();
  const hint = /server_not_running/i.test(stderr)
    ? 'herdr server not running — it\'ll start on this launch; run `ocp herdr` again afterwards to register the workspace.'
    : `workspace registration skipped (exit ${res.status ?? '?'}${stderr ? `: ${stderr}` : ''})`;
  console.log(`[ocp] ${hint}`);
  process.exit(2); // warn-but-continue: still attach
}

const existing = findWorkspaceByLabel(label);
if (existing) {
  console.log(`[ocp] Reusing existing workspace "${label}" (${existing}) at ${cwd}`);
  const focusStatus = focusWorkspace(existing);
  if (focusStatus === 0) {
    console.log('[ocp] opencode will start automatically in the focused pane');
    process.exit(0);
  }
  console.log(`[ocp] workspace focus failed (exit ${focusStatus}); falling back to create`);
}
createWorkspace();
