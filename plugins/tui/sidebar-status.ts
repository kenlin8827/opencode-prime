/// <reference types="bun" />
/**
 * Sidebar Status — TUI slot plugin that renders two vertical status groups
 * inside the OpenCode right sidebar:
 *   "OCP"         — active state of guard/mode plugins (adr-guard, e2e-guard,
 *                   auto-advisor) + the active profile; `deepseek-anchor`
 *                   is only shown when the current model is DeepSeek V4 Pro
 *                   (the plugin is a no-op for other models, so showing it
 *                   unconditionally would be noise)
 *   "OCP project" — current-directory OCP project state (/project init
 *                   scaffolding, commit discipline) and code-intelligence
 *                   capabilities (codegraph/gitnexus indexes, serena)
 *
 * This replaces the per-plugin session.created announce (toast/inject) with
 * a single always-visible "OCP" section. When a user toggles a guard via
 * its slash command, the panel picks up the change on the next poll cycle
 * (the server-side plugin still fires a confirmation toast for the toggle).
 *
 * Registration: `tui.template.jsonc` → `plugin` array (TUI plugins have no directory
 * auto-discovery — they must be listed there).
 *
 * Slot: `sidebar_content` (session view) — renders as a vertical group
 * labeled "OCP" inside the right sidebar, mirroring the MCP/LSP section
 * style already used by OpenCode's sidebar.
 *
 * State sources (all read-only, same logic as each plugin's config module):
 *   - adrGuard        → project opencode.jsonc field (on | off, default off)
 *   - e2eGuard        → project opencode.jsonc field (on | off, default off)
 *   - autoAdvisorMode → project opencode.jsonc field (off | lite | full, default off)
 *   - deepSeekAnchor  → ~/.config/opencode/.deepseek-anchor-enabled (on | off, default on)
 *   - activeProfile   → ~/.config/opencode/.active-profile (name | none)
 *   - projectScaffold → /project init targets exist? (.opencode/opencode.jsonc +
 *                        docs/git-commits.md + AGENTS.md → init | partial | none)
 *   - commitDiscipline→ docs/git-commits.md exists (file-as-switch, same rule
 *                        as project-manager hasConventionFile())
 *   - capabilities     → codegraph/gitnexus: index dir exists AND MCP enabled
 *                        (global config); serena: MCP enabled. Same rules as
 *                        project-profiler buildProfile(). Staleness (git log)
 *                        is NOT polled — too heavy for the 2s cycle.
 *   - formatter        → mirrors project-manager-dprint planDprintSetup():
 *                        ready (dprint.json[c] present) | other (a non-dprint
 *                        formatter exists) | missing (none) | no-pkg.
 *
 * Model detection (for deepseek-anchor gating):
 *   - Initial: api.state.config.model ("<provider>/<model_id>" → id only)
 *   - Live:    api.event.on("message.updated") carries AssistantMessage /
 *              UserMessage with the actual modelID; refresh the panel when
 *              it changes (tier swap, etc.)
 *
 * Display rules (the panel is space-conscious — we drop default-empty
 * states and only show actionable signals):
 *   - "OCP" group: every guard row renders (ON/OFF) — at-a-glance config
 *     snapshot. `profile` row only appears when one is active. The
 *     `deepseek-anchor` row is gated on the current model being V4 Pro.
 *   - "OCP project" group: `project` row always (INIT/PARTIAL/NOT INIT).
 *     The rest (commit-discipline, capabilities, formatter) are gated
 *     on `project === "init"`. OFF / NONE / NO PKG rows are filtered out.
 *     NOT INIT and NO INDEX are kept as actionable signals.
 *   - Header: `─ OCP v<version> ─`; grows a `↑ vX.Y.Z` warning-colour
 *     suffix when an async GitHub probe finds a newer release.
 */

import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiSlotContext,
} from "@opencode-ai/plugin/tui"
import { createSignal } from "solid-js"
// Programmatically create JSX elements via the SolidJS factory.
// We use `jsx()` instead of JSX syntax to avoid tsconfig jsxImportSource
// complications — the @opentui/solid JSX namespace is local, not global.
import { jsx } from "@opentui/solid/jsx-runtime"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { loadTgrepOptions } from "../tgrep/tgrep-config"
import { resolveTgrepCapability, type TgrepCapabilityState } from "../tgrep/tgrep-service"

// ─── Theme shape ───────────────────────────────────────────────────

interface ThemeColors {
  // Semantic colour keys mirror OpenCode's built-in theme palette (see
  // install/src/ui/builtin-themes.ts — every theme defines `error` as a
  // red tone distinct from `warning`'s orange/yellow). Aligned with the
  // right-sidebar MCP/LSP convention:
  //   error   = broken / unhealthy (most severe — red)
  //   warning = actionable but not broken (orange/yellow)
  //   success = running / available / healthy (green)
  //   info    = neutral observation (blue/cyan)
  error: unknown
  warning: unknown
  info: unknown
  success: unknown
  textMuted: unknown
  borderSubtle: unknown
  text: unknown
  backgroundPanel: unknown
  border: unknown
}

// ─── Types ───────────────────────────────────────────────────────────

interface Badge {
  label: string
  state: string
  // "error" was added alongside MCP's right-sidebar convention — a more
  // severe tier than "warning" for states where OCP features won't work
  // (e.g. project never initialised). Rendered in `theme.error` (red),
  // separate from `warning` (orange/yellow).
  variant: "error" | "warning" | "info" | "success"
}

