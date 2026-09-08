import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { getOpencodeExecutable } from './shared/opencode-command';

/**
 * `ocp clean` — delete old OpenCode sessions via the official CLI.
 *
 * Uses `opencode db <query> --format json` to list sessions and
 * `opencode session delete <id>` to remove them. This avoids direct
 * SQLite access (the server owns the database lock) and delegates
 * all storage operations to the engine.
 */

// ─── Types ──────────────────────────────────────────────────────────────

export interface CleanOptions {
  days: number;
  all: boolean;
  allProjects: boolean;
  dryRun: boolean;
  yes: boolean;
  includeSubagents: boolean;
  project?: string;
  projectName?: string;
  directory?: string;
}

interface SessionRow {
  id: string;
  title: string;
  time_created: number;
  parent_id: string | null;
  tokens_input: number;
  tokens_output: number;
  cost: number;
}

interface ProjectRow {
  project_id: string;
  directory: string;
  count: number;
}

interface SessionProjectRow extends ProjectRow {
  oldest: number;
  newest: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function runOpencode(args: string[]): string {
  try {
    const executable = getOpencodeExecutable();
    if (!executable) {
      console.error('✗ opencode CLI was not found.');
      console.error('  Install OpenCode first: https://opencode.ai');
      process.exit(1);
    }
    return execFileSync(executable, args, {
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      console.error('✗ opencode CLI was not found on PATH.');
      console.error('  Install OpenCode first: https://opencode.ai');
      process.exit(1);
    }
    throw err;
  }
}

function querySessions(sql: string): SessionRow[] {
  const out = runOpencode(['db', sql, '--format', 'json']);
  if (!out) return [];
  return JSON.parse(out) as SessionRow[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(unixMs: number): string {
  return new Date(unixMs).toISOString().slice(0, 16).replace('T', ' ');
}

function daysAgo(unixMs: number): number {
  return Math.floor((Date.now() - unixMs) / (86400 * 1000));
}

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

function normalizeDirectory(dir: string): string {
  const resolved = path.resolve(dir);
  return process.platform === 'win32' ? resolved.replace(/\\/g, '/') : resolved;
}

function looksLikeProjectId(value: string): boolean {
  if (value === 'global') return true;
  return /^[0-9a-f]{40}$/i.test(value);
}

function queryProjects(sql: string): ProjectRow[] {
  const out = runOpencode(['db', sql, '--format', 'json']);
  if (!out) return [];
  return JSON.parse(out) as ProjectRow[];
}

/** `ocp session projects` — list workspaces with saved OpenCode sessions. */
export async function executeSessionProjects(): Promise<void> {
  const sql = `SELECT project_id, directory, COUNT(*) as count, MIN(time_created) as oldest, MAX(time_created) as newest FROM session GROUP BY project_id, directory ORDER BY newest DESC`;
  const rows = queryProjects(sql) as SessionProjectRow[];

  if (rows.length === 0) {
    console.log('No session projects found.');
    return;
  }

  console.log('');
  console.log('OpenCode Session Projects');
  console.log('═'.repeat(80));
  for (const row of rows) {
    console.log(`  ${row.directory}`);
    console.log(`    Sessions: ${row.count}  Last activity: ${formatDate(row.newest)}  Project: ${row.project_id}`);
  }
  console.log('');
}

function resolveProjectId(name: string): string | undefined {
  const safe = sqlEscape(name);
  const sql = `SELECT project_id, directory, COUNT(*) as count FROM session WHERE INSTR(LOWER(directory), LOWER('${safe}')) > 0 GROUP BY project_id, directory ORDER BY count DESC`;
  const rows = queryProjects(sql);
  if (rows.length === 0) return undefined;
  if (rows.length === 1) return rows[0].project_id;
  console.error(`Multiple projects match '${name}':`);
  for (const r of rows) {
    console.error(`  ${r.project_id}  ${r.directory}  (${r.count} sessions)`);
  }
  process.exit(1);
}

function getDbSize(): number {
  try {
    const dbPath = runOpencode(['db', 'path']);
    const fs = require('node:fs');
    if (fs.existsSync(dbPath)) return fs.statSync(dbPath).size;
  } catch { /* ignore */ }
  return 0;
}

// ─── Main logic ─────────────────────────────────────────────────────────

export async function executeClean(opts: CleanOptions): Promise<void> {
  // Resolve a human-readable project name to a project_id first.
  // `--project` accepts either a raw project_id or a project path/name.
  let effectiveProject = opts.project;
  const projectNameInput = opts.projectName ?? (opts.project && !looksLikeProjectId(opts.project) ? opts.project : undefined);
  if (projectNameInput) {
    const resolved = resolveProjectId(projectNameInput);
    if (!resolved) {
      console.log(`No project found matching '${projectNameInput}'.`);
      return;
    }
    effectiveProject = resolved;
  }

  // OpenCode stores timestamps in milliseconds (Unix epoch * 1000).
  const cutoff = Date.now() - opts.days * 86400 * 1000;

  // Build the SQL query.
  const effectiveDirectory = opts.directory ? normalizeDirectory(opts.directory) : undefined;
  // --all intentionally includes child sessions too: otherwise it would not
  // actually clear every session in the selected project/workspace.
  const includeSubagents = opts.all || opts.includeSubagents;
  const ageFilter = opts.all ? '' : `AND time_created < ${cutoff}`;
  const parentFilter = includeSubagents ? '' : 'AND parent_id IS NULL';
  const projectFilter = effectiveProject ? `AND project_id = '${sqlEscape(effectiveProject)}'` : '';
  const directoryFilter = effectiveDirectory ? `AND directory = '${sqlEscape(effectiveDirectory)}'` : '';
  const sql = `SELECT id, title, time_created, parent_id, tokens_input, tokens_output, cost FROM session WHERE 1 = 1 ${ageFilter} ${parentFilter} ${projectFilter} ${directoryFilter} ORDER BY time_created ASC`;

  const rows = querySessions(sql);

  const dbSizeBefore = getDbSize();

  if (rows.length === 0) {
    const context = effectiveDirectory ? ` in ${effectiveDirectory}`
      : projectNameInput ? ` for project name '${projectNameInput}'`
      : effectiveProject ? ` for project ${effectiveProject}`
      : '';
    console.log(`No ${opts.all ? 'sessions' : `sessions older than ${opts.days} day(s)`} found${context}.`);
    console.log(`Database size: ${formatBytes(dbSizeBefore)}`);
    return;
  }

  // Age distribution.
  const ageGroups = [
    { label: `${opts.days}-7 days`, count: 0 },
    { label: '7-30 days', count: 0 },
    { label: '30-90 days', count: 0 },
    { label: '90+ days', count: 0 },
  ];
  for (const r of rows) {
    const age = daysAgo(r.time_created);
    if (age < 7) ageGroups[0].count++;
    else if (age < 30) ageGroups[1].count++;
    else if (age < 90) ageGroups[2].count++;
    else ageGroups[3].count++;
  }

  const totalInputTokens = rows.reduce((s, r) => s + (r.tokens_input || 0), 0);
  const totalOutputTokens = rows.reduce((s, r) => s + (r.tokens_output || 0), 0);

  // ── Print summary ────────────────────────────────────────────────────

  console.log('');
  console.log('═'.repeat(60));
  console.log(`  OpenCode Session Cleanup — ${opts.dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('═'.repeat(60));
  console.log('');
  console.log(`  Scope        : ${opts.all ? 'ALL sessions' : `older than ${opts.days} day(s) (before ${formatDate(cutoff)})`}`);
  console.log(`  Subagents    : ${includeSubagents ? 'included' : 'excluded'}`);
  const projectLabel = opts.projectName ?? (opts.project && !looksLikeProjectId(opts.project) ? opts.project : undefined);
  console.log(`  Project      : ${projectLabel ? `${projectLabel} → ${effectiveProject}` : effectiveProject ?? '(any)'}`);
  console.log(`  Directory    : ${effectiveDirectory ?? '(any)'}`);
  console.log(`  Database size: ${formatBytes(dbSizeBefore)}`);
  console.log('');
  console.log(`  Sessions to delete: ${rows.length}`);
  console.log('');

  const nonEmpty = ageGroups.filter(g => g.count > 0);
  if (nonEmpty.length > 0) {
    console.log('  Age breakdown:');
    for (const g of nonEmpty) {
      console.log(`    ${g.label.padEnd(16)} ${g.count}`);
    }
    console.log('');
  }

  if (totalInputTokens > 0 || totalOutputTokens > 0) {
    console.log(`  Tokens (input) : ${totalInputTokens.toLocaleString()}`);
    console.log(`  Tokens (output): ${totalOutputTokens.toLocaleString()}`);
    console.log('');
  }

  // Show up to 10 sample sessions.
  const sampleCount = Math.min(rows.length, 10);
  console.log(`  Sample sessions (showing ${sampleCount} of ${rows.length}):`);
  for (const r of rows.slice(0, sampleCount)) {
    const title = (r.title || '(untitled)').slice(0, 40);
    const age = daysAgo(r.time_created);
    const sub = r.parent_id ? ' [sub]' : '';
    console.log(`    ${formatDate(r.time_created)}  ${age}d ago  ${title}${sub}`);
  }
  if (rows.length > sampleCount) {
    console.log(`    ... and ${rows.length - sampleCount} more`);
  }
  console.log('');

  // ── Dry run — stop here ──────────────────────────────────────────────

  if (opts.dryRun) {
    console.log('  (dry run — no sessions were deleted)');
    console.log('═'.repeat(60));
    return;
  }

  // ── Confirmation prompt ──────────────────────────────────────────────

  // Clearing every session is deliberately never bypassed by -y/--yes.
  // It is a destructive action with no recovery path in the OpenCode CLI.
  if (opts.all) {
    const readline = require('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const scope = opts.allProjects ? 'across ALL saved projects' : 'in the selected workspace';
    const answer: string = await new Promise((resolve) => {
      rl.question(`  This permanently deletes ALL ${rows.length} session(s) ${scope}. Continue? [y/N] `, (ans: string) => {
        rl.close();
        resolve(ans);
      });
    });

    if (!answer.match(/^[yY]$/)) {
      console.log('  Cancelled.');
      return;
    }
  } else if (!opts.yes) {
    const readline = require('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const answer: string = await new Promise((resolve) => {
      rl.question(`  Delete ${rows.length} session(s)? [y/N] `, (ans: string) => {
        rl.close();
        resolve(ans);
      });
    });

    if (!answer.match(/^[yY]$/)) {
      console.log('  Cancelled.');
      return;
    }
  }

  // ── Delete via `opencode session delete` ─────────────────────────────

  let deleted = 0;
  let failed = 0;

  for (const r of rows) {
    try {
      runOpencode(['session', 'delete', r.id]);
      deleted++;
    } catch (err) {
      failed++;
      const commandError = err as Error & { stderr?: string | Buffer; stdout?: string | Buffer };
      const detail = commandError.stderr?.toString().trim()
        || commandError.stdout?.toString().trim()
        || commandError.message.split('\n')[0];
      console.error(`  ✗ Failed to delete ${r.id}: ${detail}`);
    }
  }

  const dbSizeAfter = getDbSize();
  const reclaimed = dbSizeBefore - dbSizeAfter;

  console.log('');
  console.log(`  Deleted: ${deleted} session(s)${failed > 0 ? `, ${failed} failed` : ''}`);
  console.log('');
  console.log(`  Database size before: ${formatBytes(dbSizeBefore)}`);
  console.log(`  Database size after : ${formatBytes(dbSizeAfter)}`);
  if (reclaimed > 0) {
    console.log(`  Space reclaimed     : ${formatBytes(reclaimed)}`);
  }
  console.log('');
  console.log('═'.repeat(60));
  console.log('  Done.');
  console.log('═'.repeat(60));
}
