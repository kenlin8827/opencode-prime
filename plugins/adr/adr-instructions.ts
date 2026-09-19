/**
 * Prompt fragment builders for the ADR iron law system hint + live
 * project-level config.
 *
 * Phase 7.8: the full ADR protocol body (~5 KB) is NO LONGER injected
 * into the system prompt. It lives as `skills/adr-protocol/SKILL.md`
 * — an OCP-native L2 skill that the LLM loads on demand via
 * `read_file` when an ADR intent arises. This matches OCP's own
 * "workflow / on-demand guidance → skill" disclosure rule
 * (`DEVELOPING.md:367`) and saves ~5 KB per chat turn on every
 * ordinary session.
 *
 * What this file still produces:
 *
 *   1. **Hint block** — a tiny ~67-token block (measured) advertising the
 *      `/adr config` command family and pointing at the
 *      `adr-protocol` skill. Always injected (no on/off branch).
 *      Stable enough to live in the system prompt at low cost.
 *
 *   2. **Runtime config block** — the project-level `adr.*` config
 *      as a 9-row markdown table (8 adr.* keys + adrDir).
 *      **Re-rendered on every chat request** so a project edit to
 *      `.ocp/ocp.json` (or a `/adr config <key> <value>` mid-session)
 *      shows up on the next turn without restart. Token cost: ~187 (measured).
 *
 * What this file does NOT do:
 *
 *   - It no longer caches or constructs the protocol body. That's the
 *     skill's job.
 *   - It no longer has an on/off branch — the iron-law switch
 *     `adrGuard` still exists in the config and gates the
 *     `tool.execute.before` commit guard (see `adr-tool-guard.ts`),
 *     but it no longer toggles prompt content. The hint always
 *     advertises `/adr guard on|off` so the user can enable the
 *     mechanical gate when ready.
 */

import { existsSync, readFileSync } from "node:fs"
import { getProjectDir, ocpConfigFile, stripJsonc } from "../shared/opencode-prime"
import {
  createProjectScopedMemo,
  extractLastMarkerBlock,
  isProjectConfigCorrupt as sharedIsCorrupt,
  loadLastMarkerFromHistory,
} from "../shared/last-good"
import { getAdrConfig, getAdrConfigFromParsed, getAdrDir } from "./adr-config"

// ─── Markers ────────────────────────────────────────────────────────────
// One marker per fragment — independent strip / re-inject.
export const MARKER_HINT = "[ADR]"
export const MARKER_CONFIG = "[ADR-CONFIG-RUNTIME]"

export const PROTOCOL_SKILL_REF = "`skills/adr-protocol/SKILL.md`"

// ─── Hint block (always injected) ──────────────────────────────────────

/**
 * Always-injected hint. Deliberately minimal (~60 tokens): skill
 * discovery is already covered natively by the `adr-protocol` entry in
 * `<available_skills>` (its frontmatter description carries the trigger
 * words), so this hint only carries what the skill description CANNOT:
 * the project-local ADR directory, the command entry points, and the
 * commit-gate state. Bytes are stable for the whole session (the only
 * variable is `adrDir`, which changes only when `.ocp/ocp.json` does).
 */
export function getGuardHintPrompt(): string {
  return (
    `\n\n${MARKER_HINT}\n\n` +
    `ADRs live under \`${getAdrDir()}/\`. Full protocol: load the\n` +
    `\`adr-protocol\` skill when an ADR intent arises. Commands:\n` +
    `\`/adr help\` · \`/adr new <title>\` · \`/adr config\` ·\n` +
    `\`/adr guard on|off\` (commit gate; currently a documentation-only\n` +
    `setup unless enabled).\n`
  )
}

// ─── Runtime config block (re-rendered every chat) ─────────────────────

// ─── Last-good fallback (config corruption guard, Phase 7.9) ───────────
// `readProjectConfig()` returns null BOTH when `.ocp/ocp.json` is absent
// (legit zero-config — defaults are correct) and when it exists but is
// unparseable (hand-edit typo — defaults would LIE about the project's
// real config: the table would silently flip to `madr`/`kebab` while the
// user configured `snake`). The last-good memo keeps the most recent
// successfully rendered table and reuses it while the file stays corrupt,
// so a broken hand-edit degrades to "stale but truthful" instead of
// "fresh but wrong". Recovery is automatic: the first parse-success
// re-render replaces the memo. Corrupt-state renders are NEVER memoized,
// so a process that starts against a corrupt file recovers the moment
// the file is fixed.
//
// Per-project sharding: the memo is keyed by `getProjectDir()` (which
// `ocpConfigFile()` resolves against). A single process may serve
// multiple project directories (IDE workspace, test harness); a global
// singleton would let a corrupt file in project A poison the table
// served to project B.
//
// Shared implementation: the Map and `isProjectConfigCorrupt` live in
// `plugins/shared/last-good.ts` so other plugins (auto-advisor,
// e2e-guard, …) can reuse the same per-project last-good contract
// without duplicating corrupt-check / history-fallback logic. This file
// re-exports that contract for tests and keeps ADR-specific rendering
// single-IO (one file read shared by corrupt-check + render).

