/**
 * Context Watch — long-session reminder system for all main agents
 * (@lite, @build, @code, @plan, @advisor, …).
 *
 * Why: every step of a long session ships the full conversation history
 * to the LLM. Past ~60 turns the model starts to lose attention to the
 * earliest instructions, and the server-side cache.read grows linearly
 * with session age. The recommended move is to wrap up the current task
 * and open a fresh session with a recap bridge — but the user is busy and
 * often doesn't notice. This plugin:
 *
 *   1. Tracks the highest tier already injected per session (WeakMap keyed
 *      by session id). Tier escalation is monotonic: once "hard" is
 *      injected, no further reminders fire for that session.
 *   2. At three thresholds (30 / 60 / 100 turns) injects a one-line
 *      reminder into the LATEST user message — recency position has the
 *      highest attention weight, and the reminder naturally rides along
 *      on the next LLM call rather than paying a separate system-prompt
 *      token. Past the hard threshold only the strongest reminder fires
 *      (no stacked messages).
 *   3. Lets the LLM suggest the handoff in its own words — we don't fire
 *      toast/warning at the user from this hook because (a) toasts during
 *      a chat are intrusive and (b) the user already gets the `/usage`
 *      header banner for a clearer picture when they look.
 *
 * Idempotency: WeakMap on session id (not message object) because the
 * "tier already injected" check is per-session, not per-message. A second
 * WeakSet on the message object keeps the transform itself single-shot per
 * turn in case opencode fires it more than once.
 *
 * Scope: fires for every session that the opencode host reports as a
 * top-level session. Subagent sessions are filtered out via session.created
 * event tracking (parentID !== null) — subagent contexts are isolated and
 * ephemeral, the user wouldn't see their banners anyway and the LLM in a
 * subagent has no power to suggest the user open a new main session.
 *
 * Plugin hooks must NEVER crash the session — failures degrade to
 * "no injection".
 */

import type { Plugin } from "@opencode-ai/plugin"

// Tier thresholds — single source of truth, also imported by /usage's
// header banner (`renderContextWarning`). Keep in sync: any change here
// must be reflected in `plugins/tui/usage.ts:CONTEXT_WARN_TIERS`.
export const CONTEXT_TIERS = { soft: 30, strong: 60, hard: 100 } as const
type Tier = keyof typeof CONTEXT_TIERS

const MARKER = "[CONTEXT WATCH]"

const REMINDERS: Record<Tier, string> = {
  soft: `${MARKER} 💡 ~${CONTEXT_TIERS.soft}+ turns — early context may already be losing weight. Offer the user a recap before the next task if it helps, but don't push.`,
  strong: `${MARKER} ⚠️ ~${CONTEXT_TIERS.strong}+ turns — context is heavy. Recommend wrapping up the current task and opening a fresh session with a recap bridge.`,
  hard: `${MARKER} 🚨 Past the attention-decay line at ${CONTEXT_TIERS.hard} turns. Strongly recommend the user opens a new session NOW with a brief recap — old instructions may already be forgotten.`,
}

// Per-session escalation state: tracks the highest tier already injected
// for each session, keyed by sessionID. Plain Map (not WeakMap) —
// sessionIDs are string handles, not object references, so we can't
// weak-key them; and the set is bounded by the number of live sessions
// the host has open at any one moment, which is tiny (single digits).
// On session end the opencode host issues `session.deleted` and we drop
// the entry via the listener registered below.
const lastInjectedBySession = new Map<string, Tier>()
// Subagent filter: session IDs whose parentID is set are subagents, not
// main sessions. We track them via session.created so the transform hook
// can early-return without an extra API call.
const subagentSessionIds = new Set<string>()

/** Pick the highest applicable tier (monotonic — past HARD only HARD fires). */
function pickTier(count: number): Tier | null {
  if (count >= CONTEXT_TIERS.hard) return "hard"
  if (count >= CONTEXT_TIERS.strong) return "strong"
  if (count >= CONTEXT_TIERS.soft) return "soft"
  return null
}

/** Tier rank for comparison: hard > strong > soft. */
const TIER_RANK: Record<Tier, number> = { soft: 1, strong: 2, hard: 3 }
function tierGte(a: Tier, b: Tier): boolean { return TIER_RANK[a] >= TIER_RANK[b] }

export const ContextWatchPlugin: Plugin = async () => {
  return {
    // Filter out subagent sessions at the transform site — they're isolated
    // ephemeral contexts whose reminder would never reach the user anyway.
    event: async ({ event }) => {
      if (event.type !== "session.created") return
      const { id, parentID } = event.properties.info
      if (parentID) subagentSessionIds.add(id)
    },
    "experimental.chat.messages.transform": async (
      input: { sessionID?: string } | undefined,
      output: { messages: { info: { role?: string }; parts: unknown[] }[] },
    ) => {
      try {
        const sessionID = input?.sessionID
        if (!sessionID) return
        // Subagent filter: the session.created listener (above) tracks
        // subagent session IDs; if this one matches, bail out.
        if (subagentSessionIds.has(sessionID)) return

        const msgs = output.messages
        if (!Array.isArray(msgs) || msgs.length === 0) return

        // Count only assistant messages — proxy for "conversation length"
        // and matches the /usage header banner metric so the two stay in sync.
        let assistantCount = 0
        for (const m of msgs) if (m.info?.role === "assistant") assistantCount++
        const tier = pickTier(assistantCount)
        if (!tier) return

        // Monotonic escalation: skip if we've already injected a tier at
        // least as strong. This is the per-session memory that fixes the
        // "every user turn gets a fresh reminder" bug.
        const previous = lastInjectedBySession.get(sessionID)
        if (previous && tierGte(previous, tier)) return
        lastInjectedBySession.set(sessionID, tier)

        // Find the most recent user message — that's where reminders carry
        // the most attention weight (system prompts decay; user-message
        // tail dominates the recency position).
        let target: { info: { role?: string }; parts: unknown[] } | undefined
        for (let i = msgs.length - 1; i >= 0; i--) {
          const message = msgs[i]
          if (!message || message.info?.role !== "user") continue
          target = message
          break
        }
        if (target === undefined) return

        target.parts.push({ type: "text", text: `\n\n${REMINDERS[tier]}` })
      } catch {
        // Never crash the session — degrade to no reminder.
      }
    },
  }
}
