import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isBinaryOnPath, loadToolRegistry, type ToolRegistry } from './installer';
import { majorOf } from './manifest';
import { findPackageManager, globalAddCommand } from './package-manager';
import { localBinaryVersion } from './shared/opencode-detect';

// OpenChamber (https://openchamber.dev) — the GUI layer that runs on top of
// the local OpenCode engine. It ships as three independent surfaces, each
// behind its own `tools.openchamber_*` switch in options.jsonc:
//
//   web     — the npm package `@openchamber/web` exposes the `openchamber`
//             CLI, which powers `ocp web` (browser UI with a UI password).
//             Pinned to major 2 (see PACKAGE_SPEC): `ocp web` drives the
//             CLI's serve/status/stop surface, so a v3 rewrite must never
//             be pulled in silently.
//   desktop — the Tauri native app powering `ocp desktop` / `ocp ui`. It is
//             distributed separately (https://openchamber.dev/download) and
//             is NEVER downloaded by the installer — we only check presence
//             and print the download link when missing.
//   vscode  — the editor extension `fedaykindev.openchamber` powering
//             `ocp code`. Auto-installs through the editor's own CLI
//             (VS Code Marketplace, or OpenVSX for VSCodium/Cursor/Windsurf).

const PACKAGE_NAME = '@openchamber/web';
const BIN_NAME = 'openchamber';

/**
 * Major version this OCP line is built against. Mirrors the opencode
 * runtime contract: the web CLI's `serve` / `status --quiet` / `stop
 * [--port]` surface (and OpenChamber's settings.json project layout) is
 * what `ocp web` / `ocp desktop` drive, so an untested v3 must never be
 * installed silently.
 *
 * Keep in sync with install/tools.jsonc → tools.openchamber_web (both the
 * `install` and the `update_check.upgrade` spec).
 */
export const OPENCHAMBER_WEB_REQUIRED_MAJOR = 2;

/**
 * Pinned install spec — `@openchamber/web@2`. A semver RANGE, not an exact
 * version: in-major fixes still flow through, only the major boundary is
 * closed.
 */
export const PACKAGE_SPEC = `${PACKAGE_NAME}@${OPENCHAMBER_WEB_REQUIRED_MAJOR}`;

export type OpenChamberSurface = 'web' | 'desktop' | 'vscode';
export type OpenChamberStatus = 'present' | 'installed' | 'skipped' | 'failed';

export interface OpenChamberResult {
  status: OpenChamberStatus;
  message: string;
}

/**
 * Resolve a `tools.openchamber_<surface>` switch. Default-true: only an
 * explicit `false` opts out of that surface.
 */
export function isOpenChamberSurfaceEnabled(
  tools: Record<string, boolean> | undefined,
  surface: OpenChamberSurface
): boolean {
  return tools?.[`openchamber_${surface}`] !== false;
}

/**
 * Pick the global install argv for the first package manager found on
 * PATH. Order follows the official OpenChamber install.sh (pnpm > bun >
 * yarn > npm). All segments are fixed constants — no external input.
 * Installs the PINNED spec — `ocp update` upgrades through the same pin
 * declared in install/tools.jsonc, not through this helper.
 */
export function getOpenChamberInstallCommand(): { bin: string; args: readonly string[] } | null {
  // Default availability probe (not a bare PATH hit): Hadoop ships a `yarn`
  // that `where.exe` finds but that cannot execute, which would fail the
  // install instead of falling through to npm.
  const manager = findPackageManager(['pnpm', 'bun', 'yarn', 'npm']);
  return manager === null ? null : globalAddCommand(manager, PACKAGE_SPEC);
}

/**
 * Cross-check the OpenChamber web CLI pin contract in `install/tools.jsonc`
 * against the code constants above. Returns a warning string when any of
 * the four contract fields drift apart (a maintainer bumped only one of
 * them), or null when everything agrees. Soft-only: a malformed registry
 * must NEVER block install — the test suite is the binding contract;
 * this is a loud early signal for hand-edits and CI drift.
 *
 * The four fields that must agree:
 *   1. `tools.openchamber_web.install.default`               — `@pm:@openchamber/web@<major>`
 *   2. `tools.openchamber_web.update_check.upgrade.default`  — `@pm:@openchamber/web@<major>`
 *   3. `tools.openchamber_web.update_check.required_major`   — `<major>`
 *   4. `tools.openchamber_web.update_check.upgrade_strategy` — `"static"` (smart would re-install the unpinned upgrade_package)
 */
