import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import {
  getCurrentRepoVersion,
  getDefaultTargetDir,
  getInstalledVersion,
  isBinaryOnPath,
  loadToolRegistry,
  requiredRuntimeMajor,
  apiMirrorUrls,
  rawMirrorUrls,
  resolveInstallCommand,
  runInstallCommand,
  type ToolRegistry,
} from './installer';
import { isCrossMajorVersion, majorOf, isNewerVersion, parseVersionPayload } from './manifest';
import { findPackageManager, globalAddCommand } from './package-manager';
import { installMethodFromPath, localBinaryVersion, resolveBinPath } from './shared/opencode-detect';

const REPO_BASE = 'https://github.com/kenlin8827/opencode-prime';
const RELEASE_BASE = `${REPO_BASE}/releases/latest/download`;
// raw.githubusercontent serves tracked files (not release assets) — used as
// a lightweight version probe. raw.githubusercontent.com is BLOCKED in
// mainland CN (frequent DNS reset), so `rawMirrorUrls()` reorders the
// fetch to try `OCP_RAW_MIRROR` first when the user has set it.
const RAW_VERSION_URL =
  'https://raw.githubusercontent.com/kenlin8827/opencode-prime/main/install/version.json';

/**
 * Pure decision helper for the OCP archive-download branch in
 * `executeUpgrade`. Exported so the test suite can pin the force-override
 * semantics without mocking fetch / fs / network.
 *
 * Skip ONLY when ALL THREE hold:
 *   - the caller did NOT pass `-f` / `--force`
 *   - the remote probe succeeded (`probed !== null`)
 *   - the probed version is NOT newer than the local repo version
 *
 * Every other shape forces the archive to be re-fetched: a force request,
 * a probe failure (CN raw.githubusercontent often times out), or a remote
 * that's actually ahead of the local copy.
 */
export function shouldSkipUpgradeDownload(
  force: boolean,
  probed: string | null,
  repoVersion: string,
): boolean {
  return !force && probed !== null && !isNewerVersion(probed, repoVersion);
}

/**
 * Pure decision helper for the major-version upgrade lock: true when
 * local → latest is an upgrade that crosses the major boundary (e.g.
 * 1.18.32 → 2.0.0, OCP 2.0.1 → 3.0.0). Such upgrades are refused by
 * `ocp update` / `ocp upgrade` for every locked component. Downgrades and
 * same-major bumps are never "blocked major upgrades" — the former are
 * already refused by isNewerVersion, the latter are exactly what remains
 * allowed.
 *
 * The opencode runtime row carries a deliberate exception (see
 * probeToolFromRegistry): crossing UP to the major this OCP line requires
 * (v1 → v2) is the compat fix itself, so it is offered, not refused. The
 * apply path (@script:opencode) pins the newest tag WITHIN the required
 * major, so unlocking the decision can never overshoot into an untested
 * future major.
 */
export function isBlockedMajorUpgrade(local: string, latest: string): boolean {
  return isNewerVersion(latest, local) && isCrossMajorVersion(local, latest);
}

/**
 * Pure decision for the opencode row's lock: crossing up to the required
 * runtime major is the fix (unlocked); every other cross stays locked.
 */
export function opencodeRowLocked(local: string, requiredMajor: number, baseLocked: boolean): boolean {
  const major = majorOf(local);
  if (!baseLocked || Number.isNaN(major)) return baseLocked;
  return !(major < requiredMajor);
}

/**
 * Pure decision helper for the registry-wide lock default: locked unless
 * the policy block explicitly opts out. Fail-closed on purpose — a failed
 * registry load, a missing update_policy block, or a malformed flag all
 * leave the lock ON.
 */
export function policyDefaultFromRegistry(registry: ToolRegistry | null): boolean {
  return registry?.update_policy?.lock_major_default !== false;
}

/**
 * Resolve the per-tool major-version lock. `lockMajor` is the tool's
 * update_check.lock_major flag; undefined inherits the registry-wide
 * update_policy.lock_major_default. Exported for the lock truth table in
 * tests/test-updater-unit.ts.
 */
export function majorLockEnabled(lockMajor: boolean | undefined, policyDefault: boolean): boolean {
  return typeof lockMajor === 'boolean' ? lockMajor : policyDefault;
}

/** Registry-wide major-lock default from tools.jsonc update_policy (locked when absent). */
function majorLockPolicyDefault(repoDir: string): boolean {
  return policyDefaultFromRegistry(loadToolRegistry(repoDir));
}

/**
 * Pure decision helper for the archive-overlay step in `executeUpgrade`:
 * the downloaded release is applied onto the repo copy only when it is
 * newer AND stays within the same major version. OCP itself is always
 * major-locked, so `ocp upgrade` must never jump majors — a cross-major
 * release aborts the upgrade instead (see executeUpgrade).
 */
export function shouldOverlayRelease(remoteVersion: string, repoVersion: string): boolean {
  return isNewerVersion(remoteVersion, repoVersion) && !isCrossMajorVersion(repoVersion, remoteVersion);
}

/**
 * Pure decision helper for the `ocp update` report: partition the probed
 * components into pending (offered for apply) and blocked (refused by the
 * major-version lock). Externally-managed rows and rows without a known
 * local/latest version never appear in either list. Exported so the test
 * suite can pin the lock wiring without mocking fetch / fs / network.
 */
