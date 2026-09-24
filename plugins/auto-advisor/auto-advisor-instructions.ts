/**
 * Shared auto-advisor instructions — mode-specific prompt strings.
 *
 * The advisor protocol body lives in `auto-advisor-protocol.md` (next to this
 * file), loaded once at first use and cached in memory — same pattern as
 * review-fix-loop and grill plugins.
 *
 * Three shapes:
 *   getAdvisorPrompt("off")   — OFF marker + protocol (for manual @advisor).
 *   getAdvisorPrompt("lite")  — full protocol + lite marker (default).
 *   getAdvisorPrompt("full")  — full protocol + full marker (auto-execute).
 */

import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import type { AdvisorMode } from "./auto-advisor-config"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROTOCOL_FILE = join(__dirname, "auto-advisor-protocol.md")

// Cache the protocol file content (loaded once).
let cachedProtocol: string | null = null
function getProtocol(): string {
  if (cachedProtocol !== null) return cachedProtocol
  cachedProtocol = readFileSync(PROTOCOL_FILE, "utf-8")
  return cachedProtocol
}

export const MODE_MARKER: Record<AdvisorMode, string> = {
  off: `[AUTO-ADVISOR MODE: OFF]\nDo NOT auto-dispatch @advisor for blocking decisions — you decide alone.\nEXCEPTION: if the user's message explicitly contains @advisor, you MAY dispatch @advisor to consult it. The advisor's opinion is advisory only — never auto-execute.`,
  lite: `[AUTO-ADVISOR MODE: LITE]\nDispatch @advisor ONLY for genuinely blocking decisions where a second opinion adds value — not routine or low-stakes calls (see Frugality rules in protocol below). When dispatched, present BOTH opinions to the user. Advisor gives opinions only — it NEVER answers on the user's behalf.`,
  full: `[AUTO-ADVISOR MODE: FULL — ACTIVE NOW]\n` +
    `Dispatch @advisor ONLY for genuinely blocking decisions (see Frugality rules in protocol below). Question class FACTUAL + confidence ≥ 8 → auto-execute the answer NOW (on the user's behalf), no question tool. ` +
    `Max 10/session, then lite. ` +
    `PREFERENCE or < 8 → present BOTH opinions (lite flow).`,
}

/**
 * Build the prompt fragment for the active mode. The plugin appends this to
 * the system prompt via the v2 "context" session hook.
 *
 * For "off", the protocol is included so the LLM knows the dispatch template
 * and output format when the user explicitly @advisor. The OFF marker tells
 * the LLM not to auto-dispatch, but the protocol enables manual dispatch.
 */
export function getAdvisorPrompt(mode: AdvisorMode): string {
  return `\n\n---\n${MODE_MARKER[mode]}\n\n${getProtocol()}\n`
}

/**
 * Directive appended to advisor's tool output in full mode when confidence
 * meets threshold and the question was classified FACTUAL. A code-level
 * nudge for the orchestrator.
 */
export function fullDirective(confidence: number): string {
  return (
    `\n\n---\n[FULL MODE — CODE-LEVEL DIRECTIVE]\n` +
    `Advisor confidence: ${confidence}/10 (threshold met; question classified FACTUAL).\n` +
    `Auto-execute the advisor's recommendation NOW, on the user's behalf. ` +
    `Do NOT call question. Note: "Advisor answered on the user's behalf (confidence ${confidence}/10, class FACTUAL) — auto-executed per full mode."`
  )
}

/**
 * Warning appended when the advisor model wasn't available and OpenCode
 * silently fell back to the default model. In that case the confidence score
 * is untrustworthy — never auto-execute off it.
 */
export function fallbackWarning(): string {
  return (
    `\n\n---\n[ADVISOR MODEL FALLBACK]\n` +
    `The advisor model was unavailable; default model was used.\n` +
    `Do NOT auto-execute in full mode. Return both opinions to the user.`
  )
}

/**
 * Warning appended when the advisor dispatch itself failed (timeout,
 * network error, empty response, explicit error key). A failed dispatch is
 * not a real opinion, so full mode must fall back to lite flow.
 */
export function advisorFailureWarning(reason: string): string {
  return (
    `\n\n---\n[ADVISOR DISPATCH FAILURE]\n` +
    `Advisor dispatch failed (${reason}).\n` +
    `Do NOT auto-execute in full mode. Return both opinions to the user.`
  )
}
