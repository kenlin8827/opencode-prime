/**
 * Profile Wizard Reset — Unit Tests (no host dependency)
 *
 * Coverage:
 *   - listModelRefs: read-only listing of root model, small_model and
 *     per-agent model refs
 *   - stripModelRefs: removes exactly those fields, keeps everything else
 *   - parseProfileSubcommand: ctx shapes (data.args / payload / input),
 *     leading command-name tokens skipped, case-insensitive
 *   - /profile reset end-to-end via a mock v2 plugin Context: confirm
 *     dialog gate, config rewrite without model refs, .bak backup,
 *     .active-profile removed, location reload, success toast
 *   - unknown subcommand → usage warning toast; no arg → main menu
 *
 * Run: bun run tests/test-profile-reset-unit.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// Redirect homedir BEFORE importing the plugin: CONFIG_DIR is computed at
// module load from os.homedir(), which reads USERPROFILE (win) / HOME (posix).
const repoRoot = join(fileURLToPath(import.meta.url), "..", "..")
const fakeHome = mkdtempSync(join(repoRoot, "tests", ".tmp-profile-reset-"))
process.env.USERPROFILE = fakeHome
process.env.HOME = fakeHome

const {
  listModelRefs,
  stripModelRefs,
  parseProfileSubcommand,
  default: plugin,
} = await import("../plugins/tui/profile-wizard")

const CONFIG_DIR = join(fakeHome, ".config", "opencode")
const CONFIG_FILE = join(CONFIG_DIR, "opencode.jsonc")
const STATE_FILE = join(CONFIG_DIR, ".active-profile")

let passed = 0
let failed = 0

function assert(cond: unknown, label: string) {
  if (cond) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.error(`  ❌ ${label}`)
  }
}

function section(title: string) {
  console.log(`\n${"═".repeat(60)}\n  ${title}\n${"═".repeat(60)}`)
}

// ─── 01: listModelRefs (read-only) ─────────────────────────────────────────

section("01: listModelRefs — read-only listing")

{
  const refs = listModelRefs({
    model: "anthropic/claude-sonnet-5",
    small_model: "anthropic/claude-haiku-4-5",
    agent: {
      build: { model: "anthropic/claude-sonnet-5", prompt: "{file:x}" },
      code: { model: "anthropic/claude-opus-5" },
      explore: {},
    },
  } as never)
  assert(refs.length === 4, `lists 4 refs (got ${refs.length})`)
  assert(refs[0] === "model → anthropic/claude-sonnet-5", "root model listed first")
  assert(refs[1] === "small_model → anthropic/claude-haiku-4-5", "small_model listed")
  assert(refs.includes("agent.build → anthropic/claude-sonnet-5"), "agent.build listed")
  assert(!refs.some((r: string) => r.includes("explore")), "agents without a model are skipped")
}

{
  const refs = listModelRefs({ agent: {} } as never)
  assert(refs.length === 0, "empty config → no refs")
}

// ─── 01b: listModelRefs on a v2-native config ─────────────────────────────

{
  const refs = listModelRefs({
    model: "anthropic/claude-sonnet-5",
    agents: {
      build: { model: "anthropic/claude-sonnet-5#high", system: "S" },
      title: { model: "anthropic/claude-haiku-4-5" },
      explore: {},
    },
  } as never)
  assert(refs.length === 3, `native config lists 3 refs (got ${refs.length})`)
  assert(refs[0] === "model → anthropic/claude-sonnet-5", "native: root model listed first")
  assert(refs.includes("agents.build → anthropic/claude-sonnet-5#high"), "native: agents.build listed with #variant ref")
  assert(refs.includes("agents.title → anthropic/claude-haiku-4-5"), "native: agents.title (small slot) listed")
}

// ─── 02b: stripModelRefs on a v2-native config ────────────────────────────

{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config: any = {
    model: "p/m1",
    small_model: "p/m0",
    agents: {
      build: { model: "p/m1", system: "S" },
      title: { model: "p/m0" },
      explore: {},
    },
    provider: { p: { models: { m1: {} } } },
  }
  const removed = stripModelRefs(config)
  assert(removed === 4, `native+residual removed count is 4 (got ${removed})`)
  assert(!("model" in config), "native: root model removed")
  assert(!("small_model" in config), "native: residual small_model removed")
  assert(!("model" in config.agents.build), "native: agents.build.model removed")
  assert(!("model" in config.agents.title), "native: agents.title.model removed")
  assert(config.agents.build.system === "S", "native: agents.build.system kept")
  assert(!!config.provider.p, "native: provider section untouched")
}

// ─── 02: stripModelRefs (mutating) ─────────────────────────────────────────

section("02: stripModelRefs — exact field removal")

{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config: any = {
    model: "p/m1",
    small_model: "p/m0",
    agent: {
      build: { model: "p/m1", prompt: "{file:x}" },
      code: { model: "p/m2", mode: "primary" },
      explore: {},
    },
    provider: { p: { models: { m1: {} } } },
  }
  const removed = stripModelRefs(config)
  assert(removed === 4, `removed count is 4 (got ${removed})`)
  assert(!("model" in config), "root model removed")
  assert(!("small_model" in config), "small_model removed")
  assert(!("model" in config.agent.build), "agent.build.model removed")
  assert(config.agent.build.prompt === "{file:x}", "agent.build.prompt kept")
  assert(config.agent.code.mode === "primary", "agent.code.mode kept")
  assert(!!config.provider.p, "provider section untouched")
}

// ─── 03: parseProfileSubcommand ────────────────────────────────────────────

section("03: parseProfileSubcommand — ctx shapes")

{
  assert(parseProfileSubcommand({ input: "profile.switch reset" }) === "reset", "input with command name prefix")
  assert(parseProfileSubcommand({ data: { args: "/profile reset" } }) === "reset", "data.args with slash form")
  assert(parseProfileSubcommand({ payload: "profile RESET" }) === "reset", "payload, case-insensitive")
  assert(parseProfileSubcommand({ input: "profile.switch" }) === null, "no subcommand → null")
  assert(parseProfileSubcommand({ input: "profile.switch banana" }) === "banana", "unknown arg passed through")
  assert(parseProfileSubcommand(null) === null, "null ctx → null")
  assert(parseProfileSubcommand(undefined) === null, "undefined ctx → null")
}

// ─── 04: /profile reset end-to-end (mock TUI host) ─────────────────────────

section("04: /profile reset — end-to-end via mock host")

mkdirSync(CONFIG_DIR, { recursive: true })
const SAMPLE_CONFIG = `{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-5",
  "small_model": "anthropic/claude-haiku-4-5",
  "agent": {
    "build": { "prompt": "{file:~/.config/opencode/prompts/build.md}", "model": "anthropic/claude-sonnet-5" },
    "code": { "mode": "primary", "model": "anthropic/claude-opus-5" },
    "explore": {}
  },
  "provider": {}
}`
writeFileSync(CONFIG_FILE, SAMPLE_CONFIG, "utf-8")
writeFileSync(STATE_FILE, "anthropic", "utf-8")

const toasts: { title?: string; message?: string; variant?: string }[] = []
const confirmProps: { title: string; message: string }[] = []
const confirmAnswers: boolean[] = []
const selectProps: { title: string }[] = []
let reloads = 0

type Command = { id?: string; slash?: { name: string }; run: (input?: string) => unknown }
const registeredCommands: Command[] = []

const fakeCtx = {
  keymap: {
    layer: (input: () => { commands?: Command[] }) => {
      registeredCommands.push(...(input().commands ?? []))
    },
  },
  ui: {
    toast: { show: (t: { title?: string; message?: string; variant?: string }) => { toasts.push(t) } },
    dialog: {
      confirm: async (o: { title: string; message: string }) => {
        confirmProps.push(o)
        return confirmAnswers.length ? confirmAnswers.shift() : true
      },
      select: async (o: { title: string }) => {
        selectProps.push(o)
        return undefined // Esc — wizard loops terminate cleanly
      },
      alert: async () => {},
      prompt: async () => undefined,
      show: () => {},
      clear: () => {},
      set: () => {},
    },
  },
  client: {
    location: { reload: async () => { reloads++ } },
  },
} as never

await plugin.setup(fakeCtx)
// Deterministic English dialog copy regardless of the host locale env.
const { setLocale } = await import("../plugins/tui/i18n")
setLocale("en")

const cmd = registeredCommands.find((c) => c.slash?.name === "profile")
assert(!!cmd, "slash command 'profile' registered")

// resetModels is async fire-and-forget from the command — flush the
// promise chain before asserting.
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)) }

// 4a. reset opens a confirm dialog listing the refs (answer: cancel)
confirmAnswers.push(false)
cmd!.run("profile.switch reset")
await flush()
assert(confirmProps.length === 1, "confirm dialog opened")
assert(confirmProps[0]?.message.includes("model → anthropic/claude-sonnet-5"), "confirm message lists root model")
assert(confirmProps[0]?.message.includes("agent.code → anthropic/claude-opus-5"), "confirm message lists agent model")
assert(confirmProps[0]?.message.includes("tiers.json"), "confirm message states tiers.json is kept")

// 4b. cancel leaves everything untouched
assert(JSON.parse(readFileSync(CONFIG_FILE, "utf-8")).model === "anthropic/claude-sonnet-5", "cancel: config untouched")
assert(existsSync(STATE_FILE), "cancel: .active-profile kept")

// 4c. confirm performs the reset
confirmAnswers.push(true)
cmd!.run("profile.switch reset")
await flush()
const after = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Record<string, unknown>
assert(!("model" in after), "reset: root model removed from file")
assert(!("small_model" in after), "reset: small_model removed from file")
const afterAgent = after.agent as Record<string, { model?: string; prompt?: string; mode?: string }>
assert(!afterAgent.build.model && afterAgent.build.prompt !== undefined, "reset: agent.build model removed, prompt kept")
assert(!afterAgent.code.model && afterAgent.code.mode === "primary", "reset: agent.code model removed, mode kept")
assert(existsSync(CONFIG_FILE + ".bak"), "reset: .bak backup kept")
assert(!existsSync(STATE_FILE), "reset: .active-profile removed")
assert(reloads > 0, "reset: location reload requested (live refresh)")
assert(toasts.some((t) => t.variant === "success" && /4/.test(t.message ?? "")), "reset: success toast reports 4 refs")

// 4d. nothing left to reset → info toast, no confirm dialog
const confirmCount = confirmProps.length
cmd!.run("profile.switch reset")
await flush()
assert(confirmProps.length === confirmCount, "nothing-to-reset: no confirm dialog")
assert(toasts.some((t) => t.variant === "info" && /nothing to reset|无需重置/i.test(t.message ?? "")), "nothing-to-reset: info toast (locale-agnostic)")

// 4e. unknown subcommand → usage warning, no dialog
const selectCount = selectProps.length
cmd!.run("profile.switch banana")
await flush()
assert(toasts.some((t) => t.variant === "warning" && (t.message ?? "").includes("banana")), "unknown sub: warning toast")
assert(selectProps.length === selectCount, "unknown sub: no dialog opened")

// 4f. bare /profile still opens the main menu
cmd!.run("profile.switch")
await flush()
assert(selectProps.length > selectCount, "bare /profile opens the main menu")

// 4g. v2-native config end-to-end: agents.* + title slot stripped in place
{
  writeFileSync(
    CONFIG_FILE,
    `{
  "model": "anthropic/claude-sonnet-5",
  "agents": {
    "build": { "system": "S", "model": "anthropic/claude-sonnet-5#high" },
    "title": { "model": "anthropic/claude-haiku-4-5" },
    "explore": {}
  }
}`,
    "utf-8",
  )
  writeFileSync(STATE_FILE, "anthropic", "utf-8")
  confirmAnswers.push(true)
  cmd!.run("profile.switch reset")
  await flush()
  const afterNative = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Record<string, any>
  assert(!("model" in afterNative), "native reset: root model removed from file")
  assert("agents" in afterNative && !("model" in afterNative.agents.build), "native reset: agents.build.model removed, section kept")
  assert(afterNative.agents.build.system === "S", "native reset: agents.build.system kept")
  assert(!("model" in afterNative.agents.title), "native reset: agents.title slot removed")
  assert(!existsSync(STATE_FILE), "native reset: .active-profile removed")
  assert(toasts.some((t) => t.variant === "success" && /3/.test(t.message ?? "")), "native reset: success toast reports 3 refs")
}

// ─── Cleanup + summary ─────────────────────────────────────────────────────

rmSync(fakeHome, { recursive: true, force: true })

console.log(`\n${"═".repeat(60)}`)
console.log(`  Profile reset unit tests: ${passed} passed, ${failed} failed`)
console.log(`${"═".repeat(60)}`)
if (failed > 0) process.exit(1)