const lastGoodMemo = createProjectScopedMemo<string>()

/** True when the config file EXISTS but cannot be parsed (mirrors
 *  parseConfigFile's `JSON.parse(stripJsonc(...))` semantics). An absent
 *  file is NOT corruption — defaults are legitimately correct there.
 *  Exported for unit tests. Delegates to `shared/last-good`. */
export function isProjectConfigCorrupt(): boolean {
  return sharedIsCorrupt()
}

/** Test-only: clear the last-good memo. Pass a project dir to clear
 *  only that entry; omit to clear all. */
export function resetAdrLastGoodFragment(dir?: string): void {
  if (typeof dir === "string" && dir.trim() !== "") {
    lastGoodMemo.delete(dir)
    return
  }
  lastGoodMemo.clear()
}

/** Direct access to the underlying memo for advanced callers (tests,
 *  shared utils). Prefer `resetAdrLastGoodFragment` for test cleanup. */
export function getAdrLastGoodMemo(): ReturnType<typeof createProjectScopedMemo<string>> {
  return lastGoodMemo
}

/** Render the config table body from the current config state. Pure with
 *  respect to config content — no timestamps or volatile values, so an
 *  unchanged config renders byte-identical output (provider cache-safe). */
function renderAdrConfigTableFromConfig(
  cfg: ReturnType<typeof getAdrConfig>,
  adrDir: string,
): string {
  const fmt = (v: unknown): string => {
    if (Array.isArray(v)) return v.length === 0 ? "_(none)_" : v.map((s) => `\`${s}\``).join(", ")
    if (v === null || v === undefined) return "_(null)_"
    return `\`${String(v)}\``
  }
  return (
    `\n\n${MARKER_CONFIG}\n\n` +
    `The active ADR config for THIS project (from \`.ocp/ocp.json\`):\n\n` +
    `| Key | Active value |\n` +
    `| :--- | :--- |\n` +
    `| adr.style | ${fmt(cfg.style)} |\n` +
    `| adr.numbering | ${fmt(cfg.numbering)} |\n` +
    `| adr.layout | ${fmt(cfg.layout ?? "inherit from adrLayout")} |\n` +
    `| adr.governance | ${fmt(cfg.governance)} |\n` +
    `| adr.filenamePattern | ${fmt(cfg.filenamePattern)} |\n` +
    `| adr.slugStyle | ${fmt(cfg.slugStyle)} |\n` +
    `| adr.extraSections | ${fmt(cfg.extraSections)} |\n` +
    `| adr.indexColumns | ${fmt(cfg.indexColumns)} |\n` +
    `| adrDir | \`${adrDir}/\` |\n\n` +
    `**Honor these values** when scaffolding, naming, and indexing. Do NOT\n` +
    `invent your own filename pattern or default style — they override\n` +
    `the protocol defaults. Use \`/adr config\` to read or change them;\n` +
    `use \`/adr config reset <key>\` to fall back to the protocol default.\n`
  )
}

function renderAdrConfigTable(): string {
  return renderAdrConfigTableFromConfig(getAdrConfig(), getAdrDir())
}

/** Shared single-IO loader: read once, return `{ corrupt, parsed }`.
 *  Keeping this inline preserves the single-read guarantee documented
 *  above while letting both sync and async entry points share it. */
function loadConfigOnce(): { corrupt: boolean; parsed: Record<string, unknown> | null } {
  const file = ocpConfigFile()
  if (!existsSync(file)) return { corrupt: false, parsed: null }
  try {
    const raw = readFileSync(file, "utf-8")
    return { corrupt: false, parsed: JSON.parse(stripJsonc(raw)) as Record<string, unknown> }
  } catch {
    return { corrupt: true, parsed: null }
  }
}