// ─── Config readers (mirror each plugin's config module) ────────────

/** Strip JSONC comments so project .jsonc files can be JSON.parsed. */
function stripJsonc(raw: string): string {
  return stripTrailingCommas(stripComments(raw))
}

function stripComments(raw: string): string {
  let result = ""
  let i = 0
  const len = raw.length
  let state: "normal" | "string" | "lineComment" | "blockComment" = "normal"
  while (i < len) {
    const c = raw[i]
    const next = i + 1 < len ? raw[i + 1] : ""
    switch (state) {
      case "normal":
        if (c === '"') { result += c; state = "string" }
        else if (c === "/" && next === "/") { state = "lineComment"; i++ }
        else if (c === "/" && next === "*") { state = "blockComment"; i++ }
        else { result += c }
        break
      case "string":
        result += c
        if (c === "\\") { i++; if (i < len) result += raw[i] }
        else if (c === '"') { state = "normal" }
        break
      case "lineComment":
        if (c === "\n") { result += c; state = "normal" }
        break
      case "blockComment":
        if (c === "*" && next === "/") { state = "normal"; i++ }
        break
    }
    i++
  }
  return result
}

function stripTrailingCommas(src: string): string {
  let result = ""
  let inString = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inString) {
      result += c
      if (c === "\\") { if (i + 1 < src.length) result += src[++i] }
      else if (c === '"') { inString = false }
      continue
    }
    if (c === '"') { inString = true; result += c; continue }
    if (c === ",") {
      let j = i + 1
      while (j < src.length && /\s/.test(src[j])) j++
      if (j < src.length && (src[j] === "}" || src[j] === "]")) continue
    }
    result += c
  }
  return result
}

function projectConfigFiles(projectDir: string): string[] {
  return [
    join(projectDir, ".opencode", "opencode.jsonc"),
    join(projectDir, ".opencode", "opencode.json"),
    join(projectDir, "opencode.jsonc"),
    join(projectDir, "opencode.json"),
  ]
}

function readProjectConfig(projectDir: string): Record<string, unknown> | null {
  for (const path of projectConfigFiles(projectDir)) {
    if (!existsSync(path)) continue
    try {
      return JSON.parse(stripJsonc(readFileSync(path, "utf-8")))
    } catch {
      // try next
    }
  }
  return null
}

// ─── State resolvers ────────────────────────────────────────────────

function normalizeOnOff(v: unknown): "on" | "off" | null {
  if (typeof v === "boolean") return v ? "on" : "off"
  if (typeof v !== "string") return null
  const s = v.trim().toLowerCase()
  if (["on", "enabled", "true"].includes(s)) return "on"
  if (["off", "disabled", "false"].includes(s)) return "off"
  return null
}

function resolveAdrGuard(projectDir: string): "on" | "off" {
  return normalizeOnOff(readProjectConfig(projectDir)?.adrGuard) ?? "off"
}

function resolveE2eGuard(projectDir: string): "on" | "off" {
  return normalizeOnOff(readProjectConfig(projectDir)?.e2eGuard) ?? "off"
}

function resolveAutoAdvisor(projectDir: string): "off" | "lite" | "full" {
  const raw = readProjectConfig(projectDir)?.autoAdvisorMode
  if (typeof raw !== "string") return "off"
  const mode = raw.trim().toLowerCase()
  return mode === "full" || mode === "lite" ? mode : "off"
}

function resolveDeepSeekAnchor(): "on" | "off" {
  const stateFile = join(homedir(), ".config", "opencode", ".deepseek-anchor-enabled")
  if (existsSync(stateFile)) {
    try {
      const m = normalizeOnOff(readFileSync(stateFile, "utf-8"))
      if (m) return m
    } catch { /* fall through */ }
  }
  const globalCfg = join(homedir(), ".config", "opencode", "opencode.jsonc")
  if (existsSync(globalCfg)) {
    try {
      const cfg = JSON.parse(stripJsonc(readFileSync(globalCfg, "utf-8")))
      const m = normalizeOnOff(cfg?.deepSeekAnchor)
      if (m) return m
    } catch { /* fall through */ }
  }
  return "on"
}

function resolveActiveProfile(): string {
  const stateFile = join(homedir(), ".config", "opencode", ".active-profile")
  if (!existsSync(stateFile)) return ""
  try {
    return readFileSync(stateFile, "utf-8").trim()
  } catch {
    return ""
  }
}

// ─── OCP project state resolvers ────────────────────────────────────

/**
 * OCP project scaffolding state — mirrors SCAFFOLD_TARGETS from
 * plugins/project-manager/project-manager-config.ts:
 *   .opencode/opencode.jsonc | docs/git-commits.md | AGENTS.md
 * 3/3 → init, 1–2 → partial, 0 → none.
 */
function resolveProjectScaffold(projectDir: string): "init" | "partial" | "none" {
  const count = [
    join(projectDir, ".opencode", "opencode.jsonc"),
    join(projectDir, "docs", "git-commits.md"),
    join(projectDir, "AGENTS.md"),
  ].filter((p) => existsSync(p)).length
  return count === 3 ? "init" : count === 0 ? "none" : "partial"
}

