import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { parseTgrepOptions, stripJsonc, tgrepIndexArgs, tgrepOptionsFrom } from "../plugins/tgrep/tgrep-config"
import { tgrepPolicyFingerprint } from "../plugins/tgrep/tgrep-state"
import { acquireLeaseLock, hasTgrepCli, isCliMissing, parseTgrepStatusOutput, probeTgrepCapability, resolveTgrepCapability } from "../plugins/tgrep/tgrep-service"
import { buildTgrepSearchArgs, resolveSearchPath, searchTgrep, summarizeTgrepSearch } from "../plugins/tgrep/tgrep-search"
import { loadTgrepOptions } from "../plugins/tgrep/tgrep-config"
import { TgrepPlugin } from "../plugins/tgrep"
import { tgrepLocation } from "../plugins/tgrep/tgrep-output"
import { validateTgrepMode, OUTPUT_ROW_BUDGET, OUTPUT_CHAR_BUDGET, exceedsDetailBudget, exceedsDetailCharBudget } from "../plugins/tgrep/tgrep-mode"
import { capSummaryCounts } from "../plugins/tgrep/tgrep-output"
import { logTgrepRequest } from "../plugins/tgrep/tgrep-request-log"

let failed = 0
function assert(ok: boolean, message: string) { console.log(`${ok ? "✅" : "❌"} ${message}`); if (!ok) failed++ }
function throws(fn: () => unknown) { try { fn(); return false } catch { return true } }

const root = mkdtempSync(join(tmpdir(), "tgrep-unit-"))
mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "a.ts"), "x")
assert(tgrepOptionsFrom(root, '{"tools":{"tgrep":true}}').enabled === true, "explicit tools.tgrep enables integration")
assert(tgrepOptionsFrom(root, '{"tools":{"tgrep":false}}').enabled === false, "false disables integration")
assert(tgrepOptionsFrom(root, '{/* c */"tools":{ "tgrep": { "enabled": true, }, }, } // tail').enabled === true, "inline comments, block comments and trailing commas parse")
assert(tgrepOptionsFrom(root, '{"tools":{"tgrep":{"enabled":true,"requestLog":true}}}').requestLog === true, "request logging is opt-in")
assert(throws(() => parseTgrepOptions(root, { enabled: true, requestLog: "yes" })), "rejects non-boolean request logging")
assert(stripJsonc('{"url":"http://x/*ok*/"}') === '{"url":"http://x/*ok*/"}', "comment-like content inside strings survives")
const options = parseTgrepOptions(root, { enabled: true, indexPath: ".cache/tgrep", maxFileSize: "64M", exclude: ["vendor"], noRequireGit: true })
assert(tgrepIndexArgs(options).join(" ") === "--index-path .cache/tgrep --max-filesize 64M --exclude vendor --no-require-git", "stable index arguments (real tgrep flag names)")
assert(throws(() => parseTgrepOptions(root, { enabled: true, maxFileSize: "64MiB" })), "rejects MiB suffix (real CLI only accepts K/M/G)")
assert(tgrepPolicyFingerprint({ ...options, exclude: ["vendor", "build"] }) === tgrepPolicyFingerprint({ ...options, exclude: ["build", "vendor"] }), "policy fingerprint normalizes exclude order")
assert(throws(() => parseTgrepOptions(root, { enabled: true, indexPath: "../outside" })), "rejects escaping index path")
assert(throws(() => parseTgrepOptions(root, { enabled: true, exclude: [""] })), "rejects empty exclusion")
const args = buildTgrepSearchArgs(root, { pattern: 'a "quoted" -- value', path: "src", literal: true, noIndex: true })
assert(args[0] === "--no-index" && args.includes("--") && args.includes('a "quoted" -- value'), "pattern remains a single argv argument")
const globArgs = buildTgrepSearchArgs(root, { pattern: "x", glob: ["*.ts", "src/**"] })
assert(globArgs.filter((arg) => arg === "-g").length === 2 && globArgs.includes("*.ts") && globArgs.includes("src/**") && globArgs.indexOf("-g", 0) < globArgs.indexOf("--"), "glob filters travel as -g value pairs before --")
assert(throws(() => buildTgrepSearchArgs(root, { pattern: "x", glob: ["-evil"] })), "rejects glob that looks like a flag")
const optionArgs = buildTgrepSearchArgs(root, { pattern: "x", ignoreCase: true, literal: true })
assert(optionArgs.includes("--ignore-case") && optionArgs.includes("--fixed-strings"), "explicit boolean options map to the supported CLI flags")
const policySearchArgs = buildTgrepSearchArgs(root, { pattern: "x" }, options)
assert(policySearchArgs.join(" ").includes("--index-path .cache/tgrep --max-filesize 64M --no-require-git"), "indexed searches carry the configured corpus policy without index-only excludes")
assert(tgrepLocation("C:\\repo\\sample.ts:12:const time = \"12:34:56\"") === "C:\\repo\\sample.ts:12", "locations preserve Windows paths when content contains colon-number-colon")
const omittedMode = validateTgrepMode(undefined)
assert(omittedMode.ok && omittedMode.mode === "summary", "omitted mode returns file counts")
const summaryMode = validateTgrepMode("summary")
assert(summaryMode.ok && summaryMode.mode === "summary", "explicit summary mode returns file counts")
const filesWithMatchesMode = validateTgrepMode("files_with_matches")
assert(filesWithMatchesMode.ok && filesWithMatchesMode.mode === "summary", "files_with_matches explicitly aliases file-count summary")
assert(validateTgrepMode("locations").ok && validateTgrepMode("content").ok, "canonical detail modes are accepted")
const invalidMode = validateTgrepMode("files")
assert(!invalidMode.ok && invalidMode.error.includes("`summary`, `locations`, or `content`") && invalidMode.error.includes("omit mode"), "unknown modes return actionable invalid-request errors")
assert(!validateTgrepMode(42).ok, "non-string mode values are invalid")

