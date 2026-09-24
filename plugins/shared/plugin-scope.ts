/**
 * Plugin scope gate — runtime half of plugin-scope.json (repo root;
 * installed to the config root, hence the ../../ relative import).
 *
 * opencode has no native plugin-to-agent scoping (v2 hook events carry
 * `agent` as an observation field only — no filtering), so every hook
 * fires for every session and every plugin tool is exposed everywhere.
 * Detection channels for the agent / session state:
 *
 *   1. detectAgentByName(agent) — v2 primary channel: hook events carry
 *      the agent id string.
 *   2. detectAgent(system) — synchronous text identification: matches the
 *      system text against the `identifiers` rules (pure data, no match
 *      text hardcoded here). Accepts BOTH v1 `string[]` and v2
 *      `SystemPart[]` ({ type:"text", text }) shapes. Yields a scope name
 *      (lite, utility) or null.
 *   3. parentID ground truth — a session with a parent session IS a
 *      subagent step (state "subagent"); resolved via a session lookup,
 *      cached per sessionID. Checked only when the other channels find
 *      nothing.
 *
 * Gate entry points: this module owns identification + policy evaluation
 * only. Plugins gate through `agent-scope.ts` (`scopedForAgent` /
 * `scopedForCall`) over the policy engine exported here as `evaluateScope`.
 * The v1 entry points (`scoped`, `scopedForTool`) and their
 * `SessionClient`/`{data:{parentID}}` lookup were removed once the last
 * v1-shaped plugin (`project-profiler`) migrated — the v2 session domain
 * returns the session object directly, so subagent detection lives in
 * `agent-scope.ts` alone.
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
 * This file lives in plugins/shared/ and is NOT loaded as a plugin itself
 * (only root-level .ts files are), so it may export non-functions.
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

/* ---- text identification (sync) — accepts string[] and SystemPart[] ---- */

/** Flatten a v1 string array or a v2 SystemPart-like array to plain text. */
export function systemTexts(system: Array<unknown> | undefined | null): string[] {
  if (!Array.isArray(system)) return []
  const out: string[] = []
  for (const entry of system) {
    if (typeof entry === "string") out.push(entry)
    else if (entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string")
      out.push((entry as { text: string }).text)
  }
  return out
}

function matchesRule(texts: string[], rule: IdentifierRule): boolean {
  if (typeof rule.contains === "string") {
    const needle = rule.contains
    return texts.some((s) => s.includes(needle))
  }
  if (typeof rule.startsWith === "string") {
    const first = texts[0]
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
  const texts = systemTexts(system)
  if (texts.length === 0) return null
  for (const [name, rule] of Object.entries(config.identifiers ?? {})) {
    if (rule && typeof rule === "object" && matchesRule(texts, rule)) return name
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

/** Core gate logic — the single policy engine behind the v2 gates in
 *  `agent-scope.ts` (`scopedForAgent` / `scopedForCall`). Pure of detection
 *  source: callers resolve `identity` / `state`, this decides. */
export function evaluateScope(
  identity: string | null,
  state: string | null,
  pluginId: string,
): boolean {
  if (identity === null && state === null) return true
  const policy = config.plugins?.[pluginId] ?? config.plugins?.["*"]
  if (!policy || typeof policy !== "object") return true
  return !policyBlocks(policy, { identity, state })
}

/**
 * v1 gate entry points — REMOVED.
 *
 * `scoped()` / `scopedForTool()` were the pre-v2 wrappers over
 * `evaluateScope` (v1 `client` + `{data:{parentID}}` session lookup, no
 * agent-id channel). They were deleted once `project-profiler`, the last
 * v1-shaped plugin, moved to `agent-scope.scopedForAgent`. Every caller —
 * plugins and tests alike — now gates through `agent-scope.ts`, so this
 * module keeps only identification helpers and the policy engine.
 */