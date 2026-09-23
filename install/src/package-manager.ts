import {
  getInstallMethod,
  installMethodFromPath,
  isBinaryOnPath,
  resolveBinPath,
  type InstallMethod,
} from './shared/opencode-detect';

export const PACKAGE_MANAGERS = ['bun', 'pnpm', 'yarn', 'npm'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export interface PackageManagerCommand {
  readonly bin: PackageManager;
  readonly args: readonly string[];
}

export type PackageManagerAvailability = (manager: PackageManager) => boolean;

export function globalAddCommand(manager: PackageManager, packageName: string): PackageManagerCommand {
  switch (manager) {
    case 'bun':
    case 'pnpm':
      return { bin: manager, args: ['add', '-g', packageName] };
    case 'yarn':
      return { bin: manager, args: ['global', 'add', packageName] };
    case 'npm':
      return { bin: manager, args: ['install', '-g', packageName] };
  }
}

export function findPackageManager(
  order: readonly PackageManager[],
  isAvailable: PackageManagerAvailability = isBinaryOnPath,
): PackageManager | null {
  for (const manager of order) {
    if (isAvailable(manager)) return manager;
  }
  return null;
}

export function findPackageManagerForBinary(
  ownedBy: string,
  order: readonly PackageManager[],
  isAvailable: PackageManagerAvailability = isBinaryOnPath,
): PackageManager | null {
  const normalized = ownedBy.toLowerCase();
  const ownedManager = order.find((manager) => normalized.includes(manager));
  if (ownedManager !== undefined && isAvailable(ownedManager)) return ownedManager;
  return findPackageManager(order, isAvailable);
}

const PM_METHODS: readonly PackageManager[] = PACKAGE_MANAGERS;

function isPmMethod(method: InstallMethod): method is PackageManager {
  return (PM_METHODS as readonly string[]).includes(method);
}

/** Injection points for `resolvePmForSpec` — every probe is overridable so the decision chain is unit-testable without a real PATH. */
export interface PmResolutionOptions {
  /** Tool binary name (e.g. "openchamber") whose installed location should own the choice. Null/undefined skips the ownership layer. */
  binary?: string | null;
  /** Availability probe for a package manager; defaults to the real isBinaryOnPath. */
  isAvailable?: PackageManagerAvailability;
  /** Pre-computed install method of opencode itself; defaults to the live detectOpencode() snapshot. */
  opencodeMethod?: InstallMethod;
  /** Path resolver for `binary`; defaults to the real PATH lookup (inject for tests). */
  resolveBinaryPath?: (binary: string) => string | null;
}

/**
 * Resolve which package manager should run a global install for `spec`
 * (a package spec that may carry @version/@latest, e.g. "@openchamber/web@latest").
 * PURE with respect to its inputs — all environment probes are injectable.
 *
 * Decision chain:
 *   1. Per-tool ownership: when `opts.binary` is given and resolves on
 *      PATH, the install method classified from its path wins if it is
 *      bun/pnpm/yarn/npm — reinstalling through the manager that owns the
 *      binary avoids duplicate orphaned copies.
 *   2. Otherwise opencode's own install method is used as a proxy for the
 *      user's preferred manager.
 *   3. 'official' / 'unknown' / no opencode install → npm fallback.
 *   4. Availability gate: if the selected manager is not on PATH, degrade
 *      to npm; when npm is missing too, return null (caller prints the
 *      manual `npm install -g <spec>` hint).
 *
 * Returns null only when no usable manager exists (or the spec is empty).
 */
export function resolvePmForSpec(
  spec: string,
  opts: PmResolutionOptions = {},
): PackageManagerCommand | null {
  if (!spec) return null;
  const isAvailable = opts.isAvailable ?? isBinaryOnPath;
  const resolveBinaryPath = opts.resolveBinaryPath ?? resolveBinPath;

  // 1. Per-tool ownership first.
  let selected: PackageManager | null = null;
  if (opts.binary) {
    const binPath = resolveBinaryPath(opts.binary);
    if (binPath) {
      const owned = installMethodFromPath(binPath);
      if (isPmMethod(owned)) selected = owned;
    }
  }

  // 2. Opencode's own install method as proxy; 3. npm fallback otherwise.
  if (!selected) {
    const method = opts.opencodeMethod ?? getInstallMethod();
    selected = isPmMethod(method) ? method : 'npm';
  }

  // 4. Availability gate: degrade to npm; null when npm is missing too.
  if (isAvailable(selected)) return globalAddCommand(selected, spec);
  if (selected !== 'npm' && isAvailable('npm')) return globalAddCommand('npm', spec);
  return null;
}
