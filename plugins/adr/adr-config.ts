/**
 * Shared adr config — project .ocp/ocp.json switch field + ADR
 * directory + ADR layout. Single source of truth for reading,
 * writing, and normalizing each.
 *
 * State is PROJECT-LEVEL and lives in:
 *   - `adrGuard` — the on/off switch (default off; `/adr guard on|off`, alias `/adr-guard`)
 *   - `adrDir` — ADR directory (default "docs/adr")
 *   - `adrLayout` — hierarchy mode (auto / flat / hierarchical, default auto)
 *
 * The switch is delegated to `plugins/shared/plugin-switch.ts`. The
 * ADR-directory and hierarchy-mode helpers below are plugin-specific
 * (no other plugin shares them).
 *
 * /adr guard on|off (alias /adr-guard) writes the field into the project-level config
 * only (targeted upsert via ../shared/opencode-prime — comments and
 * unrelated fields survive); /adr guard reset removes the field,
 * reverting to the default off.
 *
 * The project directory is injected by the plugin entry via
 * setProjectDir() (PluginInput.directory); until then we fall back to
 * process.cwd().
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  clearConfigField,
  getProjectDir,
  ocpConfigFile,
  readProjectConfig,
  setConfigField,
  setProjectDir,
  stripJsonc,
  writableProjectConfigFile,
} from "../shared/opencode-prime"
import { refreshLocale, STRINGS, tr } from "../tui/i18n"
import { createPluginSwitch, normalizeSwitchState } from "../shared/plugin-switch"
import { findAdrStyleAdapter } from "./adr-style-registry"
import type { AdrGovernance, AdrNumbering, AdrStyle } from "./adr-types"

// Re-export the shared plumbing so existing importers (plugin entry, tool
// guard, tests) keep their current import paths.
export { getProjectDir, readProjectConfig, setProjectDir, stripJsonc }

export type GuardState = "on" | "off"
export type GuardStateSource = "config" | "default"

const adrSwitch = createPluginSwitch<GuardState>({
  field: "adrGuard",
  aliases: {
    on: "on", enabled: "on", true: "on",
    off: "off", disabled: "off", false: "off",
  },
  defaultState: "off",
  onStates: ["on"],
})

/** Normalize a raw config value (boolean or string) to a canonical
 * GuardState. Pure — exported for unit tests. */
export function normalizeState(state: unknown): GuardState | null {
  return normalizeSwitchState(state, adrSwitch.spec.aliases)
}

// ─── Switch state ────────────────────────────────────────────────────

export function getState(): GuardState {
  return adrSwitch.getState()
}

/** Where the current state came from (shown in `/adr guard` status). */
export function getStateSource(): GuardStateSource {
  return adrSwitch.getStateSource()
}

/** Write the switch into the project-level .ocp/ocp.json.
 * Project-scoped and never throws: a read-only project dir degrades
 * to a false return instead of crashing a plugin hook. */
export function setState(state: GuardState): boolean {
  return adrSwitch.setState(state)
}

/** Remove the `adrGuard` field from the project config so the state
 * reverts to the default off. Used by `/adr guard reset`. */
export function clearState(): boolean {
  return adrSwitch.clear()
}

export function isEnabled(): boolean {
  warnLegacyAdrKeys(detectLegacyAdrKeys(readProjectConfig()))
  return adrSwitch.isOn()
}

// ─── Legacy key deprecation (read-compat, §6.4) ──────────────────────
//
// The three pre-refactor keys (adrGuard/adrDir/adrLayout) still carry full
// authority, but they are deprecated and will be REMOVED at v1.0 — the
// `adr.*` block is their future home. Detection stays read-only; a single
// deprecation warning fires per key-set per process on the real config-read
// paths (guard gate, getAdrDir, getAdrLayout).

const LEGACY_ADR_KEYS = ["adrGuard", "adrDir", "adrLayout"] as const

/** Names of the deprecated legacy keys present in `cfg` (pure). */
export function detectLegacyAdrKeys(cfg: Record<string, unknown> | null): string[] {
  if (!cfg) return []
  return LEGACY_ADR_KEYS.filter((k) => cfg[k] !== undefined)
}

const warnedLegacyKeySets = new Set<string>()

/** Emit the deprecation warning once per distinct key-set per process.
 * Channels: console.warn with the i18n notice — same convention as the
 * shared config notices (model-catalog). Never throws. */
function warnLegacyAdrKeys(keys: string[]): void {
  if (keys.length === 0) return
  const signature = keys.join(",")
  if (warnedLegacyKeySets.has(signature)) return
  warnedLegacyKeySets.add(signature)
  refreshLocale()
  console.warn(tr("guard.adr.legacyKeyWarning", { keys: keys.join(", ") }))
}

/** Test-only: clear the once-per-process warning registry. */
export function resetLegacyAdrKeyWarnings(): void {
  warnedLegacyKeySets.clear()
}

// ─── ADR directory ────────────────────────────────────────────────────

