import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseTgrepOptions, stripJsonc, tgrepIndexArgs, tgrepOptionsFrom } from "../plugins/tgrep/tgrep-config"
import { tgrepPolicyFingerprint } from "../plugins/tgrep/tgrep-state"
import { acquireLeaseLock } from "../plugins/tgrep/tgrep-service"
import { buildTgrepSearchArgs, resolveSearchPath, searchTgrep } from "../plugins/tgrep/tgrep-search"
import { loadTgrepOptions } from "../plugins/tgrep/tgrep-config"
import { TgrepPlugin } from "../plugins/tgrep"

let failed = 0
function assert(ok: boolean, message: string) { console.log(`${ok ? "✅" : "❌"} ${message}`); if (!ok) failed++ }
function throws(fn: () => unknown) { try { fn(); return false } catch { return true } }

const root = mkdtempSync(join(tmpdir(), "tgrep-unit-"))
mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "a.ts"), "x")
assert(tgrepOptionsFrom(root, '{"tools":{"tgrep":true}}').enabled === true, "explicit tools.tgrep enables integration")
assert(tgrepOptionsFrom(root, '{"tools":{"tgrep":false}}').enabled === false, "false disables integration")
assert(tgrepOptionsFrom(root, '{/* c */"tools":{ "tgrep": { "enabled": true, }, }, } // tail').enabled === true, "inline comments, block comments and trailing commas parse")
assert(stripJsonc('{"url":"http://x/*ok*/"}') === '{"url":"http://x/*ok*/"}', "comment-like content inside strings survives")
const options = parseTgrepOptions(root, { enabled: true, indexPath: ".cache/tgrep", maxFileSize: "64M", exclude: ["vendor"], noRequireGit: true })
assert(tgrepIndexArgs(options).join(" ") === "--index-path .cache/tgrep --max-filesize 64M --exclude vendor --no-require-git", "stable index arguments (real tgrep flag names)")
assert(throws(() => parseTgrepOptions(root, { enabled: true, maxFileSize: "64MiB" })), "rejects MiB suffix (real CLI only accepts K/M/G)")
assert(tgrepPolicyFingerprint({ ...options, exclude: ["vendor", "build"] }) === tgrepPolicyFingerprint({ ...options, exclude: ["build", "vendor"] }), "policy fingerprint normalizes exclude order")
assert(throws(() => parseTgrepOptions(root, { enabled: true, indexPath: "../outside" })), "rejects escaping index path")
assert(throws(() => parseTgrepOptions(root, { enabled: true, exclude: [""] })), "rejects empty exclusion")
const args = buildTgrepSearchArgs(root, { pattern: 'a "quoted" -- value', path: "src", flags: ["-F"], freshness: "current" })
assert(args[0] === "--no-index" && args.includes("--") && args.includes('a "quoted" -- value'), "pattern remains a single argv argument")
const globArgs = buildTgrepSearchArgs(root, { pattern: "x", glob: ["*.ts", "src/**"] })
assert(globArgs.filter((arg) => arg === "-g").length === 2 && globArgs.includes("*.ts") && globArgs.includes("src/**") && globArgs.indexOf("-g", 0) < globArgs.indexOf("--"), "glob filters travel as -g value pairs before --")
assert(throws(() => buildTgrepSearchArgs(root, { pattern: "x", glob: ["-evil"] })), "rejects glob that looks like a flag")
assert(throws(() => buildTgrepSearchArgs(root, { pattern: "x", flags: ["-g"] })), "rejects valueless -g flag")
assert(throws(() => resolveSearchPath(root, "../outside")), "rejects lexical path escape")
if (process.platform !== "win32") {
  const outside = mkdtempSync(join(tmpdir(), "tgrep-outside-")); symlinkSync(outside, join(root, "escape"))
  assert(throws(() => resolveSearchPath(root, "escape")), "rejects symlink path escape")
  rmSync(outside, { recursive: true, force: true })
}
if (process.platform === "win32") {
  assert(throws(() => resolveSearchPath(root, "\\\\localhost\\c$")), "rejects UNC path escape")
}
const unavailable = searchTgrep(root, { pattern: "definitely-no-result", freshness: "indexed" }, "unavailable")
assert(unavailable.backend === "fallback", "unready indexed search transparently falls back to rg")
assert(unavailable.status === "no-matches", "rg exit code 1 maps to no matches")

// Stale lease lock recovery: a dead owner (pid 0 is never valid) is cleared;
// a live owner (this process) keeps holding it.
const lockRoot = mkdtempSync(join(tmpdir(), "tgrep-lock-"))
mkdirSync(join(lockRoot, ".tgrep"))
const lockOptions = { enabled: true }
writeFileSync(join(lockRoot, ".tgrep", ".ocp-tgrep-serve.lock"), '{"pid":0}\n', "utf8")
assert(acquireLeaseLock(lockRoot, lockOptions) !== null, "stale lease lock with dead owner is cleared and re-acquired")
writeFileSync(join(lockRoot, ".tgrep", ".ocp-tgrep-serve.lock"), `{"pid":${process.pid}}\n`, "utf8")
assert(acquireLeaseLock(lockRoot, lockOptions) === null, "live owner keeps the lease lock")
rmSync(lockRoot, { recursive: true, force: true })

// Default-on gate: registration must equal (switch enabled AND CLI on PATH),
// whichever way the local machine is configured.
const cliOnPath = spawnSync("tgrep", ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true }).status === 0
const switchOn = loadTgrepOptions(root).enabled
const hooks = await TgrepPlugin({ directory: root }) as { tool?: { tgrep_search?: unknown } }
assert(!!hooks?.tool?.tgrep_search === (switchOn && cliOnPath), "tool registration gates on switch AND CLI presence")

rmSync(root, { recursive: true, force: true })
if (failed) process.exit(1)
