import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dprintSetupCommands, packageManagerFor, planDprintSetup, setupDprint } from "../plugins/project-manager/project-manager-dprint"

const root = mkdtempSync(join(tmpdir(), "ocp-dprint-"))

try {
  writeFileSync(join(root, "package.json"), "{}")
  if (planDprintSetup(root).status !== "eligible") throw new Error("new Node project must offer dprint setup")
  if (packageManagerFor(root) !== "npm") throw new Error("project without a lockfile must default to npm")

  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'")
  if (packageManagerFor(root) !== "pnpm") throw new Error("pnpm lockfile must select pnpm")
  if (dprintSetupCommands("pnpm")[0]?.args.join(" ") !== "add --save-dev dprint") throw new Error("pnpm setup must add local dprint")

  const commands: string[] = []
  await setupDprint(root, async (command) => { commands.push(`${command.command} ${command.args.join(" ")}`) })
  if (commands.join(" | ") !== "pnpm add --save-dev dprint | bun x --no-install dprint init --yes") throw new Error("setup must install then initialize dprint")

  writeFileSync(join(root, ".prettierrc"), "{}")
  if (planDprintSetup(root).status !== "formatter-configured") throw new Error("existing formatter config must suppress dprint setup")
  rmSync(join(root, ".prettierrc"))
  writeFileSync(join(root, "package.json"), '{"prettier":{}}')
  if (planDprintSetup(root).status !== "formatter-configured") throw new Error("package.json formatter config must suppress dprint setup")
  console.log("Project dprint setup contract: PASS")
} finally {
  rmSync(root, { recursive: true, force: true })
}
