import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { AutoFormatPlugin, filePathFromEvent, formatterNameFor } from "../plugins/auto-format"

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

  if (filePathFromEvent({ path: "src/app.ts" }) !== "src/app.ts") {
    throw new Error("file-object event payloads must yield their path")
  }
  if (filePathFromEvent({}) !== null || filePathFromEvent(42) !== null) {
    throw new Error("non-path event payloads must be ignored")
  }

  // End-to-end: invoke the registered event hook with the object-shaped payload
  // reported by OpenCode, then verify that it runs the real gofmt executable.
  const formatRoot = join(root, "gofmt-project")
  mkdirSync(formatRoot)
  writeFileSync(join(formatRoot, "go.mod"), "module example.com/autoformat\n\ngo 1.22\n")
  const goFile = join(formatRoot, "main.go")
  writeFileSync(goFile, "package main\nfunc main(){println(\"formatted\")}\n")
  const logs: unknown[] = []
  const plugin = await AutoFormatPlugin({
    directory: formatRoot,
    client: { app: { log: async (entry: unknown) => { logs.push(entry) } } },
  } as any)
  await plugin.event!({ event: { type: "file.edited", properties: { file: { path: goFile } } } } as any)
  const formatted = readFileSync(goFile, "utf8")
  if (!formatted.includes("func main() { println(\"formatted\") }")) {
    throw new Error(`file-object event payload must run gofmt on the extracted path; got ${JSON.stringify(formatted)}`)
  }
  if (logs.length !== 1) throw new Error("successful formatting must produce one log entry")

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
