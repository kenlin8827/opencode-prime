/// <reference types="bun" />
/**
 * Sidebar Status — TUI slot plugin that renders two vertical status groups
 * inside the OpenCode right sidebar:
 *   "OCP"         — agent behavior/policy switches (independent of project):
 *                   adr, auto-advisor, deepseek-anchor,
 *                   plus the active profile.
 *   "OCP project" — current-directory OCP project state and capabilities:
 *                   scaffold (init state), memory (curated lessons for this
 *                   project), git-commits, code-intelligence backends
 *                   (codegraph/gitnexus indexes, serena LSP), and the
 *                   project formatter (dprint).
 *
 * This replaces the per-plugin session.created announce (toast/inject) with
 * a single always-visible "OCP" section. When a user toggles a guard via
 * its slash command, the panel picks up the change on the next poll cycle
 * (the server-side plugin still fires a confirmation toast for the toggle).
 *
 * Registration: `cli.template.jsonc` → `plugins` array, as a DIRECTORY entry
 * (`./plugins/tui/sidebar-status`). The v2 TUI reconcile silently skips file
 * entries; the entrypoint is this directory's `tui.ts` (Host.resolve probes
 * <dir>/tui). Nested bare files under plugins/tui/ are never auto-discovered.
 *
 * Slot: `sidebar.content` claim (session view) — renders as a vertical group
 * labeled "OCP" inside the right sidebar, mirroring the MCP/LSP section
 * style already used by OpenCode's sidebar. Each section header is a
 * collapsible disclosure mirroring the MCP group: a ▼/▶ prefix and a
 * click handler on the header row toggle that section's rows. Collapse
 * state is session-local (a plain signal — no config write for a pure
 * view preference; a TUI restart re-opens both sections).
 *
 * State sources (all read-only, same logic as each plugin's config module):
 *   - adrGuard        → project OCP config field (on | off, default off)
 *   - projectMemory   → project OCP config field (on | off, default on —
 *                       advisory; nothing is injected unless a curated
 *                       public.md actually exists)
 *   - autoAdvisorMode → project OCP config field (off | lite | full, default off)
 *   - deepSeekAnchor  → ~/.config/opencode/ocp.json deepSeekAnchor (on | off, default off — opt-in)
 *   - activeProfile   → ~/.config/opencode/.active-profile (name | none)
 *   - projectScaffold → /project init targets exist? (.ocp/ocp.json +
 *                        docs/git-commits.md + AGENTS.md
 *                        → init | partial | none)
 *   - gitCommits      → docs/git-commits.md exists (file-as-switch, same rule
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
 *   - Initial: active route's session → ctx.data.session.get(id).model
 *   - Live:    ctx.data.on("session.model.selected") carries the new
 *              ModelRef; refresh the panel when it changes (tier swap, etc.)
 *
 * Display rules (the panel is space-conscious — we drop default-empty
 * states and only show actionable signals):
 *   - "OCP" group: every guard row renders (ON/OFF) — at-a-glance config
 *     snapshot. `profile` row only appears when one is active. The
 *     `deepseek-anchor` row is gated on the current model being V4 Pro.
 *   - "OCP project" group: `scaffold` and `memory` rows always render
 *     (memory is lifecycle-independent — /memory note works pre-init
 *     and the row nudges users toward capture with `ON · empty`).
 *     The rest (git-commits, capabilities, formatter) are gated
 *     on `scaffold === "INIT"`. OFF / NONE / NO PKG rows are filtered out.
 *     NOT INIT and NO INDEX are kept as actionable signals.
 *   - Header: `─ OCP v<version> ─`; grows a `↑ vX.Y.Z` warning-colour
 *     suffix when an async GitHub probe finds a newer release.
 */

