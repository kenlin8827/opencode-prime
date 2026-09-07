import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

let cachedExecutable: string | null | undefined;

function firstExisting(paths: string[]): string | undefined {
  return paths.find((candidate) => fs.existsSync(candidate));
}

function directExecutable(candidate: string): string | undefined {
  if (process.platform !== 'win32' || /\.(exe|com)$/i.test(candidate)) return candidate;
  if (!/\.(cmd|bat)$/i.test(candidate)) return undefined;
  const packageBinary = path.join(path.dirname(candidate), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
  return fs.existsSync(packageBinary) ? packageBinary : undefined;
}

function findOnPath(): string | undefined {
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    const args = process.platform === 'win32' ? ['opencode'] : ['-a', 'opencode'];
    const output = execFileSync(command, args, { encoding: 'utf8', timeout: 1_000 });
    const candidates = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (process.platform === 'win32') {
      // Preserve `where`/PATH precedence while resolving npm/Bun shims to
      // their native targets for direct child-process execution.
      for (const candidate of candidates) {
        const executable = directExecutable(candidate);
        if (executable) return executable;
      }
      return undefined;
    }
    return candidates[0];
  } catch {
    return undefined;
  }
}

/**
 * Locate an executable OpenCode binary for direct child-process use.
 *
 * Resolution order: explicit OPENCODE_BIN override, PATH (`where`/`which`),
 * then the OpenChamber desktop bundle on Windows. The resolved absolute path
 * avoids platform-specific PATHEXT and shell-shim behavior.
 */
export function getOpencodeExecutable(): string | null {
  if (cachedExecutable !== undefined) return cachedExecutable;

  const configured = process.env.OPENCODE_BIN;
  if (configured) {
    const resolved = path.resolve(configured);
    const executable = fs.existsSync(resolved) ? directExecutable(resolved) : undefined;
    if (executable) return (cachedExecutable = executable);
  }

  const fromPath = findOnPath();
  if (fromPath) return (cachedExecutable = fromPath);

  if (process.platform === 'win32') {
    const bundled = firstExisting([
      path.join(process.env.LOCALAPPDATA ?? '', 'Programs', '@openchamberelectron', 'resources', 'opencode-cli', 'opencode.exe'),
      path.join(process.env.PROGRAMFILES ?? '', 'OpenChamber', 'resources', 'opencode-cli', 'opencode.exe'),
    ]);
    if (bundled) return (cachedExecutable = bundled);
  }

  return (cachedExecutable = null);
}
