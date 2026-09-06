import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { formatterNameFor } from "../plugins/auto-format"

const root = join(tmpdir(), `ocp-auto-format-${Date.now()}`)

try {
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true })
  writeFileSync(join(root, "dprint.json"), "{}")
  writeFileSync(join(root, "biome.json"), "{}")
  writeFileSync(join(root, ".prettierrc"), "{}")
  writeFileSync(join(root, "node_modules", ".bin", "dprint.cmd"), "")
  writeFileSync(join(root, "node_modules", ".bin", "biome.cmd"), "")

  if (formatterNameFor("src/app.ts", root) !== "dprint") {
    throw new Error("dprint must win over Biome when both project configs and local binaries exist")
  }

  rmSync(join(root, "dprint.json"))
  writeFileSync(join(root, ".dprint.jsonc"), "{}")
  if (formatterNameFor("src/app.ts", root) !== "dprint") {
    throw new Error("dprint must recognize its hidden project configuration")
  }

  rmSync(join(root, "node_modules", ".bin", "dprint.cmd"))
  if (formatterNameFor("src/app.ts", root) !== "biome") {
    throw new Error("Biome must be selected when dprint lacks its project-local binary")
  }

  rmSync(join(root, "node_modules", ".bin", "biome.cmd"))
  if (formatterNameFor("src/app.ts", root) !== "prettier") {
    throw new Error("Biome must not activate without its project-local binary")
  }

  console.log("Auto-format dprint, Biome, and Prettier selection: PASS")
} finally {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
}