export function partitionUpdates(
  components: ComponentCheck[],
): { pending: ComponentCheck[]; blocked: ComponentCheck[] } {
  const upgradable = components.filter(
    (c) => !c.external && c.local && c.latest && isNewerVersion(c.latest, c.local),
  );
  const blocked = upgradable.filter(
    (c) => c.majorLocked !== false && c.local && c.latest && isCrossMajorVersion(c.local, c.latest),
  );
  // Set membership, not reference-equality includes(): robust if a future
  // edit clones or maps rows between the two filters.
  const blockedSet = new Set(blocked);
  const pending = upgradable.filter((c) => !blockedSet.has(c));
  return { pending, blocked };
}

/** A single component covered by the `ocp update` check/upgrade flow. */
export interface ComponentCheck {
  key: string;
  label: string;
  local: string | null;
  latest: string | null;
  status: string;
  /**
   * True when the binary lives outside the user profile and the upgrade
   * runs one of our @script: installers — those scripts refuse to overwrite
   * another manager's file, so the row is informational only and must not
   * be offered as a pending update.
   */
  external?: boolean;
  /**
   * Major-version upgrade lock (tools.jsonc update_policy / update_check.lock_major).
   * undefined/true = locked: an upgrade crossing the major boundary is
   * refused. OCP itself is always locked (set explicitly below).
   */
  majorLocked?: boolean;
}

/** `update_check.source` shape from install/tools.jsonc. */
interface UpdateCheckSource {
  kind: 'github' | 'npm' | 'cargo' | 'url';
  repo?: string;       // for github
  package?: string;    // for npm
  crate?: string;      // for cargo
  url?: string;        // for url
  regex?: string;      // for url extraction
}

interface ToolEntryUpdate {
  source?: UpdateCheckSource;
  /**
   * How to upgrade the tool:
   *   - "smart" (default for npm-managed tools): detect the package manager
   *     owning the installed binary, re-run its global install for
   *     `upgrade_package`. Falls back to the static `upgrade` command if no
   *     package manager is on PATH.
   *   - "static": just run the platform-resolved `upgrade` command.
   */
  upgrade_strategy?: 'smart' | 'static';
  /** Required when upgrade_strategy === "smart": the npm/yarn/etc package to install. */
  upgrade_package?: string;
  /**
   * Major-version lock override for this tool (see update_policy in
   * tools.jsonc). undefined inherits update_policy.lock_major_default
   * (true = locked); false opts the tool out of the lock.
   */
  lock_major?: boolean;
  /** Optional fallback for both strategies when no pm is detected / no per-platform override. */
  upgrade?: unknown; // string | Record<string, string>; resolved via resolveInstallCommand
  /**
   * Optional hooks around the upgrade, resolved like `upgrade` (per-platform
   * map or plain string). Needed when a running instance of the tool locks
   * its own binary (Windows): e.g. luvus stops its background server before
   * the installer replaces luvus.exe and restarts it afterwards.
   */
  pre_upgrade?: unknown;
  post_upgrade?: unknown;
}

interface ToolEntry {
  description?: string;
  binary: string;
  url?: string;
  install?: unknown;
  post_install?: unknown;
  update_check?: ToolEntryUpdate;
}

/**
 * `ocp update` — check the suite and its companion tools (opencode,
 * openchamber) for newer versions. Flag semantics follow the apt/brew
 * convention:
 *
 * - Interactive TTY: every available update is preselected ([Y/n] per item,
 *   Enter keeps it) and the selected upgrades are applied right away.
 * - `-y/--yes`: apply ALL pending updates without prompting (non-interactive
 *   safe — this is the scripted/unattended path).
 * - `--check-only`: probe versions and print the report, apply nothing.
 * - Non-interactive stdin without `-y`: check-only, to never mutate a
 *   machine an unattended run was not explicitly asked to change.
 */