export function openChamberPinContractWarning(registry: ToolRegistry | null): string | null {
  if (!registry) return null;
  const entry = registry.tools?.openchamber_web as
    | (Record<string, unknown> & {
        install?: { default?: string }
        update_check?: {
          upgrade?: { default?: string }
          required_major?: number
          upgrade_strategy?: string
        }
      })
    | undefined;
  if (!entry) return null;
  const expected = `@pm:@openchamber/web@${OPENCHAMBER_WEB_REQUIRED_MAJOR}`;
  const issues: string[] = [];
  if (entry.install?.default !== expected) {
    issues.push(`install.default = ${JSON.stringify(entry.install?.default ?? null)} (want ${expected})`);
  }
  if (entry.update_check?.upgrade?.default !== expected) {
    issues.push(`update_check.upgrade.default = ${JSON.stringify(entry.update_check?.upgrade?.default ?? null)} (want ${expected})`);
  }
  if (entry.update_check?.required_major !== OPENCHAMBER_WEB_REQUIRED_MAJOR) {
    issues.push(`update_check.required_major = ${JSON.stringify(entry.update_check?.required_major ?? null)} (want ${OPENCHAMBER_WEB_REQUIRED_MAJOR})`);
  }
  if (entry.update_check?.upgrade_strategy !== 'static') {
    issues.push(`update_check.upgrade_strategy = ${JSON.stringify(entry.update_check?.upgrade_strategy ?? null)} (want "static" — smart re-installs the unpinned upgrade_package and bypasses the major pin)`);
  }
  if (issues.length === 0) return null;
  return (
    `[openchamber-web] install/tools.jsonc pin contract drifted — OCP v${OPENCHAMBER_WEB_REQUIRED_MAJOR}.x runtime will refuse a v${OPENCHAMBER_WEB_REQUIRED_MAJOR + 1}+ CLI, but the registry now declares:\n` +
    issues.map((s) => `  • ${s}`).join('\n')
  );
}

/**
 * Ensure the OpenChamber web UI CLI is available. Never throws — all
 * outcomes are reported through the returned result so install flows can
 * degrade gracefully (a missing GUI must not fail the config install).
 *
 * `repoDir` is the OCP repo root, used to load install/tools.jsonc for the
 * pin-contract cross-check. Optional: when omitted, the cross-check is
 * skipped (preserves the existing zero-arg contract for tests/callers
 * that don't have a repoDir in hand — those paths never install).
 */
export function ensureOpenChamberWebCli(repoDir?: string): OpenChamberResult {
  // Defendability check first: warn if the registry's pin contract has
  // drifted from the code constants. Soft-only (never blocks install) —
  // the test suite is the binding contract; this is a loud signal for
  // hand-edits and CI drift.
  if (repoDir) {
    const pinWarn = openChamberPinContractWarning(loadToolRegistry(repoDir));
    if (pinWarn) console.warn(pinWarn);
  }

  if (isBinaryOnPath(BIN_NAME)) {
    // Present but off-major: say so in the install log instead of silently
    // calling it done. Install never REPLACES an existing global package —
    // `ocp update` is the (now unlocked) path from v1 to v2.
    const mismatch = openChamberWebMajorMismatch();
    return {
      status: 'present',
      message: mismatch
        ? `ℹ [openchamber-web] web UI CLI is installed at v${mismatch.local}, but this OCP release targets the v${OPENCHAMBER_WEB_REQUIRED_MAJOR}.x CLI — move it with \`ocp update\` (or reinstall the pinned major: npm install -g ${PACKAGE_SPEC})`
        : '✓ [openchamber-web] web UI CLI is already installed',
    };
  }

  const installCmd = getOpenChamberInstallCommand();
  if (!installCmd) {
    return {
      status: 'skipped',
      message:
        `ℹ [openchamber-web] no package manager found (pnpm/bun/yarn/npm) — install manually with \`npm install -g ${PACKAGE_SPEC}\` ` +
        'or from https://openchamber.dev/download',
    };
  }

  const cmdText = `${installCmd.bin} ${installCmd.args.join(' ')}`;
  console.log(`🚀 [openchamber-web] Installing OpenChamber web UI CLI via: ${cmdText}`);
  const res = spawnSync(installCmd.bin, installCmd.args, {
    stdio: 'inherit',
    timeout: 600000,
    shell: process.platform === 'win32',
  });
  if (res.status !== 0 || res.error) {
    const detail = res.error ? res.error.message : `exit code ${res.status}`;
    return {
      status: 'failed',
      message: `⚠ [openchamber-web] automatic installation failed (${detail}). Install manually: ${cmdText}`,
    };
  }

  if (isBinaryOnPath(BIN_NAME)) {
    return {
      status: 'installed',
      message:
        '✓ [openchamber-web] installed — launch the web UI with `ocp web`',
    };
  }

  return {
    status: 'installed',
    message:
      '✓ [openchamber-web] installed, but the binary is not on PATH yet — open a new terminal or add your package manager\'s global bin directory to PATH',
  };
}

