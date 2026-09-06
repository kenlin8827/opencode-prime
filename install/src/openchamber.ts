import { spawnSync } from 'node:child_process';
import { isBinaryOnPath } from './installer';
import { findPackageManager, globalAddCommand } from './package-manager';

// OpenChamber (https://openchamber.dev) — the desktop / web GUI that runs
// on top of the local OpenCode engine. The native desktop app is a Tauri
// binary distributed separately (see https://openchamber.dev/download) and
// launched via `ocp desktop` / `ocp ui`; the npm package `@openchamber/web`
// exposes the `openchamber` CLI, which powers `ocp web` (web mode with a
// UI password) and is what this provisioning step installs.

const PACKAGE_NAME = '@openchamber/web';
const BIN_NAME = 'openchamber';

export type OpenChamberStatus = 'present' | 'installed' | 'skipped' | 'failed';

export interface OpenChamberResult {
  status: OpenChamberStatus;
  message: string;
}

/**
 * Pick the global install argv for the first package manager found on
 * PATH. Order follows the official OpenChamber install.sh (pnpm > bun >
 * yarn > npm). All segments are fixed constants — no external input.
 * Also used by `ocp update` to upgrade an existing installation.
 */
export function getOpenChamberInstallCommand(): { bin: string; args: readonly string[] } | null {
  const manager = findPackageManager(['pnpm', 'bun', 'yarn', 'npm'], isBinaryOnPath);
  return manager === null ? null : globalAddCommand(manager, PACKAGE_NAME);
}

/**
 * Ensure the OpenChamber web UI CLI is available. Never throws — all
 * outcomes are reported through the returned result so install flows can
 * degrade gracefully (a missing GUI must not fail the config install).
 */
export function ensureOpenChamber(): OpenChamberResult {
  if (isBinaryOnPath(BIN_NAME)) {
    return {
      status: 'present',
      message: '✓ [openchamber] web UI CLI is already installed',
    };
  }

  const installCmd = getOpenChamberInstallCommand();
  if (!installCmd) {
    return {
      status: 'skipped',
      message:
        'ℹ [openchamber] no package manager found (pnpm/bun/yarn/npm) — install manually from https://openchamber.dev/download',
    };
  }

  const cmdText = `${installCmd.bin} ${installCmd.args.join(' ')}`;
  console.log(`🚀 [openchamber] Installing OpenChamber web UI CLI via: ${cmdText}`);
  const res = spawnSync(installCmd.bin, installCmd.args, {
    stdio: 'inherit',
    timeout: 600000,
    shell: process.platform === 'win32',
  });
  if (res.status !== 0 || res.error) {
    const detail = res.error ? res.error.message : `exit code ${res.status}`;
    return {
      status: 'failed',
      message: `⚠ [openchamber] automatic installation failed (${detail}). Install manually: ${cmdText}`,
    };
  }

  if (isBinaryOnPath(BIN_NAME)) {
    return {
      status: 'installed',
      message:
        '✓ [openchamber] installed — launch the web UI with `ocp web` (the native desktop app for `ocp desktop` / `ocp ui` is a separate download from https://openchamber.dev/download)',
    };
  }

  return {
    status: 'installed',
    message:
      '✓ [openchamber] installed, but the binary is not on PATH yet — open a new terminal or add your package manager\'s global bin directory to PATH',
  };
}
