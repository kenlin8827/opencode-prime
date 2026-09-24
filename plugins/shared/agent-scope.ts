/**
 * Agent scope gate — the v2 replacement for v1's text-sniffing scoped() gate.
 *
 * V2 has NO per-agent hook scoping: `agent` on hook events is an
 * observation field only, so every plugin hook fires for every session and
 * every registered tool is visible everywhere. This helper restores the
 * exact v1 plugin-scope.json semantics (deny/allow per plugin id over
 * identity/state scope names, fail-open) on top of the v2 event shapes.
 *
 * Detection order (first hit wins), mirroring plugin-scope.ts channels:
 *   1. e.agent (Agent.ID string) via detectAgentByName — the v2 primary
 *      channel; v1 never had it on system.transform hooks.
 *   2. System text sentinels via detectAgent(e.system) — the legacy
 *      channel, still needed for contexts whose AGENT ID is insufficient:
 *      auxiliary title-generation requests can surface under the session
 *      agent id, but their system text carries the "title generator"
 *      sentinel. Accepts v2 SystemPart[] ({ type:"text", text }) entries.
 *   3. parentID ground truth — session.get → parentID set means the
 *      session IS a subagent step (state "subagent"), cached per session.
 *
 * Fail-open on any error, exactly like the v1 gate: a broken lookup
 * degrades to pre-gate behavior (inject), never to lost functionality.
 */

import { detectAgent, detectAgentByName, evaluateScope } from "./plugin-scope"

/** Minimal structural view of the v2 session domain client (ctx.session). */
export interface V2Session {
  synthetic(input: { sessionID: string; text: string; delivery?: "steer" | "queue" | null; resume?: boolean }): Promise<unknown>
  prompt?(input: { sessionID: string; text: string; delivery?: "steer" | "queue" | null }): Promise<unknown>
  get?(input: { sessionID: string }): Promise<unknown>
}

/** Fields a v2 hook event may carry for scope detection. */
export interface ScopeEvent {
  agent?: string | null
  system?: unknown
  sessionID?: string | null
}

// parentID ground truth, cached per session (bounded like the v1 map).
const subagentBySession = new Map<string, boolean>()

/** True when the session has a parent session (subagent step). */
export async function isSubagentSession(
  sessionID: string | null | undefined,
  session: V2Session | undefined,
): Promise<boolean> {
  if (!sessionID || typeof session?.get !== "function") return false
  const cached = subagentBySession.get(sessionID)
  if (cached !== undefined) return cached
  let result = false
  try {
    const info = (await session.get({ sessionID })) as { parentID?: unknown } | undefined
    result = typeof info?.parentID === "string" && info.parentID.length > 0
  } catch {
    result = false
  }
  if (subagentBySession.size >= 512) subagentBySession.clear()
  subagentBySession.set(sessionID, result)
  return result
}

/** Drop cached state when a session ends (call from a session.deleted event
 *  listener so long-lived servers do not accumulate entries). */
export function forgetSession(sessionID: string): void {
  subagentBySession.delete(sessionID)
}

/**
 * Gate for `ctx.session.hook("context", …)`-family callbacks. Returns true
 * when `pluginId` may run its side effect for this request.
 */
export async function scopedForAgent(
  event: ScopeEvent | undefined | null,
  pluginId: string,
  session?: V2Session,
): Promise<boolean> {
  try {
    const identity =
      detectAgentByName(event?.agent ?? undefined) ??
      detectAgent(Array.isArray(event?.system) ? (event?.system as Array<unknown>) : undefined)
    let state: string | null = null
    if (identity === null) {
      if (await isSubagentSession(event?.sessionID ?? undefined, session)) state = "subagent"
    }
    return evaluateScope(identity, state, pluginId)
  } catch {
    return true
  }
}

/**
 * Gate for `ctx.tool.hook("execute.*", …)` callbacks and registered-tool
 * execute handlers — no system text exists there, so detection is
 * agent-id first, parentID fallback.
 */
export async function scopedForCall(
  event: { agent?: string | null; sessionID?: string | null } | undefined | null,
  pluginId: string,
  session?: V2Session,
): Promise<boolean> {
  try {
    const identity = detectAgentByName(event?.agent ?? undefined)
    let state: string | null = null
    if (identity === null) {
      if (await isSubagentSession(event?.sessionID ?? undefined, session)) state = "subagent"
    }
    return evaluateScope(identity, state, pluginId)
  } catch {
    return true
  }
}

/**
 * v1 `client.session.prompt({ noReply, parts:[{type:"text",ignored:true}] })`
 * — a user-visible reply that must not trigger a model turn — maps to the
 * v2 synthetic-message channel. Failures are rethrown: call sites decide
 * whether a failed announcement is fatal (it generally is not, and the v1
 * callers already wrapped where needed).
 */
export async function injectReply(
  session: V2Session | undefined,
  sessionID: string | null | undefined,
  text: string,
): Promise<void> {
  if (!sessionID || !session) return
  await session.synthetic({ sessionID, text, resume: false })
}

/**
 * Arguments text for a plugin-command execute invocation. Observed v2
 * hosts pass `invocation.prompt.text` either as the bare arguments or as
 * the full "/name args" line; strip the leading "/name" when present so
 * handler code sees exactly what v1's `input.arguments` carried.
 */
export function commandArgumentText(text: string | undefined, name: string): string {
  const raw = text ?? ""
  const prefix = `/${name}`
  if (raw === prefix) return ""
  if (raw.startsWith(prefix) && /^[ \t]/.test(raw.slice(prefix.length)))
    return raw.slice(prefix.length).trim()
  return raw
}
