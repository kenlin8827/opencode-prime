/**
 * Shared advisor runtime — log helper + advisor detection + output shaping.
 * Single source of truth for utilities every hook reuses.
 */

// ─── Constants ───────────────────────────────────────────────────────

const CONFIDENCE_THRESHOLD = 8
const MAX_AUTO_ANSWERS = 10

// ─── Try-catch wrapper ───────────────────────────────────────────────
// Plugin hooks must NEVER crash the user's session.

export function safeHook<H extends (...args: never[]) => Promise<unknown>>(
  hook: H,
  log?: (level: "info" | "warn", msg: string) => Promise<unknown>,
): H {
  return (async (...args: never[]) => {
    try {
      return await hook(...args)
    } catch (err) {
      try { await log?.("warn", `hook error (suppressed): ${String(err)}`) } catch {}
    }
  }) as H
}

// ─── Cheap tool-name filter ──────────────────────────────────────────

const DISPATCH_TOOL_RE = /^(task|subagent|dispatch|agent|delegate)$/i

/**
 * Returns true when the tool looks like a dispatch/subagent tool.
 * When the input shape is unrecognized (no object, no .tool string),
 * returns true as a conservative default — the caller (full-inject)
 * re-filters with isAdvisorDispatch, so a false positive here only
 * costs one extra JSON.stringify, never a wrong auto-execute.
 */
export function isDispatchTool(input: unknown): boolean {
  if (!input || typeof input !== "object") return true
  const t = (input as Record<string, unknown>).tool
  if (typeof t !== "string") return true
  return DISPATCH_TOOL_RE.test(t) || t.toLowerCase().includes("task") || t.toLowerCase().includes("agent")
}

// ─── Advisor dispatch detection ──────────────────────────────────────

export function isAdvisorDispatch(args: unknown): boolean {
  const s = JSON.stringify(args || {})
  return s.includes('"advisor"') || s.includes("@advisor")
}

// ─── Output parsing ──────────────────────────────────────────────────

export function isRedTeamOutput(text: string): boolean {
  const s = String(text || "")
  return s.includes("Red-team analysis") || /\*\*Verdict\*\*\s*:/.test(s)
}

export function detectQuestionClass(text: string): "FACTUAL" | "PREFERENCE" | null {
  const s = String(text || "")
  // Match the mandatory output format from advisor.md:
  //   "**Question class**: FACTUAL" / "Question class: PREFERENCE"
  // Also tolerate close variants:
  //   "Question type: FACTUAL"  — some models swap "class" for "type"
  //   "Class: FACTUAL"          — shortened label
  //   "**FACTUAL**"             — standalone bold marker (no label)
  if (/question\s*(?:class|type)?\s*\*{0,2}\s*[:：]\s*\*{0,2}\s*factual\b/i.test(s)) return "FACTUAL"
  if (/question\s*(?:class|type)?\s*\*{0,2}\s*[:：]\s*\*{0,2}\s*preference\b/i.test(s)) return "PREFERENCE"
  if (/\bclass\s*\*{0,2}\s*[:：]\s*\*{0,2}\s*factual\b/i.test(s)) return "FACTUAL"
  if (/\bclass\s*\*{0,2}\s*[:：]\s*\*{0,2}\s*preference\b/i.test(s)) return "PREFERENCE"
  // Standalone bold marker — last resort, only if no labeled match found.
  if (/\*{0,2}\bFACTUAL\b\*{0,2}/i.test(s)) return "FACTUAL"
  if (/\*{0,2}\bPREFERENCE\b\*{0,2}/i.test(s)) return "PREFERENCE"
  return null
}

export function extractResponseText(output: unknown): string {
  if (typeof output === "string") return output
  if (!output || typeof output !== "object") return ""
  const o = output as Record<string, unknown>
  for (const key of ["content", "result", "text", "output", "data"]) {
    if (typeof o[key] === "string") return o[key] as string
  }
  if (o.state && typeof o.state === "object") {
    const st = o.state as Record<string, unknown>
    if (typeof st.output === "string") return st.output
  }
  return JSON.stringify(o)
}

// ─── Dispatch-input question-text extraction ───────────────────────
// The text the orchestrator sent to @advisor is the only reliable place
// to look for PREFERENCE markers. The advisor's own classification regex
// can be gamed by a model that emits the word "FACTUAL".

