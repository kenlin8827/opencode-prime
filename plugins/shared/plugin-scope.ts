/**
 * Plugin scope gate — runtime half of plugin-scope.json (repo root;
 * installed to the config root, hence the ../../ relative import).
 *
 * opencode has no native plugin-to-agent scoping: every
 * `experimental.chat.system.transform` hook fires for every session, AND
 * every tool registered by a plugin is exposed to every session. Two
 * detection channels for the agent / session state:
 *
 *   1. detectAgent(system) — synchronous text identification: matches the
 *      system text against the `identifiers` rules (pure data, no match text
 *      hardcoded here). Works for system-transform hooks because they carry
 *      `output.system: string[]` — we can scan for marker text like the
 *      `<!-- lite-mode -->` HTML probe or the "You are a title generator"
 *      sentinel. Yields a scope name (identity or state: lite, utility) or null.
 *   2. parentID ground truth — a session with a parent session IS a subagent
 *      step (state "subagent"); resolved via the opencode client, cached per
 *      sessionID. Checked only when text identification finds nothing.
 *
 * Two entry points, same policy engine:
 *
 *   `scoped(input, system, pluginId, client?)`
 *     — for system-transform hooks. Detects agent via `system` text.
 *     Call: `if (!await scoped(input, output.system, "<plugin-id>", client)) return`.
 *
 *   `scopedForTool(input, pluginId, client?)`
 *     — for tool execute handlers. Detects agent via `input.agent` string
 *     (OpenCode passes the agent name through ToolContext but NOT the
 *     system text — there is no system to scan inside a tool call).
 *     Subagent still falls through to parentID when agent-name detection
 *     is null. Call:
 *       if (!await scopedForTool({ sessionID: ctx.sessionID, agent: ctx.agent }, "<plugin-id>", client)) {
 *         return { title: "...", output: "tool not available in this context" }
 *       }
 *
 * Policy lookup: plugins[<pluginId>] ?? plugins["*"], each { deny?, allow? }.
 * Scope entry grammar: "x" matches identity or state x; "x:*" matches state
 * x; "x:y" matches state x with identity y (reserved — identity-in-state
 * detection is not wired yet). deny = blacklist; allow = whitelist
 * (presence means only listed entries pass); deny wins.
 *
 * Fail-open on any error: broken policy degrades to pre-gate behavior, never
 * to lost functionality.
 *
 * Public surface is exactly the gate API (detectAgent, detectAgentByName,
 * scoped, scopedForTool); identifier match texts stay encapsulated in
 * plugin-scope.json. This file lives in plugins/shared/ and is NOT loaded
 * as a plugin itself (only root-level .ts files are), so it may export
 * non-functions.
 */

import scopeFile from "../../plugin-scope.json"

type IdentifierRule = { contains?: unknown; startsWith?: unknown }
type Policy = { deny?: unknown; allow?: unknown }
type ScopeFile = {
  identifiers?: Record<string, IdentifierRule>
  plugins?: Record<string, Policy>
}
type Context = { identity: string | null; state: string | null }

const config: ScopeFile = (scopeFile && typeof scopeFile === "object" ? scopeFile : {}) as ScopeFile

/* ---- text identification (sync) — for system-transform hooks ---- */

function matchesRule(system: Array<unknown> | undefined | null, rule: IdentifierRule): boolean {
  if (!Array.isArray(system)) return false
  if (typeof rule.contains === "string") {
    const needle = rule.contains
    return system.some((s) => typeof s === "string" && s.includes(needle))
  }
  if (typeof rule.startsWith === "string") {
    const first = system[0]
    return typeof first === "string" && first.startsWith(rule.startsWith)
  }
  return false
}

/**
 * Identify the context serving this transform from the system text, or null
 * for ordinary steps (first matching rule wins; rules are mutually exclusive
 * by construction). Returns a scope name (identity or state).
 */
export function detectAgent(system: Array<unknown> | undefined | null): string | null {
  for (const [name, rule] of Object.entries(config.identifiers ?? {})) {
    if (rule && typeof rule === "object" && matchesRule(system, rule)) return name
  }
  return null
}

/* ---- agent-name identification (sync) — for tool execute handlers ---- */

/**
 * Identify the context from the agent name string OpenCode provides via
 * ToolContext.agent. System text is NOT available inside tool calls, so
 * we map the agent name directly to a scope identifier:
 *
 *   "title-generator" / "title" / "utility" → "utility" (OpenCode's title agent)
 *   "lite" / contains "lite-mode"            → "lite" (this project's default agent)
 *   anything else                            → null (falls through to subagent detection)
 *
 * Conservative substring match for utility so future OpenCode renames
 * (e.g. "title-generator-v2") still match without a plugin-scope bump.
 * Lite requires a tighter match to avoid false positives on names like
 * "satellite".
 */