/**
 * Commit discipline — file-as-switch, same rule as hasConventionFile():
 * active (system-prompt injection + commit gate) exactly while
 * docs/git-commits.md exists.
 */
function resolveCommitDiscipline(projectDir: string): "on" | "off" {
  return existsSync(join(projectDir, "docs", "git-commits.md")) ? "on" : "off"
}

// ─── Code-intelligence capabilities (mirror project-profiler) ───────
// Same rules as buildProfile() in plugins/project-profiler/project-profiler.ts:
// a backend is "ready" only when its index directory exists AND the MCP
// server is enabled in the global config. Serena is live LSP — enabled
// is enough. Index staleness (git log probe) is intentionally NOT shown
// here — too heavy for the 2s poll.

/** Parsed global ~/.config/opencode/opencode.jsonc (null when absent/broken). */
function readGlobalConfig(): Record<string, unknown> | null {
  const globalCfg = join(homedir(), ".config", "opencode", "opencode.jsonc")
  if (!existsSync(globalCfg)) return null
  try {
    return JSON.parse(stripJsonc(readFileSync(globalCfg, "utf-8")))
  } catch {
    return null
  }
}

/** MCP server enabled in the global config (strict `enabled === true`). */
function mcpEnabledIn(cfg: Record<string, unknown> | null, name: string): boolean {
  const mcp = (cfg as { mcp?: Record<string, { enabled?: unknown }> } | null)?.mcp
  return mcp?.[name]?.enabled === true
}

/**
 * Sidebar capability states. The shared subset (`ready | off | no-index`)
 * is what the indexed-MCP resolvers (codegraph/gitnexus) and serena
 * return. Tgrep widens the union with four extra values — `no-cli`,
 * `no-watcher`, `stale`, `building` — because the optional external CLI
 * has more failure surfaces than an in-process MCP server. The
 * non-`off` tgrep values share names with `TgrepCapabilityState` in
 * plugins/tgrep/tgrep-service.ts so the sidebar text and the
 * [PROJECT CAPABILITIES] block the model reads stay aligned.
 *
 * Cross-platform note: state names are kebab-case ASCII — no path or
 * platform-specific text — so the same set renders identically on
 * Windows, macOS, and Linux (both in the sidebar and in the system
 * prompt block).
 */
type CapabilityState =
  | "ready"       // green  — fully operational
  | "off"         // hidden — feature disabled by config (user's choice)
  | "no-index"    // yellow — backend on, no index built yet
  | "no-cli"      // yellow — backend switch on, CLI binary missing
  | "no-watcher"  // yellow — index on disk but no live watcher running
  | "stale"       // yellow — index exists but policy fingerprint mismatches
  | "building"    // blue   — index build in progress

/** Indexed backend capability: off (MCP disabled) | no-index (MCP on, no index dir) | ready. */
function resolveIndexedCapability(
  projectDir: string,
  indexDir: string,
  mcpName: string,
  globalCfg: Record<string, unknown> | null,
): CapabilityState {
  if (!mcpEnabledIn(globalCfg, mcpName)) return "off"
  return existsSync(join(projectDir, indexDir)) ? "ready" : "no-index"
}

/** Serena capability — live LSP, no index step. */
function resolveSerena(globalCfg: Record<string, unknown> | null): CapabilityState {
  return mcpEnabledIn(globalCfg, "serena") ? "ready" : "off"
}

/** Tgrep capability resolver — folds the switch-off short-circuit in
 * front of resolveTgrepCapability so the project manager / sidebar share
 * the exact same state names as the [PROJECT CAPABILITIES] block the
 * model reads. The shared helper (resolveTgrepCapability in
 * plugins/tgrep/tgrep-service.ts) is the single source of truth for
 * the state → label mapping; do not duplicate it here. */
function resolveTgrep(projectDir: string): CapabilityState {
  try {
    const options = loadTgrepOptions(projectDir)
    if (!options.enabled) return "off"
    return resolveTgrepCapability(projectDir, options) as CapabilityState
  } catch {
    return "off"
  }
}

/** Render a TgrepCapabilityState to its sidebar label text. Kept as a
 * pure function (separate from resolveTgrepCapability) so the same
 * state-to-label table can be reused by other UI surfaces (e.g. a
 * hypothetical CLI status command) without re-running the probes. */
const TGREP_STATE_LABEL: Record<TgrepCapabilityState, string> = {
  "ready": "READY",
  "no-watcher": "NO WATCHER",
  "stale": "STALE",
  "building": "BUILDING",
  "no-index": "NO INDEX",
  "no-cli": "NO CLI",
}

// ─── Model detection (for deepseek-anchor gating) ──────────────────
//
// deepseek-anchor only does anything for DeepSeek V4 Pro (see
// plugins/deepseek-anchor/index.ts TARGET_MODEL_PATTERN). To avoid
// showing a "no-op" ON/OFF row for every other model, we gate the
// deepseek-anchor badge on a live model-id check.

/** Mirror of deepseek-anchor's TARGET_MODEL_PATTERN — kept local per the
 * "mirror each plugin's config module" convention in this file. */
const DEEPSEEK_V4_PRO_PATTERN = /deepseek[-_ ]?v4[-_ ]?pro/i

