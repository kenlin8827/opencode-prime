/**
 * ocp-config — Unit Tests (no host dependency)
 *
 * The shared user config (~/.config/opencode/ocp.jsonc) is one JSONC file
 * that all ocp plugins use for cross-session user preferences (currently:
 * TUI language). This suite covers the storage layer and the i18n wiring.
 *
 * Coverage:
 *   - ocpConfigPath: OCP_CONFIG_PATH override
 *   - parseJsonc: // and block comments, trailing commas, "//" inside strings
 *   - read/write roundtrip: unknown keys preserved, parent dirs created,
 *     corrupt/missing file → {} (fail-open)
 *   - i18n: file value wins at init; setLocale persists to the file
 *
 * Run: bun run tests/test-ocp-config-unit.ts
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let passed = 0
let failed = 0

function assert(cond: unknown, label: string) {
  if (cond) {
    passed++
  } else {
    failed++
    console.error(`  ✗ FAIL: ${label}`)
  }
}

function assertEq(actual: unknown, expected: unknown, label: string) {
  assert(actual === expected, `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
}

// ─── Isolated config path for the whole run ─────────────────────────────────

const sandbox = mkdtempSync(join(tmpdir(), "ocp-config-test-"))
const configPath = join(sandbox, "nested", "ocp.jsonc")
process.env.OCP_CONFIG_PATH = configPath

const { ocpConfigPath, parseJsonc, readOcpConfig, readOcpField, writeOcpField } = await import("../plugins/shared/ocp-config")

// --- ocpConfigPath override ---
assertEq(ocpConfigPath(), configPath, "OCP_CONFIG_PATH overrides the default location")

// --- missing file → fail-open {} ---
assertEq(Object.keys(readOcpConfig()).length, 0, "missing file → empty config object")

// parseJsonc: comments, trailing commas, strings that contain "//"
const parsed = parseJsonc(`
{
  // line comment
  "a": "http://keep-me", /* block
     comment */
  "b": ["x", "y",],
  "nested": { "c": 1, },
}`)
assertEq(parsed.a, "http://keep-me", '"//" inside a string survives comment stripping')
assert(Array.isArray(parsed.b) && (parsed.b as string[]).length === 2, "trailing comma in array tolerated")
assertEq((parsed.nested as Record<string, unknown>).c, 1, "nested keys parsed")
assertEq(Object.keys(parseJsonc("not json at all {{{")).length, 0, "unparseable text → empty object, not a throw")

// write → read roundtrip, unknown keys preserved, dirs auto-created
assert(writeOcpField("language", "zh-CN"), "first write succeeds (creates nested dir)")
assert(existsSync(configPath), "config file created at OCP_CONFIG_PATH")
assertEq(readOcpField("language"), "zh-CN", "field roundtrip")
assert(writeOcpField("queue.toastDurationMs", 15000), "second write succeeds")
assertEq(readOcpField("language"), "zh-CN", "first key preserved across second write")
assertEq(readOcpField("queue.toastDurationMs"), 15000, "second key stored")
const raw = readFileSync(configPath, "utf8")
assert(raw.trimStart().startsWith("//"), "generated header comment present")

// corrupt file → {} instead of a crash
writeFileSync(configPath, "{ broken !!!")
assertEq(readOcpField("language"), undefined, "corrupt file fails open as undefined")

// missing file again
rmSync(configPath)
assert(!existsSync(configPath), "cleanup: file removed")
assertEq(readOcpField("language"), undefined, "missing file → undefined field")

// ─── i18n wiring ────────────────────────────────────────────────────────────

const { setLocale, getLocale, initI18n } = await import("../plugins/tui/i18n")
const { formatI18n, getPreferredLocaleCode, setPreferredLocaleCode } = await import("../install/src/i18n")

// initI18n is a per-process singleton, so seed the file BEFORE first init:
// the file value must win over both kv and env detection.
writeOcpField("language", "en")
const kvStore = new Map([["opencode.locale", "zh-CN"]])
const fakeApi = { kv: { get: (k: string) => kvStore.get(k), set: (k: string, v: unknown) => kvStore.set(k, v) } } as any
initI18n(fakeApi)
assertEq(getLocale(), "en", "file value wins over legacy kv and env detection")

// setLocale persists to the shared file (and keeps memory in sync)
mkdirSync(join(sandbox, "nested"), { recursive: true })
setLocale(fakeApi, "zh-CN")
assertEq(getLocale(), "zh-CN", "setLocale updates in-memory locale")
assertEq(readOcpField("language"), "zh-CN", "setLocale persists to ocp.jsonc")

// The installer UI and shell output share the same persisted preference.
assertEq(getPreferredLocaleCode(), "zh-CN", "installer locale reads the shared language preference")
setPreferredLocaleCode("en")
assertEq(readOcpField("language"), "en", "installer language switch persists to ocp.jsonc")
assertEq(formatI18n("Installed {count} files to {target}", { count: 2, target: "/tmp/ocp" }), "Installed 2 files to /tmp/ocp", "installer message placeholders are interpolated")

// ─── cleanup ────────────────────────────────────────────────────────────────

rmSync(sandbox, { recursive: true, force: true })
delete process.env.OCP_CONFIG_PATH

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
