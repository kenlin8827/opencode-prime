/**
 * Queue Manager Plugin — Unit Tests (no API dependency)
 *
 * Validates the pure queue-computation helpers of plugins/tui/queue-manager.ts
 * against the v2 session-inbox model:
 *   - queue definition: pending USER inbox items only (synthetic /
 *     compaction / move rows are internal work, never queue entries)
 *   - preview/age formatting, delivery passthrough, attachment counting
 *
 * Run: bun tests/test-queue-manager-unit.ts   (or: bun test ./tests/test-queue-manager-unit.ts)
 */

import { computeQueued, preview, age } from "../plugins/tui/queue-manager"
import type { SessionInboxInfo } from "@opencode/client"

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

function section(title: string): void {
  console.log(`\n${"═".repeat(60)}`)
  console.log(`  ${title}`)
  console.log(`${"═".repeat(60)}`)
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

let seq = 0
function nextId(prefix: string): string {
  seq++
  return `${prefix}_${String(seq).padStart(4, "0")}`
}

function userItem(created: number, text: string, delivery: "steer" | "queue" = "queue", files = 0): SessionInboxInfo {
  return {
    id: nextId("inbox"),
    sessionID: "ses_test",
    type: "user",
    time: { created },
    delivery,
    payload: {
      text,
      ...(files > 0 ? { files: Array.from({ length: files }, () => ({ uri: "file:///x.png", name: "x.png" })) } : {}),
    },
  }
}

function syntheticItem(created: number): SessionInboxInfo {
  return {
    id: nextId("inbox"),
    sessionID: "ses_test",
    type: "synthetic",
    time: { created },
    delivery: "queue",
    payload: { text: "plugin feedback" },
  } as SessionInboxInfo
}

function compactionItem(created: number): SessionInboxInfo {
  return {
    id: nextId("inbox"),
    sessionID: "ses_test",
    type: "compaction",
    time: { created },
    delivery: "queue",
    payload: {},
  } as SessionInboxInfo
}

// ═════════════════════════════════════════════════════════════════════════
//  1. Queue definition: pending user items only
// ═════════════════════════════════════════════════════════════════════════

function test01_QueueDefinition() {
  section("01: queue = user inbox items only")

  const t = Date.now()
  const items: SessionInboxInfo[] = [
    userItem(t - 10_000, "while you were busy…"),
    syntheticItem(t - 9_000),
    compactionItem(t - 8_000),
  ]

  const result = computeQueued(items)
  assert(result.length === 1, "exactly one queued item")
  assert(result[0].text === "while you were busy…", "text extracted from payload")
}

function test03_SortedByCreatedAscending() {
  section("03: queue sorted oldest → newest")

  const t = Date.now()
  const q2 = userItem(t - 5_000, "second")
  const q1 = userItem(t - 30_000, "first")
  const q3 = userItem(t - 1_000, "third")

  const result = computeQueued([q2, q1, q3])
  assert(result.length === 3, "three queued items")
  assert(
    result[0].text === "first" && result[1].text === "second" && result[2].text === "third",
    "sorted by time.created ascending",
  )
}

function test04_DeliveryAndAttachments() {
  section("04: delivery mode passthrough and attachment counts")

  const t = Date.now()
  const result = computeQueued([
    userItem(t - 10_000, "steered", "steer", 2),
    userItem(t - 9_000, "plain", "queue"),
  ])
  assert(result[0].delivery === "steer", "steer delivery kept")
  assert(result[0].attachments === 2, "attachments counted from payload.files")
  assert(result[1].delivery === "queue", "queue delivery kept")
  assert(result[1].attachments === 0, "no attachments → 0")
}

// ═════════════════════════════════════════════════════════════════════════
//  6. Formatting helpers
// ═════════════════════════════════════════════════════════════════════════

function test06_Preview() {
  section("06: preview truncation and attachment-only fallback")

  assert(preview("hello\n\nworld") === "hello world", "whitespace flattened")
  const long = "x".repeat(200)
  const p = preview(long, 90)
  assert(p.length === 90 && p.endsWith("…"), "truncated to max with ellipsis")
  assert(preview("") === "[attachment only — no text]", "empty text fallback")
}

function test07_Age() {
  section("07: age formatting")

  const now = 1_000_000_000_000
  assert(age(now - 5_000, now) === "5s ago", "seconds")
  assert(age(now - 120_000, now) === "2m ago", "minutes")
  assert(age(now - 3 * 3_600_000, now) === "3h ago", "hours")
  assert(age(now + 10_000, now) === "0s ago", "future timestamps clamped to 0s")
}

// ─── Run ──────────────────────────────────────────────────────────────────

test01_QueueDefinition()
test03_SortedByCreatedAscending()
test04_DeliveryAndAttachments()
test06_Preview()
test07_Age()

console.log(`\n${"═".repeat(60)}`)
console.log(`  Result: ${passed} passed, ${failed} failed`)
console.log(`${"═".repeat(60)}`)
if (failed > 0) process.exit(1)