export function extractQuestionText(input: unknown): string {
  if (typeof input === "string") return input
  if (!input || typeof input !== "object") return ""
  const o = input as Record<string, unknown>
  const args = o.args ?? o.input ?? o.prompt ?? o.task
  if (typeof args === "string") return args
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>
    for (const key of ["content", "text", "message", "prompt", "task", "input"]) {
      if (typeof a[key] === "string") return a[key] as string
    }
    return JSON.stringify(a)
  }
  return JSON.stringify(input)
}

// ─── Independent PREFERENCE / irreversibility guards ─────────────────
// These deliberately do not trust the advisor's self-reported class.
// See auto-advisor-protocol.md: PREFERENCE questions must never auto-execute.

const PREFERENCE_MARKERS = [
  /\buser\s+(?:wants|prefers|would\s+like)\b/i,
  /\bwhich\s+do\s+you\b/i,
  /what['’]?s\s+your\s+opinion\b/i,
  /\bdo\s+you\s+(?:like|prefer|want)\b/i,
  /\byou\s+think\b/i,
]

const IRREVERSIBILITY_MARKERS = [
  /\bdelete\b/i,
  /\bdrop\b/i,
  /\bforce\s+push\b/i,
  /\bdeploy\s+to\s+prod\b/i,
  /\bpayment\b/i,
  /\bpermission\b/i,
  /\bauth\s+change\b/i,
]

export function containsPreferenceMarker(text: string): boolean {
  return PREFERENCE_MARKERS.some((re) => re.test(String(text || "")))
}

export function containsIrreversibilityMarker(text: string): boolean {
  return IRREVERSIBILITY_MARKERS.some((re) => re.test(String(text || "")))
}

export function parseConfidence(text: string): number {
  // Match the mandatory output format from advisor.md:
  //   "**Confidence**: 8" or "Confidence: 8/10"
  // Also tolerate close variants:
  //   "Confidence Level: 8" / "Confidence Score: 8" — extra word
  //   "Confidence：8" — fullwidth colon
  // Require a colon (ASCII or fullwidth) so natural-language phrases like
  // "confidence in the team is high" don't trigger a false parse.
  const s = String(text || "")
  const patterns = [
    // Primary: Confidence[: ] N  or  **Confidence**: N/10
    /confidence\s*(?:level|score)?\s*\*{0,2}\s*[:：]\s*\*{0,2}(\d{1,2})\s*(?:\/\s*10)?\b/i,
  ]
  for (const re of patterns) {
    const m = s.match(re)
    if (m) return Math.min(10, Math.max(0, parseInt(m[1], 10)))
  }
  return 0
}

// ─── Model fallback detection ────────────────────────────────────────
//
// Strategy: read opencode.jsonc to find the advisor agent's configured model
// (e.g. "deepseek/deepseek-v4-pro") and the default agent's model (e.g.
// "deepseek/deepseek-v4-flash"). The tool output carries the actual model id
// that was used. If the actual id matches the advisor's configured model →
// not a fallback. If it matches the default model → fallback. If we can't
// read the config or the actual id is missing → trust the configuration and
// return false (don't block auto-execute on a parse failure).
//
// Provider model ids are compared directly because they do not necessarily
// contain the agent name (for example DeepSeek, Qwen, or MiniMax model ids).

import { readFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { getProjectDir, stripJsonc } from "./auto-advisor-config"

const CONFIG_DIR_FALLBACK = join(homedir(), ".config", "opencode")
const CONFIG_FILE_FALLBACK = join(CONFIG_DIR_FALLBACK, "opencode.jsonc")

// Cache the config read — it doesn't change during a session.
let cachedAdvisorModel: string | null | undefined = undefined
let cachedDefaultModel: string | null | undefined = undefined

// Agent → tier mapping from tiers.json (kept out of opencode.jsonc because
// opencode forwards unknown agent fields to the provider as model options).
// Missing or invalid files produce an empty map.
function readTierMap(dir: string): Record<string, string> {
  try {
    const raw = readFileSync(join(dir, "tiers.json"), "utf-8")
    const data = JSON.parse(raw) as Record<string, unknown>
    const map: Record<string, string> = {}
    for (const [agent, tier] of Object.entries(data)) {
      if (agent.startsWith("$")) continue
      if (typeof tier === "string") map[agent] = tier
    }
    return map
  } catch {
    return {}
  }
}

function readAgentModels(): { advisor: string | null; default: string | null } {
  if (cachedAdvisorModel !== undefined && cachedDefaultModel !== undefined) {
    return { advisor: cachedAdvisorModel, default: cachedDefaultModel }
  }
  cachedAdvisorModel = null
  cachedDefaultModel = null
  // Project config first (agent overrides live there), then global config.
  const dir = getProjectDir()
  const candidates = [
    join(dir, "opencode.jsonc"),
    join(dir, ".opencode", "opencode.jsonc"),
    CONFIG_FILE_FALLBACK,
  ]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      const raw = readFileSync(path, "utf-8")
      const cfg = JSON.parse(stripJsonc(raw)) as Record<string, unknown>
      const agents = cfg?.agent as Record<string, Record<string, unknown>> | undefined
      if (!agents) continue
      // tiers.json sits next to the config file; fall back to the global
      // one for project configs that don't ship their own.
      let tierMap = readTierMap(dirname(path))
      if (Object.keys(tierMap).length === 0) tierMap = readTierMap(CONFIG_DIR_FALLBACK)
      // Find the advisor agent's model (the agent named "advisor").
      const advisorAgent = agents["advisor"]
      if (!cachedAdvisorModel && advisorAgent?.model && typeof advisorAgent.model === "string") {
        cachedAdvisorModel = advisorAgent.model
      }
      // Find the default model from the root config or the standard tier.
      if (!cachedDefaultModel && cfg.model && typeof cfg.model === "string") {
        cachedDefaultModel = cfg.model
      }
      if (!cachedDefaultModel) {
        for (const [name, a] of Object.entries(agents)) {
          if (tierMap[name] === "standard" && typeof a.model === "string") {
            cachedDefaultModel = a.model
            break
          }
        }
      }
      // Both models resolved — stop scanning. Breaking on advisor alone
      // would strand cachedDefaultModel null when the project config only
      // overrides the advisor agent, disabling the default-model fallback
      // check in isModelFallback.
      if (cachedAdvisorModel && cachedDefaultModel) break
    } catch {
      // config parse error — try next file
    }
  }
  return { advisor: cachedAdvisorModel, default: cachedDefaultModel }
}

