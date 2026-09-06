import { isBinaryOnPath } from './installer';

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