export async function executeUpdate(repoDir: string, passthrough: string[]): Promise<number> {
  const checkOnly = passthrough.some((a) => ['--check-only', '--dry-run', '-n'].includes(a));
  const assumeYes = passthrough.some((a) => ['-y', '--yes', '-Yes'].includes(a));

  const repoVersion = getCurrentRepoVersion(repoDir);
  const targetDir = resolveTargetDir(passthrough);
  const installedVersion = getInstalledVersion(targetDir);

  let remoteVersion: string;
  try {
    // Try OCP_RAW_MIRROR first (CN-friendly), then the official
    // raw.githubusercontent URL as fallback. Each attempt is bounded by
    // the 15s timeout; the whole sequence stops on the first 2xx.
    let res: Response | null = null;
    let lastErr: unknown = null;
    for (const url of rawMirrorUrls(RAW_VERSION_URL)) {
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (res.ok) break;
        lastErr = new Error(`HTTP ${res.status} ${res.statusText}`);
      } catch (err) {
        lastErr = err;
      }
    }
    if (!res?.ok) throw lastErr ?? new Error('all attempts failed');
    const parsed = parseVersionPayload(await res.text());
    if (!parsed) throw new Error('Empty version payload');
    remoteVersion = parsed;
  } catch (err) {
    console.error(`✗ Version check failed: ${(err as Error).message ?? err}`);
    console.error('  Network trouble? Set OCP_RAW_MIRROR (e.g. https://ghfast.top),');
    console.error('  run `ocp upgrade` directly, or update via `git pull`.');
    return 1;
  }

  const baseline = installedVersion ?? repoVersion;
  const ocp: ComponentCheck = {
    key: 'ocp',
    label: 'opencode-prime',
    local: baseline,
    latest: remoteVersion,
    // OCP itself is not a registry tool — the major-version lock always
    // applies to it (0.45.0 must never auto-jump to 1.0.0).
    majorLocked: true,
    status: installedVersion
      ? `installed in ${targetDir}`
      : `not installed (repo copy at v${repoVersion})`,
  };
  // Drive the tool-update list from install/tools.jsonc. Each entry with
  // an `update_check` block becomes a probe; entries without one (legacy
  // entries or ones we haven't wired up yet) are silently skipped.
  const toolProbes = await probeToolsFromRegistry(repoDir);
  const components = [ocp, ...toolProbes];

  console.log('\nVersion check:');
  for (const c of components) {
    console.log(`  ${c.label.padEnd(15)} ${fmtVer(c.local).padEnd(11)} latest ${fmtVer(c.latest).padEnd(11)} ${c.status}`);
  }

  // Major-version lock: for locked components an upgrade that would cross
  // the major boundary is refused — reported below, never offered. The
  // lock list is the tools.jsonc registry (OCP is always locked); a tool
  // opts out via update_check.lock_major: false.
  const { pending, blocked } = partitionUpdates(components);
  if (blocked.length > 0) {
    console.log(`\n${blocked.length} major-version update(s) blocked by the major-version lock:`);
    for (const c of blocked) {
      console.log(`  ${c.label.padEnd(15)} v${c.local} → v${c.latest} — cross-major upgrades are refused; reinstall fresh to jump majors.`);
    }
  }
  if (pending.length === 0) {
    if (blocked.length === 0) console.log('\nEverything is up to date.');
    else console.log('\nNo in-major updates available (see the blocked list above).');
    return 0;
  }

  console.log(`\n${pending.length} update(s) available — all selected by default.`);

  let selected: ComponentCheck[];
  if (checkOnly) {
    console.log('Check-only mode (--check-only) — nothing was applied.');
    return 0;
  } else if (assumeYes) {
    console.log('Non-interactive mode (-y) — applying all pending updates.');
    selected = pending;
  } else if (!process.stdin.isTTY) {
    console.log('Non-interactive terminal without -y — staying check-only.');
    console.log('Run `ocp update -y` to apply all pending updates,');
    console.log('or `ocp upgrade` to update the suite itself.');
    return 0;
  } else {
    console.log('Press Enter to keep an update selected, or type n to skip it.\n');
    selected = [];
    for (const c of pending) {
      if (await confirmDefaultYes(`  Upgrade ${c.label} ${fmtVer(c.local)} → ${fmtVer(c.latest)}?`)) {
        selected.push(c);
      }
    }
    if (selected.length === 0) {
      console.log('\nNothing selected — no changes made.');
      return 0;
    }
  }

  let failed = 0;
  for (const c of selected) {
    console.log(`\n=== Upgrading ${c.label} ${fmtVer(c.local)} → ${fmtVer(c.latest)} ===`);
    // Pass the user-facing passthrough (incl. `-f`/`--force`) down to
    // executeUpgrade so `ocp update -f` actually forces a re-download.
    // Companion tools ignore passthrough (see applyComponentUpgrade).
    const code = await applyComponentUpgrade(c, repoDir, passthrough);
    if (code === 0) {
      console.log(`✔ ${c.label} upgraded.`);
    } else if (code === 2 && isScriptRefusal(c.key, repoDir)) {
      // The tool's @script installer refused: binary is managed by another
      // package manager (the refusal message above says how to update it).
      // Not a failure — don't count it against the run. Exit 2 from any
      // other upgrade path is a real failure (see isScriptRefusal).
      console.log(`↷ ${c.label} left as-is (managed outside ocp — see message above).`);
    } else {
      console.error(`✗ ${c.label} upgrade failed (exit ${code}).`);
      failed++;
    }
  }
  return failed === 0 ? 0 : 1;
}

function fmtVer(v: string | null): string {
  return v ? `v${v}` : '?';
}