export const DEFAULT_ADR_DIR = "docs/adr"

export function getAdrDir(): string {
  const cfg = readProjectConfig()
  warnLegacyAdrKeys(detectLegacyAdrKeys(cfg))
  const v = cfg?.adrDir
  if (typeof v === "string" && v.trim() !== "") {
    return v.trim().replace(/\\/g, "/").replace(/\/+$/, "")
  }
  return DEFAULT_ADR_DIR
}

// ─── Hierarchy Mode (auto / flat / hierarchical) ─────────────────────
//
// Distinct from the on/off switch above — three modes with real
// behavioral differences, so it stays as its own state machine.

export type AdrLayout = "auto" | "flat" | "hierarchical"

const VALID_MODES = new Set<string>(["auto", "flat", "hierarchical"])
const MODE_FIELD = "adrLayout"
const DEFAULT_LAYOUT: AdrLayout = "auto"

const LAYOUT_ALIASES: Record<string, AdrLayout> = {
  // auto
  auto: "auto",
  a: "auto",
  smart: "auto",
  default: "auto",

  // flat
  flat: "flat",
  f: "flat",
  single: "flat",
  s: "flat",
  linear: "flat",

  // hierarchical
  hierarchical: "hierarchical",
  hierarchy: "hierarchical",
  h: "hierarchical",
  tree: "hierarchical",
  t: "hierarchical",
  nested: "hierarchical",
  multi: "hierarchical",
  levels: "hierarchical",
  l: "hierarchical",
}

export function normalizeAdrLayout(layout: unknown): AdrLayout | null {
  if (typeof layout !== "string") return null
  const s = layout.trim().toLowerCase()
  return LAYOUT_ALIASES[s] ?? null
}

export function getAdrLayout(): AdrLayout {
  const cfg = readProjectConfig()
  warnLegacyAdrKeys(detectLegacyAdrKeys(cfg))
  // Legacy `adrLayout` keeps authority when present; the new `adr.layout`
  // is the fallback for projects configured only via the adr.* block.
  const normalized = normalizeAdrLayout(cfg?.adrLayout) ?? normalizeAdrLayout(readAdrBlock(cfg)["layout"])
  return normalized ?? DEFAULT_LAYOUT
}

export function setAdrLayout(layout: AdrLayout): boolean {
  const normalized = normalizeAdrLayout(layout)
  if (!normalized) return false
  return setConfigField(MODE_FIELD, normalized).ok
}

export function clearAdrLayout(): boolean {
  return clearConfigField(MODE_FIELD).ok
}

// ─── adr.* config block (multi-style ADL, §6) ────────────────────────
//
// ADDITIVE over the legacy three keys (adrGuard/adrDir/adrLayout) — those
// keep working unchanged and are never written here. The block lives in
// the same project `.ocp/ocp.json`:
//
//   { "adr": { "style": "madr", "numbering": "sequential",
//              "layout": "auto", "governance": "none", "suite": "…" } }
//
// `style` affects only NEW documents: --style > adr.style >
// madr fallback. Existing documents dispatch by their own frontmatter.

// `ocp` is the OCP-native container style (OCP grammar, ADR-0007
// §7): one record per iteration file, sections as structured payload. The two
// industry templates stay canonical for interop; existing documents
// dispatch by their own frontmatter.

const VALID_STYLES = new Set<string>(["nygard", "madr", "ocp"])
const VALID_NUMBERINGS = new Set<string>(["sequential", "iteration"])
const VALID_GOVERNANCE = new Set<string>(["none", "review", "strict"])

export interface AdrConfig {
  style: AdrStyle // "madr" fallback (zero-config behavior unchanged)
  numbering: AdrNumbering // "sequential" default
  layout: AdrLayout | null // null → legacy adrLayout / default governs
  governance: AdrGovernance // "none" default
  suite: string | null // informational init-time label; never re-enforces
  // ── Project-level overrides (Phase 7 — all OPT-IN, defaults preserve
  //    pre-Phase-7 behavior so existing projects don't shift) ──
  /** Filename template. Supported placeholders: {id} (bare or prefixed per
   *  style), {slug} (post-slugify). Whitespace stripped, must contain {id}. */
  filenamePattern: string
  /** Slugify transform applied to titles before filename use. */
  slugStyle: "kebab" | "snake" | "lower"
  /** Extra H2 sections appended after the style's own body. Each entry is
   *  the full heading line ("## Risks") — body is left empty for the
   *  author to fill. Append order is the array order. */
  extraSections: string[]
  /** Columns rendered in the generated INDEX.md table, drawn from the
   *  normalized record (id/title/style/layer/status/domain/iteration/
   *  created). Default = every column. */
  indexColumns: IndexColumn[]
}

export type IndexColumn =
  | "id"
  | "title"
  | "style"
  | "layer"
  | "status"
  | "domain"
  | "iteration"
  | "created"