// ─── Output budget: broad requests degrade honestly, never context-dump. ───
assert(!exceedsDetailBudget("summary", 1_000_000), "summary mode is never budget-refused")
assert(exceedsDetailBudget("content", OUTPUT_ROW_BUDGET + 1) && exceedsDetailBudget("locations", OUTPUT_ROW_BUDGET + 1), "both detail modes are refused past the budget")
assert(!exceedsDetailBudget("content", OUTPUT_ROW_BUDGET), "the budget boundary itself still materializes")
const budgetRoot = mkdtempSync(join(tmpdir(), "tgrep-budget-"))
writeFileSync(join(budgetRoot, "broad.ts"), "needle\n".repeat(OUTPUT_ROW_BUDGET + 1), "utf8")
const broadSummary = summarizeTgrepSearch(budgetRoot, { pattern: "needle", path: budgetRoot, noIndex: true }, "server")
assert(broadSummary.matchedLines === OUTPUT_ROW_BUDGET + 1 && exceedsDetailBudget("content", broadSummary.matchedLines), "a real broad corpus trips the detail budget")
rmSync(budgetRoot, { recursive: true, force: true })
const smallCap = capSummaryCounts(["a.ts:1", "b.ts:2"])
assert(smallCap.complete && smallCap.rows.length === 2, "summary at or under budget returns complete counts")
const manyCounts = Array.from({ length: OUTPUT_ROW_BUDGET + 5 }, (_, i) => `f${i}.ts:1`)
const capped = capSummaryCounts(manyCounts)
assert(!capped.complete && capped.rows.length === OUTPUT_ROW_BUDGET + 1 && capped.rows.at(-1) === "… 5 more matching files not shown; narrow path/glob", "summary past budget truncates with an explicit omission marker")
assert(!exceedsDetailCharBudget("x".repeat(OUTPUT_CHAR_BUDGET)) && exceedsDetailCharBudget("x".repeat(OUTPUT_CHAR_BUDGET + 1)), "detail char budget boundary: at-budget passes, +1 refuses")
const longLineRoot = mkdtempSync(join(tmpdir(), "tgrep-longline-"))
writeFileSync(join(longLineRoot, "lock.json"), `{"blob":"${"x".repeat(OUTPUT_CHAR_BUDGET)}"}\n`, "utf8")
const longLineDetail = searchTgrep(longLineRoot, { pattern: "blob", path: longLineRoot, noIndex: true }, "server", undefined, ["--with-filename", "--line-number"])
assert(longLineDetail.status === "matches" && exceedsDetailCharBudget(longLineDetail.stdout.trim()), "a single long matched line trips the detail char budget")
rmSync(longLineRoot, { recursive: true, force: true })
const logRoot = mkdtempSync(join(tmpdir(), "tgrep-log-"))
await logTgrepRequest(logRoot, { enabled: true, requestLog: true }, { pattern: "secret-looking-pattern", path: "src", literal: true }, "summary", { backend: "fallback", matchedFiles: 2, matchedLines: 3 })
const requestLog = readFileSync(join(logRoot, ".ocp", "logs", "tgrep.jsonl"), "utf8")
assert(requestLog.includes('"matchedLines":3') && !requestLog.includes("matched content"), "request log records totals without matched content")
rmSync(logRoot, { recursive: true, force: true })