/**
 * Extract the model-id portion from a "provider/model-id" reference.
 * Splits on the FIRST slash to match opencode's own ref parsing, so
 * nested model ids stay intact:
 *   "deepseek/deepseek-v4-pro" → "deepseek-v4-pro"
 *   "llm-router/advisor" → "advisor"
 *   "openrouter/vendor/gpt-5.6" → "vendor/gpt-5.6"
 * Returns the input as-is if there's no slash.
 */
function modelIdFromRef(ref: string): string {
  const idx = ref.indexOf("/")
  return idx >= 0 ? ref.substring(idx + 1) : ref
}

export function isModelFallback(output: unknown): boolean {
  if (!output || typeof output !== "object") return false
  const o = output as Record<string, unknown>
  const meta = o.metadata as Record<string, unknown> | undefined
  const model = meta?.model as Record<string, unknown> | undefined
  const actualId =
    (model?.modelID as string | undefined) ??
    (model?.id as string | undefined) ??
    (meta?.modelID as string | undefined) ??
    (o.modelID as string | undefined)
  // If we can't determine the actual model id, don't block auto-execute.
  if (!actualId || typeof actualId !== "string") return false

  const { advisor: advisorModel, default: defaultModel } = readAgentModels()

  // If we know the advisor's configured model, check whether the actual id
  // matches it (any case). This is the primary check.
  const actualLower = actualId.toLowerCase()
  if (advisorModel) {
    const advisorId = modelIdFromRef(advisorModel).toLowerCase()
    if (actualLower === advisorId || actualLower.includes(advisorId)) {
      return false // actual model matches advisor config — not a fallback
    }
  }

  // If we know the default model, check whether the actual id matches it.
  // That would indicate the advisor was unavailable and the system fell back.
  if (defaultModel) {
    const defaultId = modelIdFromRef(defaultModel).toLowerCase()
    if (actualLower === defaultId || actualLower.includes(defaultId)) {
      return true // actual model matches default config — it's a fallback
    }
  }

  // Can't determine — trust the configuration, don't block auto-execute.
  return false
}

// ─── Advisor dispatch-failure detection ──────────────────────────────
//
// The model-fallback guard above catches "wrong model used". This guard
// catches the cases where the advisor tool itself never produced a usable
// response: timeout, network error, empty output, or explicit error keys.
// The orchestrator must never treat a failed dispatch as a real opinion.

