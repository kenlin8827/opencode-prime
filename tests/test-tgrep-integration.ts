/**
 * Opt-in real CLI smoke test. It never downloads tgrep: set OCP_TGREP_BIN to
 * an already installed, fixed-version executable to enable it.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
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
try {
  mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "sample.txt"), "known literal\n", "utf8")
  assert(run(["--version"]).status === 0, "tgrep --version succeeds")
  assert(run(["index", "."]).status === 0, "tgrep index succeeds")
  const status = run(["status", "."])
  assert(status.status === 0, "tgrep status succeeds")
  const indexed = run(["-F", "--", "known literal", "."])
  assert(indexed.status === 0 && indexed.stdout.includes("sample.txt"), "indexed literal search finds file")
  writeFileSync(join(root, "src", "sample.txt"), "just-written literal\n", "utf8")
  const current = run(["--no-index", "-F", "--", "just-written literal", "."])
  assert(current.status === 0 && current.stdout.includes("sample.txt"), "no-index search sees just-written text")
} finally { rmSync(root, { recursive: true, force: true }) }
if (failures) process.exit(1)