/**
 * Major-mismatch probe for the web surface: the installed CLI's version and
 * major vs the one this OCP release targets. Null when there is nothing to
 * report (binary absent, unparseable version, or already on the required
 * major). Shared by the install log and the launch-time guard, so both say
 * the same thing.
 */
function openChamberWebMajorMismatch(): { local: string; major: number } | null {
  const local = localBinaryVersion(BIN_NAME);
  if (!local) return null;
  const major = majorOf(local);
  if (Number.isNaN(major) || major === OPENCHAMBER_WEB_REQUIRED_MAJOR) return null;
  return { local, major };
}

/**
 * Soft compat guard for `ocp web`. Warn-only on purpose — the pin keeps our
 * own installs on v2, but a user can upgrade openchamber outside ocp (or
 * have installed it before the pin landed), and refusing to launch a working
 * UI over a version probe would be worse than a visible warning.
 */
export function openChamberWebMajorWarning(): string | null {
  const mismatch = openChamberWebMajorMismatch();
  if (!mismatch) return null;
  return (
    `⚠ [openchamber-web] found v${mismatch.local}, but this OCP release targets the v${OPENCHAMBER_WEB_REQUIRED_MAJOR}.x web CLI. ` +
    `Reinstall the pinned major: npm install -g ${PACKAGE_SPEC} (or your package manager's equivalent).`
  );
}

// ── desktop surface ────────────────────────────────────────────────────────

export const DESKTOP_NOT_FOUND_HINT =
  '  Download the native app from https://openchamber.dev/download\n' +
  '  (the `openchamber` CLI serves the browser UI instead — use `ocp web`)';

/**
 * Locate the OpenChamber native desktop app (Tauri) on Windows. It is not
 * registered on PATH, so probe the common per-user / system install dirs
 * for an OpenChamber directory and return the first launcher exe inside.
 */
export function findWindowsDesktopExe(): string | null {
  const roots: string[] = [];
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    roots.push(path.join(localAppData, 'Programs'), localAppData);
  }
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)']) {
    const dir = process.env[key];
    if (dir) roots.push(dir);
  }
  for (const root of roots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/openchamber/i.test(entry)) continue;
      const dirPath = path.join(root, entry);
      if (!fs.existsSync(dirPath)) continue;
      const exe = scanForExe(dirPath, 2);
      if (exe) return exe;
    }
  }
  return null;
}

function scanForExe(dir: string, depth: number): string | null {
  if (depth < 0) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name.endsWith('.exe') && !/^unins/i.test(e.name)) {
      return full;
    }
    if (e.isDirectory()) {
      const found = scanForExe(full, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

/** Locate the native app on Linux: PATH binary first, then common paths. */
export function findLinuxDesktopBin(): string | null {
  if (isBinaryOnPath('openchamber-desktop')) return 'openchamber-desktop';
  const candidates = [
    path.join(os.homedir(), 'Applications', 'openchamber-desktop'),
    path.join(os.homedir(), 'Applications', 'OpenChamber', 'OpenChamber'),
    '/usr/local/bin/openchamber-desktop',
    '/opt/openchamber-desktop/openchamber-desktop',
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* keep probing */
    }
  }
  return null;
}

/**
 * Cross-platform presence probe for the desktop app. Returns a launchable
 * path when found, null otherwise. (macOS checks the .app bundle directly —
 * `open -a` would LAUNCH the app, which is not a check.)
 */
export function locateOpenChamberDesktopApp(): string | null {
  if (process.platform === 'win32') return findWindowsDesktopExe();
  if (process.platform === 'darwin') {
    for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      const app = path.join(dir, 'OpenChamber.app');
      if (fs.existsSync(app)) return app;
    }
    return null;
  }
  return findLinuxDesktopBin();
}

/**
 * Install-time check for the desktop surface. The installer never downloads
 * the desktop app (documented policy) — it only verifies presence and points
 * at the download page when missing.
 */
export function checkOpenChamberDesktop(): OpenChamberResult {
  if (locateOpenChamberDesktopApp()) {
    return {
      status: 'present',
      message: '✓ [openchamber-desktop] desktop app found — launch it with `ocp desktop`',
    };
  }
  return {
    status: 'skipped',
    message:
      'ℹ [openchamber-desktop] desktop app not found — download it from https://openchamber.dev/download (the installer never downloads it; `ocp web` works without it)',
  };
}

// ── vscode surface ─────────────────────────────────────────────────────────

/** Extension ID on the VS Code Marketplace (also on OpenVSX, same slug). */
export const OPENCHAMBER_VSCODE_EXTENSION_ID = 'fedaykindev.openchamber';

