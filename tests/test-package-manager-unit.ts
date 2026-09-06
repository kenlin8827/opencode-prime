import {
  findPackageManager,
  findPackageManagerForBinary,
  globalAddCommand,
  type PackageManager,
} from "../install/src/package-manager"
import { devDependencyArgs, packageManagerFor } from "../plugins/shared/package-manager"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const available = new Set<PackageManager>(["npm", "yarn"])
const isAvailable = (manager: PackageManager): boolean => available.has(manager)

if (findPackageManager(["pnpm", "bun", "yarn", "npm"], isAvailable) !== "yarn") {
  throw new Error("package manager selection must respect caller order and availability")
}
if (findPackageManagerForBinary("C:/Users/test/.bun/bin/tool", ["bun", "pnpm", "yarn", "npm"], isAvailable) !== "yarn") {
  throw new Error("unavailable binary owner must fall back to the available manager")
}
if (findPackageManagerForBinary("C:/Users/test/.pnpm/tool", ["bun", "pnpm", "yarn", "npm"], isAvailable) !== "yarn") {
  throw new Error("unavailable binary owner must not be selected")
}
if (globalAddCommand("bun", "pkg").args.join(" ") !== "add -g pkg") throw new Error("bun global install command mismatch")
if (globalAddCommand("pnpm", "pkg").args.join(" ") !== "add -g pkg") throw new Error("pnpm global install command mismatch")
if (globalAddCommand("yarn", "pkg").args.join(" ") !== "global add pkg") throw new Error("yarn global install command mismatch")
if (globalAddCommand("npm", "pkg").args.join(" ") !== "install -g pkg") throw new Error("npm global install command mismatch")
if (devDependencyArgs("bun", "dprint").join(" ") !== "add --dev dprint") throw new Error("bun local install command mismatch")
if (devDependencyArgs("pnpm", "dprint").join(" ") !== "add --save-dev dprint") throw new Error("pnpm local install command mismatch")
if (devDependencyArgs("yarn", "dprint").join(" ") !== "add --dev dprint") throw new Error("yarn local install command mismatch")
if (devDependencyArgs("npm", "dprint").join(" ") !== "install --save-dev dprint") throw new Error("npm local install command mismatch")

const root = mkdtempSync(join(tmpdir(), "ocp-package-manager-"))
try {
  writeFileSync(join(root, "package.json"), "{}")
  if (packageManagerFor(root) !== "npm") throw new Error("package manager must default to npm")
  writeFileSync(join(root, "bun.lock"), "")
  if (packageManagerFor(root) !== "bun") throw new Error("bun lockfile must select bun")
  console.log("Package manager shared layer: PASS")
} finally {
  rmSync(root, { recursive: true, force: true })
}