export const DEFAULT_INDEX_COLUMNS: IndexColumn[] = [
  "id",
  "title",
  "style",
  "layer",
  "status",
  "domain",
  "iteration",
  "created",
]

const VALID_SLUG_STYLES = new Set<string>(["kebab", "snake", "lower"])
const VALID_INDEX_COLUMNS = new Set<string>([
  "id",
  "title",
  "style",
  "layer",
  "status",
  "domain",
  "iteration",
  "created",
])

export function normalizeAdrStyle(style: unknown): AdrStyle | null {
  if (typeof style !== "string") return null
  const s = style.trim().toLowerCase()
  return VALID_STYLES.has(s) ? (s as AdrStyle) : null
}

export function normalizeAdrNumbering(numbering: unknown): AdrNumbering | null {
  if (typeof numbering !== "string") return null
  const s = numbering.trim().toLowerCase()
  return VALID_NUMBERINGS.has(s) ? (s as AdrNumbering) : null
}

export function normalizeAdrGovernance(governance: unknown): AdrGovernance | null {
  if (typeof governance !== "string") return null
  const s = governance.trim().toLowerCase()
  return VALID_GOVERNANCE.has(s) ? (s as AdrGovernance) : null
}

// Unknown governance values degrade to 'none' (zero-friction default, §6.2)
// with one warning per distinct value per process — same convention as the
// legacy-key deprecation warning.
const warnedGovernanceValues = new Set<string>()

function warnUnknownGovernance(value: unknown): void {
  const signature = String(value)
  if (warnedGovernanceValues.has(signature)) return
  warnedGovernanceValues.add(signature)
  refreshLocale()
  console.warn(tr("guard.adr.governanceUnknownWarning", { value: signature }))
}

/** Test-only: clear the once-per-process unknown-governance registry. */
export function resetAdrGovernanceWarnings(): void {
  warnedGovernanceValues.clear()
}

/** Raw (unvalidated) `adr` object from project config, {} when absent. */
function readAdrBlock(cfg: Record<string, unknown> | null): Record<string, unknown> {
  const block = cfg?.adr
  return block && typeof block === "object" && !Array.isArray(block) ? (block as Record<string, unknown>) : {}
}

export function getAdrConfig(): AdrConfig {
  const block = readAdrBlock(readProjectConfig())
  const governance = normalizeAdrGovernance(block.governance)
  if (governance === null && block.governance !== undefined) {
    warnUnknownGovernance(block.governance)
  }
  return {
    style: normalizeAdrStyle(block.style) ?? "madr",
    numbering: normalizeAdrNumbering(block.numbering) ?? "sequential",
    layout: normalizeAdrLayout(block.layout),
    governance: governance ?? "none",
    suite: typeof block.suite === "string" && block.suite.trim() !== "" ? block.suite.trim() : null,
    ...readProjectOverrides(block),
  }
}

/** Build an AdrConfig from an already-parsed `.ocp/ocp.json` object
 *  without re-reading the file. Used by the per-turn system prompt
 *  fragment to avoid a second IO per chat turn. Warning side-effects
 *  (unknown governance/override) are identical to getAdrConfig(). */
export function getAdrConfigFromParsed(parsed: Record<string, unknown> | null): AdrConfig {
  const block = readAdrBlock(parsed)
  const governance = normalizeAdrGovernance(block.governance)
  if (governance === null && block.governance !== undefined) {
    warnUnknownGovernance(block.governance)
  }
  return {
    style: normalizeAdrStyle(block.style) ?? "madr",
    numbering: normalizeAdrNumbering(block.numbering) ?? "sequential",
    layout: normalizeAdrLayout(block.layout),
    governance: governance ?? "none",
    suite: typeof block.suite === "string" && block.suite.trim() !== "" ? block.suite.trim() : null,
    ...readProjectOverrides(block),
  }
}

/** Style resolution for NEW documents (§6): explicit > config > madr. */
export function resolveAdrStyleForNew(explicit?: string): AdrStyle {
  return normalizeAdrStyle(explicit) ?? getAdrConfig().style
}

// ─── Phase 7 — project-level ADR overrides ────────────────────────────
//
// Four OPT-IN fields under the existing `adr.*` block. Every default
// preserves pre-Phase-7 behavior — existing projects shift nothing.
// Unknown values degrade silently to the default with a one-shot warn,
// mirroring the governance-value convention above.

const DEFAULT_FILENAME_PATTERN = "{id}-{slug}"
const DEFAULT_SLUG_STYLE: AdrConfig["slugStyle"] = "kebab"
const DEFAULT_EXTRA_SECTIONS: string[] = []
const DEFAULT_INDEX_COLUMNS_VALUE: IndexColumn[] = [...DEFAULT_INDEX_COLUMNS]

const warnedProjectOverrideKeys = new Set<string>()

function warnProjectOverrideOnce(key: string, value: unknown): void {
  const signature = `${key}:${String(value)}`
  if (warnedProjectOverrideKeys.has(signature)) return
  warnedProjectOverrideKeys.add(signature)
  refreshLocale()
  console.warn(tr("guard.adr.overrideUnknownWarning", { key, value: String(value) }))
}

