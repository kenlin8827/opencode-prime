import { existsSync, readFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { devDependencyArgs, packageManagerFor, type PackageManager } from "../shared/package-manager"

export { packageManagerFor } from "../shared/package-manager"
export type { PackageManager } from "../shared/package-manager"
export type DprintSetupStatus = "eligible" | "dprint-configured" | "formatter-configured" | "no-package-json"

export interface DprintSetupPlan {
  readonly status: DprintSetupStatus
  readonly packageManager?: PackageManager
  readonly reason: string
}

interface Command {
  readonly command: string
  readonly args: readonly string[]
}

export type CommandRunner = (command: Command, root: string) => Promise<void>

const DPRINT_CONFIGS = ["dprint.json", "dprint.jsonc", ".dprint.json", ".dprint.jsonc"]
const FORMATTER_CONFIGS = [
  "biome.json", "biome.jsonc", ".prettierrc", ".prettierrc.json", ".prettierrc.js", "prettier.config.js",
  "prettier.config.mjs", ".eslintrc", ".eslintrc.js", ".eslintrc.json", "eslint.config.js", "eslint.config.mjs",
  "ruff.toml", ".ruff.toml", "rustfmt.toml", ".rustfmt.toml",
]

function hasAny(root: string, files: readonly string[]): boolean {
  return files.some((file) => existsSync(join(root, file)))
}

function hasRuffPyproject(root: string): boolean {
  const path = join(root, "pyproject.toml")
  try {
    return existsSync(path) && /^\s*\[tool\.ruff\]/m.test(readFileSync(path, "utf8"))
  } catch {
    return false
  }
}

function hasPackageFormatterConfig(root: string): boolean {
  try {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>
    return "prettier" in packageJson || "eslintConfig" in packageJson
  } catch {
    return false
  }
}

export function planDprintSetup(root: string): DprintSetupPlan {
  if (!existsSync(join(root, "package.json"))) {
    return { status: "no-package-json", reason: "A project-local dprint dependency requires package.json." }
  }
  if (hasAny(root, DPRINT_CONFIGS)) {
    return { status: "dprint-configured", reason: "A dprint configuration already exists." }
  }
  if (hasAny(root, FORMATTER_CONFIGS) || hasPackageFormatterConfig(root) || hasRuffPyproject(root) || existsSync(join(root, "go.mod")) || existsSync(join(root, "Cargo.toml"))) {
    return { status: "formatter-configured", reason: "An existing formatter configuration was detected." }
  }
  return { status: "eligible", packageManager: packageManagerFor(root), reason: "No formatter configuration was detected." }
}

export function dprintSetupCommands(manager: PackageManager): Command[] {
  return [
    { command: manager, args: devDependencyArgs(manager, "dprint") },
    { command: "bun", args: ["x", "--no-install", "dprint", "init", "--yes"] },
  ]
}

function runCommand(command: Command, root: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, [...command.args], {
      cwd: root,
      shell: process.platform === "win32",
      stdio: "ignore",
    })
    child.once("error", reject)
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command.command} exited with ${code}`)))
  })
}

export async function setupDprint(root: string, runner: CommandRunner = runCommand): Promise<void> {
  const plan = planDprintSetup(root)
  if (plan.status !== "eligible" || !plan.packageManager) throw new Error(plan.reason)
  for (const command of dprintSetupCommands(plan.packageManager)) await runner(command, root)
}
