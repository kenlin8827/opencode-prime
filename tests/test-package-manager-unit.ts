import {
  findPackageManager,
  findPackageManagerForBinary,
  globalAddCommand,
  isUsablePackageManager,
  type PackageManager,
} from "../install/src/package-manager"
import { devDependencyArgs, packageManagerFor } from "../plugins/shared/package-manager"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isBinaryOnPath } from "../install/src/shared/opencode-detect"

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
} finally {
  rmSync(root, { recursive: true, force: true })
}

// Availability must mean more than "where.exe/which found a file": Hadoop
// ships a `yarn` that resolves on PATH but cannot execute at all. Selecting
// it would run `yarn global add <pkg>`, fail, and never reach the npm
// fallback — so the probe also requires `<pm> --version` to exit 0.
//
// PATH-mutation fixtures are unreliable on Windows (a child process does
// not always inherit a rewritten process.env.PATH), so the PATH-hit layer
// is stubbed via the injectable `onPath` parameter. The post-PATH layer
// (spawnSync) still runs against the real child process — for the "hit but
// broken" case, that means invoking a name that the shell cannot resolve,
// which is enough to drive `res.status !== 0 || res.error` → false.
if (isUsablePackageManager("ocp-no-such-package-manager")) throw new Error("a missing binary must not count as available")
if (isUsablePackageManager("ocp-broken-pm-fixture", () => true)) {
  throw new Error("a PATH hit for a name that spawnSync cannot resolve must not count as available")
}

// Stderr-failure guard regex sanity: must catch the four failure tokens
// the production code recognizes (error / cannot / not found / enoent).
// Portable without PATH mutation: this only pins the regex, not spawnSync.
const stderrFailureRe = /\b(error|cannot|not found|enoent)\b/i
const stderrShouldReject = [
  "error: something went wrong",
  "Cannot find module 'foo'",
  "/usr/local/bin/foo: not found",
  "spawnSync ocp-x ENOENT",
]
const stderrShouldAccept = [
  "",
  "1.2.3",
  "Warning: deprecated config key",
]
for (const s of stderrShouldReject) {
  if (!stderrFailureRe.test(s)) throw new Error(`stderr guard must reject: ${JSON.stringify(s)}`)
}
for (const s of stderrShouldAccept) {
  if (stderrFailureRe.test(s)) throw new Error(`stderr guard must accept: ${JSON.stringify(s)}`)
}

// Any manager that IS on PATH and answers `--version` with exit 0 must be
// reported usable — otherwise a working npm/pnpm/bun would be skipped and
// the install would fall through to a worse manager.
const candidate = (["npm", "bun", "pnpm"] as const).find((m) => isBinaryOnPath(m))
if (candidate) {
  const probe = spawnSync(candidate, ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  })
  const answers = probe.status === 0 && /\d+\.\d+\.\d+/.test(probe.stdout ?? "")
  if (answers && !isUsablePackageManager(candidate)) {
    throw new Error(`${candidate} answers --version with a semver but was reported unusable`)
  }
}

console.log("Package manager shared layer: PASS")
