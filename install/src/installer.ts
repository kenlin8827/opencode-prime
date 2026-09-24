import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { CliArgs, InstallOptions } from './types';
import { deployHerdrConfig } from './herdr-config';
import { deployModelsCost } from './models-cost';
import { colorize } from './color';
import { runShellCommand, ShellCommandResult } from './shared/shell-command';
import {
  collectHistoricalShippedFiles,
  collectShippedFiles,
  generateManifest,
  getManifestPath,
  isCrossMajorVersion,
  isNewerVersion,
  majorOf,
  readManifest,
  readVersionJson,
} from './manifest';
import {
  extractPreserveBag,
  mergeConfig,
  mergeTuiConfig,
  readJsoncFile,
  getUserOptionsPath,
  mergeUserOptions,
} from './merger';
import { isBinaryOnPath, probeRunningOpencodeConfigDir } from './shared/opencode-detect';
import { section } from './shared/output';
import { resolvePmForSpec } from './package-manager';

// Detection primitives live in shared/opencode-detect.ts (self-contained
// leaf module); re-exported here so existing importers of installer.ts
// keep working unchanged.
export { isBinaryOnPath, probeRunningOpencodeConfigDir };

/**
 * Maximum number of backup directories ("<targetDir>.bak.<timestamp>") kept
 * beside the target. Older ones are pruned after each backup is created.
 * Override with the OCP_MAX_BACKUPS environment variable (0 disables backups
 * retention pruning — use with care).
 */
const DEFAULT_MAX_BACKUPS = 5;