/** Test-only: clear the once-per-process project-override warning registry. */
export function resetAdrOverrideWarnings(): void {
  warnedProjectOverrideKeys.clear()
}

/** Normalize a project-supplied filename pattern. The pattern MUST
 * contain `{id}`; the `{slug}` placeholder is optional. Whitespace is
 * collapsed; any other `{…}` placeholder is stripped with a warning.
 * Pure — exported for unit tests. */
export function normalizeFilenamePattern(pattern: unknown): string | null {
  if (typeof pattern !== "string") return null
  const trimmed = pattern.trim()
  if (trimmed === "") return null
  if (!trimmed.includes("{id}")) return null
  // Allow {id} and {slug} only; warn on anything else.
  const stray = trimmed.match(/\{([^}]+)\}/g)?.filter((p) => p !== "{id}" && p !== "{slug}") ?? []
  for (const s of stray) warnProjectOverrideOnce("filenamePattern.placeholder", s)
  // Collapse whitespace inside the pattern (a single space inside is OK;
  // a tab or newline is a copy-paste mistake).
  return trimmed.replace(/\s+/g, " ")
}

/** Normalize a slug-style key. Unknown keys → null (caller falls back). */
export function normalizeSlugStyle(value: unknown): AdrConfig["slugStyle"] | null {
  if (typeof value !== "string") return null
  const s = value.trim().toLowerCase()
  return VALID_SLUG_STYLES.has(s) ? (s as AdrConfig["slugStyle"]) : null
}

/** Normalize an `extraSections` array: each entry must be a non-empty
 * H2 heading line. Returns the validated list (possibly empty). Pure. */
export function normalizeExtraSections(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const raw of value) {
    if (typeof raw !== "string") return null
    const line = raw.trim()
    if (line === "") return null
    // Section must be an H2. Caller decides whether stricter heading
    // grammar (parens, language hint) is allowed — we accept anything
    // beginning with `## `.
    if (!line.startsWith("## ")) return null
    out.push(line)
  }
  return out
}

/** Normalize an `indexColumns` array: each entry must be a known column
 * key, drawn (no duplicates) from the canonical 8. Pure. */
export function normalizeIndexColumns(value: unknown): IndexColumn[] | null {
  if (!Array.isArray(value)) return null
  if (value.length === 0) return null
  const seen = new Set<string>()
  const out: IndexColumn[] = []
  for (const raw of value) {
    if (typeof raw !== "string") return null
    const k = raw.trim().toLowerCase()
    if (!VALID_INDEX_COLUMNS.has(k)) return null
    if (seen.has(k)) return null
    seen.add(k)
    out.push(k as IndexColumn)
  }
  return out
}

function readProjectOverrides(block: Record<string, unknown>): Pick<
  AdrConfig,
  "filenamePattern" | "slugStyle" | "extraSections" | "indexColumns"
> {
  const fp = normalizeFilenamePattern(block.filenamePattern)
  if (fp === null && block.filenamePattern !== undefined) {
    warnProjectOverrideOnce("filenamePattern", block.filenamePattern)
  }
  const ss = normalizeSlugStyle(block.slugStyle)
  if (ss === null && block.slugStyle !== undefined) {
    warnProjectOverrideOnce("slugStyle", block.slugStyle)
  }
  const es = normalizeExtraSections(block.extraSections)
  if (es === null && block.extraSections !== undefined) {
    warnProjectOverrideOnce("extraSections", JSON.stringify(block.extraSections))
  }
  const ic = normalizeIndexColumns(block.indexColumns)
  if (ic === null && block.indexColumns !== undefined) {
    warnProjectOverrideOnce("indexColumns", JSON.stringify(block.indexColumns))
  }
  return {
    filenamePattern: fp ?? DEFAULT_FILENAME_PATTERN,
    slugStyle: ss ?? DEFAULT_SLUG_STYLE,
    extraSections: es ?? DEFAULT_EXTRA_SECTIONS,
    indexColumns: ic ?? DEFAULT_INDEX_COLUMNS_VALUE,
  }
}

/**
 * Phase-1 gate for PERSISTING a style as `adr.style`: the name must
 * normalize AND its adapter must be registered — persisting an
 * unregistered style would make every later `/adr new` without `--style`
 * throw. Suites resolve through ADR_SUITES (style/numbering/layout/
 * governance bundles), so the `--style`
 * override path is the one to guard — symmetric with the `/adr new` guard
 * in adr-command.
 */
export function isAdrStyleAvailable(style: unknown): boolean {
  const normalized = normalizeAdrStyle(style)
  return normalized !== null && findAdrStyleAdapter(normalized) !== null
}

// ─── Nested `adr` block upsert (comment-preserving) ──────────────────

/** True when `index` sits after a `//` line-comment marker on its line
 * (string-aware enough for config text: quotes toggle string state). */
