import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, spawnSync } from 'node:child_process';
import { CliArgs, InstallOptions } from './types';
import { deployHerdrConfig } from './herdr-config';
import { deployModelsCost } from './models-cost';
import { colorize } from './color';
import { runShellCommand } from './shared/shell-command';
import {
  collectHistoricalShippedFiles,
  collectShippedFiles,
  generateManifest,
  getManifestPath,
  isNewerVersion,
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

export function getDefaultTargetDir(): string {
  if (process.env.OPENCODE_CONFIG_DIR) {
    return path.resolve(process.env.OPENCODE_CONFIG_DIR);
  }
  const home = os.homedir();
  return path.join(home, '.config', 'opencode');
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

export function copyRepoFiles(repoDir: string, targetDir: string, files: string[]): number {
  let count = 0;
  // Shipped preset files in `providers/` are seeded on first install only.
  // After that, the user owns `~/.config/opencode/providers/`: opencode loads
  // every JSON there as an available preset (see `/provider` → "Add preset"),
  // and the user can delete / edit / re-add presets as they see fit. We use
  // the presence of `installed.version` (written at the end of a successful
  // install) as the "first install already happened" signal — checking the
  // preset file itself is unreliable because the user may have just deleted
  // it and we must not undo that.
  const userOwnsProviders = fs.existsSync(path.join(targetDir, 'installed.version'));
  for (const relFile of files) {
    // The config template ships in the package but never lands in the target:
    // mergeConfig renders it (plus options + preserved fields) into the
    // target's opencode.jsonc. Copying it verbatim would leave a stray
    // opencode.template.jsonc beside the merged config.
    if (relFile === 'opencode.template.jsonc') continue;

    // Same pattern for the TUI template — mergeTuiConfig renders it
    // (plus preserved user plugins) into the target's tui.jsonc. We can't
    // verbatim-copy because users add their own TUI plugins; overwriting
    // would lose them on every reinstall.
    if (relFile === 'tui.template.jsonc') continue;

    if (
      userOwnsProviders &&
      relFile.startsWith('providers/') &&
      relFile.endsWith('.json')
    ) {
      continue;
    }

    const src = path.join(repoDir, relFile);
    const dest = path.join(targetDir, relFile);
    const destDir = path.dirname(dest);

    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      count++;
    }
  }
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
      if (relFile === 'tui.template.jsonc') return false;
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

export function isBinaryOnPath(cmdName: string): boolean {
  const checkCmd = process.platform === 'win32' ? `where.exe ${cmdName}` : `which ${cmdName}`;
  try {
    execSync(checkCmd, { stdio: 'ignore', timeout: 1000 });
    return true;
  } catch {
    return false;
  }
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
  const mcp = template?.mcp;
  if (!mcp || typeof mcp !== 'object' || !options.mcp) return [];

  const plan: Array<{ name: string; install: string }> = [];
  for (const [name, enabled] of Object.entries(options.mcp)) {
    if (!enabled) continue;
    const block = mcp[name];
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
export function runInstallCommand(cmd: string) {
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
 * Provision CLIs for enabled MCP servers that declare an `install` field and
 * are missing from PATH. Never throws — failures are logged with manual
 * instructions so a missing CLI can't fail the config install.
 */
export function provisionMcpCli(repoDir: string, options: InstallOptions): void {
  for (const { name, install } of mcpProvisionPlan(repoDir, options)) {
    console.log(`🚀 [mcp] ${name} missing from PATH — provisioning via: ${install}`);
    const res = runInstallCommand(install);
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
  tools?: Record<
    string,
    {
      description?: string;
      binary: string;
      url?: string;
      install?: unknown; // string | Record<string, string>; resolved via resolveInstallCommand
      post_install?: Array<string | PostInstallStep>;
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
 */
function toolEnabled(name: string, options: InstallOptions): boolean {
  const v = options.tools?.[name];
  return v !== false;
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
      console.log(colorize.green(`✓ [tool] ${name} (${def.binary}) is present on PATH`));
      continue;
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
    const res = runInstallCommand(cmd);
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
  const targetDir = args.target ? path.resolve(args.target) : getDefaultTargetDir();
  const curVersion = getCurrentRepoVersion(repoDir);

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

  // 6. Write installed version
  fs.writeFileSync(path.join(targetDir, 'installed.version'), curVersion + '\n', 'utf8');
  writeTargetInstalledManifest(targetDir, targetManagedFiles);

  // 7. Provision CLIs for enabled MCP servers missing from PATH
  provisionMcpCli(repoDir, effectiveOptions);

  // 8. Provision optional tools declared in install/tools.jsonc
  //    Phase 1 reports presence for each enabled tool (✓ [tool] … is present
  //    on PATH / provisioning / installed); Phase 2 runs post-install steps.
  //    This subsumes the former standalone checkExternalTools() call.
  provisionTools(repoDir, effectiveOptions);

  // 10. Deploy the bundled herdr config to ~/.config/herdr/ — only when herdr
  //     is enabled. Non-destructive: if the user already has a config, we
  //     leave it alone (they can run `ocp herdr-config install --force`).
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

  // 11. Deploy the bundled OCP models/cost.jsonc (coding-plan points) to
  //     ~/.config/opencode/models/. Copy-if-missing — user's edits to the
  //     rates survive; --force overwrites.
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