/** Default-yes [Y/n] prompt: anything but n/no confirms. */
async function confirmDefaultYes(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${question} [Y/n] `, resolve));
    return !/^(n|no)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function applyComponentUpgrade(
  c: ComponentCheck,
  repoDir: string,
  passthrough: string[] = [],
): Promise<number> {
  // Defense in depth: the pending list already excludes locked cross-major
  // upgrades; this guard keeps the applier safe if a future call site
  // reconstructs its selection differently.
  if (c.majorLocked !== false && c.local && c.latest && isBlockedMajorUpgrade(c.local, c.latest)) {
    console.error(`✗ ${c.label}: cross-major upgrade blocked by the major-version lock (v${c.local} → v${c.latest}).`);
    return 1;
  }
  switch (c.key) {
    case 'ocp':
      // Forward passthrough so `ocp update -f` actually reaches
      // executeUpgrade and forces the archive re-download. Companion
      // tools don't take passthrough (their registry entries have no
      // -f semantics — upgrade_tool_from_registry ignores it).
      return executeUpgrade(repoDir, passthrough);
    default: {
      // Everything else comes from install/tools.jsonc via probeToolsFromRegistry.
      // The dispatch (smart vs static) lives inside upgradeToolFromRegistry.
      const code = await upgradeToolFromRegistry(repoDir, c.key);
      if (code === 0) verifyPostUpgradeMajor(c, repoDir);
      return code;
    }
  }
}

/**
 * TOCTOU guard for companion tools: the lock decision consumed the probe
 * snapshot, but a tool upgrade runs `pkg@latest` or an official installer —
 * whatever is newest AT APPLY TIME. A major published inside the
 * probe→apply window slips past the pending filter, so verify the binary's
 * major after a successful upgrade and warn loudly on violation.
 * Detection only: script-based installers cannot be pinned, so rollback is
 * left to the printed hint.
 */
function verifyPostUpgradeMajor(c: ComponentCheck, repoDir: string): void {
  const def = loadToolRegistry(repoDir)?.tools?.[c.key] as ToolEntry | undefined;
  const now = def?.binary ? localBinaryVersion(def.binary) : null;
  if (!now || !c.local || !isCrossMajorVersion(c.local, now)) return;
  console.error(`⚠ ${c.label}: the upgrade crossed the major boundary (v${c.local} → v${now}).`);
  console.error('  A new major was published between the version check and the apply — the lock gates the decision, not the installer itself.');
  const pkg = def?.update_check?.upgrade_package;
  if (pkg) {
    console.error(`  To pin the previous version back: npm install -g ${pkg}@${c.local} (or your package manager's equivalent)`);
  } else {
    console.error(`  To restore the previous version, reinstall v${c.local} with the tool's own installer.`);
  }
}

/**
 * Exit code 2 means "binary managed outside ocp — refused" ONLY for our
 * @script: tool installers (scripts/tools/*.ps1|.sh). No other upgrade
 * path carries that convention: package managers exit 2 on real errors,
 * and `curl | bash` installers exit 2 when the download hands back an
 * HTML error page. Misreading those as a benign refusal would hide the
 * failure as a success, so everything else falls through to the failure
 * branch.
 */
function isScriptRefusal(key: ComponentCheck['key'], repoDir: string): boolean {
  if (key === 'ocp') return false;
  const def = loadToolRegistry(repoDir)?.tools?.[key] as ToolEntry | undefined;
  return !!resolveInstallCommand(def?.update_check?.upgrade)?.startsWith('@script:');
}

/**
 * Upgrade a tool declared in install/tools.jsonc. Two strategies are
 * supported via `update_check.upgrade_strategy`:
 *   - `"smart"` (default for npm-managed tools): detect which package
 *     manager owns the installed binary and re-run that manager's install
 *     for the package declared in `upgrade_package`. Falls back to the
 *     static `upgrade` command if no package manager is on PATH.
 *   - `"static"`: just run the platform-resolved `upgrade` command. Used
 *     for tools installed by a script (e.g. herdr's official installer)
 *     rather than a package manager.
 *
 * No `upgrade` command at all = 1 (refuses to do anything).
 */
function upgradeToolFromRegistry(repoDir: string, toolName: string): number {
  const registry = loadToolRegistry(repoDir);
  const def = registry?.tools?.[toolName] as ToolEntry | undefined;
  if (!def) {
    console.error(`"${toolName}" is not declared in install/tools.jsonc.`);
    return 1;
  }
  const strategy = def.update_check?.upgrade_strategy ?? 'static';

  // Optional pre/post hooks (see ToolEntryUpdate). Best-effort on purpose:
  // correctness is enforced by the upgrade step itself — e.g. if the luvus
  // server is still holding luvus.exe, the installer's copy fails loudly.
  const pre = resolveInstallCommand(def?.update_check?.pre_upgrade);
  const post = resolveInstallCommand(def?.update_check?.post_upgrade);
  if (pre) {
    console.log(`Running: ${pre}`);
    runInstallCommand(pre, repoDir);
  }

  let code: number;
  if (strategy === 'smart') {
    code = smartUpgrade(toolName, def, repoDir);
  } else {
    code = staticUpgrade(toolName, def, repoDir);
  }

  if (post) {
    console.log(`Running: ${post}`);
    const r = runInstallCommand(post, repoDir);
    if ((r.status ?? 1) !== 0 || r.error) {
      console.error(`post-upgrade step for "${toolName}" failed — re-run it manually if needed.`);
    }
  }
  return code;
}

/**
 * Static strategy: resolve and run the platform-resolved `upgrade` command.
 * No `upgrade` command at all = 1 (refuses to do anything).
 */
function staticUpgrade(toolName: string, def: ToolEntry, repoDir: string): number {
  const cmd = resolveInstallCommand(def?.update_check?.upgrade);
  if (!cmd) {
    console.error(`No upgrade command declared for "${toolName}" on ${process.platform}-${process.arch} (and no smart upgrade configured).`);
    return 1;
  }
  console.log(`Running: ${cmd}`);
  const res = runInstallCommand(cmd, repoDir, { binary: def.binary });
  if (res.error) {
    console.error(`Failed to run upgrade for "${toolName}": ${res.error.message}`);
    return 1;
  }
  return res.status ?? 1;
}