function isInsideLineComment(raw: string, index: number): boolean {
  const lineStart = raw.lastIndexOf("\n", index - 1) + 1
  let inString = false
  for (let i = lineStart; i < index; i++) {
    const c = raw[i]
    if (inString) {
      if (c === "\\") i++
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === "/" && raw[i + 1] === "/") return true
  }
  return false
}

/** Locate an ACTIVE `"adr" : {` object; returns the `{` index or -1. */
function findAdrObjectOpen(raw: string): number {
  const re = /"adr"\s*:\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    if (!isInsideLineComment(raw, m.index)) return m.index + m[0].length - 1
  }
  return -1
}

/** String-aware brace match: index of the `}` closing the `{` at `open`. */
function matchBrace(raw: string, open: number): number {
  let depth = 0
  let inString = false
  for (let i = open; i < raw.length; i++) {
    const c = raw[i]
    if (inString) {
      if (c === "\\") i++
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function jsonEscape(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

function upsertKeysInObjectSpan(
  inner: string,
  fields: Record<string, string> | Record<string, string | string[]>,
): string {
  let out = inner
  const missing: string[] = []
  for (const key of Object.keys(fields)) {
    const member = renderAdrBlockMember(key, fields[key])
    // `/g`: exec must advance past commented-out matches, else the same
    // commented duplicate re-matches forever. Array values match a
    // longer span (`[...]`) so the literal-string regex below is
    // sufficient — both shapes are covered by the alternation.
    const re = new RegExp(`"${key}"\\s*:\\s*(?:"(?:[^"\\\\]|\\\\.)*"|\\[[^\\]]*\\])`, "g")
    // Replace only an ACTIVE key — a commented-out duplicate line must
    // stay untouched (otherwise the real key goes stale).
    let m: RegExpExecArray | null
    let replaced = false
    while ((m = re.exec(out)) !== null) {
      if (!isInsideLineComment(out, m.index)) {
        out = out.slice(0, m.index) + member + out.slice(m.index + m[0].length)
        replaced = true
        break
      }
    }
    if (!replaced) missing.push(key)
  }
  if (missing.length === 0) return out
  // Insert missing keys before the closing brace. When the host ends with
  // `//` comment lines, strip them first and re-attach AFTER the comma —
  // appending the comma to the unstripped text would land inside the
  // comment and corrupt the JSONC.
  const host = out.replace(/(\n[ \t]*\/\/[^\n]*)+\s*$/, "")
  const tail = out.slice(host.length)
  const needsComma = host.trim() !== "" && !host.trimEnd().endsWith("{") && !host.trimEnd().endsWith(",")
  const members = missing.map((k) => `\n    ${renderAdrBlockMember(k, fields[k])}`).join(",")
  // Re-attach stripped comments after the comma; a pure-whitespace tail
  // (nothing stripped) is dropped — members carry their own leading `\n`.
  return host + (needsComma ? "," : "") + (/^\s*\/\//.test(tail) ? tail : "") + members + "\n  "
}

/** Render one `"key": <value>` member line. String values are JSON-escaped
 *  and double-quoted; array values are JSON-serialized as a literal
 *  (no surrounding quotes — the surrounding `"key": …` already wraps the
 *  whole expression). Phase 7 uses this so `extraSections` /
 *  `indexColumns` serialize as JSON arrays, not JSON-encoded strings. */
function renderAdrBlockMember(key: string, value: string | string[]): string {
  if (Array.isArray(value)) {
    return `"${key}": ${JSON.stringify(value)}`
  }
  return `"${key}": "${jsonEscape(value)}"`
}

/**
 * Targeted upsert of `fields` into the nested `adr` object of a config's
 * raw text: an existing active block is edited in place (other keys and
 * comments survive); otherwise a new `"adr": { … }` member is appended
 * to the root object. Strict-JSON valid in both cases.
 */
export function upsertAdrBlock(
  raw: string,
  fields: Record<string, string> | Record<string, string | string[]>,
): string {
  const open = findAdrObjectOpen(raw)
  if (open !== -1) {
    const close = matchBrace(raw, open)
    if (close !== -1) {
      return raw.slice(0, open + 1) + upsertKeysInObjectSpan(raw.slice(open + 1, close), fields) + raw.slice(close)
    }
  }
  const member = `"adr": {\n${Object.entries(fields)
    .map(([k, v]) => `    ${renderAdrBlockMember(k, v)}`)
    .join(",\n")}\n  }`
  if (raw.trim() === "") return `{\n  ${member}\n}\n`
  // Trailing `//` comment lines (e.g. a parked template) are stripped
  // BEFORE locating the root close — a `}` inside a footer comment would
  // otherwise be picked as `close` and the adr member would land outside
  // the root object, comma inside the comment (unparseable JSONC).
  const body = raw.replace(/(\n[ \t]*\/\/[^\n]*)+\s*$/, "")
  const tail = raw.slice(body.length)
  const close = body.lastIndexOf("}")
  if (close === -1) throw new Error("no root object in config file")
  const head = body.slice(0, close).replace(/\s+$/, "")
  // In-head trailing `//` comment lines are re-attached AFTER the comma —
  // a comma appended to the unstripped head would land inside the comment
  // and corrupt the whole config.
  const host = head.replace(/(\n[ \t]*\/\/[^\n]*)+\s*$/, "")
  const prev = host.trimEnd()
  const needsComma = prev !== "" && !prev.endsWith("{") && !prev.endsWith(",")
  return (needsComma ? host + "," + head.slice(host.length) : head) + `\n  ${member}\n` + body.slice(close) + tail
}

/**
 * Persist resolved `adr.*` values into the project `.ocp/ocp.json`.
 * Never touches the legacy keys. Never throws (read-only project dir
 * degrades to false), mirroring setConfigField's contract. Re-running
 * with the same fields is a stable no-op — same content out.
 */
/**
 * Write a single project-level ADR config key (suite fields + Phase 7
 * overrides) into the nested `adr` block. Validates via the matching
 * normalizer; an invalid value degrades to false without touching disk.
 * Mirrors `setConfigField`'s read-only failure mode. Array-valued
 * overrides (extraSections, indexColumns) round-trip as proper JSON
 * arrays — not double-encoded strings. Suite fields reuse the same
 * validators `/adr init` uses, so the single-key write path is fully
 * consistent with the bulk init path.
 */
export function setAdrConfigKey(key: AdrConfigKey, value: string): boolean {
  const parsed = parseAdrConfigKeyValue(key, value)
  if (parsed === null) return false
  return writeAdrConfigKey(key, parsed)
}

/** Normalize + parse one config-key value. String fields round-trip as a
 *  string; array fields return a `string[]` for proper JSON serialization.
 *  Suite fields (style / numbering / layout / governance) reuse their
 *  existing normalizers and persist as plain strings — `setAdrConfigFields`
 *  already handles that path. Returns null when the value is invalid. */
function parseAdrConfigKeyValue(key: AdrConfigKey, value: string): string | string[] | null {
  switch (key) {
    case "filenamePattern":
      return normalizeFilenamePattern(value)
    case "slugStyle":
      return normalizeSlugStyle(value)
    case "extraSections": {
      let parsed: unknown
      try {
        parsed = JSON.parse(value)
      } catch {
        parsed = value
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s !== "")
      }
      const v = normalizeExtraSections(parsed)
      return v
    }
    case "indexColumns": {
      let parsed: unknown
      try {
        parsed = JSON.parse(value)
      } catch {
        parsed = value.split(/[,\s]+/).filter((s) => s !== "")
      }
      const v = normalizeIndexColumns(parsed)
      return v
    }
    case "style":
      return normalizeAdrStyle(value)
    case "numbering":
      return normalizeAdrNumbering(value)
    case "layout":
      return normalizeAdrLayout(value)
    case "governance":
      return normalizeAdrGovernance(value)
  }
}

/** Upsert one config key into the nested `adr` block via raw text
 *  surgery. Suite fields route through the same comment-preserving
 *  upsert path that `/adr init` uses; array-valued overrides
 *  (extraSections, indexColumns) pass the parsed array straight
 *  through so the writer emits a JSON literal instead of a
 *  double-encoded string. */
function writeAdrConfigKey(key: AdrConfigKey, value: string | string[]): boolean {
  const file = writableProjectConfigFile()
  let raw: string
  try {
    raw = existsSync(file) ? readFileSync(file, "utf-8") : ""
  } catch {
    return false
  }
  let updated: string
  try {
    updated = upsertAdrBlock(raw, { [key]: value })
  } catch {
    return false
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, updated, "utf-8")
    return true
  } catch {
    return false
  }
}

/** Remove one project-level config key from the nested `adr` block,
 * falling back to the in-code default. Mirrors setAdrConfigFields's
 * read-only failure mode. The shared `clearConfigField` only handles
 * flat top-level keys, so we hand-roll the nested-block removal here.
 * Suite fields fall back through the same path as Phase 7 overrides —
 * `getAdrConfig()` returns "none / sequential / auto / madr" defaults
 * when the block key is absent, so removal cleanly reverts to the
 * zero-config baseline. */
export function clearAdrConfigKey(key: AdrConfigKey): boolean {
  const file = writableProjectConfigFile()
  let raw: string
  try {
    raw = existsSync(file) ? readFileSync(file, "utf-8") : ""
  } catch {
    return false
  }
  const updated = removeKeyFromAdrBlock(raw, key)
  if (updated === null) return false
  try {
    writeFileSync(file, updated, "utf-8")
    return true
  } catch {
    return false
  }
}

/** Strip one `"key": "value"` (with its preceding comma + newline
 * when present) from an active `"adr": { … }` block. Returns null
 * when the block or key is absent, or when the key is only
 * commented-out (silent skip). Pure. */
function removeKeyFromAdrBlock(raw: string, key: string): string | null {
  const open = findAdrObjectOpen(raw)
  if (open === -1) return null
  const close = matchBrace(raw, open)
  if (close === -1) return null
  const inner = raw.slice(open + 1, close)
  const re = new RegExp(`"${key}"\\s*:\\s*(?:"(?:[^"\\\\]|\\\\.)*"|\\[[^\\]]*\\])`, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(inner)) !== null) {
    if (isInsideLineComment(inner, m.index)) continue
    let cutStart = m.index
    let cutEnd = m.index + m[0].length
    // Consume the trailing comma + the surrounding newline + indent.
    // Two shapes: (a) "key": "v",\n  next  → drop comma + newline +
    //                            whitespace; (b) prev,\n  "key": "v"  →
    //                            drop newline + indent + key + comma.
    let t = cutEnd
    while (t < inner.length && /[ \t\n]/.test(inner[t])) t++
    if (inner[t] === ",") {
      cutEnd = t + 1
      while (cutEnd < inner.length && /[ \t]/.test(inner[cutEnd])) cutEnd++
      if (inner[cutEnd] === "\n") cutEnd++
    } else {
      // Walk backward past BOTH whitespace AND newlines looking for the
      // previous comma — the value may sit on its own line, separated
      // from the comma by indent + newline.
      let p = cutStart - 1
      while (p >= 0 && /[ \t\n]/.test(inner[p])) p--
      if (p >= 0 && inner[p] === ",") {
        let q = p + 1
        while (q < inner.length && /[ \t]/.test(inner[q])) q++
        if (inner[q] === "\n") q++
        cutStart = q
      } else {
        // No comma on either side — the value sits in isolation. Strip
        // the surrounding newline + indent (and any trailing newline)
        // so the block stays well-formed.
        let lead = cutStart
        while (lead > 0 && /[ \t\n]/.test(inner[lead - 1])) lead--
        if (inner[lead - 1] === "\n") lead--
        cutStart = lead
        while (cutEnd < inner.length && /[ \t]/.test(inner[cutEnd])) cutEnd++
        if (inner[cutEnd] === "\n") cutEnd++
      }
    }
    return raw.slice(0, open + 1) + inner.slice(0, cutStart) + inner.slice(cutEnd) + raw.slice(close)
  }
  return null
}

/** Every project-level ADR config key the `/adr config` command accepts.
 *  Suite fields (style/numbering/layout/governance) live in the same
 *  `adr.*` block as Phase 7 overrides (filenamePattern/slugStyle/
 *  extraSections/indexColumns) — both groups route through the same
 *  comment-preserving upsert path so a user can set/clear any key
 *  uniformly. */
export type AdrConfigKey =
  | "filenamePattern"
  | "slugStyle"
  | "extraSections"
  | "indexColumns"
  | "style"
  | "numbering"
  | "layout"
  | "governance"

export function setAdrConfigFields(fields: Record<string, string>): boolean {
  const file = writableProjectConfigFile()
  let raw: string
  try {
    raw = existsSync(file) ? readFileSync(file, "utf-8") : ""
  } catch {
    return false
  }
  let updated: string
  try {
    updated = upsertAdrBlock(raw, fields)
  } catch {
    return false
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, updated, "utf-8")
    return true
  } catch {
    return false
  }
}

// ─── /adr init suites (§6.3) — data-driven ───────────────────────────

/** One suite row from adr-suites.json: a named bundle of adr.* values plus
 * its wizard presentation (icon + i18n desc key). Suites are an init-time
 * bundling only; individual options remain the source of truth and stay
 * overridable. Adding a suite = one JSON row + two i18n strings — no code
 * change (the same schema-driven philosophy as plugins/tui/wizard-schema). */
export interface AdrSuiteRow {
  name: string
  icon: string
  descKey: string
  fields: Record<string, string>
}

const ADR_SUITES_FILE = joinPath(dirname(fileURLToPath(import.meta.url)), "adr-suites.json")
const SUITE_FIELD_KEYS = ["style", "numbering", "layout", "governance"] as const

function loadAdrSuites(): Record<string, AdrSuiteRow> {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(ADR_SUITES_FILE, "utf-8"))
  } catch (err) {
    throw new Error(`adr-suites.json is missing or unparseable: ${String(err)}`)
  }
  const rows = (raw as { suites?: unknown }).suites
  if (!Array.isArray(rows)) throw new Error("adr-suites.json must carry a 'suites' array")

  const out: Record<string, AdrSuiteRow> = {}
  for (const row of rows as Array<Record<string, unknown>>) {
    const name = typeof row?.name === "string" ? row.name.trim().toLowerCase() : ""
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      throw new Error(`adr-suites.json: suite row with invalid name: ${JSON.stringify(row?.name)}`)
    }
    if (name === "custom") throw new Error("adr-suites.json: 'custom' is reserved — it is not a data row")
    if (out[name]) throw new Error(`adr-suites.json: duplicate suite '${name}'`)
    const icon = typeof row.icon === "string" && row.icon !== "" ? row.icon : "📦"
    const descKey = typeof row.descKey === "string" ? row.descKey : ""
    if (!(descKey in STRINGS)) {
      throw new Error(`adr-suites.json: suite '${name}' references unknown i18n descKey '${descKey}'`)
    }
    const fields = (row.fields ?? {}) as Record<string, unknown>
    const clean: Record<string, string> = {}
    for (const [key, value] of Object.entries(fields)) {
      if (!SUITE_FIELD_KEYS.includes(key as (typeof SUITE_FIELD_KEYS)[number])) {
        throw new Error(`adr-suites.json: suite '${name}' has unknown field '${key}'`)
      }
      const v = typeof value === "string" ? value : ""
      const valid =
        (key === "style" && normalizeAdrStyle(v) !== null) ||
        (key === "numbering" && normalizeAdrNumbering(v) !== null) ||
        (key === "layout" && normalizeAdrLayout(v) !== null) ||
        (key === "governance" && normalizeAdrGovernance(v) !== null)
      if (!valid) {
        throw new Error(`adr-suites.json: suite '${name}' field '${key}' has invalid value '${v}'`)
      }
      clean[key] = v
    }
    out[name] = { name, icon, descKey, fields: clean }
  }
  if (Object.keys(out).length === 0) throw new Error("adr-suites.json: no suites defined")
  return out
}