function renderFromParsedOrDefault(parsed: Record<string, unknown> | null): string {
  if (parsed !== null) {
    const cfg = getAdrConfigFromParsed(parsed)
    const adrDirRaw = parsed.adrDir
    const adrDir = typeof adrDirRaw === "string" && adrDirRaw.trim() !== ""
      ? adrDirRaw.trim().replace(/\\/g, "/").replace(/\/+$/, "")
      : "docs/adr"
    return renderAdrConfigTableFromConfig(cfg, adrDir)
  }
  return renderAdrConfigTable()
}

/** Render the project-level `adr.*` config as a small markdown table the
 *  agent can scan in one beat. Every Phase 7 field is present so the
 *  agent never invents its own filename pattern or default style.
 *  Empty arrays render as `_(none)_`; null layout renders as
 *  `_(inherit from adrLayout)_`.
 *
 *  Deterministic per-turn render: an unchanged config produces a
 *  byte-identical fragment (provider prefix-cache hit); a changed config
 *  produces a fresh table (one-time cache break at the table — the
 *  whole `adr.*` state re-sends together, per the Phase 7.9 contract).
 *  Token cost: ~187 (measured).
 *
 *  Corruption guard: when `.ocp/ocp.json` exists but is unparseable,
 *  `getAdrConfig()` would silently fall back to defaults — the table
 *  would claim values the user never set. In that state this function
 *  serves the LAST GOOD table instead (stale but truthful) and never
 *  memoizes the corrupt-state render.
 *
 *  Single-IO path: the file is read ONCE; corrupt detection and config
 *  rendering share that read. The per-project memo (`lastGoodMemo`,
 *  from `shared/last-good`) prevents a corrupt file in one project
 *  from poisoning another. */
export function getAdrConfigRuntimeFragment(): string {
  const { corrupt, parsed } = loadConfigOnce()
  if (corrupt) {
    const memo = lastGoodMemo.get()
    if (memo !== undefined) return memo
    // Cold-start corrupt (no memo yet) — degrade to defaults gracefully
    // but do NOT memoize so the next good read heals.
    return renderFromParsedOrDefault(null)
  }
  const rendered = renderFromParsedOrDefault(parsed)
  lastGoodMemo.set(rendered)
  return rendered
}

/** Async variant of `getAdrConfigRuntimeFragment` with low-frequency
 *  history fallback. When the file is corrupt and the in-memory memo is
 *  empty (e.g. immediately after a process restart) it tries to load the
 *  last good `[ADR-CONFIG-RUNTIME]` block from the session's system history
 *  via `client`/`sessionID`. That path is expected to be rare — a cold
 *  corrupt start with no prior good turn in this process — and is
 *  fail-open to defaults.
 *
 *  System transform already has `client` and `sessionID` (hook args), so
 *  passing them here costs no extra plumbing; other callers can omit them
 *  and get the sync-behaviour. The history scan uses
 *  `shared/last-good:loadLastMarkerFromHistory`, which duck-types both
 *  server (`client.session.messages`) and TUI clients and never throws. */
export async function getAdrConfigRuntimeFragmentWithHistory(
  client?: unknown,
  sessionID?: string,
): Promise<string> {
  const { corrupt, parsed } = loadConfigOnce()
  if (corrupt) {
    const memo = lastGoodMemo.get()
    if (memo !== undefined) return memo
    // Low-frequency restart recovery: Map miss → try conversation/system history
    if (client && sessionID) {
      try {
        const fromHistory = await loadLastMarkerFromHistory(client, sessionID, MARKER_CONFIG)
        if (typeof fromHistory === "string" && fromHistory.includes(MARKER_CONFIG)) {
          // History blocks may be a tail slice (from marker onward) — keep them verbatim
          // so the LLM sees byte-identical truthful config until the file heals.
          lastGoodMemo.set(fromHistory)
          return fromHistory
        }
        // Also try a direct scan of already-injected system history if the
        // caller passed an explicit buffer (not available here — keep the
        // hook's own `output.system` scan as a second fallback below if needed).
      } catch { /* fail open */ }
    }
    return renderFromParsedOrDefault(null)
  }
  const rendered = renderFromParsedOrDefault(parsed)
  lastGoodMemo.set(rendered)
  return rendered
}

/** Extract the last `[ADR-CONFIG-RUNTIME]` block from a system prompt
 *  history array (output.system shape). Pure helper for history fallback
 *  when `client.session.messages` is unavailable but the current system
 *  array already carries a prior good block from an earlier transform.
 *  Delegates to `shared/last-good:extractLastMarkerBlock`. */
export function extractLastConfigBlockFromSystem(system: string[]): string | null {
  return extractLastMarkerBlock(system, MARKER_CONFIG)
}