/**
 * "Smart" upgrade: classify the installed binary of `def.binary` by its
 * path shape (installMethodFromPath — anchored directory markers, npm
 * included), then:
 *   - 'official' (e.g. opencode installed by the official @script channel):
 *     re-run the registry's own static `upgrade` command — the registry
 *     decides per tool (for opencode that is the pinned @script:opencode).
 *     Blindly reinstalling an officially-installed binary through
 *     bun/pnpm/yarn/npm would leave a duplicate orphaned copy behind.
 *   - bun/pnpm/yarn/npm: re-install the package declared in
 *     `update_check.upgrade_package` through that manager (per-tool
 *     ownership first). If the owning manager is not on PATH, fall back to
 *     the first of bun/pnpm/yarn/npm that is.
 *   - 'unknown' / no manager on PATH: static `upgrade` fallback (or fail).
 */
function smartUpgrade(toolName: string, def: ToolEntry, repoDir: string): number {
  const pkg = def.update_check?.upgrade_package;
  if (!pkg) {
    console.error(`upgrade_strategy:"smart" requires "upgrade_package" in update_check for "${toolName}".`);
    return 1;
  }

  const binPath = resolveBinPath(def.binary);
  const method = installMethodFromPath(binPath ?? '');

  if (method === 'official') {
    const official = resolveInstallCommand(def?.update_check?.upgrade);
    if (!official) {
      console.error(`"${toolName}" is officially installed and no static fallback upgrade is configured in update_check.`);
      return 1;
    }
    console.log(`Officially installed — using the tool's own upgrade channel: ${official}`);
    return runInstallCommand(official, repoDir, { binary: def.binary }).status ?? 1;
  }

  const manager =
    method !== 'unknown' && isBinaryOnPath(method)
      ? method
      : findPackageManager(['bun', 'pnpm', 'yarn', 'npm'], isBinaryOnPath);
  const cmd = manager === null ? null : globalAddCommand(manager, pkg);

  if (!cmd) {
    const fallback = resolveInstallCommand(def?.update_check?.upgrade);
    if (fallback) {
      console.log(`No package manager detected — falling back to: ${fallback}`);
      return runInstallCommand(fallback, repoDir, { binary: def.binary }).status ?? 1;
    }
    console.error(`No package manager detected for "${toolName}" and no static fallback upgrade configured.`);
    return 1;
  }

  console.log(`Running: ${cmd.bin} ${cmd.args.join(' ')}`);
  const res = spawnSync(cmd.bin, cmd.args, {
    stdio: 'inherit',
    timeout: 600000,
    shell: process.platform === 'win32',
  });
  return res.status ?? 1;
}

/**
 * `ocp update` tool registry — drives the per-tool update check from
 * install/tools.jsonc. Every entry that declares an `update_check` block
 * becomes a probe; entries without one are silently skipped (they were
 * created for the install flow only, with no upstream version to track).
 *
 * Each `source.kind`:
 *   - github: api.github.com/repos/<repo>/releases/latest → tag_name
 *   - npm:    registry.npmjs.org/<package> → dist-tags.latest
 *   - cargo:  crates.io/api/v1/crates/<crate> → crate.max_stable_version
 *   - url:    arbitrary endpoint, regex extracts semver from body
 */
async function probeToolsFromRegistry(repoDir: string): Promise<ComponentCheck[]> {
  const registry = loadToolRegistry(repoDir);
  if (!registry?.tools) return [];
  const out: ComponentCheck[] = [];
  for (const [name, rawDef] of Object.entries(registry.tools)) {
    const def = rawDef as ToolEntry;
    if (!def.update_check?.source) continue;
    out.push(await probeToolFromRegistry(repoDir, name, def));
  }
  return out;
}

