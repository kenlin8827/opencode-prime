import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseTgrepOptions, stripJsonc, tgrepIndexArgs, tgrepOptionsFrom } from "../plugins/tgrep/tgrep-config"
import { tgrepPolicyFingerprint } from "../plugins/tgrep/tgrep-state"
import { acquireLeaseLock, parseTgrepStatusOutput, resolveTgrepCapability } from "../plugins/tgrep/tgrep-service"
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

// ─── Schema-shape normalization (LLM middleboxes occasionally send bare
// strings instead of arrays; the execute boundary must not crash). ───
const stringFlagArgs = buildTgrepSearchArgs(root, { pattern: "x", flags: "--ignore-case" as unknown as string[] })
assert(stringFlagArgs.includes("--ignore-case"), "bare-string flags is coerced to a single-element array")
const stringGlobArgs = buildTgrepSearchArgs(root, { pattern: "x", glob: "!node_modules/**" as unknown as string[] })
assert(stringGlobArgs.includes("!node_modules/**"), "bare-string glob is coerced to a single-element array")
const nullFlagArgs = buildTgrepSearchArgs(root, { pattern: "x", flags: null as unknown as string[] })
assert(!nullFlagArgs.some((arg) => arg.startsWith("-i")) || nullFlagArgs.includes("-i"), "null flags does not throw (treated as no flags)")
const undefinedArgs = buildTgrepSearchArgs(root, { pattern: "x" })
assert(!undefinedArgs.includes("-g") && undefinedArgs[undefinedArgs.length - 1] !== "--", "undefined flags/glob yields clean argv")
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

// ─── Parser: tgrep 1.0.5 status emits `Watcher:` (not `Server:`) ───
// Before this fix the parser only looked for `Server:`, missed the
// real field name, and the sidebar falsely reported NO WATCHER even
// when a watcher was running. These two cases pin the behaviour:
// `active` → not disk-index (watcher is up); `not running` → disk-index.
const parserRoot = mkdtempSync(join(tmpdir(), "tgrep-parser-"))
const parserOptions = parseTgrepOptions(parserRoot, { enabled: true })
const liveOutput = [
  "Server status for D:\\repo",
  "  PID:        25748",
  "  Port:       58591",
  "  Watcher:    active",
  "  Watch mode: native",
  "  Indexing:   complete",
].join("\n")
const watcherUp = parseTgrepStatusOutput(liveOutput, parserRoot, parserOptions, true)
assert(watcherUp !== "disk-index" && watcherUp !== "unavailable",
  "Watcher: active classifies as a live watcher (was disk-index before fix)")
assert(watcherUp === "server" || watcherUp === "stale",
  "Watcher: active returns server or stale — never disk-index")
const downOutput = liveOutput.replace(/  Watcher:\s*active/, "  Watcher:    not running")
assert(parseTgrepStatusOutput(downOutput, parserRoot, parserOptions, true) === "disk-index",
  "Watcher: not running classifies as disk-index")
rmSync(parserRoot, { recursive: true, force: true })

// ─── TTL cache: resolveTgrepCapability must not probe the CLI on every call ───
// The sidebar ticks every 2s and the profiler runs per chat turn — an
// uncached resolver spawns `tgrep --version` + `tgrep status` on each call.
// Patch the shared spawnSync export to count probes (works because the
// plugin reads it off the CJS module object at call time); a second
// identical call must add zero spawns.
{
  // ESM namespace is readonly — patch via the mutable CJS exports object
  // (the plugin's named import resolves off it at call time).
  const cp = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process")
  const orig = cp.spawnSync
  let probeCalls = 0
  cp.spawnSync = ((...args: unknown[]) => {
    probeCalls += 1
    return (orig as (...a: unknown[]) => unknown).apply(cp, args)
  }) as typeof orig
  try {
    const cacheRoot = mkdtempSync(join(tmpdir(), "tgrep-cache-"))
    const cacheOpts = parseTgrepOptions(cacheRoot, { enabled: true })
    const first = resolveTgrepCapability(cacheRoot, cacheOpts)
    const probesAfterFirst = probeCalls
    const second = resolveTgrepCapability(cacheRoot, cacheOpts)
    assert(second === first, "TTL cache returns the same capability state")
    assert(probeCalls === probesAfterFirst, "second resolveTgrepCapability call hits the TTL cache (0 new probes)")
    rmSync(cacheRoot, { recursive: true, force: true })
  } finally {
    cp.spawnSync = orig
  }
}

rmSync(root, { recursive: true, force: true })
if (failed) process.exit(1)