export function getMaxBackups(): number {
  const raw = process.env.OCP_MAX_BACKUPS;
  if (raw !== undefined && raw !== '') {
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_MAX_BACKUPS;
}

/**
 * Config directories managed by a hosting application — currently orca's
 * opencode-hooks shared dir. Wrapper apps inject OPENCODE_CONFIG_DIR into
 * every shell they spawn, so the value is ambient environment noise rather
 * than a deliberate user choice (it is invisible in the OS env-var settings
 * and only exists inside the wrapper's process tree). Installing OCP's
 * managed file set into another app's managed tree is never the intent, so
 * the install TARGET skips these values; the detect/report still shows them
 * truthfully, and an explicit --target always wins.
 */
const WRAPPER_MANAGED_CONFIG_PATTERN = /[/\\]orca[/\\]opencode-hooks(?:[/\\]|$)/i;

export function isWrapperManagedConfigDir(dir: string | undefined | null): boolean {
  if (!dir) return false;
  return WRAPPER_MANAGED_CONFIG_PATTERN.test(path.resolve(dir));
}

/**
 * Resolve the install target directory.
 *
 * Precedence:
 *   1. Caller passes `true` as `useDefaultConfig` → ignore
 *      `OPENCODE_CONFIG_DIR` and fall through to the canonical default
 *      (~/.config/opencode on POSIX, %USERPROFILE%\.config\opencode on
 *      Windows). Used to escape wrapper-injected overrides (orca's
 *      opencode-hooks, e.g.) that diverge from where the running
 *      opencode TUI actually reads.
 *   2. `OPENCODE_CONFIG_DIR` in this process — caller has not opted out.
 *      Wrapper-managed values (isWrapperManagedConfigDir) are skipped
 *      automatically: they are injected by the hosting app, not chosen
 *      by the user, and must not silently become the install target.
 *   3. Default ~/.config/opencode.
 *
 * Existing callers that omit `useDefaultConfig` get the previous
 * behaviour (env var wins) — backward compatible.
 */
export function getDefaultTargetDir(useDefaultConfig = false): string {
  const envOverride = process.env.OPENCODE_CONFIG_DIR;
  if (!useDefaultConfig && envOverride && !isWrapperManagedConfigDir(envOverride)) {
    return path.resolve(envOverride);
  }
  const home = os.homedir();
  return path.join(home, '.config', 'opencode');
}

/**
 * Cross-process sanity check for the install target. Returns a non-empty
 * warning when there is a *detectable* divergence between where the install
 * will write and where the running opencode.exe instance will read:
 *
 *   1. --target was passed but OPENCODE_CONFIG_DIR is also set and they
 *      disagree — explicit caller inconsistency.
 *   2. A running opencode.exe was started with --config-dir pointing
 *      somewhere OTHER than our resolved targetDir — the install will
 *      land in a place opencode never reads.
 *
 * The probe is injected so unit tests can run anywhere (Bun on macOS/Linux
 * do not have `wmic`); production callers omit the second arg and get the
 * live probe.
 */
export function warnInstallTargetMismatch(
  targetDir: string,
  runtimeConfigDir: string | null = probeRunningOpencodeConfigDir(),
): string | null {
  // A wrapper-managed env override (orca's opencode-hooks, e.g.) is skipped
  // by getDefaultTargetDir on purpose — flagging the resulting divergence
  // as "pick one" would contradict that deliberate guard.
  const envOverride = isWrapperManagedConfigDir(process.env.OPENCODE_CONFIG_DIR)
    ? undefined
    : process.env.OPENCODE_CONFIG_DIR
  const envAbs = envOverride ? path.resolve(envOverride) : null
  const runtimeAbs = runtimeConfigDir ? path.resolve(runtimeConfigDir) : null

  const warnings: string[] = []

  if (envAbs && targetDir !== envAbs) {
    warnings.push(
      `[ocp] ⚠ OPENCODE_CONFIG_DIR=${envAbs} is set but --target resolved to ${targetDir}.`,
      `[ocp] ⚠ These should be the same directory; pick one.`,
    )
  }

  if (runtimeAbs && runtimeAbs !== targetDir) {
    warnings.push(
      `[ocp] ⚠ A running opencode.exe was launched with --config-dir=${runtimeAbs},`,
      `[ocp] ⚠ but the install will write to ${targetDir}.`,
      `[ocp] ⚠ The opencode TUI will NOT see this install until restart with --config-dir=${targetDir}.`,
    )
  }

  if (warnings.length === 0) return null
  return warnings.join('\n')
}

export function getCurrentRepoVersion(repoDir: string): string {
  // install/version.json is the single source of truth. A legacy single-line
  // install/VERSION is tolerated as fallback for pre-migration repo layouts.
  const versionJson = path.join(repoDir, 'install', 'version.json');
  const info = readVersionJson(repoDir);
  if (info) return info.version;
  const versionFile = path.join(repoDir, 'install', 'VERSION');
  if (fs.existsSync(versionFile)) {
    const v = fs.readFileSync(versionFile, 'utf8').trim();
    if (v) return v;
  }
  throw new Error(`Missing version file: ${versionJson}`);
}

export function getInstalledVersion(targetDir: string): string | null {
  const versionFile = path.join(targetDir, 'installed.version');
  if (fs.existsSync(versionFile)) {
    return fs.readFileSync(versionFile, 'utf8').trim();
  }
  return null;
}

export function backupTargetDir(targetDir: string): string | null {
  if (!fs.existsSync(targetDir)) return null;
  const entries = fs.readdirSync(targetDir);
  if (entries.length === 0) return null;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = `${targetDir}.bak.${timestamp}`;

  try {
    fs.cpSync(targetDir, backupDir, {
      recursive: true,
      filter: (source) => {
        const base = path.basename(source);
        return base !== 'node_modules' && base !== '.git' && !base.startsWith('.bak');
      },
    });
    return backupDir;
  } catch (err) {
    return null;
  }
}

/**
 * Top-level directories managed by the installer. Empty-directory pruning
 * stops at these boundaries — they are never removed themselves.
 */
const MANAGED_DIRS = new Set(['commands', 'instructions', 'plugins', 'profiles', 'prompts', 'providers', 'skills']);
const OCP_STATE_DIR = '.ocp';
const TARGET_INSTALLED_MANIFEST = 'installed.manifest.txt';

/**
 * Walk up from `startDir`, removing every empty directory until a managed
 * top-level dir or `stopAt` (the target root) is reached. Returns the number
 * of directories actually removed.
 */
function pruneEmptyParents(startDir: string, stopAt: string): number {
  let removed = 0;
  let dir = startDir;
  while (dir !== stopAt && dir.length > stopAt.length) {
    const name = path.basename(dir);
    if (MANAGED_DIRS.has(name)) break;
    try {
      const entries = fs.readdirSync(dir);
      if (entries.length > 0) break;
      fs.rmdirSync(dir);
      removed++;
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
  return removed;
}

/**
 * Prune old backup directories ("<targetDir>.bak.<timestamp>" siblings of the
 * target), keeping only the newest `keep` ones. Timestamps in backup names are
 * ISO-like and sort lexicographically, so a plain name sort is enough.
 * Returns the number of pruned backups.
 */
export function pruneOldBackups(targetDir: string, keep: number = getMaxBackups()): number {
  const parent = path.dirname(targetDir);
  const prefix = `${path.basename(targetDir)}.bak.`;
  let entries: string[];
  try {
    entries = fs
      .readdirSync(parent)
      .filter((e) => e.startsWith(prefix) && fs.statSync(path.join(parent, e)).isDirectory());
  } catch {
    return 0;
  }

  // Newest first (lexicographic order matches chronological order here).
  entries.sort().reverse();
  let pruned = 0;
  for (const stale of entries.slice(keep)) {
    try {
      fs.rmSync(path.join(parent, stale), { recursive: true, force: true });
      pruned++;
    } catch {
      // Unremovable backup — leave it for the next run.
    }
  }
  return pruned;
}

/**
 * Providers seeding ledger: rel paths of every providers/*.json this machine
 * has ever been delivered (or has adopted from the user). Installer state in
 * .ocp/ — NOT user config — so `ocp uninstall` wipes it and the next install
 * reseeds like a fresh machine.
 */
function getProviderLedgerPath(targetDir: string): string {
  return path.join(targetDir, OCP_STATE_DIR, 'providers.seeded.txt');
}

function readProviderLedger(targetDir: string): Set<string> {
  try {
    return new Set(
      fs
        .readFileSync(getProviderLedgerPath(targetDir), 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    );
  } catch {
    return new Set<string>();
  }
}

function writeProviderLedger(targetDir: string, seen: Set<string>): void {
  const stateDir = path.join(targetDir, OCP_STATE_DIR);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(getProviderLedgerPath(targetDir), [...seen].sort().join('\n') + '\n', 'utf8');
}

export function copyRepoFiles(repoDir: string, targetDir: string, files: string[]): number {
  let count = 0;
  // Preset files in `providers/` are user-owned once seen: opencode loads
  // every JSON there as an available preset (see `/provider` → "Add preset"),
  // and users delete / edit presets freely. Per-preset rule:
  //   already in the ledger      → never re-seed (deletions stick)
  //   on disk (user-made/edited) → adopt into the ledger, never overwrite
  //   neither                    → seed it (first install AND new presets in
  //                                upgrades — no version reasoning needed)
  const seen = readProviderLedger(targetDir);
  const seenNext = new Set(seen);
  for (const relFile of files) {
    // The config template ships in the package but never lands in the target:
    // mergeConfig renders it (plus options + preserved fields) into the
    // target's opencode.jsonc. Copying it verbatim would leave a stray
    // opencode.template.jsonc beside the merged config.
    if (relFile === 'opencode.template.jsonc') continue;

    // Same pattern for the terminal-client template — mergeTuiConfig renders
    // it (plus preserved user plugins, plus a migrated v1 tui.jsonc on the
    // first V2 run) into the target's global cli.json. We can't
    // verbatim-copy because users add their own TUI plugins; overwriting
    // would lose them on every reinstall.
    if (relFile === 'cli.template.jsonc') continue;

    const isProviderPreset =
      relFile.startsWith('providers/') && relFile.endsWith('.json');
    if (isProviderPreset) {
      if (seen.has(relFile)) continue;
      if (fs.existsSync(path.join(targetDir, relFile))) {
        seenNext.add(relFile);
        continue;
      }
    }

    const src = path.join(repoDir, relFile);
    const dest = path.join(targetDir, relFile);
    const destDir = path.dirname(dest);

    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      if (isProviderPreset) seenNext.add(relFile);
      count++;
    }
  }
  writeProviderLedger(targetDir, seenNext);
  return count;
}

/**
 * Files in the package manifest are not always files that should exist in the
 * target directory after install. Template inputs are rendered into user config
 * files, and provider presets are seeded once then owned by the user.
 */
export function computeTargetManagedFiles(files: string[], userOwnsProviders: boolean): string[] {
  return files
    .filter((relFile) => {
      if (relFile === 'opencode.template.jsonc') return false;
      if (relFile === 'cli.template.jsonc') return false;
      if (
        userOwnsProviders &&
        relFile.startsWith('providers/') &&
        relFile.endsWith('.json')
      ) {
        return false;
      }
      return true;
    })
    .sort();
}

export function getTargetInstalledManifestPath(targetDir: string): string {
  return path.join(targetDir, OCP_STATE_DIR, TARGET_INSTALLED_MANIFEST);
}

export function readTargetInstalledManifest(targetDir: string): string[] | null {
  return readManifest(getTargetInstalledManifestPath(targetDir));
}

function writeTargetInstalledManifest(targetDir: string, files: string[]): void {
  const stateDir = path.join(targetDir, OCP_STATE_DIR);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(getTargetInstalledManifestPath(targetDir), files.sort().join('\n') + '\n', 'utf8');
}

/**
 * Plugin runtime deps for the install TARGET (~/.config/opencode).
 * Every shipped plugins/*.ts imports `@opencode/plugin` (MIT-licensed —
 * compatible per AGENTS.md License section), but the manifest only ships
 * the .ts files, never a package.json/node_modules. Without this step a
 * cleaned/rebased target fails every plugin with
 * `Die(ResolveMessage: Cannot find package '@opencode/plugin')`.
 * Best-effort by design (same philosophy as provisionTools): never throws,
 * network/PM failures degrade to a warning line and the install continues.
 */
export const PLUGIN_RUNTIME_PKG = '@opencode/plugin';
const PLUGIN_RUNTIME_SPEC_FALLBACK = '^2.0.15';

/**
 * TUI-side runtime deps for the same target. The TUI loads plugin files with
 * a bare `import()` (no dependency injection): every TUI plugin imports
 * `solid-js` and `@opentui/solid/jsx-runtime`, and `@opencode/plugin/tui`
 * itself imports `solid-js` — none of which opencode provides to plugin code.
 * Versions pin opencode's own TUI catalog (v2.0.16: solid-js 1.9.15,
 * @opentui/solid 0.5.10) so the plugin-side copy stays aligned with the
 * host's across the two-instance boundary (mismatched solid instances break
 * signals/context sharing).
 * License — both MIT (AGENTS.md License section: compatible to bundle;
 * this comment is the inline license statement): solid-js MIT,
 * @opentui/solid MIT.
 */
export const TUI_PLUGIN_RUNTIME_DEPS: Record<string, string> = {
  'solid-js': '1.9.15',
  '@opentui/solid': '0.5.10',
};

/** Spec pinned by this repo (root package.json dependencies). Fallback when unreadable. Pure file read. */
export function getPluginRuntimeSpec(repoDir: string): string {
  try {
    const raw = fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8');
    const spec = (JSON.parse(raw)?.dependencies as Record<string, string> | undefined)?.[PLUGIN_RUNTIME_PKG];
    if (typeof spec === 'string' && spec.trim()) return spec.trim();
  } catch {
    // fall through to fallback
  }
  return PLUGIN_RUNTIME_SPEC_FALLBACK;
}

/** Create/merge targetDir/package.json so dependencies include the runtime spec. Preserves user fields. */
export function ensureTargetPluginPackageJson(
  targetDir: string,
  spec: string,
): { action: 'created' | 'updated' | 'uptodate' } {
  const pkgPath = path.join(targetDir, 'package.json');
  let pkg: Record<string, any> = {};
  try {
    if (fs.existsSync(pkgPath)) pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) ?? {};
  } catch {
    pkg = {};
  }
  if (typeof pkg !== 'object' || Array.isArray(pkg)) pkg = {};
  const deps = (pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}) as Record<string, string>;
  const required: Record<string, string> = { [PLUGIN_RUNTIME_PKG]: spec, ...TUI_PLUGIN_RUNTIME_DEPS };
  if (Object.entries(required).every(([name, value]) => deps[name] === value)) return { action: 'uptodate' };
  const existed = fs.existsSync(pkgPath);
  pkg.dependencies = { ...deps, ...required };
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  return { action: existed ? 'updated' : 'created' };
}

/** Run a local (non-global) install inside targetDir. Prefers bun, falls back to npm. */
export function installTargetPluginDeps(
  targetDir: string,
  run: (cmd: string, opts: { cwd: string }) => ShellCommandResult = (cmd, opts) =>
    runShellCommand(cmd, { cwd: opts.cwd, output: 'inherit', timeoutMs: 600000 }),
): ShellCommandResult {
  const cmd = isBinaryOnPath('bun') ? 'bun install' : 'npm install';
  return run(cmd, { cwd: targetDir });
}

/** Orchestrator: package.json merge + local install. Never throws — returns a loggable summary. */
export function ensurePluginRuntimeDeps(
  repoDir: string,
  targetDir: string,
  overrides?: {
    run?: (cmd: string, opts: { cwd: string }) => ShellCommandResult;
  },
): { pkg: 'created' | 'updated' | 'uptodate' | 'error'; install: 'ok' | 'failed' | 'skipped'; message: string } {
  try {
    const spec = getPluginRuntimeSpec(repoDir);
    let pkg: 'created' | 'updated' | 'uptodate';
    try {
      pkg = ensureTargetPluginPackageJson(targetDir, spec).action;
    } catch (err) {
      return { pkg: 'error', install: 'skipped', message: `could not write package.json (${err instanceof Error ? err.message : String(err)})` };
    }
    // Fast path: every runtime dep already resolvable — skip the network
    // install. All markers must exist: a target with @opencode/plugin but no
    // solid-js is exactly the broken TUI-plugin state this step repairs.
    try {
      const marker = path.join(targetDir, 'node_modules', '@opencode', 'plugin', 'package.json');
      const missing = Object.keys(TUI_PLUGIN_RUNTIME_DEPS).filter(
        (name) => !fs.existsSync(path.join(targetDir, 'node_modules', ...name.split('/'), 'package.json')),
      );
      if (missing.length === 0 && fs.existsSync(marker)) {
        const installed = JSON.parse(fs.readFileSync(marker, 'utf8'))?.version as string | undefined;
        if (typeof installed === 'string' && installed.trim()) {
          return { pkg, install: 'skipped', message: `@opencode/plugin@${installed} + TUI deps present — install skipped` };
        }
      }
    } catch {
      // unreadable marker — fall through to install
    }
    // Test/dev escape hatch: merge package.json but skip the network install.
    if (process.env.OCP_SKIP_PLUGIN_INSTALL) {
      return { pkg, install: 'skipped', message: `package.json ${pkg} — install skipped via OCP_SKIP_PLUGIN_INSTALL` };
    }
    const res = installTargetPluginDeps(targetDir, overrides?.run);
    if (!res.error && res.status === 0) {
      return { pkg, install: 'ok', message: `package.json ${pkg}, deps installed (${spec})` };
    }
    const detail = res.error ? res.error.message : `exit code ${res.status ?? '?'}`;
    return { pkg, install: 'failed', message: `package.json ${pkg}, install failed (${detail}) — plugins will fail until \`bun install\`/\`npm install\` succeeds in ${targetDir}` };
  } catch (err) {
    return { pkg: 'error', install: 'skipped', message: `unexpected (${err instanceof Error ? err.message : String(err)})` };
  }
}

/**
 * Major of an `opencode --version` stdout ("opencode 1.18.32" / "2.0.15" →
 * number); NaN when no semver-looking token is present — dev/local builds
 * report "local" (cli/src/version.ts), which stays unprovable and therefore
 * fail-open downstream. Pure — the shell/PS1 installers mirror this parse
 * with grep/regex.
 */
export function majorOfOpencodeOutput(output: string): number {
  const m = /\d+\.\d+\.\d+/.exec(output ?? '');
  return m ? majorOf(m[0]) : NaN;
}

/**
 * Installed opencode major, or null when opencode is absent from PATH or
 * its version is unparseable. Null is fail-open on purpose (same philosophy
 * as isCrossMajorVersion): the lock refuses only what it can prove.
 */
export function installedOpencodeMajor(): number | null {
  if (!isBinaryOnPath('opencode')) return null;
  try {
    const res = spawnSync('opencode', ['--version'], {
      encoding: 'utf8',
      timeout: 15000,
      shell: process.platform === 'win32',
    });
    const major = majorOfOpencodeOutput(res.stdout ?? '');
    return Number.isNaN(major) ? null : major;
  } catch {
    return null;
  }
}

/** The opencode runtime major this OCP line requires: v1 for OCP 0.x/1.x,
 *  v2 for OCP 2.x (config/plugin contracts differ; either direction mixed
 *  is broken). */
export function requiredRuntimeMajor(ocpVersion: string): number {
  const major = majorOf(ocpVersion);
  return Number.isNaN(major) || major < 2 ? 1 : 2;
}

export type RuntimeCompat =
  | { ok: true }
  | { ok: false; kind: 'runtime-too-old' | 'runtime-too-new'; message: string };

/**
 * Both-direction runtime/package compat gate: a v1 runtime must not run the
 * v2 OCP package and vice versa — plugin API, config schema and the TUI
 * client contract all changed with the runtime major. Null (absent binary or
 * an unparseable dev/"local" version) is fail-open: `@script:opencode`
 * provisioning pins the required major, and `ocp update` surfaces the
 * runtime row. Unprovable versions are never blocked (same philosophy as
 * isCrossMajorVersion). Pure — unit-tested.
 */
export function checkRuntimeCompat(runtimeMajor: number | null, ocpVersion: string): RuntimeCompat {
  if (runtimeMajor === null) return { ok: true };
  const required = requiredRuntimeMajor(ocpVersion);
  if (runtimeMajor === required) return { ok: true };
  if (runtimeMajor < required) {
    return {
      ok: false,
      kind: 'runtime-too-old',
      message:
        `opencode v${runtimeMajor}.x detected — OpenCode Prime v${required}.x requires opencode v${required}.x (v${required} config/plugin contract). ` +
        'Upgrade the runtime first: run `ocp update` (or reinstall opencode from https://opencode.ai), then re-run this install.',
    };
  }
  return {
    ok: false,
    kind: 'runtime-too-new',
    message:
      `opencode v${runtimeMajor}.x detected — this OCP release only supports the v${required}.x runtime. ` +
      `Install the matching OpenCode Prime line (https://github.com/kenlin8827/opencode-prime/releases) or downgrade opencode to v${required}.x`,
  };
}

/**
 * Pure decision helper for the fresh-install major-version lock in
 * `executeInstall`: true when an existing installation sits on a different
 * major than the repo copy being applied (e.g. installed OCP v2.x vs repo
 * v0.41.0 — the v2→v1 rollback — or the symmetric v1→v2 jump). Direction-
 * agnostic: a cross-major apply in EITHER direction is the jump the lock
 * exists to prevent (stale-file prune, template mergers). Null installed
 * (first install, or `ocp init` cleared the target) is always allowed, as
 * are unprovable versions.
 */
export function isBlockedFreshInstall(installed: string | null, repo: string): boolean {
  return installed !== null && isCrossMajorVersion(installed, repo);
}

export function checkExternalTools(repoDir: string, options: InstallOptions): void {
  // Walk every tool declared in install/tools.jsonc that the user has not
  // opted out of. Provisioning itself happens in provisionTools() below;
  // this function only reports presence.
  const registry = loadToolRegistry(repoDir);
  if (registry?.tools) {
    for (const [name, def] of Object.entries(registry.tools)) {
      if (!toolEnabled(name, options)) continue;
      if (isBinaryOnPath(def.binary)) {
        console.log(colorize.green(`✓ [tool] ${name} (${def.binary}) is present on PATH`));
      } else {
        const hint = def.url ? ` — see ${def.url}` : '';
        console.log(colorize.gray(`ℹ [tool] ${name} not found on PATH${hint}`));
      }
    }
  }

  // Check MCP tools
  if (options.mcp?.serena) {
    if (isBinaryOnPath('serena')) {
      console.log(colorize.green('✓ [mcp] serena is installed'));
    } else {
      console.log(colorize.gray('ℹ [mcp] serena tool not found on PATH'));
    }
  }

  if (options.mcp?.dbhub) {
    if (isBinaryOnPath('dbhub')) {
      console.log(colorize.green('✓ [mcp] dbhub is installed'));
    } else {
      console.log(colorize.gray('ℹ [mcp] dbhub tool not found on PATH'));
    }
  }

  if (options.mcp?.headroom) {
    if (isBinaryOnPath('headroom')) {
      console.log(colorize.green('✓ [mcp] headroom is installed'));
    } else {
      console.log(colorize.gray('ℹ [mcp] headroom tool not found on PATH'));
    }
  }
}

/**
 * Effective install options: repo install/options.jsonc (defaults) < user
 * overrides (target options.jsonc) < explicit customOptions (CLI / wizard /
 * dashboard).
 */
export function loadEffectiveOptions(
  repoDir: string,
  targetDir: string,
  customOptions?: InstallOptions
): InstallOptions {
  const optionsPath = path.join(repoDir, 'install', 'options.jsonc');
  const fileOptions = readJsoncFile<InstallOptions>(optionsPath) || {};
  const userOptions = readJsoncFile<InstallOptions>(getUserOptionsPath(targetDir));
  const merged = mergeUserOptions(fileOptions, userOptions);
  return mergeUserOptions(merged, customOptions);
}

/**
 * Decide which enabled MCP servers need CLI provisioning: enabled in options,
 * declares an `install` field in the template, and its binary (the MCP key
 * name) is missing from PATH. Pure decision — no side effects.
 */
export function mcpProvisionPlan(
  repoDir: string,
  options: InstallOptions
): Array<{ name: string; install: string }> {
  const template = readJsoncFile<Record<string, any>>(path.join(repoDir, 'opencode.template.jsonc'));
  // V2 shape: servers live under `mcp.servers` (schema/config/mcp.ts).
  const servers = template?.mcp?.servers;
  if (!servers || typeof servers !== 'object' || !options.mcp) return [];

  const plan: Array<{ name: string; install: string }> = [];
  for (const [name, enabled] of Object.entries(options.mcp)) {
    if (!enabled) continue;
    const block = servers[name];
    if (!block || typeof block !== 'object') continue;
    const install = block.install;
    if (typeof install !== 'string' || !install.trim()) continue;
    if (isBinaryOnPath(name)) continue;
    plan.push({ name, install });
  }
  return plan;
}

/**
 * Shared core for URL-list-returning mirror helpers. Given a URL, an env
 * var name, a domain predicate, and an order flag, returns the URL
 * sequence the caller should try in order.
 *
 * Returns `[url]` only when:
 *   - the env var is unset, OR
 *   - the URL doesn't match the supplied domain predicate
 *
 * Used by `rawMirrorUrls` / `apiMirrorUrls` / any future GitHub-domain
 * mirror wrapper. Each public helper documents its own env var, domain,
 * and order — keeping call sites self-explanatory instead of passing a
 * stringly-typed config blob through a single mega-helper.
 *
 * Mirror prefix convention: `${envValue}/${url}` (verified to work with
 * ghfast.top, gh-proxy.com, mirror.ghproxy.com — all use the same
 * `prefix + full-https-url` shape).
 */
function withMirrorUrls(
  url: string,
  envVar: string,
  matchesDomain: (u: string) => boolean,
  mirrorFirst: boolean,
): string[] {
  const mirror = process.env[envVar]?.replace(/\/+$/, '');
  if (!mirror || !matchesDomain(url)) return [url];
  const mirrored = `${mirror}/${url}`;
  return mirrorFirst ? [mirrored, url] : [url, mirrored];
}

/**
 * Probe URLs through OCP_RAW_MIRROR for raw.githubusercontent.com
 * fetches. Mirror first because raw.github is BLOCKED in mainland CN
 * (DNS reset); official as fallback. Setting OCP_RAW_MIRROR is an
 * explicit opt-in from a user who has declared "the official is
 * unreachable for me, please use the mirror", and we honor that.
 */
export function rawMirrorUrls(url: string): string[] {
  return withMirrorUrls(
    url,
    'OCP_RAW_MIRROR',
    (u) => u.includes('raw.githubusercontent.com'),
    /* mirrorFirst */ true,
  );
}

/**
 * Probe URLs through OCP_API_MIRROR for api.github.com fetches.
 * `api.github.com` is rate-limited (60 unauth req/hour per IP) and from
 * mainland CN frequently returns HTTP 429 on tool-version probes
 * (rtk / herdr / opencode latest release tag). Routing through a
 * ghproxy-class mirror avoids the rate-limit / slow path. Falls back to
 * the official URL on mirror failure so a mirror outage doesn't block
 * the probe.
 */
export function apiMirrorUrls(url: string): string[] {
  return withMirrorUrls(
    url,
    'OCP_API_MIRROR',
    (u) => u.includes('api.github.com'),
    /* mirrorFirst */ true,
  );
}

/**
 * Shared core for shell-command URL rewriters. Prepends the mirror
 * prefix to every URL match in the command. Returns the original string
 * unchanged when the env var is unset.
 *
 * Trailing whitespace, quotes, and `<>` are excluded from the URL match
 * (caller's regex responsibility) so the regex doesn't eat into shell
 * quoting or pipe metacharacters.
 */
function withMirrorRewrite(cmd: string, envVar: string, urlRegex: RegExp): string {
  const mirror = process.env[envVar]?.replace(/\/+$/, '');
  if (!mirror) return cmd;
  return cmd.replace(urlRegex, (m) => `${mirror}/${m}`);
}

/**
 * Rewrite raw.githubusercontent.com URLs inside a shell command string so
 * companion-tool installs / upgrades (rtk POSIX today, anything declared
 * in install/tools.jsonc tomorrow) route through OCP_RAW_MIRROR when set.
 *
 * Touches ONLY raw.githubusercontent.com URLs. github.com release-asset
 * URLs are NOT rewritten here — see `rewriteReleaseMirror`.
 */
export function rewriteRawMirror(cmd: string): string {
  return withMirrorRewrite(
    cmd,
    'OCP_RAW_MIRROR',
    /https:\/\/raw\.githubusercontent\.com\/[^\s'"<>]+/g,
  );
}

/**
 * Rewrite github.com release-asset URLs inside a shell command string so
 * companion-tool installs that ship via GitHub Releases (rtk Windows today)
 * route through OCP_RELEASE_MIRROR when set.
 *
 * The regex requires `/releases/` in the path so we only touch release
 * assets, never project home pages (`github.com/<owner>/<repo>`), source
 * browse (`/blob/`, `/raw/`-on-github), or unrelated github.com URLs.
 *
 * Note: OCP_RELEASE_MIRROR's order semantics differ from OCP_RAW_MIRROR's
 * — for github.com releases the order is `[official, mirror]` (release
 * assets are slow but reachable from CN, so trust the official first;
 * mirror is a backup for outages). The order decision lives in
 * `downloadArchive` (ocp upgrade path) and `installCommandSequence`
 * (ocp install path) — this rewriter only produces the rewritten string;
 * the orchestration decides what to do on failure.
 */
export function rewriteReleaseMirror(cmd: string): string {
  return withMirrorRewrite(
    cmd,
    'OCP_RELEASE_MIRROR',
    /https:\/\/github\.com\/[^/\s'"<>]+\/[^/\s'"<>]+\/releases\/[^\s'"<>]+/g,
  );
}

/**
 * Decide the sequence of commands to run under OCP_RAW_MIRROR. Pure helper
 * so the orchestration can be unit-tested without mocking spawnSync.
 *
 * Returns:
 *   - primary:  command to run first
 *   - fallback: command to run if primary fails (null = no fallback)
 *
 * Rules:
 *   - env unset → mirror is a no-op; run original once, no fallback.
 *   - env set + rewrite actually changed the command → try rewritten
 *     first, fall back to the original on failure. A mirror outage
 *     (timeout, 5xx, DNS reset) degrades to raw.githubusercontent.com.
 *   - env set but the rewrite was a no-op (no raw.githubusercontent.com
 *     URL matched in the command) → don't retry the same command twice.
 */
export function installCommandSequence(
  rewritten: string,
  original: string,
  mirrorSet: boolean,
): { primary: string; fallback: string | null } {
  if (!mirrorSet) return { primary: original, fallback: null };
  if (rewritten === original) return { primary: original, fallback: null };
  return { primary: rewritten, fallback: original };
}

/**
 * Run an install command string from install/tools.jsonc or an MCP `install`
 * field. Shares the PowerShell-vs-POSIX split with `ocp update`:
 *
 * On Windows the registry stores PowerShell-syntax commands (`iwr`/`irm`/`iex`);
 * `spawnSync(cmd, { shell: true })` routes through cmd.exe, which doesn't
 * recognize those aliases ("'iwr' is not recognized"). Spawn PowerShell
 * directly — prefer `pwsh` but fall back to the built-in Windows PowerShell
 * 5.1 so this works on machines without PowerShell 7. Both expose iwr/irm/iex.
 *
 * On POSIX the commands are `curl | sh` pipelines, so let Node pick a shell.
 *
 * Placeholder prefixes resolved here before any shell involvement:
 *   - "@script:<name>" — a script file under install/scripts/tools/ (see
 *     runScriptCommand).
 *   - "@pm:<pkg-spec>" — a package-manager global install of the spec (the
 *     spec may carry @version/@latest, e.g. "@pm:@openchamber/web@latest").
 *     The manager is resolved at run time by resolvePmForSpec (per-tool
 *     ownership → opencode's own install method → npm fallback) instead of
 *     hardcoding `npm install -g`, so a bun/pnpm-owned machine reinstalls
 *     through its own manager. `opts.binary` (the tool's binary name, when
 *     the caller knows it) enables the per-tool ownership layer; callers
 *     without context skip it.
 *
 * Mirror orchestration for tool installs (chains OCP_RAW_MIRROR and
 * OCP_RELEASE_MIRROR — they cover non-overlapping URL classes, so order
 * is cosmetic):
 *   1. Rewrite raw.githubusercontent.com URLs (rtk POSIX install).
 *   2. Rewrite github.com release-asset URLs (rtk Windows install).
 *   3. Run the rewritten command.
 *   4. If it failed AND at least one mirror is configured, fall back to the
 *      ORIGINAL command. A mirror outage (timeout, 5xx, DNS reset) still
 *      has a chance to succeed via the official source. Without this
 *      fallback, mirror-only users would hard-fail on the first mirror
 *      hiccup.
 */
export function runInstallCommand(cmd: string, repoDir?: string, opts?: { binary?: string }) {
  // "@script:<name>" references a script file under install/scripts/tools/
  // (see tools.jsonc) instead of an inline command — long escape-prone
  // one-liners live there as real .ps1/.sh files.
  if (cmd.startsWith('@script:')) {
    return runScriptCommand(cmd.slice('@script:'.length).trim(), repoDir);
  }

  // "@pm:<pkg-spec>" references a package-manager global install (see
  // runPmCommand) — resolved against the machine's actual managers.
  if (cmd.startsWith('@pm:')) {
    return runPmCommand(cmd.slice('@pm:'.length).trim(), opts?.binary);
  }

  // Chain both rewriters — they target non-overlapping URL classes, so
  // applying one then the other is safe. Whichever (if any) actually
  // matches determines whether `installCommandSequence` produces a
  // fallback path.
  let rewritten = rewriteRawMirror(cmd);
  rewritten = rewriteReleaseMirror(rewritten);
  const mirrorSet = !!process.env.OCP_RAW_MIRROR || !!process.env.OCP_RELEASE_MIRROR;
  const { primary, fallback } = installCommandSequence(rewritten, cmd, mirrorSet);

  const res = runShellCommand(primary);
  if (res.status === 0 || !fallback) return res;

  // At least one mirror URL failed. Try the original command (with all
  // the unwritten official URLs) as a last-resort fallback. The stderr
  // line tells the user why they're seeing the second attempt.
  console.error(
    `[OCP_*_MIRROR] mirror URL failed (exit ${res.status ?? 'n/a'}), ` +
      `falling back to the official source URL`,
  );
  return runShellCommand(fallback);
}

/**
 * Execute a "@script:<name>" reference: resolve the platform-matching file
 * under install/scripts/tools/ and run it with the platform's native shell
 * (powershell -File with ExecutionPolicy Bypass on Windows — registry .ps1
 * files must run even under a restrictive default policy; `sh` on POSIX).
 * OCP_*_MIRROR env vars pass through to the script, which does its own
 * mirror-first/fallback URL handling (a file can't be URL-rewritten the way
 * the inline-command path rewrites command strings).
 */
function runScriptCommand(name: string, repoDir?: string): ShellCommandResult {
  const win = process.platform === 'win32';
  const ext = win ? 'ps1' : 'sh';
  const baseDir = path.join(repoDir ?? process.cwd(), 'install', 'scripts', 'tools');
  let file: string | null = null;
  for (const suffix of [`${process.platform}-${process.arch}`, process.platform, '']) {
    const candidate = path.join(baseDir, suffix ? `${name}.${suffix}.${ext}` : `${name}.${ext}`);
    if (fs.existsSync(candidate)) {
      file = candidate;
      break;
    }
  }
  if (!file) {
    console.error(`[ocp] "@script:${name}" matches no file under install/scripts/tools/ (${process.platform}-${process.arch}, .${ext})`);
    return { status: 1, error: new Error(`script not found: ${name}`), stdout: '', stderr: '' };
  }
  console.log(`Running script: ${file}`);
  const res = spawnSync(
    win ? 'powershell.exe' : 'sh',
    win ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file] : [file],
    { stdio: 'inherit', timeout: 600000 },
  );
  return { status: res.status ?? 1, error: res.error, stdout: '', stderr: '' };
}

/**
 * Execute a "@pm:<pkg-spec>" reference: resolve the package manager for the
 * spec via resolvePmForSpec (per-tool ownership → opencode's own install
 * method → npm fallback) and run its global-add for the spec. Spawn
 * conventions mirror smartUpgrade in updater.ts: stdio inherit, generous
 * timeout, shell on Windows (manager shims are .cmd there).
 *
 * When no usable manager exists, prints the raw npm command as a manual
 * hint and returns a failure — never throws.
 */
function runPmCommand(spec: string, binary?: string): ShellCommandResult {
  if (!spec) {
    console.error('[ocp] "@pm:" reference is missing a package spec.');
    return { status: 1, error: new Error('empty @pm: spec'), stdout: '', stderr: '' };
  }
  const resolved = resolvePmForSpec(spec, { binary });
  if (!resolved) {
    const manual = `npm install -g ${spec}`;
    console.error(`[ocp] "@pm:${spec}" — no usable package manager (bun/pnpm/yarn/npm) found on PATH.`);
    console.error(`[ocp] Install manually: ${manual}`);
    return { status: 1, error: new Error(`no package manager available for: ${spec}`), stdout: '', stderr: '' };
  }
  const cmdText = `${resolved.bin} ${resolved.args.join(' ')}`;
  console.log(`Running: ${cmdText}`);
  const res = spawnSync(resolved.bin, resolved.args, {
    stdio: 'inherit',
    timeout: 600000,
    shell: process.platform === 'win32',
  });
  return { status: res.status ?? 1, error: res.error, stdout: '', stderr: '' };
}

/**
 * Provision CLIs for enabled MCP servers that declare an `install` field and
 * are missing from PATH. Never throws — failures are logged with manual
 * instructions so a missing CLI can't fail the config install.
 *
 * `plan` lets the caller pass a precomputed mcpProvisionPlan() result (the
 * install flow uses it to skip the section header when the plan is empty);
 * when omitted the plan is computed here.
 */
export function provisionMcpCli(
  repoDir: string,
  options: InstallOptions,
  plan?: Array<{ name: string; install: string }>
): void {
  for (const { name, install } of plan ?? mcpProvisionPlan(repoDir, options)) {
    console.log(`🚀 [mcp] ${name} missing from PATH — provisioning via: ${install}`);
    const res = runInstallCommand(install, repoDir, { binary: name });
    if (res.status !== 0 || res.error) {
      const detail = res.error ? res.error.message : `exit code ${res.status}`;
      console.log(`⚠ [mcp] ${name} automatic installation failed (${detail}). Install manually: ${install}`);
    } else if (isBinaryOnPath(name)) {
      console.log(`✓ [mcp] ${name} installed`);
    } else {
      console.log(`✓ [mcp] ${name} install command finished — open a new terminal if the binary is not on PATH yet`);
    }
  }
}

/**
 * Resolve the install command for a tool on the current machine.
 *
 * Keys are tried in this order:
 *   1. `${platform}-${arch}`   (e.g. "linux-x64", "darwin-arm64", "win32-x64")
 *   2. `${platform}`           (e.g. "linux", "darwin", "win32")
 *   3. `default`               (fallback)
 *
 * Returns null if no key matches — caller should skip with a friendly hint.
 */
export function resolveInstallCommand(install: unknown): string | null {
  if (typeof install === 'string') return install.trim() || null;
  if (!install || typeof install !== 'object') return null;
  const map = install as Record<string, unknown>;
  const platform = process.platform;          // 'linux' | 'darwin' | 'win32' | …
  const arch = process.arch;                  // 'x64' | 'arm64' | …
  const candidates = [
    `${platform}-${arch}`,
    platform,
    'default',
  ];
  for (const key of candidates) {
    const v = map[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Generic tool registry shape (install/tools.jsonc).
 *
 * Designed to be reusable: the `install` field uses the same string-or-map
 * shape as MCP `install` fields can adopt later without data migration —
 * they share `resolveInstallCommand` and the same platform/arch resolution
 * order.
 *
 * `post_install` is an array of init commands that run AFTER the binary
 * is verified on PATH (whether it was just installed or already present).
 * Each step is either:
 *   - a string — a bare shell command (no guard)
 *   - an object with `name?` (for logging), `when?` (binary name required
 *     on PATH; step is skipped if missing), and `command` (shell)
 *
 * Multiple post-install steps per tool are supported so a single install
 * can trigger several independent setup operations.
 */
export interface PostInstallStep {
  name?: string;
  /** Tool/binary name required on PATH for this step to run. */
  when?: string;
  /** Shell command. */
  command: string;
}

export interface ToolRegistry {
  /**
   * Suite-wide update policy (the `update_policy` block in tools.jsonc).
   * Currently carries only the major-version lock default; per-tool
   * `update_check.lock_major` overrides it.
   */
  update_policy?: {
    /**
     * Default major-version lock for every tool in the registry
     * (default true when absent): `ocp update` refuses upgrades that
     * cross the major version boundary.
     */
    lock_major_default?: boolean;
  };
  tools?: Record<
    string,
    {
      description?: string;
      binary: string;
      url?: string;
      install?: unknown; // string | Record<string, string>; resolved via resolveInstallCommand
      post_install?: Array<string | PostInstallStep>;
      /**
       * TUI launch manifest consumed by src/tui-engine.ts (shape:
       * TuiEngineSpec there). Typed loosely on purpose: the installer must
       * not import the engine module (it imports installer.ts) — the engine
       * validates the shape at launch time.
       */
      tui?: unknown;
    }
  >;
}

/** Load the tool registry from install/tools.jsonc. Returns null on miss. */
export function loadToolRegistry(repoDir: string): ToolRegistry | null {
  return readJsoncFile<ToolRegistry>(path.join(repoDir, 'install', 'tools.jsonc'));
}

/**
 * True when `options.tools[name]` is not explicitly set to false.
 * All tools (rtk, openchamber, herdr, ...) read from the same `tools: {}`
 * map — no top-level flags anymore.
 *
 * Exported so the install flow can guard the "Tools" section header
 * (all-tools-disabled would otherwise print an empty block).
 */
export function toolEnabled(name: string, options: InstallOptions): boolean {
  const v = options.tools?.[name];
  return v && typeof v === "object" ? v.enabled !== false : v !== false;
}

/**
 * Provision optional tools declared in install/tools.jsonc.
 *
 * Two phases:
 *   1. **Install**: For each enabled tool whose binary is missing from PATH,
 *      run the resolved install command. Best-effort: failures are logged,
 *      never thrown, so a network-blasted install can't fail the config
 *      install. When the tool's install command has no entry for the
 *      current platform/arch, log a hint pointing at the tool's homepage.
 *   2. **Post-install**: After the install pass, run each tool's
 *      `post_install` steps whose `when` guard is satisfied (i.e. the
 *      referenced binary is now on PATH). This second phase handles
 *      cross-tool dependencies — e.g. `herdr.post_install` referencing
 *      `opencode` will only run after `opencode` itself has been installed
 *      or was already present.
 */
export function provisionTools(repoDir: string, options: InstallOptions): void {
  const registry = loadToolRegistry(repoDir);
  if (!registry?.tools) return;

  // Phase 1: install missing binaries.
  for (const [name, def] of Object.entries(registry.tools)) {
    if (!toolEnabled(name, options)) continue;
    if (isBinaryOnPath(def.binary)) {
      // Runtime/package compat gate (both directions): a wrong-major
      // opencode on PATH is never adopted. An OLDER runtime is upgradeable
      // right here via @script:opencode (which pins the OCP-required major),
      // so provisioning continues; a NEWER one (old OCP line, v2 binary) has
      // no in-place fix on this line — refuse with the upgrade-the-package
      // instruction. Dependent post-install steps use the same check below.
      if (name === 'opencode') {
        const major = installedOpencodeMajor();
        const compat = checkRuntimeCompat(major, getCurrentRepoVersion(repoDir));
        if (!compat.ok) {
          console.log(colorize.red(`✗ [tool] ${name}: ${compat.message}`));
          if (compat.kind === 'runtime-too-new') continue;
        } else {
          console.log(colorize.green(`✓ [tool] ${name} (${def.binary}) is present on PATH`));
          continue;
        }
      } else {
        console.log(colorize.green(`✓ [tool] ${name} (${def.binary}) is present on PATH`));
        continue;
      }
    }
    const cmd = resolveInstallCommand(def.install);
    if (!cmd) {
      if (def.install === undefined) {
        // Presence-only registry entry (e.g. openchamber_desktop): the
        // installer never provisions it — a dedicated surface helper owns
        // that check, so stay silent here.
        continue;
      }
      const hint = def.url ? ` (${def.url})` : '';
      console.log(colorize.gray(`ℹ [tool] ${name} not installed — no install command for ${process.platform}-${process.arch}${hint}`));
      continue;
    }
    console.log(colorize.cyan(`🚀 [tool] ${name} missing from PATH — provisioning via: ${cmd}`));
    const res = runInstallCommand(cmd, repoDir, { binary: def.binary });
    if (res.error || res.status !== 0) {
      const detail = res.error ? res.error.message : `exit code ${res.status}`;
      const hint = def.url ? ` Manual install: ${def.url}` : '';
      console.log(colorize.yellow(`⚠ [tool] ${name} automatic installation failed (${detail}).${hint}`));
    } else if (isBinaryOnPath(def.binary)) {
      console.log(colorize.green(`✓ [tool] ${name} installed`));
    } else {
      console.log(colorize.green(`✓ [tool] ${name} install command finished — open a new terminal if the binary is not on PATH yet`));
    }
  }

  // Phase 2: post-install steps (cross-tool order respected by phase-1
  // completion — by now every tool's binary is on PATH or its install
  // failed; we run steps whose `when` guards match reality).
  for (const [name, def] of Object.entries(registry.tools)) {
    if (!toolEnabled(name, options)) continue;
    if (!def.post_install?.length) continue;
    runPostInstall(repoDir, name, def);
  }
}

/**
 * Run a tool's post-install steps. Each step is skipped silently when its
 * `when` binary is missing (so cross-tool order doesn't matter — by the
 * time this runs, all installs have completed). Failures are logged and
 * the next step is attempted.
 *
 * `OCP_REPO_DIR` is exported to each step so they can reference repo-side
 * files (e.g. `herdr plugin link "$OCP_REPO_DIR/install/herdr-plugins/..."`)
 * via portable paths that survive cwd changes.
 */
function runPostInstall(repoDir: string, name: string, def: ToolRegistry['tools'] extends infer T ? (T extends Record<string, infer V> ? V : never) : never): void {
  const steps = def.post_install ?? [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const command = typeof step === 'string' ? step : step.command;
    const stepName = typeof step === 'string' ? `step ${i + 1}` : (step.name || `step ${i + 1}`);
    const guard = typeof step === 'string' ? undefined : step.when;

    if (guard && !isBinaryOnPath(guard)) {
      console.log(colorize.gray(`⏭ [post-install] ${name}: skipping "${stepName}" (requires "${guard}" on PATH)`));
      continue;
    }

    // opencode-gated steps (herdr/luvus integration) must not run against a
    // wrong-major binary — the integration would be wired to an incompatible
    // runtime. Unparseable/absent versions fall through (fail-open).
    if (guard === 'opencode') {
      const compat = checkRuntimeCompat(installedOpencodeMajor(), getCurrentRepoVersion(repoDir));
      if (!compat.ok) {
        console.log(colorize.yellow(`⏭ [post-install] ${name}: skipping "${stepName}" — ${compat.message}`));
        continue;
      }
    }

    console.log(colorize.cyan(`⚙ [post-install] ${name}: ${stepName}`));
    // Resolve $OCP_REPO_DIR / %OCP_REPO_DIR% in the command string before
    // handing it to the shell — spawnSync({shell:true}) on Windows uses
    // cmd.exe, which only expands %VAR%, not POSIX $VAR. Without this,
    // herdr plugin link receives literal "$OCP_REPO_DIR/..." and fails
    // with "system cannot find path" (os error 3) on Windows.
    const resolvedCommand = command
      .replace(/\$OCP_REPO_DIR/g, repoDir)
      .replace(/%OCP_REPO_DIR%/g, repoDir);
    // Capture stdout (not inherit) so commands that emit JSON — e.g. herdr
    // plugin link — don't dump raw payloads to the terminal. We parse and
    // surface a one-line summary instead.
    const res = runShellCommand(resolvedCommand, {
      env: { ...process.env, OCP_REPO_DIR: repoDir },
      output: 'capture',
      timeoutMs: 300000,
    });
    if (res.error || res.status !== 0) {
      const stderr = res.stderr.trim();
      const detail = res.error
        ? res.error.message
        : stderr || `exit code ${res.status ?? '?'}`;
      console.log(colorize.yellow(`⚠ [post-install] ${name}/${stepName} failed: ${detail}`));
    } else {
      const summary = extractJsonSummary(res.stdout);
      const suffix = summary ? ` — ${summary}` : '';
      console.log(colorize.green(`✓ [post-install] ${name}/${stepName} ok${suffix}`));
    }
  }
}

/**
 * Attempt to extract a one-line human-readable summary from a command's stdout
 * when it returns JSON. Currently handles herdr plugin link output:
 *   {"result":{"plugin":{"name":"Auto-Start OpenCode on New Tabs",...}}}
 * Returns null when the output is not JSON or lacks a recognizable field, so
 * callers can fall back to a bare "ok".
 */
function extractJsonSummary(stdout: string): string | null {
  const text = stdout.trim();
  if (!text) return null;
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON — common for shell commands that print nothing on success.
    return null;
  }
  // herdr cli envelope: { id, result: { plugin: { name } } }
  const name = json?.result?.plugin?.name ?? json?.result?.name ?? json?.name;
  if (typeof name === 'string' && name.trim()) return name;
  // luvus cli: `module link` prints a flat { "id": "ocp.auto-opencode" }
  // (possibly wrapped in a result/module envelope). Only accept the flat id
  // when there is no result envelope — herdr's top-level id is a request id.
  const moduleId =
    json?.result?.module?.id ??
    (json?.result === undefined && typeof json?.id === 'string' ? json.id : null);
  if (typeof moduleId === 'string' && moduleId.trim()) return moduleId;
  return null;
}

/**
 * ADR 0004 §3 one-shot global rename: `ocp.jsonc` → `ocp.json`. The
 * plugins stopped reading the legacy name at runtime (v2 hard cutover);
 * the installer owns making the old content survive. The destination is
 * always the runtime-resolved plugin dir — NOT necessarily the install
 * `targetDir`: with XDG_CONFIG_HOME set (and no OPENCODE_CONFIG_DIR) the
 * runtime reads `$XDG_CONFIG_HOME/opencode/ocp.json` while the installer
 * installs into `~/.config/opencode`. A legacy file found in the wrong
 * base is MOVED to the runtime path so its content survives. Collision
 * (both exist in the plugin dir) → warn and keep BOTH — `ocp.json` wins
 * at runtime, nothing is ever deleted. Idempotent (after a run the
 * legacy source is gone) and non-fatal: failures degrade to a warning
 * line and the install continues.
 *
 * The move-from-wrong-base case reports under `action: 'renamed'` (with its
 * own message) rather than a new action, so the caller's ✓/⚠ classification
 * (renamed=✓) stays correct and unchanged.
 *
 * Keep-in-sync: `pluginDir` mirrors `ocpConfigPath()` in
 * plugins/shared/ocp-config.ts (the runtime resolver) — that file owns
 * the path contract; this is the documented installer-side mirror. The
 * runtime `OCP_CONFIG_PATH` override is deliberately NOT consulted here:
 * it is a test/sandbox pin, and the migration must move the REAL runtime
 * file the plugins read after install.
 */
export function migrateGlobalOcpConfig(targetDir: string): {
  action: 'renamed' | 'collision' | 'skipped' | 'error';
  message: string;
} {
  // Mirror of the runtime resolver — see keep-in-sync note above.
  const pluginDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
  const current = path.join(pluginDir, 'ocp.json');
  const legacyHere = path.join(pluginDir, 'ocp.jsonc');
  const fail = (err: unknown) => ({
    action: 'error' as const,
    message: `Could not migrate ocp.jsonc → ocp.json (${err instanceof Error ? err.message : String(err)}) — left in place; preferences stay at defaults.`,
  });

  if (fs.existsSync(current)) {
    // The runtime file exists where it is read — nothing to place. Only a
    // co-resident legacy sibling warns (kept; today's collision semantics).
    if (fs.existsSync(legacyHere)) {
      return {
        action: 'collision',
        message:
          'Both ocp.jsonc and ocp.json exist — kept both; ocp.json is the single runtime source. Delete ocp.jsonc once your preferences are confirmed.',
      };
    }
    return { action: 'skipped', message: '' };
  }
  if (fs.existsSync(legacyHere)) {
    try {
      fs.renameSync(legacyHere, current);
      return { action: 'renamed', message: 'Migrated global OCP config: ocp.jsonc → ocp.json' };
    } catch (err) {
      return fail(err);
    }
  }
  if (pluginDir !== targetDir && fs.existsSync(path.join(targetDir, 'ocp.jsonc'))) {
    try {
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.renameSync(path.join(targetDir, 'ocp.jsonc'), current);
      return {
        action: 'renamed',
        message: `Moved global OCP config into the runtime dir: ${path.join(targetDir, 'ocp.jsonc')} → ${current}`,
      };
    } catch (err) {
      return fail(err);
    }
  }
  return { action: 'skipped', message: '' };
}

/**
 * Resolve the install target directory from CLI args — shared by
 * executeInstall and the CLI's Environment report so the displayed target
 * can never drift from the one actually written to.
 */
export function resolveInstallTarget(args: Pick<CliArgs, 'target' | 'useDefaultConfig'>): string {
  return args.target ? path.resolve(args.target) : getDefaultTargetDir(args.useDefaultConfig === true);
}

export function executeInstall(
  repoDir: string,
  args: CliArgs,
  customOptions?: InstallOptions
): {
  success: boolean;
  version: string;
  targetDir: string;
  filesInstalled: number;
  backupPath: string | null;
} {
  const targetDir = resolveInstallTarget(args);
  // Opens the "Install" section of the log; every phase below (options
  // notes, backup/prune, copy, merge, provisioning) reports under it.
  section('Install');
  // Cross-process sanity: the shell that runs `ocp install` may have a
  // different OPENCODE_CONFIG_DIR (or none) than the opencode TUI process
  // that will actually load the installed files. Surface the divergence
  // loudly here so a silent "installed but not visible" install fails
  // fast, before we touch the user's installed tree.
  const mismatchWarning = warnInstallTargetMismatch(targetDir)
  if (mismatchWarning) {
    console.warn(colorize.yellow(mismatchWarning))
  }
  const curVersion = getCurrentRepoVersion(repoDir);

  // Major-version lock, fresh-install step: `ocp update` / `ocp upgrade`
  // refuse cross-major applies, and a bare `ocp install` must not be the
  // back door around them — installed v2.x + repo v0.41.0 would otherwise
  // silently roll back (and the symmetric jump forward is no safer:
  // stale-file prune and template mergers assume same-major evolution).
  // --force re-applies in-major work only — it never bypasses this lock.
  // Escape hatch: back up, `ocp init` (clears the target, removing
  // installed.version), then install fresh.
  const installedBefore = getInstalledVersion(targetDir);
  if (isBlockedFreshInstall(installedBefore, curVersion)) {
    throw new Error(
      `Cross-major install blocked: installed v${installedBefore} vs repository v${curVersion}. ` +
      'The major-version lock cannot be bypassed — not even with --force. ' +
      'To jump majors, back up your config, run `ocp init`, then install fresh (see docs/maintenance/ocp-cli.md).',
    );
  }

  // Runtime/package compat gate (both directions): refuse to wire this OCP
  // package onto an opencode runtime of the wrong major — the old silent
  // "install v2 OCP on a v1 runtime" refusal path is gone; the user gets an
  // explicit instruction. runtime-too-new has no fix on this package line →
  // hard stop. runtime-too-old is upgradeable in this very run (the Tools
  // phase pins the required major via @script:opencode) → loud warning,
  // continue; if that upgrade cannot own the binary (externally managed),
  // the warning still names the manual step.
  const runtimeCompat = checkRuntimeCompat(installedOpencodeMajor(), curVersion);
  if (!runtimeCompat.ok) {
    if (runtimeCompat.kind === 'runtime-too-new') {
      throw new Error(`[ocp] ${runtimeCompat.message}`);
    }
    console.log(colorize.yellow(`[ocp] ⚠ ${runtimeCompat.message}`));
  }

  // Load options: repo defaults < user overrides < explicit customOptions
  const effectiveOptions = loadEffectiveOptions(repoDir, targetDir, customOptions);

  // tui_mode=herdr implies tools.herdr=true; surface the override so the user
  // sees why their explicit `tools.herdr: false` was ignored.
  if (
    effectiveOptions.tui_mode === 'herdr' &&
    effectiveOptions.tools?.herdr === false
  ) {
    console.log('[ocp] tui_mode=herdr requires herdr — auto-enabling tools.herdr (overrides your tools.herdr=false).');
    effectiveOptions.tools = { ...effectiveOptions.tools, herdr: true };
  }
  if (
    effectiveOptions.tui_mode === 'luvus' &&
    effectiveOptions.tools?.luvus === false
  ) {
    console.log('[ocp] tui_mode=luvus requires luvus — auto-enabling tools.luvus (overrides your tools.luvus=false).');
    effectiveOptions.tools = { ...effectiveOptions.tools, luvus: true };
  }

  // Symmetric auto-disable for the OFF-mode tool — when the user picks one
  // TUI driver, the other should not silently run its post-install steps.
  // We only flip `undefined` → `false`: an explicit `true` means the user
  // really wants both (rare but valid, e.g. testing). The earlier shallow-
  // replace merge of `tools` means "undefined" here = the user simply didn't
  // list that key — exactly the silent-drift case we want to close.
  if (
    effectiveOptions.tui_mode === 'herdr' &&
    effectiveOptions.tools?.luvus === undefined
  ) {
    console.log('[ocp] tui_mode=herdr — auto-disabling tools.luvus (set tools.luvus=true explicitly to opt back in).');
    effectiveOptions.tools = { ...effectiveOptions.tools, luvus: false };
  }
  if (
    effectiveOptions.tui_mode === 'luvus' &&
    effectiveOptions.tools?.herdr === undefined
  ) {
    console.log('[ocp] tui_mode=luvus — auto-disabling tools.herdr (set tools.herdr=true explicitly to opt back in).');
    effectiveOptions.tools = { ...effectiveOptions.tools, herdr: false };
  }

  // 1. Ensure Manifest for current version exists
  const curManifestPath = getManifestPath(repoDir, curVersion);
  if (!fs.existsSync(curManifestPath)) {
    generateManifest(repoDir, curVersion);
  }

  // 2. Perform Backup if target exists and not skipped
  let backupPath: string | null = null;
  if (!args.noBackup && fs.existsSync(targetDir)) {
    backupPath = backupTargetDir(targetDir);
    const keep = args.keepBackups ?? getMaxBackups();
    const pruned = pruneOldBackups(targetDir, keep);
    if (pruned > 0) console.log(`Pruned ${pruned} old backup(s) (keeping at most ${keep}).`);
  }

  // 3. Extract user modifications to preserve
  const preserveBag = extractPreserveBag(targetDir);

  // 3.5 Remove files shipped in any historical version but no longer managed
  //   in the current target layout. Without this, removed prompts/instructions/plugins
  //   accumulate in ~/.config/opencode/ across upgrades.
  //
  //   The historical source is the union of every loose manifest plus the
  //   compacted history.manifest.txt, excluding only curVersion. The
  //   installed version's manifest is deliberately INCLUDED when available:
  //   entries it lists that the current version no longer manages are exactly
  //   the stale files an upgrade must remove (curSet protects everything still
  //   target-managed). Unioning all versions — rather than a single-prev diff —
  //   matches reality: the disk is the accumulation of every version ever
  //   installed, not just the previous one.
  //
  //   This catches the add/remove/re-add/remove sequence (a file shipped in
  //   v0.9.0, dropped in v0.9.1, re-added in v0.9.2, dropped again in
  //   v0.10.0) which a single-prev diff would miss, AND the "re-install same
  //   version" case (installed.version === curVersion) where historical
  //   leftovers from older versions still need cleaning.
  //
  //   Skipped only when no previous version is on disk (first install —
  //   target is empty). providers/*.json is carved out: after the first
  //   install that directory belongs to the user, mirroring the
  //   copyRepoFiles rule.
  const shippedFiles = collectShippedFiles(repoDir);
  const prevVer = getInstalledVersion(targetDir);
  const userOwnsProviders = fs.existsSync(path.join(targetDir, 'installed.version'));
  const targetManagedFiles = computeTargetManagedFiles(shippedFiles, userOwnsProviders);
  const previousTargetManifest = readTargetInstalledManifest(targetDir);
  const targetHasContent = fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0;
  if (prevVer || previousTargetManifest || targetHasContent) {
    const minVer = readVersionJson(repoDir)?.minVersion;
    if (prevVer && minVer && isNewerVersion(minVer, prevVer)) {
      console.log(`⚠ Installed v${prevVer} is below the supported floor v${minVer} — upgrading on a best-effort basis.`);
    }
    const staleBasis = new Set<string>([
      ...(previousTargetManifest ?? []),
      ...collectHistoricalShippedFiles(repoDir, new Set([curVersion])),
    ]);
    if (staleBasis.size > 0) {
      const curSet = new Set(targetManagedFiles);
      let staleRemoved = 0;
      for (const rel of staleBasis) {
        if (curSet.has(rel)) continue;
        if (userOwnsProviders && rel.startsWith('providers/') && rel.endsWith('.json')) continue;
        const p = path.join(targetDir, rel);
        if (fs.existsSync(p)) {
          fs.rmSync(p, { force: true, recursive: true });
          staleRemoved++;
          pruneEmptyParents(path.dirname(p), targetDir);
        }
      }
      if (staleRemoved > 0) {
        console.log(`Pruned ${staleRemoved} stale file(s) (shipped in some prior version, absent in v${curVersion}).`);
      }
    }
  }

  // 4. Copy files
  const installedCount = copyRepoFiles(repoDir, targetDir, shippedFiles);

  // 5. Merge configuration
  mergeConfig(repoDir, targetDir, effectiveOptions, preserveBag);
  mergeTuiConfig(repoDir, targetDir);

  // 5.5 One-shot global ocp.jsonc → ocp.json rename (ADR 0004 §3) — silent
  // when there is nothing legacy to move, warn-only on collision/error.
  const ocpCfg = migrateGlobalOcpConfig(targetDir);
  if (ocpCfg.action !== 'skipped') {
    console.log(`${ocpCfg.action === 'renamed' ? '✓' : '⚠'} [ocp-config] ${ocpCfg.message}`);
  }

  // 6. Write installed version
  fs.writeFileSync(path.join(targetDir, 'installed.version'), curVersion + '\n', 'utf8');
  writeTargetInstalledManifest(targetDir, targetManagedFiles);

  // 6.5 Plugin runtime deps: target package.json + local install so
  //   plugins/*.ts `import "@opencode/plugin"` and TUI plugins'
  //   `import "solid-js"` resolve. Best-effort —
  //   failures warn only (see ensurePluginRuntimeDeps).
  try {
    const runtime = ensurePluginRuntimeDeps(repoDir, targetDir);
    if (runtime.install === 'ok' || runtime.install === 'skipped') {
      console.log(`✓ [plugin-runtime] ${runtime.message}`);
    } else {
      console.log(colorize.yellow(`⚠ [plugin-runtime] ${runtime.message}`));
    }
  } catch (err) {
    console.log(colorize.yellow(`⚠ [plugin-runtime] unexpected (${err instanceof Error ? err.message : String(err)})`));
  }

  // 7. Provision CLIs for enabled MCP servers missing from PATH. The
  //    section header is emitted only when the plan is non-empty — with
  //    every MCP CLI already present (the common case) there is nothing
  //    to report and an empty header would be noise.
  const mcpPlan = mcpProvisionPlan(repoDir, effectiveOptions);
  if (mcpPlan.length > 0) {
    section('MCP servers');
    provisionMcpCli(repoDir, effectiveOptions, mcpPlan);
  }

  // 8. Provision optional tools declared in install/tools.jsonc
  //    Phase 1 reports presence for each enabled tool (✓ [tool] … is present
  //    on PATH / provisioning / installed); Phase 2 runs post-install steps.
  //    This subsumes the former standalone checkExternalTools() call.
  //    Header guarded the same way as MCP: only when at least one tool is
  //    enabled (all-disabled options would otherwise print an empty block).
  const toolRegistry = loadToolRegistry(repoDir);
  if (toolRegistry?.tools && Object.keys(toolRegistry.tools).some((n) => toolEnabled(n, effectiveOptions))) {
    section('Tools');
    provisionTools(repoDir, effectiveOptions);
  }

  // 10. Deploy the bundled herdr config to ~/.config/herdr/ — only when herdr
  //     is enabled. Non-destructive: if the user already has a config, we
  //     leave it alone (they can run `ocp herdr-config install --force`).
  // 11. Deploy the bundled OCP models/cost.jsonc (coding-plan points) to
  //     ~/.config/opencode/models/. Copy-if-missing — user's edits to the
  //     rates survive; --force overwrites.
  //     Both always report at least one line (models-cost is unconditional),
  //     so this section header is unguarded.
  section('Bundled configs');
  if (effectiveOptions.tools?.herdr !== false) {
    const herdrCfg = deployHerdrConfig(repoDir, false);
    if (herdrCfg.action === 'installed' || herdrCfg.action === 'merged') {
      console.log(`✓ [herdr-config] ${herdrCfg.message}`);
    } else if (herdrCfg.action === 'uptodate' || herdrCfg.action === 'skipped') {
      console.log(`ℹ [herdr-config] ${herdrCfg.message}`);
    } else {
      console.log(`⚠ [herdr-config] ${herdrCfg.message}`);
    }
  }

  const modelsCost = deployModelsCost(repoDir, args.force === true);
  if (modelsCost.action === 'installed') {
    console.log(`✓ [models-cost] ${modelsCost.message}`);
  } else if (modelsCost.action === 'uptodate' || modelsCost.action === 'skipped') {
    console.log(`ℹ [models-cost] ${modelsCost.message}`);
  } else {
    console.log(`⚠ [models-cost] ${modelsCost.message}`);
  }

  return {
    success: true,
    version: curVersion,
    targetDir,
    filesInstalled: installedCount,
    backupPath,
  };
}

export function executeStatus(
  repoDir: string,
  targetDirOverride?: string
): {
  repoVersion: string;
  installedVersion: string | null;
  targetDir: string;
  isUpToDate: boolean;
  shippedFilesCount: number;
} {
  const targetDir = targetDirOverride ? path.resolve(targetDirOverride) : getDefaultTargetDir();
  const repoVersion = getCurrentRepoVersion(repoDir);
  const installedVer = getInstalledVersion(targetDir);
  const shippedFiles = collectShippedFiles(repoDir);

  return {
    repoVersion,
    installedVersion: installedVer,
    targetDir,
    isUpToDate: installedVer === repoVersion,
    shippedFilesCount: shippedFiles.length,
  };
}

export function executeInit(
  repoDir: string,
  args: CliArgs
): { targetDir: string; backupPath: string | null } {
  const targetDir = args.target ? path.resolve(args.target) : getDefaultTargetDir();
  let backupPath: string | null = null;

  if (!args.noBackup && fs.existsSync(targetDir)) {
    backupPath = backupTargetDir(targetDir);
    const keep = args.keepBackups ?? getMaxBackups();
    const pruned = pruneOldBackups(targetDir, keep);
    if (pruned > 0) console.log(`Pruned ${pruned} old backup(s) (keeping at most ${keep}).`);
  }

  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  fs.mkdirSync(targetDir, { recursive: true });

  return { targetDir, backupPath };
}

export function executeUninstall(
  repoDir: string,
  args: CliArgs
): { targetDir: string; removedCount: number } {
  const targetDir = args.target ? path.resolve(args.target) : getDefaultTargetDir();
  if (!fs.existsSync(targetDir)) {
    return { targetDir, removedCount: 0 };
  }

  // Prefer the target-side manifest so uninstall removes exactly what the
  // current installation still considers OCP-managed. Fall back to the
  // *installed* version's package manifest for older installs without .ocp
  // state, so a user who hasn't run `ocp update` since pulling can still
  // uninstall cleanly.
  const installedVer = getInstalledVersion(targetDir);
  const manifestVer = installedVer ?? getCurrentRepoVersion(repoDir);
  // Exact per-version manifest first. When it has been compacted away (or
  // never existed), fall back to the union of every historical manifest — a
  // superset of what any version shipped, so nothing managed survives, and
  // entries absent on disk are skipped by the loop below. Live repo scan is
  // the last resort when install/versions/ is missing entirely.
  let manifest = readTargetInstalledManifest(targetDir) ?? readManifest(getManifestPath(repoDir, manifestVer));
  if (!manifest) {
    const union = collectHistoricalShippedFiles(repoDir, new Set());
    manifest = union.length > 0 ? union : collectShippedFiles(repoDir);
  }

  let count = 0;
  const dirsToCheck = new Set<string>();
  for (const rel of manifest) {
    const p = path.join(targetDir, rel);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { force: true, recursive: true });
      count++;
      dirsToCheck.add(path.dirname(p));
    }
  }

  // Prune empty directories left behind after file removal (deepest first).
  const sortedDirs = [...dirsToCheck].sort((a, b) => b.length - a.length);
  for (const d of sortedDirs) {
    pruneEmptyParents(d, targetDir);
  }

  const versionFile = path.join(targetDir, 'installed.version');
  if (fs.existsSync(versionFile)) {
    fs.rmSync(versionFile, { force: true });
  }

  const stateDir = path.join(targetDir, OCP_STATE_DIR);
  if (fs.existsSync(stateDir)) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }

  return { targetDir, removedCount: count };
}
