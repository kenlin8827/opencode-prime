/** Deterministic ADR-compaction fixture model for the v2 runtime tests.
 *
 * Why not v1's global step counter: every `handled` plugin command injects
 * its reply through session.synthetic, and the v2 host WAKES the model for
 * synthetic input unless resume:false is passed (core/src/session.ts:311).
 * injectReply currently does not (product parity gap vs v1 noReply), so
 * background "handled" commands interleave extra model turns. The driver
 * therefore keys each next action off the conversation itself — turn starts
 * off the latest user text, continuations off the last assistant tool call
 * plus its result — making stray synthetic wakes inert (unknown kickoff →
 * plain text answer, no tools, no side effects).
 */

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => c?.text ?? "").join("") : ""

export type FixtureAction = { kind: "final"; text: string } | { kind: "tool"; name: string; args: unknown }

type ChatMessage = { role: string; content?: unknown; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }

/** The native v2 skill tool takes {id} (v1 took {name}). */
const SKILL_CALL: FixtureAction = { kind: "tool", name: "skill", args: { id: "adr-compaction" } }

/** Classify the next assistant action for one chat-completions request. */
export function adrFixtureNextTurn(messages: ChatMessage[], ctx: {
  /** Serialized candidate content builder (stage payloads). */
  record: (id: string, status: string) => string
  /** Load the plan JSON by id from the project state dir. */
  plan: (id: string) => any
  /** Extra final-text override for the guard conversation. */
  archivedPath: string
}): FixtureAction {
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user")
  const lastToolIdx = messages.map((m) => m.role).lastIndexOf("tool")
  const users = messages.filter((m) => m.role === "user").map((m) => textOf(m.content))
  // The NEWEST user message carrying a plan id wins: after `archive restore`
  // is dispatched on the same session, the history holds two plan ids and the
  // flow must drive the restore plan, not the completed consolidate one.
  const planId = [...users].reverse().map((u) => /cp-[0-9a-f]{16}/.exec(u)?.[0]).find((id): id is string => id !== undefined)
  if (lastUserIdx >= lastToolIdx) {
    const prompt = textOf(messages[Math.max(lastUserIdx, 0)]?.content)
    if (/Read the archived original/.test(prompt)) return { kind: "tool", name: "read", args: { path: ctx.archivedPath } }
    if (/Review ADR maintenance/.test(prompt) && planId) return { kind: "tool", name: "adr_compaction", args: { plan: planId, action: "ask" } }
    if (/Load the adr-compaction skill/.test(prompt) && planId) return SKILL_CALL
    // Unknown kickoff: a synthetic wake of a handled command (analysis text,
    // status, confirm receipt…). Answer inertly — no tools, no side effects.
    return { kind: "final", text: "Acknowledged; no further action." }
  }
  const called = messages.filter((m) => m.role === "assistant" && m.tool_calls?.length).at(-1)?.tool_calls?.[0]?.function?.name
  const result = textOf(messages[lastToolIdx]?.content)
  if (called === "skill") {
    // Success or load failure — the drafting flow continues either way; the
    // transcript assertion separately pins that native loading worked.
    if (planId) return { kind: "tool", name: "adr_compaction", args: { plan: planId, action: "ask" } }
    return { kind: "final", text: "No plan referenced; nothing to do." }
  }
  if (called === "question" && planId) {
    // Locale-safe routing: the review Ask only ever follows evidence
    // ingestion, while the cost Ask (header literal is English in the plugin,
    // receipts and questions are i18n) is answered BEFORE any evidence call.
    const toolResults = messages.filter((m) => m.role === "tool").map((m) => textOf(m.content))
    const assistantCalls = messages.filter((m) => m.role === "assistant" && m.tool_calls?.length).flatMap((m) => m.tool_calls!.map((c) => c.function?.arguments ?? ""))
    const evidenceDone = assistantCalls.some((a) => /"action":"evidence"/.test(a))
    const sawBudget = toolResults.some((t) => t.includes("ADR drafting cost"))
    if (!evidenceDone && sawBudget) return { kind: "tool", name: "adr_compaction", args: { plan: planId, action: "evidence" } }
    return { kind: "final", text: "The maintenance receipt stands; done." }
  }
  if (called === "adr_compaction" && planId) {
    let parsed: any
    try { parsed = JSON.parse(result) } catch { return { kind: "final", text: "Read the actual maintenance receipt for results." } }
    const header = Array.isArray(parsed?.questions) ? parsed.questions[0]?.header : undefined
    if (header === "ADR drafting cost" || header === "ADR review") return { kind: "tool", name: "question", args: { questions: parsed.questions } }
    if (Array.isArray(parsed?.entries)) {
      const slotId = ctx.plan(planId).slots[0].id
      return { kind: "tool", name: "adr_compaction", args: { plan: planId, action: "stage", batch: "decisions", candidate: {
        summary: [{ text: "Use explicit boundaries. Validate calls.", sources: [slotId] }],
        replacements: [{ id: slotId, title: "Consolidated boundaries", content: ctx.record(slotId, "proposed") }],
        coverage: [],
      } } }
    }
    if (/Batch saved locally/.test(parsed?.instructions ?? "")) {
      if (parsed.batches === 1) return { kind: "tool", name: "adr_compaction", args: { plan: planId, action: "stage", batch: "coverage", candidate: { summary: [], replacements: [], coverage: [{ source: "ADR-0001", disposition: "replace", targets: [ctx.plan(planId).slots[0].id], note: "Preserved constraint without semantic change." }] } } }
      return { kind: "tool", name: "adr_compaction", args: { plan: planId, action: "submit" } }
    }
  }
  return { kind: "final", text: "Read the actual maintenance receipt for results." }
}

/** True when the conversation belongs to a measured ADR flow (drafting,
 * restore, or the read-guard probe); synthetic wakes of handled commands on
 * OTHER sessions must not count toward the main turn budget. */
export function isMainFlowConversation(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.role === "user" && /Load the adr-compaction skill|Review ADR maintenance|Read the archived original/.test(textOf(m.content)))
}