/** Initial model id from SdkConfig.model ("<provider>/<model_id>"). */
function initialModelId(apiConfig: unknown): string | undefined {
  if (!apiConfig || typeof apiConfig !== "object") return undefined
  const m = (apiConfig as { model?: unknown }).model
  if (typeof m !== "string" || m === "") return undefined
  const slash = m.lastIndexOf("/")
  return slash >= 0 ? m.slice(slash + 1) : m
}

/** Extract modelID from a message.updated event's Message payload.
 * Handles both AssistantMessage (flat) and UserMessage (nested under .model).
 * Narrows via Record<string, unknown> to avoid importing SDK types here. */
function extractModelIdFromMessage(info: unknown): string | undefined {
  if (!info || typeof info !== "object") return undefined
  const r = info as Record<string, unknown>
  if (typeof r.modelID === "string") return r.modelID
  const nested = r.model as Record<string, unknown> | undefined
  if (nested && typeof nested.modelID === "string") return nested.modelID
  return undefined
}

// ─── Formatter / dprint detection (mirror project-manager-dprint) ────
//
// Same rules as planDprintSetup() in
// plugins/project-manager/project-manager-dprint.ts. We mirror the
// detection here (no cross-module dep) and surface only a small badge
// the user can read at a glance.

const DPRINT_CONFIGS = ["dprint.json", "dprint.jsonc", ".dprint.json", ".dprint.jsonc"]
const FORMATTER_CONFIGS = [
  "biome.json", "biome.jsonc",
  ".prettierrc", ".prettierrc.json", ".prettierrc.js",
  "prettier.config.js", "prettier.config.mjs",
  ".eslintrc", ".eslintrc.js", ".eslintrc.json",
  "eslint.config.js", "eslint.config.mjs",
  "ruff.toml", ".ruff.toml",
  "rustfmt.toml", ".rustfmt.toml",
]

function hasAnyFile(root: string, files: readonly string[]): boolean {
  return files.some((f) => existsSync(join(root, f)))
}

function hasRuffPyproject(root: string): boolean {
  const path = join(root, "pyproject.toml")
  if (!existsSync(path)) return false
  try {
    return /^\s*\[tool\.ruff\]/m.test(readFileSync(path, "utf-8"))
  } catch {
    return false
  }
}

function hasPackageFormatterConfig(root: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as Record<string, unknown>
    return "prettier" in pkg || "eslintConfig" in pkg
  } catch {
    return false
  }
}

type DprintState = "ready" | "other" | "missing" | "no-pkg"

/** Formatter state — mirrors planDprintSetup() but only returns the bucket,
 * not the package manager / reason fields. */
function resolveFormatter(root: string): DprintState {
  if (!existsSync(join(root, "package.json"))) return "no-pkg"
  if (hasAnyFile(root, DPRINT_CONFIGS)) return "ready"
  if (
    hasAnyFile(root, FORMATTER_CONFIGS) ||
    hasPackageFormatterConfig(root) ||
    hasRuffPyproject(root) ||
    existsSync(join(root, "go.mod")) ||
    existsSync(join(root, "Cargo.toml"))
  ) {
    return "other"
  }
  return "missing"
}

// ─── Latest-version probe (for "update available" header indicator) ─
//
// We fetch the latest release tag from GitHub on startup and every 30
// minutes after. Compared to ~/.config/opencode/installed.version; when
// strictly newer we render an `↑ vX.Y.Z` suffix on the OCP header in
// warning colour.
//
// We mirror install/src/installer.ts apiMirrorUrls() — same env var
// (OCP_API_MIRROR), same domain predicate (api.github.com), same
// mirror-first ordering with the official URL as fallback. The mirror
// convention is `${envValue}/${fullUrl}` (verified with ghfast.top /
// gh-proxy.com / mirror.ghproxy.com). Inlined here to avoid pulling in
// installer-only imports into the TUI bundle.

const OCP_REPO = "kenlin8827/opencode-prime"
const LATEST_RELEASE_URL = `https://api.github.com/repos/${OCP_REPO}/releases/latest`
const FETCH_TIMEOUT_MS = 15_000
const FETCH_REFRESH_MS = 30 * 60 * 1_000 // 30 minutes

function apiMirrorUrls(url: string): string[] {
  const mirror = process.env.OCP_API_MIRROR?.replace(/\/+$/, "")
  if (!mirror || !url.includes("api.github.com")) return [url]
  return [`${mirror}/${url}`, url]
}

function parseSemver(s: string): number[] {
  return s.split(".").map((n) => {
    const v = parseInt(n, 10)
    return Number.isFinite(v) ? v : 0
  })
}

/** Returns positive when b > a, negative when b < a, 0 when equal.
 * Missing components are treated as 0 (handles 0.30 vs 0.30.0). */
function compareSemver(a: string, b: string): number {
  const av = parseSemver(a)
  const bv = parseSemver(b)
  const len = Math.max(av.length, bv.length)
  for (let i = 0; i < len; i++) {
    const x = av[i] ?? 0, y = bv[i] ?? 0
    if (y !== x) return y - x
  }
  return 0
}

function isUpdateAvailable(installed: string, latest: string): boolean {
  if (!installed || !latest) return false
  // Reject malformed versions (e.g. "unknown" when installed.version is
  // missing) so we don't show a false-positive indicator.
  if (!/^\d+(\.\d+)*$/.test(installed) || !/^\d+(\.\d+)*$/.test(latest)) return false
  return compareSemver(installed, latest) > 0
}