async function probeToolFromRegistry(repoDir: string, name: string, def: ToolEntry): Promise<ComponentCheck> {
  // Major-version lock resolution: per-tool update_check.lock_major wins,
  // otherwise the registry-wide update_policy.lock_major_default applies
  // (locked when the policy block is absent — the safe default).
  let locked = majorLockEnabled(def.update_check?.lock_major, majorLockPolicyDefault(repoDir));
  const local = localBinaryVersion(def.binary);
  // The opencode row is the runtime the compat gate depends on: crossing up
  // to the major this OCP line requires (v1 → v2) is the FIX, not a lock
  // violation — offer it (the @script:opencode pin bounds the apply to the
  // required major, so no overshoot). Every other major cross stays locked.
  if (name === 'opencode' && local) {
    locked = opencodeRowLocked(local, requiredRuntimeMajor(getCurrentRepoVersion(repoDir)), locked);
  }
  const base = { key: name, label: name, majorLocked: locked };

  if (!local) {
    // Still probe latest so the row shows what the user is missing instead of
    // two `?` columns. Network blip falls through to the original message.
    let latest: string | null = null;
    if (def.update_check?.source) {
      try {
        latest = await fetchLatestFromSource(def.update_check.source);
      } catch {
        // swallow — original "not found on PATH" status still applies
      }
    }
    return {
      ...base,
      local: null,
      latest,
      status: latest
        ? `not installed — latest is v${latest}; run \`ocp install\` or set tools.${name} = false`
        : `not found on PATH (install via \`ocp install\` or set tools.${name})`,
    };
  }
  if (!def.update_check?.source) {
    return { ...base, local, latest: null, status: 'no update_check source — skipped' };
  }

  try {
    const latest = await fetchLatestFromSource(def.update_check.source);
    if (!latest) {
      return { ...base, local, latest: null, status: 'latest-version probe failed — skipped' };
    }
    // Our @script: installers refuse to overwrite a binary outside the user
    // profile (another manager owns it) — mirror that here so the row says
    // "externally managed" instead of offering an upgrade that would refuse.
    const binPath = resolveBinPath(def.binary);
    const home = os.homedir().toLowerCase();
    const external =
      !!resolveInstallCommand(def.update_check.upgrade)?.startsWith('@script:') &&
      !!binPath && !binPath.toLowerCase().startsWith(home);
    return {
      ...base,
      local,
      latest,
      external,
      status: external
        ? `externally managed — update via ${externalUpdateHint(binPath as string, name)}`
        : isNewerVersion(latest, local)
          ? (base.majorLocked && isCrossMajorVersion(local, latest)
            ? 'cross-major update — blocked by policy'
            : 'update available')
          : 'up to date',
    };
  } catch (err) {
    return {
      ...base,
      local,
      latest: null,
      status: `latest-version probe failed: ${(err as Error).message ?? err}`,
    };
  }
}

/** Resolve a source-kind URL + extract the version. */
async function fetchLatestFromSource(src: UpdateCheckSource): Promise<string | null> {
  switch (src.kind) {
    case 'github': {
      if (!src.repo) return null;
      // Try OCP_API_MIRROR first (CN-friendly, avoids 429 rate-limit), then
      // the official api.github.com URL as fallback. Each attempt is bounded
      // by the 15s timeout; the whole sequence stops on the first 2xx so a
      // mirror outage degrades to the official GitHub Releases API.
      let res: Response | null = null;
      let lastErr: unknown = null;
      for (const url of apiMirrorUrls(
        `https://api.github.com/repos/${src.repo}/releases/latest`,
      )) {
        try {
          res = await fetch(url, {
            signal: AbortSignal.timeout(15000),
            headers: { 'User-Agent': 'opencode-prime-updater' },
          });
          if (res.ok) break;
          lastErr = new Error(`HTTP ${res.status}`);
        } catch (err) {
          lastErr = err;
        }
      }
      if (!res?.ok) throw lastErr ?? new Error('all attempts failed');
      const tag = (((await res.json()) as { tag_name?: string }).tag_name ?? '').replace(/^v/, '');
      return tag || null;
    }
    case 'npm': {
      if (!src.package) return null;
      const url = `https://registry.npmjs.org/${encodeURIComponent(src.package)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const latest = ((await res.json()) as { 'dist-tags'?: { latest?: string } })['dist-tags']?.latest ?? '';
      return latest || null;
    }
    case 'cargo': {
      if (!src.crate) return null;
      const res = await fetch(`https://crates.io/api/v1/crates/${encodeURIComponent(src.crate)}`, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'opencode-prime-updater' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { crate?: { max_stable_version?: string } };
      return j.crate?.max_stable_version ?? null;
    }
    case 'url': {
      if (!src.url) return null;
      const res = await fetch(src.url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.text()).trim();
      if (src.regex) {
        const m = new RegExp(src.regex).exec(body);
        return m ? (m[1] ?? m[0]) : null;
      }
      const fallback = /\d+\.\d+\.\d+[\w.-]*/.exec(body);
      return fallback ? fallback[0] : null;
    }
    default:
      return null;
  }
}

/**
 * Best-effort update command for a binary that lives outside the user
 * profile, derived from its install path. Unknown layouts fall back to
 * generic wording.
 */
function externalUpdateHint(binPath: string, pkg: string): string {
  const p = binPath.toLowerCase();
  if (p.includes('chocolatey')) return `\`choco upgrade ${pkg} -y\` (admin terminal)`;
  if (p.includes('scoop')) return `\`scoop update ${pkg}\``;
  if (p.includes('homebrew') || p.includes('cellar')) return `\`brew upgrade ${pkg}\``;
  if (p.startsWith('/usr/bin/')) return `\`sudo apt upgrade ${pkg}\``;
  return 'the tool that installed it';
}

/** Target dir from -t/--target in passthrough args, else the default target. */
function resolveTargetDir(passthrough: string[]): string {
  for (let i = 0; i < passthrough.length; i++) {
    if (['-t', '--target', '-Target'].includes(passthrough[i]) && passthrough[i + 1]) {
      return path.resolve(passthrough[i + 1]);
    }
  }
  return getDefaultTargetDir();
}

/** Semver-aware comparison lives in manifest.ts — shared with the installer. */

