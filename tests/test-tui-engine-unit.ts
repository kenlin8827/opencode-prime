/**
 * TUI Engine — Unit Tests (no network, no real herdr/luvus needed)
 *
 * Coverage:
 *   - install/scripts/engines/lib/ocp-cli.js plumbing via the scripts that
 *     use it (exit-code convention 0/1/2, JSON envelope + top-level fallbacks)
 *   - herdr ensure-server: probe fast-path, --probe never starts a server
 *   - herdr open-workspace: label dedupe -> focus, miss -> create, focus
 *     failure -> real fallback to create, server_not_running -> soft exit 2,
 *     non-JSON success -> short message (parity with the pre-engine launcher)
 *   - luvus ensure-server / open-workspace: failure propagation + abort codes
 *   - luvus start-agent: warm agent (workspace-level + pane-level) skips,
 *     cold path runs `pane run` (Windows quoting-bug workaround) +
 *     best-effort `pane name`, run failure is soft (exit 2)
 *   - tui-engine.ts runner: OCP_TUI_DRY_RUN plan for herdr/luvus, unknown
 *     engine rejected with a clear error — plus end-to-end step execution on
 *     a fixture registry (bin = node): exit-2 continues to attach, exit-5
 *     aborts, malformed step yields a clean config error. Exit codes are
 *     propagated exactly through the real step shell (cmd/sh, not PowerShell).
 *
 * Tool binaries are replaced via a PATH shim (`herdr`/`luvus` -> mock CLI)
 * that records every invocation; the mock answers per scenario rules.
 *
 * Run: bun run tests/test-tui-engine-unit.ts
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = resolve(__dirname, '..');
const scripts = join(repo, 'install', 'scripts', 'engines');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}`); }
}

// --- mock CLI shim ----------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), 'ocp-tui-engine-'));
const shimDir = join(tmp, 'shim');
mkdirSync(shimDir);

const mock = join(tmp, 'mock-cli.js');
writeFileSync(mock, [
  'const fs = require("node:fs");',
  'const scenario = JSON.parse(fs.readFileSync(process.env.MOCK_SCENARIO, "utf8"));',
  'const args = process.argv.slice(2);',
  'fs.appendFileSync(process.env.MOCK_CALLS, JSON.stringify(args) + String.fromCharCode(10));',
  'const r = scenario.responses.find((x) => new RegExp(x.match).test(args.join(" "))) || { stdout: "", status: 0 };',
  'if (r.stdout) process.stdout.write(r.stdout);',
  'if (r.stderr) process.stderr.write(r.stderr);',
  'process.exit(r.status === undefined ? 0 : r.status);',
].join('\n'));
for (const bin of ['herdr', 'luvus']) {
  writeFileSync(join(shimDir, `${bin}.cmd`), `@echo off\r\nnode "${mock}" %*\r\n`);
  writeFileSync(join(shimDir, bin), `#!/bin/sh\nexec node "${mock}" "$@"\n`);
}

interface MockResponse { match: string; stdout?: string; stderr?: string; status?: number }

function runScript(script: string, responses: MockResponse[], env: Record<string, string>, argv: string[] = []) {
  const scenarioFile = join(tmp, 'scenario.json');
  const callsFile = join(tmp, 'calls.log');
  try { unlinkSync(callsFile); } catch { /* fresh */ }
  writeFileSync(scenarioFile, JSON.stringify({ responses }));
  const res = spawnSync(process.execPath, [join(scripts, script), ...argv], {
    encoding: 'utf8',
    shell: false,
    env: {
      ...process.env, ...env,
      OCP_CWD: tmp, OCP_LABEL: 'demo', OCP_TUI_ARGS: '[]', OCP_ENGINE_ID: 'x',
      MOCK_SCENARIO: scenarioFile, MOCK_CALLS: callsFile,
      PATH: `${shimDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
    },
  });
  const calls = existsSync(callsFile)
    ? readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map((l: string) => JSON.parse(l) as string[])
    : [];
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', calls };
}

// --- herdr ensure-server ----------------------------------------------------
{
  const r = runScript('herdr/ensure-server.js', [{ match: '^agent list', status: 0 }], { OCP_ENGINE_BIN: 'herdr' });
  check('herdr ensure-server: probe ok -> exit 0, single probe call',
    r.status === 0 && r.calls.length === 1 && r.calls[0].join(' ') === 'agent list', JSON.stringify(r));
}
{
  const r = runScript('herdr/ensure-server.js', [{ match: '^agent list', status: 1 }], { OCP_ENGINE_BIN: 'herdr' }, ['--probe']);
  check('herdr ensure-server: --probe down -> exit 1 without starting a server',
    r.status === 1 && r.calls.length === 1 && /not running/.test(r.stdout + r.stderr), JSON.stringify(r));
}

// --- herdr open-workspace ---------------------------------------------------
{
  const list = JSON.stringify({ result: { workspaces: [{ label: 'demo', workspace_id: 'w1' }] } });
  const r = runScript('herdr/open-workspace.js', [
    { match: '^workspace list', stdout: list, status: 0 },
    { match: '^workspace focus w1', status: 0 },
  ], { OCP_ENGINE_BIN: 'herdr' });
  check('herdr open-workspace: label hit -> focus (no create)',
    r.status === 0 && r.calls.some((c) => c.join(' ') === 'workspace focus w1')
    && !r.calls.some((c) => c[1] === 'create')
    && /Reusing existing workspace "demo" \(w1\)/.test(r.stdout), JSON.stringify(r));
}
{
  const created = JSON.stringify({ result: { workspace: { workspace_id: 'w9' } } });
  const r = runScript('herdr/open-workspace.js', [
    { match: '^workspace list', stdout: '{"result":{"workspaces":[]}}', status: 0 },
    { match: '^workspace create', stdout: created, status: 0 },
  ], { OCP_ENGINE_BIN: 'herdr' });
  const create = r.calls.find((c) => c[1] === 'create') ?? [];
  check('herdr open-workspace: miss -> create --cwd/--label/--focus, id in message',
    r.status === 0 && create[3] === tmp && create[5] === 'demo' && create[6] === '--focus'
    && /Workspace "demo" opened .* \(w9\); opencode will start automatically/.test(r.stdout), JSON.stringify(r));
}
{
  const r = runScript('herdr/open-workspace.js', [
    { match: '^workspace list', stdout: '{"result":{"workspaces":[]}}', status: 0 },
    { match: '^workspace create', stdout: 'not-json-at-all', status: 0 },
  ], { OCP_ENGINE_BIN: 'herdr' });
  check('herdr open-workspace: non-JSON success -> short message, exit 0',
    r.status === 0 && /Workspace "demo" opened at/.test(r.stdout)
    && !/opencode will start automatically/.test(r.stdout), JSON.stringify(r));
}
{
  const r = runScript('herdr/open-workspace.js', [
    { match: '^workspace list', stdout: '{"result":{"workspaces":[{"label":"demo","workspace_id":"w1"}]}}', status: 0 },
    { match: '^workspace focus', status: 4 },
    { match: '^workspace create', stdout: '{"result":{"workspace":{"workspace_id":"w2"}}}', status: 0 },
  ], { OCP_ENGINE_BIN: 'herdr' });
  check('herdr open-workspace: focus failure -> real fallback to create',
    r.status === 0 && r.calls.some((c) => c[1] === 'create')
    && /falling back to create/.test(r.stdout), JSON.stringify(r));
}
{
  const err = '{"error":{"code":"server_not_running"}}';
  const r = runScript('herdr/open-workspace.js', [
    { match: '^workspace list', stdout: err, status: 1 },
    { match: '^workspace create', stdout: err, stderr: err, status: 1 },
  ], { OCP_ENGINE_BIN: 'herdr' });
  check('herdr open-workspace: server_not_running -> exit 2 (attach continues) + rerun hint',
    r.status === 2 && /it'll start on this launch/.test(r.stdout), JSON.stringify(r));
}

// --- luvus ensure-server / open-workspace -------------------------------------
{
  const r = runScript('luvus/ensure-server.js', [{ match: '^server start', status: 3 }], { OCP_ENGINE_BIN: 'luvus' });
  check('luvus ensure-server: non-zero propagates exit code + error line',
    r.status === 3 && /Failed to start the Luvus server/.test(r.stderr), JSON.stringify(r));
}
{
  const r = runScript('luvus/open-workspace.js', [{ match: '^workspace open', status: 0 }], { OCP_ENGINE_BIN: 'luvus' });
  check('luvus open-workspace: single idempotent open call',
    r.status === 0 && r.calls.length === 1 && r.calls[0].join(' ') === `workspace open ${tmp}`, JSON.stringify(r));
}

// --- luvus start-agent --------------------------------------------------------
{
  const agents = JSON.stringify({ result: { agents: [{ kind: 'opencode', cwd: tmp }] } });
  const r = runScript('luvus/start-agent.js', [{ match: '^agent list', stdout: agents, status: 0 }], { OCP_ENGINE_BIN: 'luvus' });
  check('luvus start-agent: warm agent under cwd -> skip without pane calls',
    r.status === 0 && r.calls.length === 1 && /already running in this workspace/.test(r.stdout), JSON.stringify(r));
}
{
  // top-level (envelope-less) payloads must still parse — parity with the
  // original `json?.result?.X ?? json?.X ?? []` lookups.
  const r = runScript('luvus/start-agent.js', [
    { match: '^agent list', stdout: '{"agents":[]}', status: 0 },
    { match: '^pane list', stdout: '{"panes":[{"pane_id":"p7","focused":true}]}', status: 0 },
    { match: '^pane status', stdout: '{"agent":"shell"}', status: 0 },
    { match: '^pane run', stdout: '{"ok":true}', status: 0 },
    { match: '^pane name', stdout: '{"ok":true}', status: 0 },
  ], { OCP_ENGINE_BIN: 'luvus' });
  check('luvus start-agent: envelope-less JSON handled (pane_id + run + name)',
    r.status === 0 && r.calls.some((c) => c.join(' ') === 'pane run p7 opencode')
    && r.calls.some((c) => c.join(' ') === 'pane name opencode --pane p7'), JSON.stringify(r));
}
{
  const r = runScript('luvus/start-agent.js', [
    { match: '^agent list', stdout: '{"result":{"agents":[]}}', status: 0 },
    { match: '^pane list', stdout: '{"result":{"panes":[{"pane":"p1","focused":true}]}}', status: 0 },
    { match: '^pane status', stdout: '{"result":{"agent":"opencode"}}', status: 0 },
  ], { OCP_ENGINE_BIN: 'luvus' });
  check('luvus start-agent: pane already runs opencode -> no duplicate start',
    r.status === 0 && !r.calls.some((c) => c[0] === 'pane' && c[1] === 'run'), JSON.stringify(r));
}
{
  const r = runScript('luvus/start-agent.js', [
    { match: '^agent list', stdout: '{"result":{"agents":[]}}', status: 0 },
    { match: '^pane list', stdout: '{"result":{"panes":[{"pane":"p1","focused":true}]}}', status: 0 },
    { match: '^pane status', stdout: '{"result":{"agent":"shell"}}', status: 0 },
    { match: '^pane run', stdout: '{"error":{"code":"boom"}}', status: 5 },
  ], { OCP_ENGINE_BIN: 'luvus' });
  check('luvus start-agent: pane run failure -> exit 2 soft + manual hint',
    r.status === 2 && /Run `opencode` there manually/.test(r.stderr + r.stdout), JSON.stringify(r));
}

// --- runner (tui-engine.ts) ---------------------------------------------------
function runEngineCode(code: string, env: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf8',
    shell: false,
    cwd: repo,
    // undefined strips the var: a developer-global dry-run must not
    // silently disable the real-spawn e2e cases.
    env: { ...process.env, OCP_TUI_DRY_RUN: undefined, ...env },
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}
const engineImport = `const { runTuiEngine } = await import(${JSON.stringify(`file:///${join(repo, 'install', 'src', 'tui-engine.ts').replace(/\\/g, '/')}`)});`;

{
  const r = runEngineCode(`${engineImport} process.exit(runTuiEngine(process.cwd(), "herdr", ["--init", "extra"]));`, { OCP_TUI_DRY_RUN: '1' });
  check('runner dry-run: herdr plan = 2 steps + attach forwards non-control args',
    r.status === 0 && /pre_launch 1\. ensure-server/.test(r.stdout) && /pre_launch 2\. open-workspace/.test(r.stdout)
    && /attach: herdr extra$/.test(r.stdout.trimEnd()), JSON.stringify(r));
}
{
  const r = runEngineCode(`${engineImport} process.exit(runTuiEngine(process.cwd(), "luvus", ["--session", "x"]));`, { OCP_TUI_DRY_RUN: '1' });
  check('runner dry-run: luvus plan = 3 steps, attach drops args (forward_args false)',
    r.status === 0 && /pre_launch 3\. start-agent/.test(r.stdout) && /attach: luvus\s*$/.test(r.stdout.trimEnd() + ' '), JSON.stringify(r));
}
{
  const r = runEngineCode(`${engineImport} process.exit(runTuiEngine(process.cwd(), "no-such-engine", []));`);
  check('runner: unknown engine id -> clear error, exit 1',
    r.status !== 0 && /not declared in install\/tools\.jsonc/.test(r.stdout + r.stderr), JSON.stringify(r));
}

// --- runner end-to-end (fixture tools.jsonc, bin = node) --------------------
// Exercises the real step execution path (spawnSync shell:true → cmd/sh) and
// verifies exact exit-code propagation (2 = continue, 5 = abort) — the
// invariant that PowerShell would silently break.
function fixtureRepo(steps: unknown[], attachArgs: string[] = ['--version']): string {
  const dir = join(tmp, `repo-${pass}-${fail}`);
  mkdirSync(join(dir, 'install'), { recursive: true });
  writeFileSync(join(dir, 'install', 'tools.jsonc'), JSON.stringify({
    tools: {
      nodefake: {
        binary: 'node',
        tui: { bin: 'node', attach_args: attachArgs, pre_launch: steps },
      },
    },
  }));
  return dir;
}
function stepScript(name: string, marker: string, code: number): string {
  const f = join(tmp, name);
  writeFileSync(f, `console.log('${marker}');process.exit(${code});\n`);
  return f;
}
{
  const warn = stepScript('step-warn.js', 'STEP2-WARN-CONTINUES', 2);
  const dir = fixtureRepo([
    { name: 'warn-step', command: `node "${warn}"` },
  ]);
  const r = runEngineCode(`const { runTuiEngine } = await import(${JSON.stringify(`file:///${join(repo, 'install', 'src', 'tui-engine.ts').replace(/\\/g, '/')}`)}); process.exit(runTuiEngine(${JSON.stringify(dir)}, "nodefake", []));`);
  check('runner e2e: step exit 2 propagates through the platform shell -> warn + attach still runs',
    r.status === 0 && /STEP2-WARN-CONTINUES/.test(r.stdout) && /v\d+\.\d+/.test(r.stdout), JSON.stringify(r));
}
{
  const bad = stepScript('step-abort.js', 'STEP5-ABORTS-LAUNCH', 5);
  const dir = fixtureRepo([
    { name: 'abort-step', command: `node "${bad}"` },
  ]);
  const r = runEngineCode(`const { runTuiEngine } = await import(${JSON.stringify(`file:///${join(repo, 'install', 'src', 'tui-engine.ts').replace(/\\/g, '/')}`)}); process.exit(runTuiEngine(${JSON.stringify(dir)}, "nodefake", []));`);
  check('runner e2e: step exit 5 aborts before attach (no version output)',
    r.status === 5 && /STEP5-ABORTS-LAUNCH/.test(r.stdout) && !/v\d+\.\d+/.test(r.stdout)
    && /not attaching/.test(r.stderr), JSON.stringify(r));
}
{
  const dir = fixtureRepo([{ name: 'broken' }]);
  const r = runEngineCode(`const { runTuiEngine } = await import(${JSON.stringify(`file:///${join(repo, 'install', 'src', 'tui-engine.ts').replace(/\\/g, '/')}`)}); process.exit(runTuiEngine(${JSON.stringify(dir)}, "nodefake", []));`);
  check('runner: malformed pre_launch step -> clean config error, no raw TypeError',
    r.status === 1 && /has no command string/.test(r.stderr + r.stdout) && !/TypeError/.test(r.stderr), JSON.stringify(r));
}

console.log(`\nTUI engine: ${pass} passed, ${fail} failed`);
rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
