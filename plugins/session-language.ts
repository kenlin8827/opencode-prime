/**
 * Session-language injector — makes ~/.config/opencode/ocp.json's
 * `language` field an in-context fact.
 *
 * Why injection: instructions/output-protocol.md §Session language makes
 * ocp.json the pre-prose default (a slash command or skill that fires
 * before the user's first message has no prose to detect). A prompt rule
 * can NAME that source, but the model still has to read the file to know
 * the value — models do not spontaneously read config files, so the chain
 * silently fell through to the environment default (empty LANG on Windows
 * → English). Per DEVELOPING.md's injection matrix this is imperative
 * protocol content the model must internalize, so the resolved value is
 * injected into the system parts via ctx.session.hook("context") and the
 * L0 rule references the `[SESSION LANGUAGE: …]` marker instead of the
 * file.
 *
 * Value source: plugins/shared/ocp-config.ts readOcpField("language") —
 * the same single source the TUI wizards write. Absent/empty/garbage
 * value → no injection; the L0 environment-default chain then governs
 * unchanged. Display names come from the single locale registry
 * (plugins/tui/i18n.ts LOCALES — already loaded in-process by the adr /
 * project-memory / usage plugins, so this import adds no new module
 * weight; registering a 9th locale flows through automatically).
 *
 * Runtime note (ADR 0002): e.system is rebuilt per chat request, so the
 * fragment is appended on every event; the defensive strip keeps this
 * idempotent under a hypothetical prompt-persistence runtime (Scenario
 * B). No agent-scope gate: every agent that produces prose needs the
 * language. Fail-open — an injector error must never abort a request.
 */

import type { Plugin } from "@opencode/plugin"
import { readOcpField } from "./shared/ocp-config"
import { appendBlock, stripBlockByPrefix } from "./shared/system-block"
import { LOCALES } from "./tui/i18n"

/** Prefix of the injected marker line; all variants start with this. */
const MARKER_PREFIX = "[SESSION LANGUAGE:"
const CONFIG_KEY = "language"

/** code → display name, derived from the single locale registry. */
const LANGUAGE_NAMES: Record<string, string> = Object.fromEntries(
  LOCALES.map((l) => [l.code, l.name]),
)

/** Plausible language-tag guard for hand-edited values: registered codes
 *  pass; sentences, paths, or 500-char junk do not (no injection). */
function isValidLanguageTag(v: string): boolean {
  return v.length <= 16 && /^[a-zA-Z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(v)
}

/** Resolved language value, or null when unset/invalid (fail-open). */
function currentLanguage(): string | null {
  try {
    const raw = readOcpField<string>(CONFIG_KEY)
    if (typeof raw !== "string") return null
    const v = raw.trim()
    return v && isValidLanguageTag(v) ? v : null
  } catch {
    return null
  }
}

/** Render the injected fragment. The marker sits at line start so the
 *  defensive strip and the L0 rule can both anchor on it. */
function renderFragment(locale: string): string {
  const name = LANGUAGE_NAMES[locale] ?? locale
  return (
    `\n${MARKER_PREFIX} ${locale}]\n` +
    `Session language: ${name} (${locale}) — the locked output language for all prose; ` +
    `the user's first instructional prose or an explicit instruction re-locks it ` +
    "(`output-protocol.md` §Session language). " +
    "Keep code, identifiers, paths, commands, and template labels verbatim."
  )
}

export const SessionLanguagePlugin: Plugin.Plugin = {
  id: "opencode-prime.session-language",
  async setup(ctx) {
    const context = await ctx.session.hook("context", async (e) => {
      try {
        const system = Array.isArray(e.system) ? e.system : []
        // Shared primitive (system-block.ts) — also used by auto-advisor,
        // deepseek-anchor, and project-manager for their marker families.
        stripBlockByPrefix(system, MARKER_PREFIX)
        const locale = currentLanguage()
        if (locale) appendBlock(system, renderFragment(locale))
      } catch {
        // Fail-open: never abort a request over an injector.
      }
    })
    return async () => {
      await context.dispose()
    }
  },
}

export default SessionLanguagePlugin