/** Fetch the latest release tag (exported for tests). Returns the tag
 * on success, throws on every failure mode — the caller (checkUpdate)
 * wraps this in `.catch(() => {})` so nothing ever surfaces in the TUI.
 *
 * Robustness:
 *   - `lifecycleSignal` (api.lifecycle.signal) is composed with the
 *     per-call timeout so a TUI dispose cancels any in-flight fetch
 *     immediately rather than letting it hang until the 15s timeout.
 *   - Every step (signal creation, fetch, json parse, tag extraction)
 *     is inside a try block; failure on one URL tries the next, and
 *     the for-loop exhausts all mirror URLs before throwing.
 *   - `res.json()` parse failure is caught separately and routed to
 *     the next URL, the same as a non-2xx response.
 */
export async function fetchLatestVersion(lifecycleSignal?: AbortSignal): Promise<string> {
  let lastErr: unknown = null
  for (const url of apiMirrorUrls(LATEST_RELEASE_URL)) {
    try {
      // Signal creation lives inside the try so a runtime error from
      // AbortSignal.timeout / AbortSignal.any doesn't escape.
      const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
      const signal = lifecycleSignal
        ? AbortSignal.any([timeoutSignal, lifecycleSignal])
        : timeoutSignal

      const res = await fetch(url, {
        signal,
        headers: { "User-Agent": "opencode-prime-tui" },
      })
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`)
        continue
      }

      let data: { tag_name?: unknown } | null = null
      try {
        data = (await res.json()) as { tag_name?: unknown }
      } catch (err) {
        // Malformed JSON body — same handling as non-2xx: try next URL.
        lastErr = err
        continue
      }
      if (!data) {
        lastErr = new Error("empty body")
        continue
      }

      const tag = typeof data.tag_name === "string" ? data.tag_name.replace(/^v/, "").trim() : ""
      if (tag) return tag
      lastErr = new Error("empty tag_name")
    } catch (err) {
      // fetch() rejection (network / DNS / abort / timeout / signal
      // creation error / anything else) — try the next URL.
      lastErr = err
    }
  }
  throw lastErr ?? new Error("all attempts failed")
}

// ─── Badge builders ─────────────────────────────────────────────────
// Two semantic groups, rendered as two sidebar sections:
//   "OCP"         — agent behavior/policy switches (profile + guards)
//   "OCP project" — current-directory OCP project state + code intelligence

/** Guard/mode badges — group "OCP" (exported for tests/smoke checks).
 * `currentModelId` gates `deepseek-anchor`: only rendered when the active
 * model matches DEEPSEEK_V4_PRO_PATTERN (matches the anchor plugin's own
 * gate, so non-V4-Pro models never see a no-op switch row). */
export function buildGuardBadges(projectDir: string, currentModelId?: string): Badge[] {
  const badges: Badge[] = []

  // Profile first — the most contextually relevant info at a glance.
  const profile = resolveActiveProfile()
  if (profile) {
    badges.push({ label: "profile", state: profile, variant: "success" })
  }

  // Always show all plugin states — ON or OFF — so the user
  // can see the full configuration at a glance.
  const adr = resolveAdrGuard(projectDir)
  badges.push({ label: "adr-guard", state: adr.toUpperCase(), variant: adr === "on" ? "warning" : "info" })

  const e2e = resolveE2eGuard(projectDir)
  badges.push({ label: "e2e-guard", state: e2e.toUpperCase(), variant: e2e === "on" ? "warning" : "info" })

  const advisor = resolveAutoAdvisor(projectDir)
  badges.push({ label: "auto-advisor", state: advisor.toUpperCase(), variant: advisor === "full" ? "warning" : advisor === "lite" ? "info" : "info" })

  // DeepSeek anchor — gated by current model. If the model is unknown or
  // not V4 Pro, the row is omitted (the plugin itself would be a no-op).
  if (currentModelId && DEEPSEEK_V4_PRO_PATTERN.test(currentModelId)) {
    const ds = resolveDeepSeekAnchor()
    badges.push({ label: "deepseek-anchor", state: ds.toUpperCase(), variant: ds === "on" ? "info" : "warning" })
  }

  return badges
}

/** Project badges — group "OCP project" (exported for tests/smoke checks).
 * `globalCfg` injectable so tests can exercise MCP on/off branches without
 * touching the real user config.
 *
 * Gating strategy:
 *   - `project` row always renders (the only row shown when NOT INIT /
 *     PARTIAL — those badges mean nothing on a directory that isn't an
 *     OCP project yet).
 *   - `commits` + code-intelligence capabilities (codegraph/gitnexus/
 *     serena) only render when the project is fully initialized
 *     (all three scaffold targets present). PARTIAL is treated as
 *     "init in progress" — finish it via /project sync before the
 *     project-level details become meaningful.
 *   - OFF rows are still filtered at the end as a final tidy. */
export function buildProjectBadges(
  projectDir: string,
  globalCfg: Record<string, unknown> | null = readGlobalConfig(),
): Badge[] {
  const proj = resolveProjectScaffold(projectDir)
  const badges: Badge[] = []

  // OCP project state — is this directory managed by /project init?
  // Always rendered so the group never appears empty.
  badges.push({
    label: "project",
    state: proj === "init" ? "INIT" : proj === "partial" ? "PARTIAL" : "NOT INIT",
    // Variant tier mirrors the MCP right-sidebar convention:
    //   NOT INIT → error   (red)    — directory isn't an OCP project at
    //                                  all; commit discipline, indexes,
    //                                  and capability gating are all off
    //                                  the table. Needs /project init.
    //   PARTIAL  → warning (yellow) — init in progress; finish with
    //                                  /project sync.
    //   INIT     → success (green)  — healthy.
    // The previous design lumped NOT INIT and PARTIAL into warning, which
    // hid the severity difference — NOT INIT is worse than PARTIAL.
    variant: proj === "init" ? "success" : proj === "partial" ? "warning" : "error",
  })

  // Project-level details only render once init has fully completed.
  if (proj === "init") {
    // Commit discipline — system-prompt injection + mechanical commit
    // gate are active exactly while docs/git-commits.md exists
    // (file-as-switch; same rule as project-manager hasConventionFile()).
    // Label chosen for clarity over the previous terse "commits" which
    // was ambiguous. With init=true this is always ON, but we resolve it
    // via the file check for consistency.
    const commits = resolveCommitDiscipline(projectDir)
    badges.push({ label: "commit-discipline", state: commits.toUpperCase(), variant: commits === "on" ? "warning" : "info" })

    // Code-intelligence capabilities (same rules as project-profiler).
    const caps: Array<{ label: string; cap: CapabilityState }> = [
      { label: "codegraph", cap: resolveIndexedCapability(projectDir, ".codegraph", "codegraph", globalCfg) },
      { label: "gitnexus", cap: resolveIndexedCapability(projectDir, ".gitnexus", "gitnexus", globalCfg) },
      { label: "serena", cap: resolveSerena(globalCfg) },
      // tgrep — optional external CLI; mirrors project-profiler's text-index
      // probe so the sidebar exposes the same signal the model sees via the
      // [PROJECT CAPABILITIES] system-prompt block. "off" rows fall through
      // the OFF filter below, so the row only renders when there's an
      // actionable signal (ready / no-index).
      { label: "tgrep", cap: resolveTgrep(projectDir) },
    ]
    for (const { label, cap } of caps) {
      // Label and variant picked from per-capability tables. Tgrep uses
      // the TGREP_STATE_LABEL map so the sidebar text matches the
      // [PROJECT CAPABILITIES] block the model reads (see
      // resolveTgrepCapability / TgrepCapabilityState in
      // plugins/tgrep/tgrep-service.ts). Other backends share a
      // 3-state contract (ready / no-index / off).
      if (label === "tgrep" && cap !== "off") {
        badges.push({
          label,
          state: TGREP_STATE_LABEL[cap as TgrepCapabilityState],
          variant: cap === "ready" ? "success" : cap === "building" ? "info" : "warning",
        })
      } else {
        badges.push({
          label,
          state: cap === "ready" ? "READY" : cap === "no-index" ? "NO INDEX" : "OFF",
          variant: cap === "ready" ? "success" : cap === "no-index" ? "warning" : "info",
        })
      }
    }

    // Formatter (dprint) — mirrors project-manager-dprint planDprintSetup().
    // Same states: ready (dprint.json[c] present) | other (some other
    // formatter exists) | missing (none, eligible for setup) | no-pkg.
    const fmt = resolveFormatter(projectDir)
    badges.push({
      label: "dprint",
      state: fmt === "ready" ? "READY" : fmt === "other" ? "OTHER" : fmt === "missing" ? "NONE" : "NO PKG",
      variant:
        fmt === "ready" ? "success" :
        fmt === "missing" ? "warning" :
        "info",
    })
  }

  // Final tidy — drop default-empty rows. Hidden:
  //   - OFF    → MCP server / external tool disabled in global config
  //              (user's choice — explicit opt-out, never actionable)
  //   - NONE   → no formatter configured (default state for fresh projects)
  //   - NO PKG → dprint can't be installed (no package.json — degenerate)
  // Kept (actionable):
  //   - NOT INIT    → /project init not run on this directory
  //   - NO INDEX    → MCP/CLI enabled but index not built — /project index
  //   - NO CLI      → tgrep enabled in config but binary missing — install
  //   - NO WATCHER  → tgrep index on disk but no live serve — start serve
  //   - STALE       → tgrep index built under different policy — rebuild
  //   - BUILDING    → tgrep index build in progress — wait
  // `project` is never OFF/NONE/NO PKG so the group always renders ≥1 row.
  return badges.filter((b) => b.state !== "OFF" && b.state !== "NONE" && b.state !== "NO PKG")
}

// ─── Slot renderer (programmatic JSX via jsx()) ─────────────────────

/**
 * Build the two-group status panel JSX tree.
 * Exported so tests can render the panel in isolation via @opentui/solid's
 * testRender harness and inspect the rendered colors / dot glyphs
 * (the slot is mounted by OpenCode's TUI server and has no standalone
 * harness of its own).
 * Layout:
 *   ─ OCP v0.30.0 ─────────────┐
 *   │ ● profile  zhipuai-coding │
 *   │ ○ adr-guard  OFF          │
 *   │ ○ e2e-guard  OFF          │
 *   │ ○ auto-advisor  OFF       │
 *   │ ● deepseek-anchor  ON     │
 *   │ ─ OCP project ────────────│
 *   │ ● project  INIT           │
 *   │ ● commit-discipline  ON   │
 *   │ ● codegraph  READY        │
 *   │ ● dprint  READY/OTHER/NONE│
 *   └───────────────────────────┘
 *
 * When `latestVersion` is strictly newer than `version` (the installed
 * one), the OCP header grows a `↑ vX.Y.Z` suffix in warning colour.
 *
 * Mirrors the sidebar section style used by MCP/LSP groups.
 */
export function renderStatusPanel(
  guards: Badge[],
  project: Badge[],
  theme: ThemeColors,
  version: string,
  latestVersion: string,
): unknown {
  if (guards.length === 0 && project.length === 0) return null

  // Build one row per badge — each row is a <box> containing a status dot
  // and a <text> with label + state.
  const renderRows = (badges: Badge[]): unknown[] => badges.map((b) => {
// Dot fill mirrors the value: filled (●) for any active state,
// hollow (○) for OFF rows only. NOT INIT is intentionally NOT in this
// list — it is an active warning that needs user action (run /project
// init), so it renders as a filled ● in warning colour, matching PARTIAL.
// OFF rows are pre-filtered; the check stays for defensive rendering.
    const isActive = b.state !== "OFF"
    // Variant priority: error > warning > success > info (default).
    // The text state falls back to textMuted for the neutral `info`
    // variant — same fallback as before; only the dot gets theme.info
    // so a blue dot still reads as "informational" rather than muted.
    const dotColor =
      b.variant === "error" ? theme.error :
      b.variant === "warning" ? theme.warning :
      b.variant === "success" ? theme.success :
      theme.info
    const stateColor =
      b.variant === "error" ? theme.error :
      b.variant === "warning" ? theme.warning :
      b.variant === "success" ? theme.success :
      theme.textMuted

    return jsx("box", {
      style: { flexDirection: "row", paddingLeft: 1, flexWrap: "wrap" },
      children: [
        // Status dot
        jsx("text", {
          // OpenTUI's <text> reconciler reads `fg` (and `bg`) out of the
          // style object — `color` is silently ignored. The original code
          // used `style: { color: ... }` which never applied, so the
          // sidebar has been rendering in default white this whole time.
          // Renaming to `fg` finally surfaces the warning/success/info
          // colour palette that the variant values already select.
          style: { fg: dotColor },
          children: jsx("span", { children: isActive ? "● " : "○ " }),
        }),
        // Label (muted) — fixed 2-space gap before the value; column
        // alignment is intentionally skipped so long values (profile
        // names) never wrap in the narrow sidebar.
        jsx("text", {
          style: { fg: theme.textMuted },
          children: jsx("span", { children: b.label + "  " }),
        }),
        // State value — wraps to next line when too long
        jsx("text", {
          style: { fg: stateColor },
          children: jsx("span", { children: b.state }),
        }),
      ],
    })
  })

  // Section header rows: "─ OCP v0.7.3 ─" / "─ OCP project ─"
  // Version comes from ~/.config/opencode/installed.version (written by installer).
  // `gapAbove` adds a blank line above the header — used to separate the
  // OCP and OCP project groups visually without affecting single-group
  // layouts.
  // `suffix` is rendered inline after the title in warning colour —
  // used for "↑ vX.Y.Z" when a newer release is available.
  const renderHeader = (text: string, gapAbove = 0, suffix = "") => {
    // Same `fg` rename as the badge rows above — `color` is ignored by
    // OpenTUI's <text> reconciler.
    const borderStyle = { fg: theme.borderSubtle }
    const warningStyle = { fg: theme.warning }
    const headerChildren: unknown[] = [
      jsx("text", {
        style: borderStyle,
        children: jsx("span", { children: `─ ${text}` }),
      }),
    ]
    if (suffix) {
      headerChildren.push(
        jsx("text", {
          style: warningStyle,
          children: jsx("span", { children: ` ↑ v${suffix}` }),
        }),
      )
    }
    headerChildren.push(
      jsx("text", {
        style: borderStyle,
        children: jsx("span", { children: " ─" }),
      }),
    )
    return jsx("box", {
      style: { flexDirection: "row", paddingLeft: 1, paddingTop: gapAbove, height: gapAbove > 0 ? 1 + gapAbove : 1 },
      children: headerChildren,
    })
  }

  // One section per group: header + its rows. Skipped when the group has
  // no badges (defensive — currently never triggers).
  // The OCP group header gets the update-available suffix; the OCP
  // project header stays plain (the suffix is about OCP itself, not the
  // current project).
  const updateSuffix = isUpdateAvailable(version, latestVersion) ? latestVersion : ""
  const sections: unknown[] = []
  if (guards.length > 0) sections.push(renderHeader(`OCP v${version}`, 0, updateSuffix), ...renderRows(guards))
  // gapAbove:1 puts a blank line between OCP and OCP project so the two
  // groups don't visually run together.
  if (project.length > 0) sections.push(renderHeader("OCP project", 1), ...renderRows(project))

  // Combine sections in a vertical container
  return jsx("box", {
    style: { flexDirection: "column", paddingTop: 0, paddingBottom: 0 },
    children: sections,
  })
}

// ─── Plugin entry ──────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2000

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  // Poll config files because slash-command toggles write to disk
  // asynchronously — there is no server→TUI event for "config field changed".
  // A 2s interval is cheap (a handful of small file reads) and keeps the
  // panel snappy. Capability checks are existsSync + one global config
  // read — still cheap. Index staleness (git log) is deliberately excluded.
  const [guards, setGuards] = createSignal<Badge[]>([])
  const [project, setProject] = createSignal<Badge[]>([])
  // Track the live model id (see deepseek-anchor gating). Initialized
  // from the resolved SDK config; refreshed on each message.updated event
  // when the id actually changes. Empty string = "model not yet known".
  const [currentModelId, setCurrentModelId] = createSignal<string>("")
  // Latest OCP release tag from GitHub (empty = no fetch result yet, or
  // fetch failed). Refreshed on startup and every FETCH_REFRESH_MS.
  // Drives the "↑ vX.Y.Z" suffix on the OCP header.
  const [latestVersion, setLatestVersion] = createSignal<string>("")
  const projectDir = api.state.path.directory || process.cwd()

  const refresh = () => {
    try {
      setGuards(buildGuardBadges(projectDir, currentModelId() || undefined))
      setProject(buildProjectBadges(projectDir))
    } catch {
      // Never crash the TUI — a config read error just means no badges.
    }
  }

  // Seed the model id from the resolved SDK config. Real V4 Pro / non-V4 Pro
  // distinction only becomes precise once the first message.updated fires,
  // but the default is a reasonable starting point (covers the "user just
  // opened the TUI and hasn't sent a message yet" case).
  const initialId = initialModelId(api.state.config)
  if (initialId) setCurrentModelId(initialId)

  // Read OCP version from installed.version (written by the installer to
  // the config directory, e.g. ~/.config/opencode/installed.version).
  const configDir = api.state.path.config
  const versionFile = join(configDir, "installed.version")
  let ocpVersion = "unknown"
  try {
    if (existsSync(versionFile)) {
      ocpVersion = readFileSync(versionFile, "utf-8").trim()
    }
  } catch { /* ignore */ }

  refresh()
  const timer = setInterval(refresh, POLL_INTERVAL_MS)

  // Refresh when a new session starts — also re-seed the model id from
  // the (possibly updated) SDK config in case the user changed defaults.
  const offSessionCreated = api.event.on("session.created", () => {
    const seeded = initialModelId(api.state.config)
    if (seeded && seeded !== currentModelId()) setCurrentModelId(seeded)
    refresh()
  })

  // Refresh when the live model id changes (tier swap, agent switch, etc.).
  // We dedupe by id so the handler is cheap on every step.
  const offMessageUpdated = api.event.on("message.updated", (event) => {
    const info = (event as { properties?: { info?: unknown } }).properties?.info
    const id = extractModelIdFromMessage(info)
    if (!id) return
    if (id === currentModelId()) return
    setCurrentModelId(id)
    refresh()
  })

  // Async latest-version probe. Fire-and-forget on startup so we never
  // block the render path; failures are silent (network/CN rate-limit
  // issues shouldn't show in the sidebar — we just skip the indicator).
  // Re-probe every FETCH_REFRESH_MS so long-running sessions stay fresh.
  //
  // Robustness:
  //   - Dedupe: skip when a previous fetch is still in-flight (e.g. a
  //     15s timeout still pending while the 30-min interval fires), so
  //     we never queue concurrent fetches.
  //   - Lifecycle-bound: pass api.lifecycle.signal so an in-flight
  //     fetch is cancelled immediately on TUI dispose.
  //   - Silent: every error path inside fetchLatestVersion is wrapped;
  //     the outer .catch on the chain is the final safety net so
  //     checkUpdate() can never throw.
  let inFlight: Promise<unknown> | null = null
  const checkUpdate = (): void => {
    if (inFlight) return
    inFlight = fetchLatestVersion(api.lifecycle.signal)
      .then((v) => {
        if (v && v !== latestVersion()) setLatestVersion(v)
      })
      .catch(() => { /* silent — see comment above */ })
      .finally(() => { inFlight = null })
  }
  void checkUpdate()
  const fetchTimer = setInterval(checkUpdate, FETCH_REFRESH_MS)

  // Register into sidebar_content so the OCP group appears as a vertical
  // section inside the right sidebar, just like the MCP/LSP groups.
  const renderFn = (ctx: Readonly<TuiSlotContext>) => {
    return renderStatusPanel(guards(), project(), {
      error: ctx.theme.current.error,
      warning: ctx.theme.current.warning,
      info: ctx.theme.current.info,
      success: ctx.theme.current.success,
      textMuted: ctx.theme.current.textMuted,
      borderSubtle: ctx.theme.current.borderSubtle,
      text: ctx.theme.current.text,
      backgroundPanel: ctx.theme.current.backgroundPanel,
      border: ctx.theme.current.border,
    }, ocpVersion, latestVersion())
  }

  api.slots.register({
    slots: {
      sidebar_content: (ctx: Readonly<TuiSlotContext>, _props: { session_id: string }) => {
        return renderFn(ctx)
      },
    },
  })

  // Cleanup on plugin dispose.
  api.lifecycle.onDispose(() => {
    clearInterval(timer)
    clearInterval(fetchTimer)
    offSessionCreated()
    offMessageUpdated()
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "sidebar-status",
  tui,
}

export default plugin
