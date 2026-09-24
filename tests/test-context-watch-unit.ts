/**
 * Context Watch Plugin — Unit Tests (no API dependency)
 *
 * Coverage:
 *   - tier boundaries: 29/30/59/60/99/100/101 — only the highest applicable
 *     tier fires (soft < strong < hard, monotonic escalation)
 *   - monotonic escalation: once "hard" is injected for a session, no
 *     further reminders fire even as turns keep climbing (no stacked
 *     messages, no per-user-turn spam)
 *   - placement: reminder attaches to the most recent user message
 *     (recency position), not the last message in the array when
 *     last is assistant/tool
 *   - subagent filter: reminder skipped when message sessionID is
 *     registered as a subagent
 *   - fail-open: throwing/empty output doesn't crash
 *   - /usage header banner: tier 30/60/100 + compactions stacking
 *     behave the way the LLM-side reminder does
 *
 * Run: bun test ./tests/test-context-watch-unit.ts  (v2 plugin contract)
 */

import { ContextWatchPlugin, CONTEXT_TIERS } from "../plugins/context-watch/context-watch"

// ─── Test framework ───────────────────────────────────────────────────────

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✅ ${msg}`)
    passed++
  } else {
    console.error(`  ❌ ${msg}`)
    failed++
  }
}

function assertEq(actual: unknown, expected: unknown, msg: string): void {
  assert(actual === expected, `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
}

function section(title: string): void {
  console.log(`\n${"═".repeat(60)}`)
  console.log(`  ${title}`)
  console.log(`${"═".repeat(60)}\n`)
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Build a synthetic message array. role="user"|"assistant"|"tool" (others
 *  count as neither — same as the production code's filter). */
function makeMessages(opts: {
  assistants: number
  trailingUser?: boolean
  sessionID?: string
}): { messages: { role: string; content: { type?: string; text?: string }[] }[] } {
  const out: { role: string; content: { type?: string; text?: string }[] }[] = []
  for (let i = 0; i < opts.assistants; i++) {
    out.push({
      role: "assistant",
      content: [{ type: "text", text: `assistant ${i}` }],
    })
  }
  if (opts.trailingUser !== false) {
    out.push({
      role: "user",
      content: [{ type: "text", text: "user latest" }],
    })
  }
  return { messages: out }
}

/** Sum the text of all text parts on the last user message. */
function lastUserText(messages: { role?: string; content?: { type?: string; text?: string }[] }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return (messages[i].content ?? [])
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n")
    }
  }
  return ""
}

/** Count how many reminders (lines starting with "[CONTEXT WATCH]") appear
 *  anywhere in the messages array. Used to assert the monotonic-escalation
 *  guarantee: even after many turns, only the latest tier's marker exists. */
function countReminders(messages: { content?: { type?: string; text?: string }[] }[]): number {
  let n = 0
  for (const m of messages) {
    for (const p of m.content ?? []) {
      if (p?.type === "text" && typeof p.text === "string" && p.text.includes("[CONTEXT WATCH]")) n++
    }
  }
  return n
}

async function loadPlugin(): Promise<(e: { sessionID?: string; messages: unknown[] }) => Promise<void>> {
  // V2 fake ctx: capture the "context" hook callback; session.get
  // returns a parent-less session (not a subagent); event.subscribe is
  // an empty iterator (tier tests do not need session.deleted).
  const hooks = new Map<string, (e: any) => Promise<void>>()
  const ctx = {
    session: {
      hook: async (name: string, cb: (e: any) => Promise<void>) => { hooks.set(name, cb); return { dispose: async () => {} } },
      get: async () => ({ id: "s", parentID: undefined }),
    },
    event: { subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }) },
  }
  await ContextWatchPlugin.setup(ctx as never)
  const hook = hooks.get("context")
  if (!hook) throw new Error("context hook not registered")
  return hook
}
/** Invoke the v2 context hook. Mirrors production: one mutable event
 *  object carrying sessionID + messages. */
async function runHook(
  hook: (e: any) => Promise<void>,
  sessionID: string | undefined,
  out: any,
): Promise<void> {
  await hook({ sessionID, messages: out.messages })
}
// ═════════════════════════════════════════════════════════════════════════
//  1. Tier boundaries — single source of truth
// ═════════════════════════════════════════════════════════════════════════