/**
 * `ocp upgrade` — fetch the latest release tarball and reinstall, mirroring
 * the "10-Second Quick Install" flow from the README:
 *
 * Download opencode-prime-latest.{tar.gz,zip} into a temp dir, overlay it
 * onto the current repo directory, then force-reapply the installer from
 * there. The repo directory stays the persistent home, so the global shims
 * in ~/.local/bin keep pointing at a valid location.
 *
 * NOTE: the overlay (`fs.cpSync recursive force`) overwrites tracked files
 * in the repo directory. If you installed via `git clone` and have local
 * edits to tracked files (your opencode.jsonc, custom prompts/skills/agents
 * that are tracked, etc.), they will be replaced by the release copy. Commit
 * or back them up before upgrading. The `.git/` directory is not in the
 * archive, so your git history and uncommitted diffs survive — but `ocp
 * upgrade` no longer uses git for the upgrade itself.
 *
 * Set OCP_RELEASE_MIRROR to a ghproxy-style prefix (e.g. https://ghfast.top)
 * when the official GitHub download is blocked or slow; the mirror is tried
 * after the official URL fails. Same version with no force flag → no-op.
 *
 * Major-version lock: OCP itself is always locked to its current major —
 * a release that would change the major version (0.45.0 → 1.0.0) is
 * refused at the probe, the archive-overlay, and the installer-apply step.
 * --force never bypasses the lock; the documented escape hatch is a fresh
 * install (`ocp init` clears the target, removing installed.version).
 */
