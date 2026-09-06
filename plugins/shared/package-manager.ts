import { existsSync } from "node:fs"
import { join } from "node:path"

export const PACKAGE_MANAGERS = ["bun", "pnpm", "yarn", "npm"] as const
export type PackageManager = (typeof PACKAGE_MANAGERS)[number]

const LOCKFILES: Readonly<Record<PackageManager, readonly string[]>> = {
  bun: ["bun.lock", "bun.lockb"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  npm: [],
}

export function packageManagerFor(root: string): PackageManager {
  for (const manager of PACKAGE_MANAGERS) {
    if (LOCKFILES[manager].some((file) => existsSync(join(root, file)))) return manager
  }
  return "npm"
}

export function devDependencyArgs(manager: PackageManager, dependency: string): readonly string[] {
  switch (manager) {
    case "bun":
    case "yarn":
      return ["add", "--dev", dependency]
    case "pnpm":
      return ["add", "--save-dev", dependency]
    case "npm":
      return ["install", "--save-dev", dependency]
  }
}
