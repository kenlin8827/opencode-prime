import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseTgrepOptions, tgrepEnabledFrom, tgrepIndexArgs } from "../plugins/tgrep/tgrep-config"
import { buildTgrepSearchArgs, resolveSearchPath, searchTgrep } from "../plugins/tgrep/tgrep-search"

let failed = 0
function assert(ok: boolean, message: string) { console.log(`${ok ? "✅" : "❌"} ${message}`); if (!ok) failed++ }
function throws(fn: () => unknown) { try { fn(); return false } catch { return true } }

const root = mkdtempSync(join(tmpdir(), "tgrep-unit-"))
mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "a.ts"), "x")
assert(tgrepEnabledFrom('{"tools":{"tgrep":true}}'), "explicit tools.tgrep enables integration")
assert(!tgrepEnabledFrom('{"tools":{"tgrep":false}}'), "false disables integration")
const options = parseTgrepOptions(root, { enabled: true, indexPath: ".cache/tgrep", maxFileSize: "64MiB", exclude: ["vendor"], noRequireGit: true })
assert(tgrepIndexArgs(options).join(" ") === "--index-path .cache/tgrep --max-file-size 64MiB --exclude vendor --no-require-git", "stable index arguments")
assert(throws(() => parseTgrepOptions(root, { enabled: true, indexPath: "../outside" })), "rejects escaping index path")
assert(throws(() => parseTgrepOptions(root, { enabled: true, exclude: [""] })), "rejects empty exclusion")
const args = buildTgrepSearchArgs(root, { pattern: 'a "quoted" -- value', path: "src", flags: ["-F"], freshness: "current" })
assert(args[0] === "--no-index" && args.includes("--") && args.includes('a "quoted" -- value'), "pattern remains a single argv argument")
assert(throws(() => resolveSearchPath(root, "../outside")), "rejects lexical path escape")
const unavailable = searchTgrep(root, { pattern: "definitely-no-result", freshness: "indexed" }, "unavailable")
assert(unavailable.backend === "fallback", "unready indexed search transparently falls back to rg")
if (process.platform !== "win32") {
  const outside = mkdtempSync(join(tmpdir(), "tgrep-outside-")); symlinkSync(outside, join(root, "escape"))
  assert(throws(() => resolveSearchPath(root, "escape")), "rejects symlink path escape")
  rmSync(outside, { recursive: true, force: true })
}
rmSync(root, { recursive: true, force: true })
if (failed) process.exit(1)