/** VS Code-family editor CLIs probed in order (first on PATH wins). */
export const VSCODE_CLI_CANDIDATES = ['code', 'code-insiders', 'codium', 'cursor', 'windsurf'] as const;

/**
 * Resolve an editor CLI name to a spawnable command. Windows gotcha: a VS
 * Code install often puts BOTH the GUI exe (`Code.exe`) and the real CLI
 * shim (`bin\code.cmd`) on PATH — and the exe can sort first. Spawning the
 * GUI exe "succeeds" (exit 0) while silently ignoring CLI args, which makes
 * every `--list-extensions` check lie empty. So on Windows we resolve
 * through `where.exe` and only accept the `.cmd`/`.bat` shim, returning its
 * basename — that resolves through the same PATH entry while dodging the
 * quoting problems of absolute install paths with spaces
 * ("C:\Programs\Microsoft VS Code\...").
 */
export function resolveVscodeCli(name: string): string | null {
  const probe =
    process.platform === 'win32'
      ? spawnSync('where.exe', [name], { encoding: 'utf8', timeout: 10000 })
      : spawnSync('which', [name], { encoding: 'utf8', timeout: 10000 });
  if (probe.status !== 0 || !probe.stdout) return null;
  const hits = probe.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (process.platform === 'win32') {
    const shim = hits.find((h) => /\.(cmd|bat)$/i.test(h));
    return shim ? path.basename(shim) : null;
  }
  return hits[0] ?? null;
}

/** First VS Code-compatible editor CLI resolvable on PATH, or null. */
export function findVscodeCli(): string | null {
  for (const name of VSCODE_CLI_CANDIDATES) {
    const resolved = resolveVscodeCli(name);
    if (resolved) return resolved;
  }
  return null;
}

/** `<cli> --list-extensions` — lowercased extension IDs, empty on failure. */
export function listVscodeExtensions(cli: string): string[] {
  const res = spawnSync(cli, ['--list-extensions'], {
    encoding: 'utf8',
    timeout: 30000,
    // Windows resolves .cmd shims (the `code` launcher) only through the shell.
    shell: process.platform === 'win32',
  });
  if (res.status !== 0 || !res.stdout) return [];
  return res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
}

/** True when the OpenChamber editor extension is installed in `cli`. */
export function isOpenChamberVscodeExtensionInstalled(cli: string): boolean {
  return listVscodeExtensions(cli).includes(OPENCHAMBER_VSCODE_EXTENSION_ID);
}

/** Best-effort install through the editor CLI. Returns true on success. */
export function installOpenChamberVscodeExtension(cli: string): boolean {
  console.log(
    `🚀 [openchamber-vscode] Installing extension ${OPENCHAMBER_VSCODE_EXTENSION_ID} via: ${cli} --install-extension`,
  );
  const res = spawnSync(cli, ['--install-extension', OPENCHAMBER_VSCODE_EXTENSION_ID], {
    stdio: 'inherit',
    timeout: 300000,
    shell: process.platform === 'win32',
  });
  return res.status === 0 && !res.error;
}

/**
 * Ensure the OpenChamber editor extension is available in `editorCli` (or
 * the first editor CLI found on PATH). Never throws — outcomes are reported
 * through the returned result so callers can degrade gracefully.
 */
export function ensureOpenChamberVscodeExtension(editorCli?: string | null): OpenChamberResult {
  const cli = editorCli ?? findVscodeCli();
  if (!cli) {
    return {
      status: 'skipped',
      message: `ℹ [openchamber-vscode] no VS Code-compatible CLI found (${VSCODE_CLI_CANDIDATES.join(', ')}) — install VS Code from https://code.visualstudio.com`,
    };
  }
  if (isOpenChamberVscodeExtensionInstalled(cli)) {
    return {
      status: 'present',
      message: `✓ [openchamber-vscode] extension ${OPENCHAMBER_VSCODE_EXTENSION_ID} is already installed in ${cli}`,
    };
  }
  // Re-verify after install: a GUI-exe PATH shadow can make a spawn exit 0
  // while doing nothing — only a listing that now contains the extension ID
  // counts as success.
  if (!installOpenChamberVscodeExtension(cli) || !isOpenChamberVscodeExtensionInstalled(cli)) {
    return {
      status: 'failed',
      message: `⚠ [openchamber-vscode] automatic installation failed — install manually: ${cli} --install-extension ${OPENCHAMBER_VSCODE_EXTENSION_ID} (https://marketplace.visualstudio.com/items?itemName=fedaykindev.openchamber)`,
    };
  }
  return {
    status: 'installed',
    message: `✓ [openchamber-vscode] extension installed in ${cli} — open the editor with \`ocp code\``,
  };
}