export async function executeUpgrade(repoDir: string, passthrough: string[]): Promise<number> {
  const force = passthrough.some((a) => ['-f', '--force', '-Force'].includes(a));

  const repoVersionBeforeDownload = getCurrentRepoVersion(repoDir);
  // Cheap probe first: skip the archive download entirely when the local
  // repo copy is already at or ahead of the latest released version. The
  // `-f` / `--force` flag bypasses this skip and re-downloads the archive
  // anyway — useful in CN where the raw.githubusercontent probe can lag
  // or return a stale cached value, and to recover from a half-applied
  // overlay where the repo copy is technically current but drift exists.
  const probed = await probeRemoteVersion();
  // Major-version lock, probe step: OCP itself is always locked, so a
  // release on a different major (0.45.0 → 1.0.0) is refused before any
  // download. --force re-downloads and re-applies, but never bypasses this.
  if (probed && isBlockedMajorUpgrade(repoVersionBeforeDownload, probed)) {
    console.error(`✗ Cross-major upgrade blocked: latest release v${probed} crosses the major boundary (local v${repoVersionBeforeDownload}).`);
    console.error('  The major-version lock cannot be bypassed — not even with --force.');
    console.error('  To jump majors, back up your config and reinstall fresh (see docs/maintenance/ocp-cli.md).');
    return 1;
  }
  if (shouldSkipUpgradeDownload(force, probed, repoVersionBeforeDownload)) {
    console.log(`Repository copy is already at v${repoVersionBeforeDownload} (latest release: v${probed}) — no download needed.`);
  } else {
    if (force && probed && !isNewerVersion(probed, repoVersionBeforeDownload)) {
      console.log(`--force requested — re-downloading v${probed} release despite local v${repoVersionBeforeDownload}.`);
    }
    const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ocp-upgrade-'));
    try {
      const archive = await downloadArchive(`${RELEASE_BASE}/opencode-prime-latest.${ext}`, tmpRoot, ext);
      if (!archive) return 1;

      // bsdtar (macOS / Windows 10+) and GNU tar both extract tar.gz and zip.
      const tar = spawnSync('tar', ['-xf', archive, '-C', tmpRoot], { stdio: 'inherit' });
      if (tar.status !== 0) {
        console.error('✗ Failed to extract the release archive.');
        return tar.status ?? 1;
      }

      const extracted = fs
        .readdirSync(tmpRoot)
        .map((e) => path.join(tmpRoot, e))
        .find(
          (p) =>
            fs.statSync(p).isDirectory() &&
            (fs.existsSync(path.join(p, 'install', 'version.json')) ||
              fs.existsSync(path.join(p, 'install', 'VERSION')))
        );
      if (!extracted) {
        console.error('✗ The release archive has an unexpected layout.');
        return 1;
      }

      // version.json is authoritative; install/VERSION covers transitional archives.
      const vjPath = path.join(extracted, 'install', 'version.json');
      const remoteVersion = fs.existsSync(vjPath)
        ? parseVersionPayload(fs.readFileSync(vjPath, 'utf8')) ?? ''
        : fs.readFileSync(path.join(extracted, 'install', 'VERSION'), 'utf8').trim();
      if (!remoteVersion) {
        console.error('✗ Could not determine the release version.');
        return 1;
      }
      const repoVersion = getCurrentRepoVersion(repoDir);
      if (shouldOverlayRelease(remoteVersion, repoVersion)) {
        console.log(`Overlaying v${remoteVersion} onto ${repoDir}...`);
        // Overlay the new package onto the persistent repo directory. Removed
        // files inside the repo dir are harmless — the manifest-driven install
        // only copies the files it lists. Tracked files in the repo are
        // overwritten by the release copy; back up local edits before
        // upgrading (see the function doc above).
        fs.cpSync(extracted, repoDir, { recursive: true, force: true });
      } else if (isNewerVersion(remoteVersion, repoVersion)) {
        // Newer but not overlayable = the release crosses the major
        // boundary. This is the first place the jump becomes visible when
        // the probe failed (stale mirror, CN network) and the archive had
        // to be downloaded blind.
        console.error(`✗ Cross-major upgrade blocked: the downloaded release is v${remoteVersion} (local v${repoVersion}).`);
        console.error('  The major-version lock cannot be bypassed — not even with --force.');
        return 1;
      } else {
        console.log(`Repository copy is already at v${repoVersion} (latest release: v${remoteVersion}) — skipping overlay.`);
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  // Decide against the installed version in the target directory (the repo
  // copy can be ahead of what is actually applied to ~/.config/opencode).
  const repoVersion = getCurrentRepoVersion(repoDir);
  const targetDir = resolveTargetDir(passthrough);
  const installedVersion = getInstalledVersion(targetDir);
  // Major-version lock, apply step: the repo copy can only sit on a
  // different major than the installed one via out-of-band means (git
  // pull, manual overlay) — the overlay guard above refuses cross-major
  // releases. Refuse the apply too, in both directions: a cross-major
  // apply is exactly the jump the lock exists to prevent. (`ocp init`
  // clears the target, removing installed.version — the documented fresh
  // install escape hatch.)
  if (installedVersion !== null && isCrossMajorVersion(installedVersion, repoVersion)) {
    console.error(`✗ Cross-major apply blocked: installed v${installedVersion} vs repository v${repoVersion}.`);
    console.error('  The major-version lock cannot be bypassed — not even with --force.');
    console.error('  To jump majors, back up your config and reinstall fresh (see docs/maintenance/ocp-cli.md).');
    return 1;
  }
  if (!force && installedVersion !== null && !isNewerVersion(repoVersion, installedVersion)) {
    console.log(`Already up to date (installed: v${installedVersion}, repository: v${repoVersion}). Add --force to re-apply anyway.`);
    return 0;
  }

  // Re-run the installer from the updated copy through the bootstrap script
  // (same entry as the one-liner quick install): it picks the right runtime
  // and loads the freshly overlaid engine, which may have replaced the code
  // currently running this upgrade. The bootstrap defaults to `install`, so
  // leave the action implicit across this self-upgrade boundary.
  //
  // Honor user intent: do NOT inject `--force` automatically. A bare
  // `ocp upgrade` should run the installer's normal version-aware flow
  // (re-apply the new repo version over an older installed copy — that's
  // why we are here). `--force` is reserved for the explicit `-f / --force`
  // flag, matching `bin/opencode-prime`'s "no -f = wizard" mental model.
  const rest = passthrough;
  // Make the reason explicit when the version probe reported no newer
  // release: the repo copy can still be ahead of what was last applied
  // to the target directory, so we still re-apply the installer.
  console.log(
    `Applying v${repoVersion} to ${targetDir} (installed: ${installedVersion ? `v${installedVersion}` : 'none'})...`,
  );
  const script =
    process.platform === 'win32'
      ? path.join(repoDir, 'install', 'install.ps1')
      : path.join(repoDir, 'install', 'install.sh');
  const res =
    process.platform === 'win32'
      ? spawnSync('pwsh', ['-NoProfile', '-File', script, ...rest], {
          stdio: 'inherit',
          cwd: repoDir,
        })
      : spawnSync('bash', [script, ...rest], {
          stdio: 'inherit',
          cwd: repoDir,
        });
  if (res.status === 0) {
    console.log('✔ OpenCode Prime upgraded successfully.');
  }
  return res.status ?? 1;
}

/**
 * Lightweight remote version probe. Tries OCP_RAW_MIRROR first when set,
 * then the official raw.githubusercontent URL. Returns null on any failure
 * — `executeUpgrade` uses null as "could not determine; proceed to download
 * anyway", which is the safe degradation path.
 */
async function probeRemoteVersion(): Promise<string | null> {
  for (const url of rawMirrorUrls(RAW_VERSION_URL)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const parsed = parseVersionPayload(await res.text());
      if (parsed) return parsed;
    } catch {
      // try the next URL
    }
  }
  return null;
}

/** Official URL first, then the optional ghproxy-style OCP_RELEASE_MIRROR. */
async function downloadArchive(url: string, destDir: string, ext: string): Promise<string | null> {
  const mirror = process.env.OCP_RELEASE_MIRROR?.replace(/\/+$/, '');
  const attempts = mirror ? [url, `${mirror}/${url}`] : [url];

  for (const attempt of attempts) {
    console.log(`Downloading the latest release: ${attempt}`);
    try {
      const res = await fetch(attempt, { signal: AbortSignal.timeout(300000) });
      if (!res.ok) {
        console.error(`  ✗ HTTP ${res.status} ${res.statusText}`);
        continue;
      }
      const dest = path.join(destDir, `opencode-prime-latest.${ext}`);
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      return dest;
    } catch (err) {
      console.error(`  ✗ ${(err as Error).message ?? err}`);
    }
  }
  console.error('✗ Download failed from every source.');
  if (!mirror) {
    console.error('  Behind a firewall? Set a ghproxy-style mirror and retry, e.g.:');
    console.error('    OCP_RELEASE_MIRROR=https://ghfast.top ocp upgrade');
  }
  return null;
}
