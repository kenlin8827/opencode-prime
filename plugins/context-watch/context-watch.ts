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
 *   1. Tracks the highest tier already injected per session (Map keyed by
 *      session id). Tier escalation is monotonic: once "hard" is injected,
 *      no further reminders fire for that session.
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
 * V2 MAPPING NOTE (v1 → v2):
 *   v1 `experimental.chat.messages.transform(input{sessionID}, output{messages})`
 *   → v2 `ctx.session.hook("context")`: same sessionID + mutable `e.messages`.
 *   v1's `event` hook tracking subagent ids off `session.created` → v2
 *   resolves parentID ground truth lazily through `ctx.session.get`
 *   (shared/agent-scope.isSubagentSession — cached, fail-open), and keeps
 *   a `session.deleted` subscription via `ctx.event.subscribe` purely to
 *   drop per-session tier state (the v1 code leaked it; the Map is
 *   session-keyed so it must be pruned).
 *
 * Plugin hooks must NEVER crash the session — failures degrade to
 * "no injection".
 */

import { Plugin } from "@opencode/plugin"
import { forgetSession, isSubagentSession, type V2Session } from "../shared/agent-scope"

// Tier thresholds — single source of truth, also imported by /usage's
// header banner (`renderContextWarning`). Keep in sync: any change here
// must be reflected in `plugins/tui/usage/tui.ts:CONTEXT_WARN_TIERS`.
export const CONTEXT_TIERS = { soft: 30, strong: 60, hard: 100 } as const
type Tier = keyof typeof CONTEXT_TIERS

const MARKER = "[CONTEXT WATCH]"

const REMINDERS: Record<Tier, string> = {
  soft: `${MARKER} 💡 ~${CONTEXT_TIERS.soft}+ turns — early context may already be losing weight. Offer the user a recap before the next task if it helps, but don't push.`,
  strong: `${MARKER} ⚠️ ~${CONTEXT_TIERS.strong}+ turns — context is heavy. Recommend wrapping up the current task and opening a fresh session with a recap bridge.`,
  hard: `${MARKER} 🚨 Past the attention-decay line at ${CONTEXT_TIERS.hard} turns. Strongly recommend the user opens a new session NOW with a brief recap — old instructions may already be forgotten.`,
}

// Per-session escalation state: tracks the highest tier already injected
// for each session, keyed by sessionID. Plain Map — sessionIDs are string
// handles, not object references, so we can't weak-key them; the `session.
// deleted` event listener drops entries so the set is bounded by live
// sessions (single digits).
const lastInjectedBySession = new Map<string, Tier>()

/** Pick the highest applicable tier (monotonic — past HARD only HARD fires). */
export function pickTier(count: number): Tier | null {
  if (count >= CONTEXT_TIERS.hard) return "hard"
  if (count >= CONTEXT_TIERS.strong) return "strong"
  if (count >= CONTEXT_TIERS.soft) return "soft"
  return null
}

/** Tier rank for comparison: hard > strong > soft. */
const TIER_RANK: Record<Tier, number> = { soft: 1, strong: 2, hard: 3 }
export function tierGte(a: Tier, b: Tier): boolean { return TIER_RANK[a] >= TIER_RANK[b] }

/** Minimal structural view of v2 `Message[]` (role + content parts). */
interface MessageLike {
  role?: string
  content?: Array<{ type?: string; text?: string }>
}

/** V2 "context" hook core — exported for unit tests with the session
 *  lookup injected. Fail-open internally (a throw must not abort the
 *  request flow). */
export async function contextWatchContextHook(
  e: { sessionID?: string; messages?: MessageLike[] },
  isSubagent: (sessionID: string | undefined) => Promise<boolean>,
): Promise<void> {
  try {
    const sessionID = e.sessionID
    if (!sessionID) return
    // Subagent filter: subagent contexts are isolated and ephemeral — the
    // user wouldn't see their banners and the subagent LLM has no power to
    // suggest the user open a new main session.
    if (await isSubagent(sessionID)) return

    const msgs = e.messages
    if (!Array.isArray(msgs) || msgs.length === 0) return

    // Count only assistant messages — proxy for "conversation length"
    // and matches the /usage header banner metric so the two stay in sync.
    let assistantCount = 0
    for (const m of msgs) if (m?.role === "assistant") assistantCount++
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
    let target: MessageLike | undefined
    for (let i = msgs.length - 1; i >= 0; i--) {
      const message = msgs[i]
      if (!message || message.role !== "user") continue
      target = message
      break
    }
    if (target === undefined) return

    if (!Array.isArray(target.content)) target.content = []
    target.content.push({ type: "text", text: `\n\n${REMINDERS[tier]}` })
  } catch {
    // Never crash the session — degrade to no reminder.
  }
}

/**
 * Handle one event from the ctx.event.subscribe stream: drop per-session
 * escalation state when a session ends. Exported (and called directly by
 * the subscription loop) so unit tests drive it deterministically without
 * a live iterator.
 */
export function handleContextWatchEvent(event: unknown): void {
  const ev = event as { type?: string; data?: { sessionID?: string }; properties?: { info?: { id?: string } } }
  if (ev?.type !== "session.deleted") return
  const sessionID = ev.data?.sessionID ?? ev.properties?.info?.id
  if (!sessionID) return
  lastInjectedBySession.delete(sessionID)
  forgetSession(sessionID)
}

export const ContextWatchPlugin = Plugin.define({
  id: "context-watch",
  async setup(ctx) {
    const abort = new AbortController()
    const context = await ctx.session.hook("context", (e) =>
      contextWatchContextHook(
        { sessionID: e.sessionID, messages: e.messages as MessageLike[] | undefined },
        async (sessionID) => isSubagentSession(sessionID, ctx.session as unknown as V2Session),
      ),
    )
    // Event loop: drop per-session escalation state when a session ends.
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: abort.signal })) {
          handleContextWatchEvent(ev)
        }
      } catch {
        // Subscription died (server shutdown) — nothing left to clean here.
      }
    })()
    return async () => {
      abort.abort()
      await context.dispose()
    }
  },
})

export default ContextWatchPlugin