/** Suite table, loaded once from adr-suites.json. Validation is
 * fail-closed: a bad builtin row throws at load (surfaced by any test that
 * imports this module) instead of silently degrading /adr init. */
export const ADR_SUITES: Record<string, AdrSuiteRow> = loadAdrSuites()

/** Suite names are data: any loaded row name, plus the reserved
 * pseudo-suite `custom`. */
export function normalizeAdrSuite(name: unknown): string | null {
  if (typeof name !== "string") return null
  const s = name.trim().toLowerCase()
  return s === "custom" || s in ADR_SUITES ? s : null
}

export interface AdrSuiteSelection {
  suite: string
  fields: Record<string, string> // resolved adr.* values incl. informational suite label
}

/**
 * Resolve a suite name + per-option overrides into the exact adr.* fields
 * to persist. `custom` (or any unknown name) resolves to overrides only —
 * callers must ask for explicit options (detection never applies silently).
 */
export function resolveAdrSuite(suite: string, overrides: Record<string, string> = {}): AdrSuiteSelection {
  const base = ADR_SUITES[suite]?.fields ?? {}
  const fields: Record<string, string> = { ...base, ...overrides }
  fields.suite = suite
  return { suite, fields }
}

export interface AdrInitSignals {
  hasAgentConfig: boolean // .opencode/ present
  packageCount: number // monorepo packages under packages/apps/services/modules/libs
  hasMigrations: boolean // migrations/ directory
  recommendedSuite: "standard" | "evolution"
}