import type { Context } from "@opencode/plugin/tui/context"
import type { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal } from "solid-js"
// Programmatically create JSX elements via the SolidJS factory.
// We use `jsx()` instead of JSX syntax to avoid tsconfig jsxImportSource
// complications — the @opentui/solid JSX namespace is local, not global.
import { jsx } from "@opentui/solid/jsx-runtime"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { loadTgrepOptions } from "../../tgrep/tgrep-config"
import { resolveTgrepCapability, type TgrepCapabilityState } from "../../tgrep/tgrep-service"
import { countEntries, readPublic } from "../../project-memory/project-memory-config"
import { ocpConfigFile, readProjectConfig, stripJsonc } from "../../shared/opencode-prime"
import { normalizeOnOff, readOcpField } from "../../shared/ocp-config"

// ─── Theme shape ───────────────────────────────────────────────────

interface ThemeColors {
  // Semantic colour keys are resolved from the v2 ResolvedTheme by
  // semantic role (feedback text colors, muted text, base border) —
  // aligned with the right-sidebar MCP/LSP convention:
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

/** Map the v2 semantic theme surface onto this panel's color slots. */
function panelTheme(ctx: Context): ThemeColors {
  const theme = ctx.theme
  return {
    error: theme.text.feedback.error.base,
    warning: theme.text.feedback.warning.base,
    info: theme.text.feedback.info.base,
    success: theme.text.feedback.success.base,
    textMuted: theme.text.muted,
    borderSubtle: theme.border.base,
    text: theme.text.base,
    backgroundPanel: theme.background.raised.base,
    border: theme.border.base,
  }
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

// ─── Config readers ──────────────────────────────────────────────────
// JSONC parsing and the `.ocp/ocp.json` read live in
// `plugins/shared/opencode-prime` — same code path the running plugins use,
// so sidebar state can never drift from actual plugin state (ADR 0004 v2:
// single source, no fallback chain). `root` is passed per call because the
// TUI process gets no server-side project dir injection.

// ─── State resolvers ────────────────────────────────────────────────

function resolveAdrGuard(projectDir: string): "on" | "off" {
  return normalizeOnOff(readProjectConfig(projectDir)?.adrGuard) ?? "off"
}

function resolveProjectMemory(projectDir: string): "on" | "off" {
  // Default flipped to "on" — memory is advisory (AGENTS.md wins on conflict),
  // empty public.md is a no-op anyway, so the friction of an extra opt-in
  // switch costs more than it saves. Users who want it off can set
  // "projectMemory": "off" explicitly. See sidebar "memory" row.
  return normalizeOnOff(readProjectConfig(projectDir)?.projectMemory) ?? "on"
}

function resolveAutoAdvisor(projectDir: string): "off" | "lite" | "full" {
  const raw = readProjectConfig(projectDir)?.autoAdvisorMode
  if (typeof raw !== "string") return "off"
  const mode = raw.trim().toLowerCase()
  return mode === "full" || mode === "lite" ? mode : "off"
}

function resolveDeepSeekAnchor(): "on" | "off" {
  // deepseek-anchor is a user preference (global `~/.config/opencode/ocp.json`
  // `deepSeekAnchor` field only) — same resolution the plugin's own
  // getMode() uses, kept in lockstep so the sidebar badge never disagrees.
  // Default: opt-in ("off"). The anchor forces a first-turn latency cost on
  // DeepSeek V4 Pro; users who don't run that model (or who actively want
  // the original behavior) should never see it on by default.
  return normalizeOnOff(readOcpField<unknown>("deepSeekAnchor")) ?? "off"
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
 *   .ocp/ocp.json | docs/git-commits.md | AGENTS.md
 * 3/3 → init, 1–2 → partial, 0 → none.
 */
function resolveProjectScaffold(projectDir: string): "init" | "partial" | "none" {
  const count = [
    ocpConfigFile(projectDir),
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
function resolveGitCommits(projectDir: string): "on" | "off" {
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

/** MCP server enabled in the global config. V2 shape: servers live under
 *  `mcp.servers` and connect unless `disabled: true` (no `enabled` field in
 *  v2 — docs: /v2/docs/mcp-servers). Mirrors `mcpEnabledFrom` in
 *  plugins/project-profiler/project-profiler.ts. */
function mcpEnabledIn(cfg: Record<string, unknown> | null, name: string): boolean {
  const servers = (cfg as { mcp?: { servers?: Record<string, { disabled?: unknown }> } } | null)?.mcp?.servers
  const server = servers?.[name]
  return server !== undefined && server.disabled !== true
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
// plugins/deepseek-anchor/deepseek-anchor.ts TARGET_MODEL_PATTERN). To avoid
// showing a "no-op" ON/OFF row for every other model, we gate the
// deepseek-anchor badge on a live model-id check.

/** Mirror of deepseek-anchor's TARGET_MODEL_PATTERN — kept local per the
 * "mirror each plugin's config module" convention in this file. */
const DEEPSEEK_V4_PRO_PATTERN = /deepseek[-_ ]?v4[-_ ]?pro/i

/** Seed model id from a v2 ModelRef ("<provider>/<model_id>"-style ids are
 * reduced to the trailing model segment; bare ids pass through). */
function modelIdFromRef(ref: { id?: string } | undefined): string | undefined {
  const m = ref?.id
  if (typeof m !== "string" || m === "") return undefined
  const slash = m.lastIndexOf("/")
  return slash >= 0 ? m.slice(slash + 1) : m
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
 *   - `lifecycleSignal` (the panel's owned AbortSignal) is composed with the
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
//   "OCP"         — agent behavior/policy switches (profile + guards):
//                   profile, adr, auto-advisor,
//                   deepseek-anchor. These change how the agent behaves
//                   regardless of which project is open.
//   "OCP project" — current-directory OCP project state + capabilities:
//                   scaffold (init state), memory (curated lessons for this
//                   project), git-commits, codegraph/gitnexus/serena/
//                   tgrep indexes, dprint formatter. All keyed off the
//                   current project (config lives in project OCP config;
//                   memory data lives at .ocp/memory/ inside the project).

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
  // Bare ON → success (green). OFF → info. State with a qualifier (e.g.
  // memory `ON · N`, `ON · empty`) → info — the qualifier IS the signal.
  const adr = resolveAdrGuard(projectDir)
  badges.push({ label: "adr", state: adr.toUpperCase(), variant: adr === "on" ? "success" : "info" })

  const advisor = resolveAutoAdvisor(projectDir)
  badges.push({ label: "auto-advisor", state: advisor.toUpperCase(), variant: advisor === "full" ? "warning" : advisor === "lite" ? "info" : "info" })

  // DeepSeek anchor — gated by current model. If the model is unknown or
  // not V4 Pro, the row is omitted (the plugin itself would be a no-op).
  if (currentModelId && DEEPSEEK_V4_PRO_PATTERN.test(currentModelId)) {
    const ds = resolveDeepSeekAnchor()
    badges.push({ label: "deepseek-anchor", state: ds.toUpperCase(), variant: ds === "on" ? "success" : "warning" })
  }

  return badges
}

/** Project badges — group "OCP project" (exported for tests/smoke checks).
 * `globalCfg` injectable so tests can exercise MCP on/off branches without
 * touching the real user config.
 *
 * Gating strategy:
 *   - `scaffold` and `memory` rows always render. memory's data lives
 *     at `.ocp/memory/public.md` inside the project (committed to
 *     git — same lifecycle as the checkout, so `git clone` gives a new
 *     contributor the team's lessons immediately). The `private.md`
 *     sibling is gitignored and intentionally NOT surfaced in the sidebar
 *     (it's a per-developer scratchpad, not a project status signal).
 *     Surfacing the memory row always also nudges pre-init users toward
 *     /memory note.
 *   - `git-commits` + code-intelligence capabilities (codegraph /
 *     gitnexus / serena) + formatter only render when the project is fully
 *     initialized (all three scaffold targets present). PARTIAL is treated
 *     as "init in progress" — finish it via /project sync before the
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
  // Label "scaffold" (not "project") — the state is INIT/PARTIAL/NOT INIT,
  // i.e. the result of /project init's scaffolding pass.
  badges.push({
    label: "scaffold",
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

  // Project memory — always rendered (independent of init state). 3-state:
  //   ON + entry count → real injection activity (public.md entries)
  //   ON + empty       → switch is on but no curated public.md yet;
  //                      nudges the user to /memory note
  //   OFF              → explicit opt-out
  // Sidebar reads public.md directly — same file the system-inject hook
  // reads, so the count matches what's actually injected (modulo the 16k
  // char cap, which collapses to a pointer block, not a count change).
  // The private.md count is intentionally not surfaced here — it's a
  // per-developer scratchpad, not a project status signal.
  const memory = resolveProjectMemory(projectDir)
  const memoryState =
    memory === "on"
      ? (() => {
          const content = readPublic()
          const n = content === null ? 0 : countEntries(content)
          return n > 0 ? `ON · ${n}` : "ON · empty"
        })()
      : "OFF"
  // Qualifier-bearing ON (`ON · N` / `ON · empty`) → info: the qualifier
  // is the signal; bare ON is reserved for single-state switches (green).
  badges.push({ label: "memory", state: memoryState, variant: "info" })

  // Project-level details only render once init has fully completed.
  if (proj === "init") {
    // git-commits — system-prompt injection + mechanical commit gate are
    // active exactly while docs/git-commits.md exists (file-as-switch;
    // same rule as project-manager hasConventionFile()). Row label mirrors
    // the file path so users can map the badge to the convention file at
    // a glance. With init=true this is always ON, but we resolve it via
    // the file check for consistency.
    const commits = resolveGitCommits(projectDir)
    badges.push({ label: "git-commits", state: commits.toUpperCase(), variant: commits === "on" ? "success" : "info" })

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
  //   - NO INDEX    → MCP/CLI enabled but index not built — /project init
  //   - NO CLI      → tgrep enabled in config but binary missing — install
  //   - NO WATCHER  → tgrep index on disk but no live serve — start serve
  //   - STALE       → tgrep index built under different policy — rebuild
  //   - BUILDING    → tgrep index build in progress — wait
  // `scaffold` is never OFF/NONE/NO PKG, so the group always renders ≥1 row;
  // `memory` drops its row only on an explicit "off".
  return badges.filter((b) => b.state !== "OFF" && b.state !== "NONE" && b.state !== "NO PKG")
}

// ─── Slot renderer (programmatic JSX via jsx()) ─────────────────────

/**
 * Build the two-group status panel JSX tree.
 * Exported so tests can render the panel in isolation via @opentui/solid's
 * testRender harness and inspect the rendered colors / dot glyphs
 * (the slot is mounted by OpenCode's TUI server and has no standalone
 * harness of its own).
 * Layout (dot = •, same glyph as the MCP group; value text always
 * textMuted in title case — colour lives on the dot only):
 *   ▼ OCP v0.30.0 ─────────────┐
 *   │ • profile  zhipuai-coding │
 *   │ • adr  Off                │
 *   │ • auto-advisor  Off       │
 *   │ • deepseek-anchor  Off    │
 *   │ ▶ OCP project ────────────│
 *   └───────────────────────────┘
 *
 * Each header row is a collapsible disclosure mirroring the MCP group's
 * ▼/▶ interaction: clicking the header row toggles that section's rows
 * (`collapse` + `onToggle` — omitted params default to expanded/no-op so
 * render-only callers keep the pre-collapse static tree).
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
  collapse: { readonly guards: boolean; readonly project: boolean } = { guards: false, project: false },
  onToggle?: (section: "guards" | "project") => void,
): unknown {
  if (guards.length === 0 && project.length === 0) return null

  // Build one row per badge — each row is a <box> containing a status dot
  // and a <text> with label + state.
  const renderRows = (badges: Badge[]): unknown[] => badges.map((b) => {
    // Variant priority: error > warning > success > info (default).
    // The dot carries the colour; the value text is always textMuted —
    // same convention as the MCP sidebar group (indicator coloured,
    // value neutral).
    const dotColor =
      b.variant === "error" ? theme.error :
      b.variant === "warning" ? theme.warning :
      b.variant === "success" ? theme.success :
      theme.info

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
          // `•` (U+2022) — same bullet glyph as the MCP sidebar group;
          // `●` renders noticeably larger in most terminal fonts.
          children: jsx("span", { children: "• " }),
        }),
        // Label (muted) — fixed 2-space gap before the value; column
        // alignment is intentionally skipped so long values (profile
        // names) never wrap in the narrow sidebar.
        jsx("text", {
          style: { fg: theme.textMuted },
          children: jsx("span", { children: b.label + "  " }),
        }),
        // State value — wraps to next line when too long. Always neutral
        // (textMuted) — colour lives on the dot only. Display casing is
        // title case per word ("Off", "No Index", "On · Empty"), matching
        // MCP's "Needs Auth"-style readability without the shouty ALL-CAPS;
        // the badge builders keep their ALL-CAPS contract for tests/filters.
        jsx("text", {
          style: { fg: theme.textMuted },
          children: jsx("span", {
            children: b.state.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" "),
          }),
        }),
      ],
    })
  })

  // Section header rows: "▼ OCP v0.7.3 ─" / "▶ OCP project ─"
  // Version comes from ~/.config/opencode/installed.version (written by installer).
  // `suffix` is rendered inline after the title in warning colour —
  // used for "↑ vX.Y.Z" when a newer release is available. No gap above
  // the OCP project header — the header rule is separator enough,
  // matching the tight stacking of the MCP/LSP sidebar groups.
  //
  // Collapsible disclosure (mirrors the MCP group's ▼/▶ header): the
  // leading rule glyph doubles as the state marker — ▼ expanded, ▶
  // collapsed. When `section.onToggle` is provided the whole header row
  // is clickable; mouse events bubble from the hit text child up to this
  // box (Renderable.processMouseEvent), so the full row is the hit target.
  // Bound on "up" for click semantics (a drag ending here never reaches
  // this handler — the renderer routes dragged releases to the captured
  // renderable instead).
  const renderHeader = (text: string, suffix = "", section?: { readonly collapsed: boolean; readonly onToggle?: () => void }) => {
    // Same `fg` rename as the badge rows above — `color` is ignored by
    // OpenTUI's <text> reconciler.
    const borderStyle = { fg: theme.borderSubtle }
    const warningStyle = { fg: theme.warning }
    const marker = section ? (section.collapsed ? "▶" : "▼") : "─"
    const headerChildren: unknown[] = [
      jsx("text", {
        style: borderStyle,
        children: jsx("span", { children: `${marker} ${text}` }),
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
      style: { flexDirection: "row", paddingLeft: 1, height: 1 },
      // `onMouseUp` rides the reconciler's default property branch →
      // Renderable's `set onMouseUp` → the renderer's "up" mouse listener.
      onMouseUp: section?.onToggle ? () => section.onToggle?.() : undefined,
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
  if (guards.length > 0) {
    sections.push(renderHeader(`OCP v${version}`, updateSuffix, {
      collapsed: collapse.guards,
      onToggle: onToggle ? () => onToggle("guards") : undefined,
    }))
    // Collapsed sections keep their clickable header and drop the rows —
    // same contract as the MCP group's disclosure.
    if (!collapse.guards) sections.push(...renderRows(guards))
  }
  if (project.length > 0) {
    sections.push(renderHeader("OCP project", "", {
      collapsed: collapse.project,
      onToggle: onToggle ? () => onToggle("project") : undefined,
    }))
    if (!collapse.project) sections.push(...renderRows(project))
  }

  // Combine sections in a vertical container
  return jsx("box", {
    style: { flexDirection: "column", paddingTop: 0, paddingBottom: 0 },
    children: sections,
  })
}

// ─── Plugin entry ──────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2000

/**
 * Global config dir for the installed.version probe. Mirrors v2's
 * global-roots precedence: OPENCODE_CONFIG_DIR override, then
 * $XDG_CONFIG_HOME/opencode, then ~/.config/opencode.
 */
function ocpConfigDir(): string {
  const override = process.env.OPENCODE_CONFIG_DIR
  if (override) return override
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(xdg, "opencode")
}

/**
 * Panel state — signals, timers, and event subscriptions owned by the
 * plugin's SETUP scope. They must not live in the slot component: the TUI
 * loads this module's solid-js as a SEPARATE instance from the host's, so
 * inside a slot component onCleanup has no plugin-side owner (silently
 * never runs) and usePlugin sees the host-side context (missing). Context
 * travels as a prop; disposal runs from setup's return value.
 */
interface PanelState {
  readonly ctx: Context
  readonly tick: () => number
  readonly currentModelId: () => string
  readonly latestVersion: () => string
  readonly collapse: () => { readonly guards: boolean; readonly project: boolean }
  readonly toggleSection: (section: "guards" | "project") => void
  readonly projectDir: string
  readonly ocpVersion: string
  readonly dispose: () => void
}

function createPanelState(ctx: Context): PanelState {
  // Poll config files because slash-command toggles write to disk
  // asynchronously — there is no server→TUI event for "config field changed".
  // A 2s interval is cheap (a handful of small file reads) and keeps the
  // panel snappy. Capability checks are existsSync + one global config
  // read — still cheap. Index staleness (git log) is deliberately excluded.
  const [tick, setTick] = createSignal(0)
  // Track the live model id (see deepseek-anchor gating). Seeded from the
  // current route's session; refreshed on session.model.selected events.
  // Empty string = "model not yet known".
  const [currentModelId, setCurrentModelId] = createSignal<string>("")
  // Latest OCP release tag from GitHub (empty = no fetch result yet, or
  // fetch failed). Refreshed on startup and every FETCH_REFRESH_MS.
  // Drives the "↑ vX.Y.Z" suffix on the OCP header.
  const [latestVersion, setLatestVersion] = createSignal<string>("")
  const projectDir = ctx.location?.directory || ctx.data.location.default().directory || process.cwd()

  // Read OCP version from installed.version (written by the installer to
  // the config directory, e.g. ~/.config/opencode/installed.version).
  const versionFile = join(ocpConfigDir(), "installed.version")
  let ocpVersion = "unknown"
  try {
    if (existsSync(versionFile)) {
      ocpVersion = readFileSync(versionFile, "utf-8").trim()
    }
  } catch { /* ignore */ }

  const refresh = () => setTick((t) => t + 1)

  // Collapsible sections (MCP-style ▼/▶ disclosure). The click handler lives
  // on the header row boxes built in renderStatusPanel; toggling flips this
  // signal and the panel memo re-renders (it reads collapse() every pass).
  const [collapse, setCollapse] = createSignal({ guards: false, project: false })
  const toggleSection = (section: "guards" | "project") =>
    setCollapse((c) => ({ ...c, [section]: !c[section] }))

  // Seed the model id from the session open at mount time. The V4 Pro /
  // non-V4 Pro distinction is refined by session.model.selected events;
  // the cache may still be empty at mount, which just means the gated row
  // appears after the first model selection.
  const seedRoute = ctx.ui.router.current()
  if (seedRoute.type === "session") {
    const seeded = modelIdFromRef(ctx.data.session.get(seedRoute.sessionID)?.model)
    if (seeded) setCurrentModelId(seeded)
  }

  // Data events — unsubscribe on slot dispose.
  const offModelSelected = ctx.data.on("session.model.selected", (event) => {
    const id = modelIdFromRef(event.data.model)
    if (!id || id === currentModelId()) return
    setCurrentModelId(id)
    refresh()
  })
  const offSessionCreated = ctx.data.on("session.created", () => refresh())

  // Async latest-version probe. Fire-and-forget on startup so we never
  // block the render path; failures are silent (network/CN rate-limit
  // issues shouldn't show in the sidebar — we just skip the indicator).
  // Re-probe every FETCH_REFRESH_MS so long-running sessions stay fresh.
  //
  // Robustness:
  //   - Dedupe: skip when a previous fetch is still in-flight (e.g. a
  //     15s timeout still pending while the 30-min interval fires), so
  //     we never queue concurrent fetches.
  //   - Lifecycle-bound: an owned AbortSignal cancels any in-flight fetch
  //     immediately when the slot disposes.
  //   - Silent: every error path inside fetchLatestVersion is wrapped;
  //     the outer .catch on the chain is the final safety net so
  //     checkUpdate() can never throw.
  const abort = new AbortController()
  let inFlight: Promise<unknown> | null = null
  const checkUpdate = (): void => {
    if (inFlight) return
    inFlight = fetchLatestVersion(abort.signal)
      .then((v) => {
        if (v && v !== latestVersion()) setLatestVersion(v)
      })
      .catch(() => { /* silent — see comment above */ })
      .finally(() => { inFlight = null })
  }
  void checkUpdate()

  const timer = setInterval(refresh, POLL_INTERVAL_MS)
  const fetchTimer = setInterval(checkUpdate, FETCH_REFRESH_MS)
  return {
    ctx,
    tick,
    currentModelId,
    latestVersion,
    collapse,
    toggleSection,
    projectDir,
    ocpVersion,
    dispose() {
      clearInterval(timer)
      clearInterval(fetchTimer)
      offSessionCreated()
      offModelSelected()
      abort.abort()
    },
  }
}

/**
 * The panel component — renders the current state. The body runs once per
 * slot mount; only the memo lives in this scope. Timers/subscriptions stay
 * in createPanelState (see the dual-instance note there) — context and
 * state arrive as props, disposal as setup's return value.
 */
function SidebarPanel(props: { readonly panel: PanelState }) {
  const p = props.panel

  // Reactive panel tree: tick() forces the badge rebuild, modelId() and
  // latestVersion() feed the gating / header suffix. Reactive children so
  // the tree repaints in place without remounting the slot contribution.
  const view = createMemo(() => {
    p.tick()
    const guards = safeBadges(() => buildGuardBadges(p.projectDir, p.currentModelId() || undefined))
    const project = safeBadges(() => buildProjectBadges(p.projectDir))
    // collapse() read inside the memo — a header click flips the signal and
    // this tree re-renders in place (same mechanism as tick()).
    const collapse = p.collapse()
    return renderStatusPanel(guards, project, panelTheme(p.ctx), p.ocpVersion, p.latestVersion(), collapse, p.toggleSection)
  })
  return jsx("box", { children: view })
}

/** Never crash the TUI — a config read error just means no badges. */
function safeBadges(build: () => Badge[]): Badge[] {
  try {
    return build()
  } catch {
    return []
  }
}

const plugin: Plugin.Definition = {
  id: "opencode-prime.sidebar-status",
  setup(ctx: Context) {
    // Claim the sidebar content slot — the OCP group renders as a vertical
    // section at the TOP of the right sidebar (prepend = first inside the
    // target boundary, above the MCP/LSP groups). State and disposal live
    // with this scope (see createPanelState).
    const panel = createPanelState(ctx)
    const release = ctx.ui.slot({
      prepend: "sidebar.content",
      // The programmatic jsx() factory types components loosely
      // (Record<string, unknown> props); SidebarPanel's concrete props only
      // materialise at runtime — cast the component, not the props.
      render: () => jsx(SidebarPanel as unknown as (props: Record<string, unknown>) => unknown, { panel }),
    })
    return () => {
      release()
      panel.dispose()
    }
  },
}

export default plugin
