/**
 * Opt-in real CLI smoke test. It never downloads tgrep: set OCP_TGREP_BIN to
 * an already installed, fixed-version executable to enable it.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

const bin = process.env.OCP_TGREP_BIN
if (!bin) {
  console.log("SKIP: set OCP_TGREP_BIN to run real tgrep integration tests")
  process.exit(0)
}
const root = mkdtempSync(join(tmpdir(), "ocp-tgrep-integration-"))
let failures = 0
function run(args: string[]) { return spawnSync(bin, args, { cwd: root, encoding: "utf8", timeout: 30_000, windowsHide: true }) }
function assert(ok: boolean, message: string) { console.log(`${ok ? "✅" : "❌"} ${message}`); if (!ok) failures++ }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let server: ChildProcess | undefined
try {
  mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "sample.txt"), "known literal\n", "utf8")
  assert(run(["--version"]).status === 0, "tgrep --version succeeds")
  assert(run(["index", "."]).status === 0, "tgrep index succeeds")
  const diskStatus = run(["status", "."])
  // Without a server, status reports the on-disk index and no "Indexing:" line
  // (verified against tgrep 1.0.5) — OCP's readiness parser maps this to
  // "disk-index" and the sidebar badge renders it as "NO WATCHER".
  assert(diskStatus.status === 0 && /Server:\s*not running/i.test(diskStatus.stdout), "status without server reports the disk index")

  // OCP's readiness parser keys on the SERVER status wording; a format change
  // must fail loudly here instead of silently degrading every search to rg.
  server = spawn(bin, ["serve", "."], { cwd: root, stdio: "ignore", windowsHide: true })
  let sawComplete = false
  for (let attempt = 0; attempt < 40 && !sawComplete; attempt += 1) {
    const status = run(["status", "."])
    sawComplete = /Indexing:\s*complete/i.test(`${status.stdout}\n${status.stderr}`)
    if (!sawComplete) await sleep(250)
  }
  assert(sawComplete, "server status reports 'Indexing: complete' (OCP parser contract)")

  const indexed = run(["-F", "--", "known literal", "."])
  assert(indexed.status === 0 && indexed.stdout.includes("sample.txt"), "indexed literal search finds file")
  writeFileSync(join(root, "src", "sample.txt"), "just-written literal\n", "utf8")
  const current = run(["--no-index", "-F", "--", "just-written literal", "."])
  assert(current.status === 0 && current.stdout.includes("sample.txt"), "no-index search sees just-written text")
  // OCP always passes these policy arguments when tools.tgrep is configured
  // with policy fields; the real CLI must accept them on index and status.
  const policyArgs = ["--index-path", ".tgrep-policy", "--max-filesize", "1M", "--exclude", "vendor", "--no-require-git"]
  assert(run(["index", ".", ...policyArgs]).status === 0, "tgrep index accepts OCP policy arguments")
  assert(run(["status", ".", "--index-path", ".tgrep-policy", "--max-filesize", "1M", "--no-require-git"]).status === 0, "tgrep status accepts OCP policy arguments (minus --exclude, which status rejects)")
} finally {
  try { server?.kill() } catch { /* best effort */ }
  rmSync(root, { recursive: true, force: true })
}
if (failures) process.exit(1)