export function detectAgentByName(agent: string | undefined | null): string | null {
  if (!agent) return null
  const lower = agent.toLowerCase()
  if (lower.includes("title") || lower === "utility") return "utility"
  if (lower === "lite" || lower.includes("lite-mode")) return "lite"
  return null
}

/* ---- subagent state via session parentID (ground truth, cached) ---- */

type SessionClient = { session?: { get?: (args: any) => Promise<any> } }
// Re-export for plugins that need to pass their plugin-level client to
// `scopedForTool` (OpenCode's ToolContext doesn't carry the client).
export type { SessionClient }

const subagentBySession = new Map<string, boolean>()

async function isSubagentSession(sessionID: string | undefined, client: SessionClient | undefined): Promise<boolean> {
  if (!sessionID || !client?.session?.get) return false
  const cached = subagentBySession.get(sessionID)
  if (cached !== undefined) return cached
  let result = false
  try {
    const res = (await client.session.get({ path: { id: sessionID } })) as { data?: { parentID?: unknown } } | undefined
    result = typeof res?.data?.parentID === "string" && res.data.parentID.length > 0
  } catch {
    result = false
  }
  if (subagentBySession.size >= 512) subagentBySession.clear()
  subagentBySession.set(sessionID, result)
  return result
}

/* ---- policy evaluation ---- */

function entryMatches(entry: unknown, ctx: Context): boolean {
  if (typeof entry !== "string" || entry === "") return false
  const sep = entry.indexOf(":")
  if (sep === -1) return ctx.identity === entry || ctx.state === entry
  const state = entry.slice(0, sep)
  const identity = entry.slice(sep + 1)
  if (identity === "*") return ctx.state === state
  return ctx.state === state && ctx.identity === identity
}

/** True when the policy blocks this context (deny wins over allow). */
function policyBlocks(policy: Policy, ctx: Context): boolean {
  if (!policy || typeof policy !== "object") return false
  const deny = Array.isArray(policy.deny) ? policy.deny : []
  if (deny.some((e) => entryMatches(e, ctx))) return true
  if (Array.isArray(policy.allow)) return !policy.allow.some((e) => entryMatches(e, ctx))
  return false
}

/** Core gate logic shared by both entry points. Pure of detection source. */
async function evaluate(
  identity: string | null,
  state: string | null,
  pluginId: string,
): Promise<boolean> {
  if (identity === null && state === null) return true
  const policy = config.plugins?.[pluginId] ?? config.plugins?.["*"]
  if (!policy || typeof policy !== "object") return true
  return !policyBlocks(policy, { identity, state })
}

/**
 * True when `pluginId` may inject protocol text for this transform. No
 * detected context, or no applicable policy, means allowed (fail-open).
 */
export async function scoped(
  input: { sessionID?: unknown } | undefined | null,
  system: Array<unknown> | undefined | null,
  pluginId: string,
  client?: SessionClient,
): Promise<boolean> {
  try {
    const identity = detectAgent(system)
    let state: string | null = null
    if (identity === null) {
      const sessionID = typeof input?.sessionID === "string" ? input.sessionID : undefined
      if (await isSubagentSession(sessionID, client)) state = "subagent"
    }
    return await evaluate(identity, state, pluginId)
  } catch {
    return true
  }
}

/**
 * True when `pluginId` may run its tool execute handler for this call.
 * Tool context differs from system-transform in two ways:
 *   1. No `output.system: string[]` is available — agent identification
 *      uses `input.agent` (ToolContext.agent) via `detectAgentByName`.
 *   2. Subagent detection still works via parentID when no agent name hits.
 *
 * Plugin IDs for tool gates use a distinct namespace (e.g. `project-memory-tool`)
 * so system-inject and tool-call policies can differ — same plugin, two
 * separate gates, each tunable in `plugin-scope.json`.
 *
 * Same fail-open contract as `scoped()`.
 */
export async function scopedForTool(
  input: { sessionID?: unknown; agent?: string } | undefined | null,
  pluginId: string,
  client?: SessionClient,
): Promise<boolean> {
  try {
    const identity = detectAgentByName(input?.agent)
    let state: string | null = null
    if (identity === null && client?.session?.get) {
      const sessionID = typeof input?.sessionID === "string" ? input.sessionID : undefined
      if (await isSubagentSession(sessionID, client)) state = "subagent"
    }
    return await evaluate(identity, state, pluginId)
  } catch {
    return true
  }
}