export function getAdvisorFailureReason(output: unknown): string | null {
  if (output === null || output === undefined) return "output missing"
  if (typeof output === "object") {
    const o = output as Record<string, unknown>
    if (o.error !== undefined && o.error !== null) return "error key present"
    if (o.state && typeof o.state === "object") {
      const st = o.state as Record<string, unknown>
      if (st.status === "error") return "state status error"
    }
  }
  const text = extractResponseText(output)
  if (text === "") return "empty response"
  const start = text.trimStart()
  if (/^(?:Error:|Failed:)/i.test(start)) return "error marker in response"
  if (/^(?:\w+\s+)?(?:request\s+)?timed?\s*out\b/i.test(start)) return "timeout"
  if (/^\s*ECONNREFUSED\b/i.test(start)) return "connection refused"
  if (/^(?:[A-Z]+\s+)?5\d\d\s+error\b/i.test(start)) return "5xx error"
  return null
}

export function isAdvisorFailure(output: unknown): boolean {
  return getAdvisorFailureReason(output) !== null
}

// ─── Output shaping ──────────────────────────────────────────────────

export function appendDirective(output: unknown, directive: string): boolean {
  if (!output || typeof output !== "object") return false
  const o = output as Record<string, unknown>
  for (const key of ["content", "result", "text", "output", "data"]) {
    if (typeof o[key] === "string") {
      o[key] = (o[key] as string) + directive
      return true
    }
  }
  if (o.state && typeof o.state === "object") {
    const st = o.state as Record<string, unknown>
    if (typeof st.output === "string") {
      st.output = st.output + directive
      return true
    }
  }
  return false
}

// ─── Auto-answer state (session-keyed, one-shot) ─────────────────────

const autoAnswerSessions = new Set<string>()
const autoAnswerCounts = new Map<string, number>()

export function setAutoAnswer(sessionId: string): void {
  autoAnswerSessions.add(sessionId)
}

export function isAutoAnswerActive(sessionId: string): boolean {
  return autoAnswerSessions.has(sessionId)
}

export function clearAutoAnswer(sessionId: string): void {
  autoAnswerSessions.delete(sessionId)
}

export function resetAutoAnswerCounter(sessionId: string): void {
  autoAnswerCounts.delete(sessionId)
}

export function clearAutoAnswerCounts(): void {
  autoAnswerCounts.clear()
}

export function clearAutoAnswerSessions(): void {
  autoAnswerSessions.clear()
}

/**
 * Tear down all state for a session — call when a session ends to prevent
 * the Set/Map from growing without bound in long-lived plugin hosts.
 */
export function disposeSession(sessionId: string): void {
  autoAnswerSessions.delete(sessionId)
  autoAnswerCounts.delete(sessionId)
}

export function autoAnswerQuotaReached(sessionId: string): boolean {
  return (autoAnswerCounts.get(sessionId) ?? 0) >= MAX_AUTO_ANSWERS
}

export function recordAutoAnswer(sessionId: string): number {
  const next = (autoAnswerCounts.get(sessionId) ?? 0) + 1
  autoAnswerCounts.set(sessionId, next)
  return next
}

// ─── Session ID extraction ───────────────────────────────────────────

export function extractSessionId(output: unknown): string {
  if (!output || typeof output !== "object") return "default"
  const o = output as Record<string, unknown>
  const sid = (o.sessionID as string) ?? (o.sessionId as string)
  if (typeof sid === "string" && sid) return sid
  const meta = o.metadata as Record<string, unknown> | undefined
  const metaSid = (meta?.sessionID as string) ?? (meta?.sessionId as string)
  return typeof metaSid === "string" && metaSid ? metaSid : "default"
}

// ─── Exports for full-inject ─────────────────────────────────────────

export { CONFIDENCE_THRESHOLD, MAX_AUTO_ANSWERS }

// ─── Log helper ──────────────────────────────────────────────────────
// V2: console-backed server log (v1 routed through client.app.log; the v2
// plugin Context has no log domain — console reaches the same server log).

export function makeLogger(service: string) {
  return async (level: "info" | "warn", message: string): Promise<void> => {
    try {
      const line = `[ocp:${service}][${level}] ${message}`
      if (level === "warn") console.warn(line)
      else console.log(line)
    } catch {
      // Logging must never fail a hook.
    }
  }
}