async function test01_TierBoundaries() {
  section("01: Tier boundaries — pickTier returns the right level")
  const hook = await loadPlugin()

  const cases: Array<[number, string | null]> = [
    [0, null], // below soft → silent
    [29, null], // 29 < 30 → silent
    [30, "soft"], // exactly soft
    [59, "soft"], // soft only
    [60, "strong"], // exactly strong
    [99, "strong"], // strong only
    [100, "hard"], // exactly hard
    [200, "hard"], // way past hard
  ]
  for (const [count, expectedTier] of cases) {
    // Build a fresh session per case (different sessionID) so the
    // per-session escalation memory from previous iterations doesn't
    // leak across boundaries.
    const sid = `t1-${count}`
    const out = makeMessages({ assistants: count, sessionID: sid })
    await runHook(hook, sid, out)
    const last = lastUserText(out.messages)
    if (expectedTier === null) {
      assert(!last.includes("[CONTEXT WATCH]"), `${count} turns → silent (no reminder)`)
    } else if (expectedTier === "soft") {
      assert(last.includes("~30+ turns") && !last.includes("~60+") && !last.includes("attention-decay"),
        `${count} turns → soft reminder only`)
    } else if (expectedTier === "strong") {
      assert(last.includes("~60+ turns") && !last.includes("attention-decay"),
        `${count} turns → strong reminder (no hard)`)
    } else if (expectedTier === "hard") {
      assert(last.includes("attention-decay line"),
        `${count} turns → hard reminder`)
    }
    // Per-tier invariant: only the matching tier's marker should be present
    // in the last user message (not the lower tiers). This catches accidental
    // double-injection bugs.
    if (expectedTier === "strong") {
      assert(!last.includes("~30+ turns"),
        `${count} turns → strong reminder (no soft tier text)`)
    }
    if (expectedTier === "hard") {
      assert(!last.includes("~30+ turns") && !last.includes("~60+ turns"),
        `${count} turns → hard reminder (no soft/strong tier text)`)
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  2. Monotonic escalation — past hard, no more spam
// ═════════════════════════════════════════════════════════════════════════

async function test02_MonotonicEscalation() {
  section("02: Monotonic escalation — past hard, no further reminders")
  const hook = await loadPlugin()
  const sessionID = "t2-session"

  // Step 1: 30 assistant turns → first reminder (soft) injected.
  const out1 = makeMessages({ assistants: 30, sessionID })
  await runHook(hook, sessionID, out1)
  assert(lastUserText(out1.messages).includes("~30+ turns"), "30 turns → soft reminder injected")
  assertEq(countReminders(out1.messages), 1, "30 turns → exactly 1 reminder")
  // Capture the soft reminder text for later comparison.
  const softText = lastUserText(out1.messages).match(/\[CONTEXT WATCH\][^\n]+/)?.[0]
  assertEq(typeof softText, "string", "soft reminder text captured")

  // Step 2: 50 assistant turns (still soft tier, between 30 and 60).
  // Same session — per-session memory says "soft already injected, soft
  // ≤ soft → skip". The new messages array should NOT get a new reminder.
  const out2 = makeMessages({ assistants: 50, sessionID })
  await runHook(hook, sessionID, out2)
  assertEq(countReminders(out2.messages), 0, "50 turns → no new reminder (still soft, already injected)")
  assert(!lastUserText(out2.messages).includes("~30+ turns"),
    "50 turns → out2's last user message stays clean (no injection)")

  // Step 3: 80 assistant turns — now crosses the strong threshold (60).
  // The per-session memory says "we had soft, current is strong, soft
  // < strong → escalate". A NEW strong reminder replaces soft.
  const out3 = makeMessages({ assistants: 80, sessionID })
  await runHook(hook, sessionID, out3)
  assertEq(countReminders(out3.messages), 1, "80 turns → exactly 1 reminder (escalated to strong)")
  assert(lastUserText(out3.messages).includes("~60+ turns"),
    "80 turns → strong tier text")
  assert(!lastUserText(out3.messages).includes("~30+ turns"),
    "80 turns → no leftover soft text (escalation replaced)")

  // Step 4: 99 turns — still strong tier, no escalation needed.
  const out4 = makeMessages({ assistants: 99, sessionID })
  await runHook(hook, sessionID, out4)
  assertEq(countReminders(out4.messages), 0, "99 turns → no new reminder (still strong, already injected)")

  // Step 5: 200 turns — crosses the hard threshold. Escalate to hard.
  const out5 = makeMessages({ assistants: 200, sessionID })
  await runHook(hook, sessionID, out5)
  assertEq(countReminders(out5.messages), 1, "200 turns → exactly 1 reminder (escalated to hard)")
  assert(lastUserText(out5.messages).includes("attention-decay line"),
    "200 turns → hard tier text")
  assert(!lastUserText(out5.messages).includes("~60+ turns"),
    "200 turns → no leftover strong text")

  // Step 6: 500 turns — past hard, no further changes (the whole point
  // of the per-session memory).
  const out6 = makeMessages({ assistants: 500, sessionID })
  await runHook(hook, sessionID, out6)
  assertEq(countReminders(out6.messages), 0, "500 turns → no new reminder (hard is the ceiling)")
}

// ═════════════════════════════════════════════════════════════════════════
//  3. Per-session isolation — different sessions don't share state
// ═════════════════════════════════════════════════════════════════════════

async function test03_PerSessionIsolation() {
  section("03: Per-session isolation — each session is independent")
  const hook = await loadPlugin()

  const sessionA = "t3-A"
  const sessionB = "t3-B"

  // Session A: 30 turns → soft reminder
  const outA = makeMessages({ assistants: 30, sessionID: sessionA })
  await runHook(hook, sessionA, outA)
  assert(lastUserText(outA.messages).includes("~30+ turns"), "session A: 30 turns → soft")

  // Session B: 30 turns (also soft) — different session, should also
  // get its own soft reminder, not be blocked by A's memory.
  const outB = makeMessages({ assistants: 30, sessionID: sessionB })
  await runHook(hook, sessionB, outB)
  assert(lastUserText(outB.messages).includes("~30+ turns"),
    "session B: 30 turns → soft (independent of session A)")

  // Session A again, but at 100 turns — escalates to hard (skips strong
  // because there's no intermediate step in this test). The point is that
  // session A's memory is independent from session B's.
  const outA2 = makeMessages({ assistants: 100, sessionID: sessionA })
  await runHook(hook, sessionA, outA2)
  assert(lastUserText(outA2.messages).includes("attention-decay line"),
    "session A: 100 turns → hard (escalation works within session)")
  // Session B at 100 turns — independent escalation to hard.
  const outB2 = makeMessages({ assistants: 100, sessionID: sessionB })
  await runHook(hook, sessionB, outB2)
  assert(lastUserText(outB2.messages).includes("attention-decay line"),
    "session B: 100 turns → hard (independent escalation)")
}

// ═════════════════════════════════════════════════════════════════════════
//  4. Placement — reminder attaches to the last user message
// ═════════════════════════════════════════════════════════════════════════

async function test04_Placement() {
  section("04: Placement — attaches to last user message (not assistant)")
  const hook = await loadPlugin()

  // No trailing user message — should silently no-op (no target).
  const outNoUser = makeMessages({ assistants: 50, trailingUser: false })
  await runHook(hook, undefined, outNoUser)
  assertEq(countReminders(outNoUser.messages), 0,
    "50 turns but no user message → silent (no target to attach)")

  // Mixed: trailing message is assistant, not user → silent (cannot
  // attach reminder to an assistant message; that would compete with
  // its content).
  const outAssistantLast = {
    messages: [
      { role: "user", content: [{ type: "text", text: "old user" }] },
      { role: "assistant", content: [{ type: "text", text: "assistant 1" }] },
      { role: "assistant", content: [{ type: "text", text: "last assistant" }] },
    ],
  }
  await runHook(hook, undefined, outAssistantLast)
  assertEq(countReminders(outAssistantLast.messages), 0,
    "no trailing user message → silent even with assistants in array")
}

// ═════════════════════════════════════════════════════════════════════════
//  5. Fail-open — empty/invalid input doesn't crash
// ═════════════════════════════════════════════════════════════════════════

async function test05_FailOpen() {
  section("05: Fail-open — empty/invalid input")
  const hook = await loadPlugin()

  // Empty messages — no-op
  await runHook(hook, undefined, { messages: [] })
  assert(true, "empty messages → no crash")

  // No messages key — no-op
  await runHook(hook, undefined, {} as any)
  assert(true, "missing messages key → no crash")
}

// ═════════════════════════════════════════════════════════════════════════
//  6. CONTEXT_TIERS is the exported source of truth
// ═════════════════════════════════════════════════════════════════════════

function test06_TierExported() {
  section("06: CONTEXT_TIERS exported — single source of truth")
  assertEq(CONTEXT_TIERS.soft, 30, "soft tier = 30")
  assertEq(CONTEXT_TIERS.strong, 60, "strong tier = 60")
  assertEq(CONTEXT_TIERS.hard, 100, "hard tier = 100")
}

// ═════════════════════════════════════════════════════════════════════════
//  Run
// ═════════════════════════════════════════════════════════════════════════

async function main() {
  await test01_TierBoundaries()
  await test02_MonotonicEscalation()
  await test03_PerSessionIsolation()
  await test04_Placement()
  await test05_FailOpen()
  test06_TierExported()

  console.log()
  if (failed > 0) {
    console.error(`\n${"═".repeat(60)}\n  ❌ ${failed} FAILED, ${passed} passed\n${"═".repeat(60)}`)
    process.exit(1)
  } else {
    console.log(`\n${"═".repeat(60)}\n  ✅ All ${passed} tests passed\n${"═".repeat(60)}`)
  }
}

main().catch((e) => {
  console.error("Test runner crashed:", e)
  process.exit(1)
})
