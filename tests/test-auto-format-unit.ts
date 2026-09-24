import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import autoFormat from "../plugins/auto-format"

const root = join(tmpdir(), `ocp-auto-format-${Date.now()}`)
const realDebug = console.debug
const realWarn = console.warn

try {
  mkdirSync(root, { recursive: true })
  // Drive the v2 shape: default { id, setup } with a fake ctx whose
  // event.subscribe yields one `filesystem.changed` event (the v2
  // replacement for v1's file.edited), then poll for real formatting.
  const formatRoot = join(root, "gofmt-project")
  mkdirSync(formatRoot)
  writeFileSync(join(formatRoot, "go.mod"), "module example.com/autoformat\n\ngo 1.22\n")
  const goFile = join(formatRoot, "main.go")
  writeFileSync(goFile, "package main\nfunc main(){println(\"formatted\")}\n")

  const events = [{ type: "filesystem.changed", data: { file: goFile, event: "change" } }]
  console.debug = () => {}
  console.warn = () => {}
  const cleanup = await autoFormat.setup({
    location: { directory: formatRoot },
    event: {
      subscribe: async function* ({ signal }: { signal?: AbortSignal }) {
        for (const event of events) {
          if (signal?.aborted) return
          yield event
        }
        // Keep the stream open like the real transport until aborted.
        await new Promise((resolve) => {
          const timer = setInterval(() => { if (signal?.aborted) { clearInterval(timer); resolve(null) } }, 50)
        })
      },
    },
  })

  // The subscription processes events out-of-band; poll the file (max ~10s).
  let formatted = ""
  for (let i = 0; i < 100; i++) {
    formatted = readFileSync(goFile, "utf8")
    if (formatted.includes("func main() {")) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await cleanup?.()
  if (!formatted.includes("func main() { println(\"formatted\") }")) {
    throw new Error(`filesystem.changed event must run gofmt on data.file; got ${JSON.stringify(formatted)}`)
  }
  console.log("Auto-format v2 event subscription: PASS")
} finally {
  console.debug = realDebug
  console.warn = realWarn
  if (existsSync(root)) rmSync(root, { recursive: true, force: true })
}