/** Codebase reconnaissance for /adr init. Detection PRE-SELECTS only —
 * it never applies a suite silently (§6.3). */
export function detectAdrInitSignals(projectDir: string = getProjectDir()): AdrInitSignals {
  const hasAgentConfig = existsSync(joinPath(projectDir, ".opencode"))
  const hasMigrations = existsSync(joinPath(projectDir, "migrations"))
  let packageCount = 0
  for (const parent of ["packages", "apps", "services", "modules", "libs"]) {
    const full = joinPath(projectDir, parent)
    if (!existsSync(full)) continue
    try {
      packageCount += readdirSync(full, { withFileTypes: true }).filter((e) => e.isDirectory()).length
    } catch {
      // unreadable dir — skip silently, detection is advisory only
    }
  }
  return {
    hasAgentConfig,
    packageCount,
    hasMigrations,
    recommendedSuite: hasAgentConfig || hasMigrations || packageCount >= 2 ? "evolution" : "standard",
  }
}

function joinPath(a: string, b: string): string {
  return `${a.replace(/[\\/]+$/, "")}/${b}`
}

// ─── Slash command parsing ────────────────────────────────────────────

export const COMMAND_NAME = "adr-guard"
export const ADR_COMMAND = "adr"

/**
 * Parse the first argument of a `/adr guard <state>` (or `/adr-guard <state>`
 * alias) call. Returns null if the argument is missing or not a valid state
 * (caller treats null as status).
 *
 *   /adr guard      → null (status)
 *   /adr guard on   → "on"
 *   /adr guard off  → "off"
 */
export function parseStateArg(args: unknown): GuardState | null {
  return adrSwitch.parseArg(args)
}

const RESET_ALIASES = ["reset", "default", "clear"]

/** True when the first argument asks to reset the switch to the default off. */
export function parseResetArg(args: unknown): boolean {
  if (typeof args !== "string") return false
  const first = args.trim().split(/\s+/)[0]?.toLowerCase()
  return RESET_ALIASES.includes(first)
}