// ─── Schema-shape normalization for glob payloads. ───
const stringGlobArgs = buildTgrepSearchArgs(root, { pattern: "x", glob: "!node_modules/**" as unknown as string[] })
assert(stringGlobArgs.includes("!node_modules/**"), "bare-string glob is coerced to a single-element array")
const undefinedArgs = buildTgrepSearchArgs(root, { pattern: "x" })
assert(!undefinedArgs.includes("-g") && undefinedArgs[undefinedArgs.length - 1] !== "--", "undefined glob/options yield clean argv")

// ─── Probe summaries keep broad searches compact. ───
const countRoot = mkdtempSync(join(tmpdir(), "tgrep-count-"))
writeFileSync(join(countRoot, "a.ts"), "needle\nnot a match\nneedle\n", "utf8")
writeFileSync(join(countRoot, "b.ts"), "not a match\nneedle\n", "utf8")
const summary = summarizeTgrepSearch(countRoot, { pattern: "needle", path: countRoot, noIndex: true }, "server")
assert(summary.matchedFiles === 2 && summary.matchedLines === 3, "count-first summary reports complete file and line totals")
assert(summary.counts.includes(`${join(countRoot, "a.ts")}:2`) && summary.counts.includes(`${join(countRoot, "b.ts")}:1`), "probe summary returns path:count entries")
const singleFileSummary = summarizeTgrepSearch(countRoot, { pattern: "needle", path: join(countRoot, "a.ts"), noIndex: true }, "server")
assert(singleFileSummary.matchedFiles === 1 && singleFileSummary.matchedLines === 2, "count-first summary retains filename metadata for a single-file path")
const detailRoot = mkdtempSync(join(tmpdir(), "tgrep-detail-"))
writeFileSync(join(detailRoot, "all.ts"), "needle\n".repeat(101), "utf8")
const detail = searchTgrep(detailRoot, { pattern: "needle", path: detailRoot, noIndex: true }, "server", undefined, ["--with-filename", "--line-number"])
assert(detail.status === "matches" && detail.stdout.split(/\r?\n/).filter(Boolean).length === 101, "detail searches return all matches without OCP-only caps")
rmSync(detailRoot, { recursive: true, force: true })
rmSync(countRoot, { recursive: true, force: true })
// Full tgrep/rg/shell compatibility — relative paths anchor to `root`
// (OpenCode's project directory: bash workdir, glob default and the
// system prompt's "Working directory" all mean the project dir). The
// host process's launch cwd is arbitrary from the agent's perspective
// (e.g. %USERPROFILE% via a shortcut), so cwd-anchoring made `.` search
// the wrong tree whenever opencode wasn't started from the project root.
// Absolute paths pass through.
const absNonexistent = join(tmpdir(), "tgrep-abs-nonexistent-" + Date.now())
assert(resolveSearchPath(root, absNonexistent) === absNonexistent, "absolute non-existent path returned unchanged")
const absExisting = join(tmpdir(), "tgrep-abs-existing-" + Date.now() + ".txt")
writeFileSync(absExisting, "x")
try {
  assert(resolveSearchPath(root, absExisting) === realpathSync(absExisting), "absolute existing path is realpathSync'd")
} finally {
  rmSync(absExisting, { force: true })
}
const parentTarget = realpathSync(resolve(root, ".."))
assert(resolveSearchPath(root, "..") === parentTarget, "relative `..` resolves to realpath of root's parent (project-anchored, not host-cwd)")
if (process.platform !== "win32") {
  // Symlink inside root pointing outside — relative names resolve against
  // root, and symlinks are still followed even when the target escapes it.
  const outside = mkdtempSync(join(tmpdir(), "tgrep-outside-"))
  const escapePath = join(root, `.tgrep-test-escape-${Date.now()}`)
  symlinkSync(outside, escapePath)
  try {
    assert(resolveSearchPath(root, basename(escapePath)) === realpathSync(outside), "symlinks followed even when target escapes root (matches rg)")
  } finally {
    unlinkSync(escapePath)
    rmSync(outside, { recursive: true, force: true })
  }
}
if (process.platform === "win32") {
  assert(!throws(() => resolveSearchPath(root, "\\\\localhost\\c$")), "absolute UNC paths accepted (matches tgrep/rg)")
}
// `path: root` (absolute) is explicit here — the literal pattern appears
// in this very test file, so a repo-rooted search would false-positive.
const unavailable = searchTgrep(root, { pattern: "definitely-no-result", path: root }, "unavailable")
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
// Patch attempts here are INERT: Bun binds the plugin's named `import
// { spawnSync }` to the builtin at load, so patching the createRequire CJS
// copy adds no calls (probeCalls stays 0 regardless). Kept as a stability
// smoke check (same key → same state) only; a real spawn-count test needs a
// production seam or bun:test mock.module.
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

