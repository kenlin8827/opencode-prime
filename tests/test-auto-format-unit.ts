import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { AutoFormatPlugin } from "../plugins/auto-format"

const root = join(tmpdir(), `ocp-auto-format-${Date.now()}`)

try {
  mkdirSync(root, { recursive: true })
  // Invoke the public plugin entry point and its registered event hook with the
  // object-shaped payload reported by OpenCode, then verify real formatting.
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
  console.log("Auto-format public event hook: PASS")
} finally {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
}