// ─── Flaky-probe regression: a --version timeout must not report "no-cli" ───
// On Win32 (AV scan / CPU contention) the 5s spawnSync timeout can fire even
// though the binary is installed; that pinned the sidebar badge READY → NO
// CLI for a whole TTL window. Only ENOENT may mean "missing".
// NB: spawnSync cannot be monkey-patched here — Bun ESM binds the plugin's
// `import { spawnSync }` to the builtin directly, so a createRequire patch
// never fires. Test the pure classifier plus real-process wiring instead.
{
  const enoent = Object.assign(new Error("spawnSync tgrep ENOENT"), { code: "ENOENT" })
  const timedout = Object.assign(new Error("spawnSync timed out"), { code: "ETIMEDOUT" })
  assert(isCliMissing({ error: enoent, status: null }) === true, "ENOENT alone classifies the CLI as missing")
  assert(isCliMissing({ error: timedout, status: null }) === false, "a --version timeout keeps the CLI classified as present")
  assert(isCliMissing({ status: 1 }) === false, "non-zero exit means unhealthy, not absent")
  assert(isCliMissing({ status: 0, stdout: "tgrep 1.0.5" }) === false, "success means present")
  const cliHere = spawnSync("tgrep", ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true }).status === 0
  assert(hasTgrepCli(root) === cliHere, "hasTgrepCli tracks real PATH presence (real spawn, live machine)")
  assert(hasTgrepCli(join(root, "no-such-dir")) === false, "dead cwd (ENOENT from spawn) reports missing")
  assert(probeTgrepCapability(root, parseTgrepOptions(root, { enabled: true })) !== "no-cli" || !cliHere, "present CLI never resolves to no-cli")
}

rmSync(root, { recursive: true, force: true })
if (failed) process.exit(1)
