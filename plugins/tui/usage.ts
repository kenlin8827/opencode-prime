/// <reference types="bun" />
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { initI18n, tr, parseSlashArgs } from "./i18n"
import { parseJsonc } from "../shared/ocp-config"
import {
  getPublicModelCatalog,
  publicModelPageID,
  publicModelPrice,
  resetModelCatalogCacheForTests,
  type PublicModelCatalog,
} from "../shared/model-catalog"

/**
 * Usage — TUI token/cost usage dialog with per-dimension views.
 *
 * /usage            → dimension picker dialog (tab-style switching)
 * /usage all        → "by session" table directly
 * /usage agent      → "by agent" table directly
 * /usage model      → "by model" table directly
 *
 * Three aggregation dimensions over the CURRENT conversation tree
 * (root session + subagent sessions):
 *   session — one row per session (agent@tag), with total row
 *   agent   — one row per agent, sessions summed
 *   model   — one row per model, summed across all sessions
 *
 * Queried live from the opencode server via api.client (@opencode-ai/sdk v2).
 * No local collection or persistence: the server already stores every
 * assistant message with full token/cost data, so this plugin is a pure view
 * over that data.
 *
 * Data sources (per session):
 *   - session.messages  → assistant messages carry cost + tokens
 *                         (input/output/reasoning/cache read+write) and
 *                         mode/agent attribution; step-finish parts count steps;
 *                         compaction parts count compactions
 *   - session.get/children → conversation tree (root + subagents)
 *
 * Display policy: three token numbers only — non-cached input, output,
 * cached input (cache read). Reasoning and cache-write are counted by the
 * server cost but not shown — they don't appear in the Anthropic/OpenAI
 * usage dashboards either, which is the industry convention. cache.read
 * is the only cache counter shown because it's the user-facing savings
 * metric (cache hits billed at 0.1× input); cache.write is the one-time
 * investment to populate the cache and rarely exceeds ~1% of session
 * tokens, so a separate column would be visual noise.
 *
 * Tables render in a host dialog (DialogAlert); hosts without the dialog
 * API fall back to a toast. Picker → table → confirm → picker acts as
 * tab-style dimension switching. Tables taller than the viewport (capped at
 * MAX_VISIBLE_ROWS) scroll (↑/↓/j/k) inside the dialog while the tab strip,
 * context warning, column header, total row and footers stay pinned — the
 * summary is never clipped.
 *
 * Note: this is a TUI-only module — it can only run while the TUI is active.
 */

// TUI prepends "/" itself — slashName must be bare (like "queued", "profile").
const SLASH_NAME = "usage"
const TOAST_DURATION = 15_000
// Guard against runaway trees when walking subagent children.
const MAX_TREE_DEPTH = 3
const MAX_PARENT_HOPS = 10

// ─── Types ──────────────────────────────────────────────────────────────────

/** Minimal structural types from the SDK (kept loose for test mocks). */
type Client = TuiPluginApi["client"]
/** Session-level metadata returned by the SDK. Optional aggregate token/cost
  * fields are populated when the server has already summed the session's
  * usage (e.g. `tokens_input`, `tokens_output`, `tokens_cache_read`,
  * `tokens_cache_write`, `tokens_reasoning`, `cost` on the session row);
  * `/usage` prefers those over summing per-message tokens — the latter
  * double-counts the conversation context that each assistant message
  * re-sends, inflating the total beyond what the server actually billed. */
type SessionInfo = {
  id: string
  parentID?: string
  agent?: string
  tokens_input?: number
  tokens_output?: number
  tokens_reasoning?: number
  tokens_cache_read?: number
  tokens_cache_write?: number
  cost?: number
}
type AssistantInfo = { role?: string; mode?: string; agent?: string; providerID?: string; modelID?: string; cost?: number; tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } }
type MessagePart = { type?: string; cost?: number; tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } }

interface SessionUsage {
  id: string
  agent?: string
  /** Non-cached input tokens. */
  input: number
  output: number
  /** Cached input tokens served from cache. */
  cacheRead: number
  /** Cached input tokens written to cache. */
  cacheWrite: number
  /** Reasoning tokens (e.g. extended thinking). */
  reasoning: number
  /** Server-billed cost in USD (from the SDK `info.cost` or session row). */
  cost: number
  /** True when `cost` came from real server billing, false when it's $0
   *  because the provider is on a plan or skipped billing metadata. The
   *  cost column shows 🏷️ when false. */
  costKnown: boolean
  /** OCP supplementary — coding-plan points (积分) for plan providers. */
  credits: number
  creditsKnown: boolean
  /** OCP supplementary — cash ($/Mtok) for non-plan providers whose server cost is 0. */
  cash: number
  cashKnown: boolean
  /** Simulated USD estimate — shown (with 🏷️) only when the server billed $0
   *  and no OCP real billing fallback (credits/cash) matched. Uses models.dev
   *  public list prices first; final fallback is a low-end market floor. */
  estimatedCost: number
  /** Canonical models.dev page ids ("lab/slug") used as pricing-standard links. */
  devModels: string[]
  /** Full opencode model ids that missed models.dev and used the final floor. */
  floorModels: string[]
  steps: number
  compactions: number
  inputByModel: Record<string, number>
  outputByModel: Record<string, number>
  cacheByModel: Record<string, number>
  stepsByModel: Record<string, number>
  costByModel: Record<string, number>
  creditsByModel: Record<string, number>
  cashByModel: Record<string, number>
  estimatedCostByModel: Record<string, number>
}

export type UsageDimension = "session" | "agent" | "model"

// ─── OCP supplementary data: GLM coding-plan points (积分) ──────────────────

/**
 * opencode bills subscription coding plans at $0 (usage is bundled in the
 * plan fee), so the dollar column is structurally zero for them. BigModel
 * publishes an official points-deduction scheme instead; this dataset mirrors
 * it so the usage dialog can show plan consumption in points.
 *
 * Source: https://docs.bigmodel.cn/cn/coding-plan/overview
 *   模型消耗积分数 = (输入 Token × Input 系数 + 缓存命中 Token × Cached 系数
 *                    + 输出 Token × Output 系数) / 10000
 *   GLM-5.3:       6.9 / 1.7 / 24
 *   GLM-5.3-Flash: 2.3 / 0.56 / 8
 * Non-peak hours (outside Mon–Fri 14:00–18:00 UTC+8) deduct at 50% — not
 * applied here because per-token timestamps are not tracked.
 */

/** OCP-supplied pricing dataset for subscription coding plans (积分抵扣).
 *  Loaded lazily from the user config dir at first use; fail-open → null. */
type CostRates = Record<string, { input: number; cached?: number; cache_read?: number; output: number }>
type ProviderCosts = { credits?: boolean; divisor: number; rates: CostRates; source?: string }
type CostsData = { providers: Record<string, ProviderCosts>; /** Last-resort USD/MTok
 *  price floor applied when no provider/model entry matches and the server
 *  hasn't billed anything. Represents the industry "kill-line" of cheap-tier
 *  models (OpenAI gpt-5-nano @ $0.10, Anthropic Haiku 4.5 @ $1.00, Gemini
 *  flash tier). Using the median of these gives a conservative lower bound:
 *  actual spend will be ≥ this estimate, never <, so the figure can be read
 *  as a "this is at least what you would have paid" ceiling. Per1M tokens. */
  killLineUSD?: { input: number; cached: number; output: number; source?: string } }
let costsDataCache: CostsData | null | undefined

/** Resolve at call time so env overrides (tests) take effect after import. */
function costsFilePath(): string {
  if (process.env.OCP_POINTS_PATH) return process.env.OCP_POINTS_PATH
  const os = require("node:os") as typeof import("node:os")
  const base = process.env.XDG_CONFIG_HOME ||
    (process.platform === "win32"
      ? `${process.env.USERPROFILE || os.homedir()}\\.config`
      : `${os.homedir()}/.config`)
  return `${base}/opencode/models/cost.jsonc`
}

export function loadCosts(): CostsData | null {
  if (costsDataCache !== undefined) return costsDataCache
  let file = ""
  try {
    const fs = require("node:fs") as typeof import("node:fs")
    file = costsFilePath()
    if (!fs.existsSync(file)) { costsDataCache = null; return null }
    const cfg = parseJsonc(fs.readFileSync(file, "utf8")) as Partial<CostsData>
    const providers: Record<string, ProviderCosts> = {}
    for (const [pid, p] of Object.entries((cfg as any).providers ?? {}) as Array<[string, any]>) {
      if (!p || typeof p !== "object") continue
      const rates: CostRates = {}
      for (const [mid, e] of Object.entries((p as any).rates ?? {})) {
        if (!e || typeof e !== "object") continue
        rates[mid] = {
          input: (e as any).input,
          cached: (e as any).cached,
          cache_read: (e as any).cache_read,
          output: (e as any).output,
        }
      }
      providers[pid] = {
        credits: p.credits === true,
        divisor: typeof p.divisor === "number" && p.divisor > 0 ? p.divisor : 10000,
        rates,
        source: typeof p.source === "string" ? p.source : undefined,
      }
    }
    const kl = (cfg as any).killLineUSD
    const killLineUSD = kl && typeof kl.input === "number" && typeof kl.cached === "number" && typeof kl.output === "number"
      ? { input: kl.input, cached: kl.cached, output: kl.output, source: typeof kl.source === "string" ? kl.source : undefined }
      : undefined
    costsDataCache = Object.keys(providers).length > 0 || killLineUSD ? { providers, killLineUSD } : null
    return costsDataCache
  } catch (e) { console.error("loadCosts err:", file, (e as Error)?.message); costsDataCache = null; return null }
}

/** Reset usage-pricing caches (used by tests when they change OCP_* paths). */
export function resetCostsCache(): void {
  costsDataCache = undefined
  modelsDevCatalog = undefined
  resetModelCatalogCacheForTests()
}

/** OCP-supplied usage for a message: either积分 (points, divided by provider divisor) or
 *  cash ($/Mtok). Returns null when out of plan scope or no matching entry. */
function computeUsageForMessage(providerID: string, modelID: string, input: number, cacheRead: number, output: number): { value: number; type: "credits" | "cash" } | null {
  const data = loadCosts()
  if (!data || !data.providers[providerID]) return null
  const p = data.providers[providerID]
  const rate = p.rates[modelID]
  if (!rate) return null
  if (p.credits) {
    const divisor = typeof p.divisor === "number" && p.divisor > 0 ? p.divisor : 10000
    return {
      value: (input * (rate.input || 0) + cacheRead * (rate.cached || 0) + output * (rate.output || 0)) / divisor,
      type: "credits",
    }
  }
  // cash — $/Mtok
  return {
    value: (input * (rate.input || 0) + output * (rate.output || 0) + cacheRead * (rate.cache_read || 0)) / 1_000_000,
    type: "cash",
  }
}

function fmtCredits(credits: number | null): string {
  return credits == null ? "—" : credits.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Strip the `provider/` prefix from a model id, leaving just the model
 *  segment for display. `minimax-cn-coding-plan/MiniMax-M3` → `MiniMax-M3`.
 *  If there's no `/`, returns the input unchanged. Used by the model table
 *  to keep the model column compact; the full id is shown in a mapping
 *  footer below the table. */
function shortModelName(fullId: string): string {
  const slash = fullId.lastIndexOf("/")
  return slash === -1 ? fullId : fullId.slice(slash + 1)
}

/** Render the cost cell. When the server actually billed something
 *  (`costKnown=true`) the dollar amount is shown plain — no icon,
 *  since the server is the source of truth.
 *
 *  Otherwise (simulated estimate): a 🏷️ prefix marks the amount as a
 *  public-list-price simulation, not a real charge. The estimate basis
 *  and pricing-standard links live in the table footer, keeping this
 *  column narrow. */
function fmtCost(cost: number, estimatedCost: number, costKnown: boolean): string {
  const value = costKnown ? cost : estimatedCost
  const icon = costKnown ? "" : "🏷️ "
  return `${icon}$${value.toFixed(4)}`
}

// ─── models.dev pricing fallback (simulated cost) ───────────────────────────

/** Public list-price source is shared with /provider via model-catalog.ts. */
/** Final fallback when models.dev is unavailable or does not list the model.
 *  USD/MTok; intentionally a low-end market floor, disclosed in the footer. */
const FALLBACK_FLOOR_USD = { input: 0.06, cached: 0.012, output: 0.12 }
type ModelsDevPrice = { input: number; cached: number; output: number }
let modelsDevCatalog: PublicModelCatalog | undefined
let modelsDevRefreshInFlight: Promise<PublicModelCatalog> | undefined

async function getModelsDevAsync(): Promise<void> {
  if (!modelsDevRefreshInFlight) {
    modelsDevRefreshInFlight = getPublicModelCatalog().then((catalog) => { modelsDevCatalog = catalog; return catalog })
      .finally(() => { modelsDevRefreshInFlight = undefined })
  }
  await modelsDevRefreshInFlight
}

function getModelsDevSync(): void {
  if (!modelsDevCatalog) void getModelsDevAsync().catch(() => { /* fallback floor remains available */ })
}

function computeModelsDevEstimate(providerID: string, modelID: string, input: number, cacheRead: number, output: number): { value: number; pageId?: string } | null {
  const price = modelsDevCatalog ? publicModelPrice(modelsDevCatalog, providerID, modelID) : null
  if (!price) return null
  return {
    value: (input * price.input + cacheRead * price.cached + output * price.output) / 1_000_000,
    pageId: modelsDevCatalog ? publicModelPageID(modelsDevCatalog, modelID) || undefined : undefined,
  }
}

// ─── Aggregation (SDK queries) ──────────────────────────────────────────────


const EMPTY: Omit<SessionUsage, "id" | "agent"> = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  cost: 0,
  costKnown: false,
  credits: 0,
  creditsKnown: false,
  cash: 0,
  cashKnown: false,
  estimatedCost: 0,
  devModels: [],
  floorModels: [],
  steps: 0,
  compactions: 0,
  inputByModel: {},
  outputByModel: {},
  cacheByModel: {},
  stepsByModel: {},
  creditsByModel: {},
  cashByModel: {},
  costByModel: {},
  estimatedCostByModel: {},
}

async function usageForSession(client: Client, session: SessionInfo): Promise<SessionUsage> {
  const m: SessionUsage = {
    id: session.id,
    agent: session.agent,
    ...EMPTY,
    devModels: [], floorModels: [],
    inputByModel: {}, outputByModel: {}, cacheByModel: {}, stepsByModel: {}, creditsByModel: {}, cashByModel: {}, costByModel: {}, estimatedCostByModel: {},
  }

  // Prefer server-aggregated totals when the SDK supplies them (session row
  // carries tokens_input/output/cache_read/cache_write/reasoning/cost).
  // Per-message summing double-counts the conversation context each
  // assistant message re-sends, so totals drift upward vs. what the server
  // actually billed.
  // Require ALL core aggregates — a partial payload (e.g. cost without
  // tokens) would silently zero out the missing fields and undercount, which
  // is worse than falling back to per-message summing. Type guards are
  // inlined in the `if` (so TS narrows each `session.tokens_*` property to
  // `number` inside the block) AND a separate boolean `usedAggregates` is
  // set so the per-message loop downstream (line ~599) knows whether to
  // double-add the per-message costs.
  let usedAggregates = false
  if (
    typeof session.tokens_input === "number" &&
    typeof session.tokens_output === "number" &&
    typeof session.tokens_cache_read === "number" &&
    typeof session.cost === "number"
  ) {
    m.input = session.tokens_input
    m.output = session.tokens_output
    m.cacheRead = session.tokens_cache_read
    m.cacheWrite = session.tokens_cache_write || 0
    m.reasoning = session.tokens_reasoning || 0
    m.cost = session.cost
    // costKnown: false if the server-billed total is exactly $0 — that means
    // we're either on a plan, the provider skipped billing metadata, or the
    // conversation is so cheap it rounds to $0. Either way the cell should
    // be flagged so the user knows.
    m.costKnown = session.cost > 0
    usedAggregates = true
  }

  let messages: Array<{ info: AssistantInfo; parts?: MessagePart[] }> = []
  try {
    const res = await client.session.messages({ sessionID: session.id })
    messages = (res?.data ?? []) as typeof messages
  } catch {
    return m
  }

  for (const msg of messages) {
    const info = msg?.info
    if (info?.role !== "assistant") continue
    const t = info.tokens || {}
    const model = `${info.providerID || "unknown"}/${info.modelID || "unknown"}`
    const cost = info.cost || 0
    // When the server supplied session-level totals, don't double-add the
    // per-message cost/tokens/cache. The message loop still walks the corpus
    // for per-model breakdown, which the session row does not expose.
    if (!usedAggregates) {
      m.cost += cost
      m.input += t.input || 0
      m.output += t.output || 0
      m.cacheRead += t.cache?.read || 0
      m.cacheWrite += t.cache?.write || 0
      m.reasoning += t.reasoning || 0
    }
    // Track whether ANY assistant message carried a real server-side cost —
    // if so we trust the cost column and skip the kill-line skull. Aggregates
    // path sets costKnown when the session row cost > 0; per-message path
    // needs to flag it here too.
    if (cost > 0) m.costKnown = true
    // OCP supplementary fallback: only when the server billed nothing (cost 0)
    // do we consult the points dataset for subscription coding plans.
    if (!m.cost) {
      const usage = computeUsageForMessage(info.providerID || "", info.modelID || "", t.input || 0, t.cache?.read || 0, t.output || 0)
      if (usage) {
        if (usage.type === "credits") {
          m.creditsKnown = true
          m.credits += usage.value
          m.creditsByModel[model] = (m.creditsByModel[model] || 0) + usage.value
          m.stepsByModel[model] = (m.stepsByModel[model] || 0) + 1
          // Credits are a real billing mechanism even when cost stays $0
          // — flag costKnown so the cost cell doesn't fall back to a kill-
          // line skull. The credits column is where the real spend lives.
          m.costKnown = true
        } else {
          // cash fallback (user-curated in OCP dataset; defaults to server $0 otherwise)
          m.cashKnown = true
          m.cash += usage.value
          m.cashByModel[model] = (m.cashByModel[model] || 0) + usage.value
          // Cash fallback is also a known pricing source (user curated $/MTok)
          m.costKnown = true
        }
      }
    }
    // Simulated USD estimate: applied to EVERY message, even when server did
    // bill something — but the rendered column will prefer `m.cost` and show
    // this only when the server total is $0. Source order: models.dev public
    // list price, then a hardcoded low-end market floor if the model is absent.
    {
      const est = computeModelsDevEstimate(info.providerID || "", info.modelID || "", t.input || 0, t.cache?.read || 0, t.output || 0)
      const value = est?.value ??
        (((t.input || 0) * FALLBACK_FLOOR_USD.input +
          (t.cache?.read || 0) * FALLBACK_FLOOR_USD.cached +
          (t.output || 0) * FALLBACK_FLOOR_USD.output) / 1_000_000)
      m.estimatedCost += value
      m.estimatedCostByModel[model] = (m.estimatedCostByModel[model] || 0) + value
      if (est) {
        if (est.pageId && !m.devModels.includes(est.pageId)) m.devModels.push(est.pageId)
      } else {
        if (!m.floorModels.includes(model)) m.floorModels.push(model)
      }
    }
    if (info.mode || info.agent) m.agent = info.agent || info.mode

    m.inputByModel[model] = (m.inputByModel[model] || 0) + (t.input || 0)
    m.outputByModel[model] = (m.outputByModel[model] || 0) + (t.output || 0)
    m.cacheByModel[model] = (m.cacheByModel[model] || 0) + (t.cache?.read || 0)
    m.costByModel[model] = (m.costByModel[model] || 0) + cost

    for (const part of msg.parts || []) {
      if (part?.type === "step-finish") {
        m.steps++
        m.stepsByModel[model] = (m.stepsByModel[model] || 0) + 1
      }
      if (part?.type === "compaction") m.compactions++
    }
  }
  return m
}

async function rootSession(client: Client, sessionId: string): Promise<SessionInfo | undefined> {
  let current: SessionInfo | undefined
  try {
    const res = await client.session.get({ sessionID: sessionId })
    current = res?.data as SessionInfo | undefined
  } catch {
    return undefined
  }
  let hops = 0
  while (current?.parentID && hops++ < MAX_PARENT_HOPS) {
    try {
      const res = await client.session.get({ sessionID: current.parentID })
      current = res?.data as SessionInfo | undefined
    } catch {
      break
    }
  }
  return current
}

async function conversationTree(client: Client, sessionId: string): Promise<SessionInfo[]> {
  const root = await rootSession(client, sessionId)
  if (!root) return []

  const tree: SessionInfo[] = [root]
  let frontier = [root.id]
  for (let depth = 0; depth < MAX_TREE_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = []
    for (const parentID of frontier) {
      try {
        const res = await client.session.children({ sessionID: parentID })
        for (const child of (res?.data ?? []) as SessionInfo[]) {
          if (tree.some((s) => s.id === child.id)) continue
          tree.push(child)
          next.push(child.id)
        }
      } catch {
        // children listing is best-effort
      }
    }
    frontier = next
  }
  // Children listing typically returns id-only entries (no tokens/cost).
  // Hydrate each with the full session object (tokens_input/output/
  // cache_read/cache_write/reasoning, cost) so usageForSession can prefer
  // the server-aggregated totals over per-message sums. Merge with
  // existing fields rather than overwrite — child listings may already
  // carry agent/parentID, and a session.get roundtrip would lose them
  // if the server response is sparse.
  for (let i = 0; i < tree.length; i++) {
    const s = tree[i]
    if (
      typeof s.tokens_input === "number" &&
      typeof s.tokens_output === "number" &&
      typeof s.tokens_cache_read === "number" &&
      typeof s.cost === "number"
    ) continue
    try {
      const res = await client.session.get({ sessionID: s.id })
      if (res?.data) tree[i] = { ...s, ...(res.data as SessionInfo) }
    } catch {
      // session.get is best-effort; id-only entry is still usable
    }
  }
  return tree
}

/** Conversation tree with per-session usage, dropping sessions without data. */
async function collectSessions(client: Client, sessionId: string): Promise<SessionUsage[]> {
  const tree = await conversationTree(client, sessionId)
  const usages: SessionUsage[] = []
  for (const session of tree) {
    const m = await usageForSession(client, session)
    usages.push(m)
  }
  return usages.filter((m) => m.steps > 0 || m.input > 0)
}

// ─── Table rendering ────────────────────────────────────────────────────────

function formatBar(pct: number, width = 6): string {
  const filled = Math.max(pct > 0 ? 1 : 0, Math.round((pct / 100) * width))
  return "\u2588".repeat(Math.min(filled, width)) + "\u2591".repeat(Math.max(0, width - Math.min(filled, width)))
}

function hitRate(cacheRead: number, input: number): string {
  const denom = input + cacheRead
  return denom > 0 ? ((cacheRead / denom) * 100).toFixed(1) : "0.0"
}

/**
 * Tiered thresholds for the context-watch banner. Picked from the opencode
 * ecosystem's own guidance (`skills/dev-ultra/SKILL.md:418` — "orchestrator
 * has a finite context window — compaction prevents overflow but does not
 * eliminate the ceiling") and Anthropic's ~50-100 turn recommendation.
 * Numbers are deliberately conservative: the user gets a gentle hint
 *  long before quality actually drops, so they can act while the cost is
 *  still negligible. Tiers are cumulative — past `hard`, the strongest
 *  message wins, so we never show two warnings stacked.
 *
 *  Single source of truth lives in plugins/context-watch/context-watch.ts
 *  (CONTEXT_TIERS) — both /usage banner and the LLM-side reminder must
 *  agree on the threshold; importing the constant here keeps them in sync
 *  without a duplicate literal that could drift. */
import { CONTEXT_TIERS as CONTEXT_WARN_TIERS } from "../context-watch/context-watch"

/** Build the optional context-warning banner that appears above the
 *  /usage table. Returns "" when nothing is worth surfacing so the caller
 *  can splice the result without conditional layout. Picks the highest
 *  applicable tier so the message escalates monotonically — once the
 *  session crosses `hard`, we don't keep showing the softer reminders.
 *  Compaction warnings are independent (different mechanism) and stack
 *  with the turn-tier when both apply. */
function renderContextWarning(totalSteps: number, totalCompactions: number): string {
  const lines: string[] = []
  if (totalCompactions > 0) {
    lines.push(tr("usage.contextWarning.compactions", { count: totalCompactions }))
  }
  if (totalSteps >= CONTEXT_WARN_TIERS.hard) {
    lines.push(tr("usage.contextWarning.hard", { count: totalSteps }))
  } else if (totalSteps >= CONTEXT_WARN_TIERS.strong) {
    lines.push(tr("usage.contextWarning.strong", { count: totalSteps }))
  } else if (totalSteps >= CONTEXT_WARN_TIERS.soft) {
    lines.push(tr("usage.contextWarning.soft", { count: totalSteps }))
  }
  return lines.join("\n")
}

/** Token counts. Below 1M the exact value is shown (11702 → "11,702")
 *  because "0.01M" is noisy and forces mental math; above 1M the
 *  industry-standard MTok notation kicks in (1.23M, 14.5M, 234M), matching
 *  OpenAI ("per 1M tokens") and Anthropic ("$X / MTok") so the reader can
 *  do cost math directly off the display. Deliberately not Intl compact
 *  notation: it follows the locale (zh-CN → 万), which fights the M
 *  convention. */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return fmtScaled(n / 1_000_000) + "M"
  return n.toLocaleString()
}

function fmtScaled(v: number): string {
  // Sub-1M values use 2 decimals (0.05M, 0.38M) so token counts like 11,702
  // don't round to "0M"; above 1M 1 decimal is enough (1.2M, 14.5M); above
  // 100M we drop the decimal entirely (234M).
  const s = v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2)
  return s.replace(/\.?0+$/, "")
}


/** Display width of a single char — CJK/fullwidth chars and emoji count as 2 so tables align in monospace. */
function charWidth(ch: string): number {
  return /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F300}-\u{1FAFF}\u2B50\u2705\u274C\u2757]/u.test(ch) ? 2 : 1
}

/** Display width — CJK/fullwidth chars and emoji count as 2 so tables align in monospace. */
function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) w += charWidth(ch)
  return w
}

/** Truncate to at most maxW display columns, appending "…" when cut. Keeps
 *  long agent/model names from blowing up the dialog width tier. */
function truncateW(s: string, maxW: number): string {
  if (displayWidth(s) <= maxW) return s
  let w = 0
  let out = ""
  for (const ch of s) {
    if (w + charWidth(ch) > maxW - 1) break // reserve 1 column for "…"
    out += ch
    w += charWidth(ch)
  }
  return out + "…"
}

function padEndW(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - displayWidth(s)))
}

function padStartW(s: string, w: number): string {
  return " ".repeat(Math.max(0, w - displayWidth(s))) + s
}

/** Structured table view — the flat string keeps its exact rendering, but the
 *  parts let the dialog scroll data rows while the header, total row and
 *  footers stay pinned (small terminals would otherwise clip the table). */
export interface TableView {
  /** Column header line + rule line, joined by a single "\n". */
  header: string
  /** One formatted line per data row (total row excluded). */
  dataRows: string[]
  /** Summary row — always the last table row in the flat rendering. */
  totalRow: string
  /** Footer blocks below the table (kill-line note, model-id mapping). */
  footers: string[]
}

const EMPTY_TABLE_VIEW: TableView = { header: "", dataRows: [], totalRow: "", footers: [] }

/** Column-aligned table with a rule under the header and airy row spacing; aligns[i] === "r" right-aligns column i. */
function renderTableView(headers: string[], rows: string[][], totalRow: string[], aligns: Array<"l" | "r">): TableView {
  const widths = headers.map((h, i) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? "")), displayWidth(totalRow[i] ?? "")))
  const fmt = (cells: string[]) =>
    cells.map((c, i) => (aligns[i] === "r" ? padStartW(c ?? "", widths[i]) : padEndW(c ?? "", widths[i]))).join("  ").replace(/\s+$/, "")
  const rule = fmt(widths.map((w) => "─".repeat(w)))
  // Header and rule stay tight; data rows get a blank line between them.
  return {
    header: fmt(headers) + "\n" + rule,
    dataRows: rows.map(fmt),
    totalRow: fmt(totalRow),
    footers: [],
  }
}

/** Flat single-string form of a table view (dialog message body, tests). */
function tableViewToString(tv: TableView): string {
  const table = [tv.header, ...tv.dataRows, tv.totalRow].join("\n\n")
  return tv.footers.length > 0 ? table + "\n\n" + tv.footers.join("\n\n") : table
}

/** Disclosure footer for 🏷️ simulated prices. The amount is only shown when
 *  the opencode server reported $0 and no real OCP billing fallback matched;
 *  link to the models.dev model pages used as the pricing standard. */
function pushEstimateFooters(tv: TableView, sessions: SessionUsage[], totalCostKnown: boolean): void {
  if (totalCostKnown) return
  const devModels = [...new Set(sessions.flatMap((s) => s.devModels))]
  const floorModels = [...new Set(sessions.flatMap((s) => s.floorModels))]
  if (devModels.length === 0 && floorModels.length === 0) return
  const lines = [tr("usage.estimateNote")]
  if (devModels.length > 0) {
    lines.push(...devModels.slice(0, 8).map((id) => `• ${shortModelName(id)} → https://models.dev/models/${id}`))
    if (devModels.length > 8) lines.push(`• +${devModels.length - 8}`)
  }
  if (floorModels.length > 0) {
    lines.push(`• ${tr("usage.estimateFloor")}`)
  }
  tv.footers.push(lines.join("\n"))
}

// ─── Dimension views ────────────────────────────────────────────────────────

function sessionName(s: SessionUsage, currentSessionId: string): string {
  // 🧠 = main (current) agent — the brain, 🦾 = subagent — the arm doing the work
  const icon = s.id === currentSessionId ? "🧠" : "🦾"
  return s.agent ? truncateW(`${icon} ${s.agent}`, 20) : icon
}

/** One row per session, with a total row. Points column appears when any session is on a coding plan. */
function renderSessionTable(sessions: SessionUsage[], currentSessionId: string): TableView {
  const totalInput = sessions.reduce((sum, s) => sum + s.input, 0)
  const totalOutput = sessions.reduce((sum, s) => sum + s.output, 0)
  const totalCost = sessions.reduce((sum, s) => sum + s.cost, 0)
  const totalEstimated = sessions.reduce((sum, s) => sum + s.estimatedCost, 0)
  const totalCostKnown = sessions.some((s) => s.costKnown)
  const totalSteps = sessions.reduce((sum, s) => sum + s.steps, 0)
  const totalCacheRead = sessions.reduce((sum, s) => sum + s.cacheRead, 0)
  const totalCredits = sessions.reduce((sum, s) => sum + s.credits, 0)
  const totalAll = totalInput + totalOutput + totalCacheRead
  const showCredits = sessions.some((s) => s.creditsKnown)

  const rows = sessions.map((s) => {
    const pct = totalInput > 0 ? (s.input / totalInput) * 100 : 0
    return [
      sessionName(s, currentSessionId),
      fmtTokens(s.input),
      fmtTokens(s.output),
      fmtTokens(s.cacheRead),
      String(s.steps),
      fmtCost(s.cost, s.estimatedCost, s.costKnown),
      ...(showCredits ? [fmtCredits(s.creditsKnown ? s.credits : null)] : []),
      `${pct.toFixed(1)}% ${formatBar(pct)}`,
    ]
  })
  const totalRow = [
    tr("usage.totalRow"),
    fmtTokens(totalInput),
    fmtTokens(totalOutput),
    fmtTokens(totalCacheRead),
    String(totalSteps),
    fmtCost(totalCost, totalEstimated, totalCostKnown),
    ...(showCredits ? [fmtCredits(totalCredits)] : []),
    tr("usage.hitCell", { hit: hitRate(totalCacheRead, totalInput), total: fmtTokens(totalAll) }),
  ]
  const headers = [
    tr("usage.hSession"),
    tr("usage.hIn"),
    tr("usage.hOut"),
    tr("usage.hCached"),
    tr("usage.hSteps"),
    tr("usage.hCost"),
    ...(showCredits ? [tr("usage.hCredits")] : []),
    tr("usage.hShare"),
  ]
  const aligns: Array<"l" | "r"> = ["l", "r", "r", "r", "r", "r", "r"]
  if (showCredits) aligns.push("r")
  aligns.push("l")
  const tv = renderTableView(headers, rows, totalRow, aligns)
  pushEstimateFooters(tv, sessions, totalCostKnown)
  return tv
}

/** One row per agent — sessions grouped by agent attribution. */
function renderAgentTable(sessions: SessionUsage[]): TableView {
  const groups = new Map<string, { n: number; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; cost: number; estimatedCost: number; costKnown: boolean; credits: number; steps: number }>()
  for (const s of sessions) {
    const key = s.agent || "-"
    const g = groups.get(key) || { n: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, estimatedCost: 0, costKnown: false, credits: 0, steps: 0 }
    g.n++
    g.input += s.input
    g.output += s.output
    g.cacheRead += s.cacheRead
    g.cost += s.cost
    g.estimatedCost += s.estimatedCost
    g.costKnown = g.costKnown || s.costKnown
    g.credits += s.credits
    g.steps += s.steps
    groups.set(key, g)
  }
  const totalInput = [...groups.values()].reduce((sum, g) => sum + g.input, 0)
  const totalOutput = [...groups.values()].reduce((sum, g) => sum + g.output, 0)
  const totalCacheRead = [...groups.values()].reduce((sum, g) => sum + g.cacheRead, 0)
  const totalCost = [...groups.values()].reduce((sum, g) => sum + g.cost, 0)
  const totalEstimated = [...groups.values()].reduce((sum, g) => sum + g.estimatedCost, 0)
  const totalCostKnown = sessions.some((s) => s.costKnown)
  const totalSteps = [...groups.values()].reduce((sum, g) => sum + g.steps, 0)
  const totalCredits = [...groups.values()].reduce((sum, g) => sum + g.credits, 0)
  const totalAll = totalInput + totalOutput + totalCacheRead
  const showCredits = sessions.some((s) => s.creditsKnown)

  const rows = [...groups.entries()].sort(([, a], [, b]) => b.input - a.input).map(([agent, g]) => {
    const pct = totalInput > 0 ? (g.input / totalInput) * 100 : 0
    return [
      truncateW(agent, 16),
      String(g.n),
      fmtTokens(g.input),
      fmtTokens(g.output),
      fmtTokens(g.cacheRead),
      String(g.steps),
      fmtCost(g.cost, g.estimatedCost, g.costKnown),
      ...(showCredits ? [fmtCredits(g.credits)] : []),
      `${pct.toFixed(1)}% ${formatBar(pct)}`,
    ]
  })
  const totalRow = [
    tr("usage.totalRow"),
    String(sessions.length),
    fmtTokens(totalInput),
    fmtTokens(totalOutput),
    fmtTokens(totalCacheRead),
    String(totalSteps),
    fmtCost(totalCost, totalEstimated, totalCostKnown),
    ...(showCredits ? [fmtCredits(totalCredits)] : []),
    tr("usage.hitCell", { hit: hitRate(totalCacheRead, totalInput), total: fmtTokens(totalAll) }),
  ]
  const headers = [
    tr("usage.hAgent"),
    tr("usage.hSessions"),
    tr("usage.hIn"),
    tr("usage.hOut"),
    tr("usage.hCached"),
    tr("usage.hSteps"),
    tr("usage.hCost"),
    ...(showCredits ? [tr("usage.hCredits")] : []),
    tr("usage.hShare"),
  ]
  const aligns: Array<"l" | "r"> = ["l", "r", "r", "r", "r", "r", "r"]
  if (showCredits) aligns.push("r")
  aligns.push("l")
  const tv = renderTableView(headers, rows, totalRow, aligns)
  pushEstimateFooters(tv, sessions, totalCostKnown)
  return tv
}

/** One row per model — tokens/cost summed across all sessions in the tree. */
function renderModelTable(sessions: SessionUsage[]): TableView {
  const models = new Map<string, { n: number; input: number; output: number; cacheRead: number; cost: number; estimatedCost: number; costKnown: boolean; credits: number; steps: number }>()
  let totalEstimated = 0
  let totalCostKnown = false
  for (const s of sessions) {
    for (const [model, input] of Object.entries(s.inputByModel)) {
      const g = models.get(model) || { n: 0, input: 0, output: 0, cacheRead: 0, cost: 0, estimatedCost: 0, costKnown: false, credits: 0, steps: 0 }
      g.n++
      g.input += input
      g.output += s.outputByModel[model] || 0
      g.cacheRead += s.cacheByModel[model] || 0
      g.cost += s.costByModel[model] || 0
      g.estimatedCost += s.estimatedCostByModel[model] || 0
      g.costKnown = g.costKnown || (s.costByModel[model] || 0) > 0
      g.credits += s.creditsByModel[model] || 0
      g.steps += s.stepsByModel[model] || 0
      models.set(model, g)
      totalEstimated += s.estimatedCostByModel[model] || 0
      totalCostKnown = totalCostKnown || (s.costByModel[model] || 0) > 0
    }
  }
  const totalInput = [...models.values()].reduce((sum, g) => sum + g.input, 0)
  const totalOutput = [...models.values()].reduce((sum, g) => sum + g.output, 0)
  const totalCacheRead = [...models.values()].reduce((sum, g) => sum + g.cacheRead, 0)
  const totalCost = [...models.values()].reduce((sum, g) => sum + g.cost, 0)
  const totalSteps = [...models.values()].reduce((sum, g) => sum + g.steps, 0)
  const totalCredits = [...models.values()].reduce((sum, g) => sum + g.credits, 0)
  const totalAll = totalInput + totalOutput + totalCacheRead
  const showCredits = sessions.some((s) => s.creditsKnown)

  const rows = [...models.entries()].sort(([, a], [, b]) => b.input - a.input).map(([model, g]) => {
    const pct = totalInput > 0 ? (g.input / totalInput) * 100 : 0
    return [
      truncateW(shortModelName(model), 16),
      String(g.n),
      fmtTokens(g.input),
      fmtTokens(g.output),
      fmtTokens(g.cacheRead),
      String(g.steps),
      fmtCost(g.cost, g.estimatedCost, g.costKnown),
      ...(showCredits ? [fmtCredits(g.credits)] : []),
      `${pct.toFixed(1)}% ${formatBar(pct)}`,
    ]
  })
  const totalRow = [
    tr("usage.totalRow"),
    String(sessions.length),
    fmtTokens(totalInput),
    fmtTokens(totalOutput),
    fmtTokens(totalCacheRead),
    String(totalSteps),
    fmtCost(totalCost, totalEstimated, totalCostKnown),
    ...(showCredits ? [fmtCredits(totalCredits)] : []),
    tr("usage.hitCell", { hit: hitRate(totalCacheRead, totalInput), total: fmtTokens(totalAll) }),
  ]
  const headers = [
    tr("usage.hModel"),
    tr("usage.hSessions"),
    tr("usage.hIn"),
    tr("usage.hOut"),
    tr("usage.hCached"),
    tr("usage.hSteps"),
    tr("usage.hCost"),
    ...(showCredits ? [tr("usage.hCredits")] : []),
    tr("usage.hShare"),
  ]
  const aligns: Array<"l" | "r"> = ["l", "r", "r", "r", "r", "r", "r"]
  if (showCredits) aligns.push("r")
  aligns.push("l")
  const tv = renderTableView(headers, rows, totalRow, aligns)
  // Full-id mapping: only emit when at least one model name was actually
  // truncated (had a `/`). The short name in the table is derived by
  // taking the last `/`-segment, so showing the mapping keeps the
  // provider prefix recoverable without bloating the model column.
  const mappings = [...models.keys()]
    .map((full) => ({ short: shortModelName(full), full }))
    .filter((m) => m.short !== m.full)
  if (mappings.length > 0) {
    const lines = mappings
      .map((m) => `• ${m.short} ← ${m.full}`)
      .join("\n")
    tv.footers.push(`🆔 ${tr("usage.fullIdMapping")}\n${lines}`)
  }
  // In the model view, place simulated-pricing disclosure after the full-id
  // mapping: first explain what each short model name expands to, then explain
  // where the 🏷️ estimated price came from.
  pushEstimateFooters(tv, sessions, totalCostKnown)
  return tv
}

/**
 * Render one dimension of the current conversation tree.
 * Returns "" when no session in the tree has any usage data.
 */
export interface UsageRender {
  table: string
  /** Same content as `table`, structured for scrollable rendering. */
  view: TableView
  /** Aggregate step count across the rendered sessions — drives the
   *  context-watch banner. */
  totalSteps: number
  /** Aggregate opencode-driven compaction events. */
  totalCompactions: number
}

export async function formatByDimension(client: Client, sessionId: string, dim: UsageDimension): Promise<UsageRender> {
  // If we have no shared public catalog yet (cold install, no disk cache,
  // first /usage open), wait briefly so simulated costs can use real public
  // list prices instead of the hardcoded market-floor fallback.
  if (!modelsDevCatalog) {
    try {
      await Promise.race([
        getModelsDevAsync(),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ])
    } catch { /* fall through to the hardcoded floor fallback */ }
  }
  const sessions = await collectSessions(client, sessionId)
  if (sessions.length === 0) {
    return { table: "", view: EMPTY_TABLE_VIEW, totalSteps: 0, totalCompactions: 0 }
  }
  const view = dim === "agent"
    ? renderAgentTable(sessions)
    : dim === "model"
    ? renderModelTable(sessions)
    : renderSessionTable(sessions, sessionId)
  const totalSteps = sessions.reduce((sum, s) => sum + s.steps, 0)
  const totalCompactions = sessions.reduce((sum, s) => sum + s.compactions, 0)
  return { table: tableViewToString(view), view, totalSteps, totalCompactions }
}

// Tokens that identify the command itself, not a subcommand. Slash dispatch
// puts the command NAME ("usage.show") into ctx.input, so leading name
// tokens must be skipped when extracting the user's trailing argument.
const COMMAND_TOKENS = new Set(["usage.show", "usage", "/usage"])

/**
 * Extract subcommand args from the keymap command context. Check data.args
 * and payload first (likely the real slash args), ctx.input last; in every
 * source skip leading command-name tokens. (Generic version lives in i18n.)
 */
export function parseSubcommand(ctx: unknown): string | null {
  return parseSlashArgs(ctx, [...COMMAND_TOKENS])
}

function currentSessionID(api: TuiPluginApi): string | undefined {
  const route = api.route.current
  if (route.name !== "session") return undefined
  return (route.params as { sessionID?: string } | undefined)?.sessionID
}

// ─── Tab strip + view composition ───────────────────────────────────────────

const DIMENSIONS: UsageDimension[] = ["session", "agent", "model"]

const DIM_TITLE_KEY: Record<UsageDimension, string> = {
  session: "usage.dimSession",
  agent: "usage.dimAgent",
  model: "usage.dimModel",
}

const DIM_SUBCOMMAND: Record<string, UsageDimension> = {
  all: "session",
  session: "session",
  agent: "agent",
  model: "model",
}

/** Tab strip with the hotkey number baked into each label and an underline bar under the active tab:
 *  `(1) 按会话   (2) 按Agent   (3) 按模型`
 *  `▬▬▬▬▬▬▬`                        */
function renderTabStrip(active: UsageDimension): string {
  const labels = DIMENSIONS.map((d, i) => `(${i + 1})${tr(DIM_TITLE_KEY[d] as Parameters<typeof tr>[0])}`)
  const gap = "   "
  const strip = labels.join(gap)
  const idx = DIMENSIONS.indexOf(active)
  const offset = labels.slice(0, idx).reduce((w, l) => w + displayWidth(l) + gap.length, 0)
  const underline = " ".repeat(offset) + "▬".repeat(displayWidth(labels[idx]))
  return strip + "\n" + underline
}

/**
 * Dialog body: numbered tab strip + underline, blank, table. The numbers are
 * the hotkeys, so no hint line is needed. Rendered inside the host
 * DialogAlert (message is a plain string — opentui requires bare text to
 * live under a <text> element, and the plugin adapter exposes no Box/Text
 * primitives, so a self-drawn panel is not possible). The host's ok button
 * is unconditional (no prop hides it); Enter/Esc both close.
 */
export function renderDimensionView(rendered: UsageRender, dim: UsageDimension): string {
  const parts: string[] = [renderTabStrip(dim), ""]
  const warning = renderContextWarning(rendered.totalSteps, rendered.totalCompactions)
  if (warning) {
    parts.push(warning, "")
  }
  parts.push(rendered.table)
  return parts.join("\n")
}

/** Smallest dialog tier that fits the text (DialogUI widths: 60/88/116, minus 2+2 padding). */
export function fitDialogSize(text: string): "medium" | "large" | "xlarge" {
  const width = Math.max(...text.split("\n").map((l) => displayWidth(l))) + 5
  if (width <= 60) return "medium"
  if (width <= 88) return "large"
  return "xlarge"
}

// ─── Scrollable viewport (short terminals) ──────────────────────────────────

/** DialogAlert chrome, in terminal rows. Derived from the opencode TUI source
 *  (packages/tui/src/ui/dialog.tsx + dialog-alert.tsx): the backdrop pushes
 *  the panel down by a quarter of the terminal height, and the panel spends
 *  7 rows on paddingTop, the title row, gaps, message padding and the
 *  ok-button row. Message budget: termHeight − ceil(termHeight/4) − CHROME.
 *  Re-verify against the host source if the dialog layout ever changes. */
const DIALOG_CHROME = 7

/** Never show fewer than one data row, even on degenerate tiny terminals. */
const MIN_VISIBLE_ROWS = 1

/** Max data rows per viewport — keeps the dialog compact on tall terminals;
 *  shorter terminals still shrink adaptively below this. */
const MAX_VISIBLE_ROWS = 8

export interface ScrollView {
  /** Composed dialog message: pinned tab strip / warning / column header,
   *  the visible slice of data rows, then pinned total row + footers +
   *  scroll indicator. */
  view: string
  /** Row offset actually applied (input clamped to [0, maxOffset]). */
  offset: number
  /** Maximum row offset — 0 when the whole table fits (scrolling disabled). */
  maxOffset: number
}

/** Compose the dialog message for a viewport of at most MAX_VISIBLE_ROWS data
 *  rows (short terminals shrink it further). Pinned top: tab strip, context
 *  warning, column header + rule. Scrolling region: data rows only,
 *  row-granular (a row is never cut mid-line). Pinned bottom: total row,
 *  table footers, scroll indicator. When nothing overflows the output is
 *  byte-identical to renderDimensionView. */
export function renderScrollView(rendered: UsageRender, dim: UsageDimension, termHeight: number, offset: number): ScrollView {
  const tv = rendered.view
  const total = tv.dataRows.length
  // Every visible row costs 2 lines (row + separating blank) except the
  // last — same arithmetic as the flat "\n\n" join.
  const budget = Math.max(termHeight - Math.ceil(termHeight / 4) - DIALOG_CHROME, 4)
  const warning = renderContextWarning(rendered.totalSteps, rendered.totalCompactions)
  const warningLines = warning ? warning.split("\n").length + 1 : 0 // + trailing blank
  const pinnedTop = 2 /* tab strip */ + 1 /* blank */ + warningLines + 2 /* header + rule */
  const footerLines = tv.footers.reduce((n, f) => n + 1 + f.split("\n").length, 0) // + leading blank each
  const pinnedBottom = 2 /* blank + total row */ + footerLines
  const rowsFor = (withIndicator: boolean) =>
    Math.max(MIN_VISIBLE_ROWS, Math.min(MAX_VISIBLE_ROWS, Math.floor((budget - pinnedTop - pinnedBottom - (withIndicator ? 2 : 0) + 1) / 2)))
  let visible = rowsFor(false)
  let maxOffset = 0
  if (visible < total) {
    // Overflowing: reserve 2 lines for the indicator and re-solve.
    visible = rowsFor(true)
    maxOffset = Math.max(0, total - visible)
  }
  const start = Math.min(Math.max(offset, 0), maxOffset)
  const slice = tv.dataRows.slice(start, start + visible)
  const lines: string[] = [...renderTabStrip(dim).split("\n"), ""]
  if (warning) lines.push(...warning.split("\n"), "")
  lines.push(...tv.header.split("\n"))
  for (const row of slice) lines.push("", row)
  lines.push("", tv.totalRow)
  for (const f of tv.footers) lines.push("", ...f.split("\n"))
  if (maxOffset > 0) {
    lines.push("", tr("usage.scrollHint", { first: start + 1, last: start + slice.length, total }))
  }
  return { view: lines.join("\n"), offset: start, maxOffset }
}

// ─── Plugin entry ───────────────────────────────────────────────────────────

let activeDim: UsageDimension = "session"
/** True while the usage dialog is on-screen. */
let dialogOpen = false
/** Generation counter: each dialog open increments this. onClose only
 *  resets dialogOpen when its captured generation matches current,
 *  preventing stale onClose from dialog.replace() from clobbering state. */
let dialogGen = 0
/** Global keypress handler: intercepts dimension-switching keys BEFORE
 *  DialogAlert can consume them. Registered on dialog open, removed on close. */
let keyHandler: ((e: any) => void) | null = null
/** Render cache for the open dialog — scrolling re-slices this locally
 *  instead of re-querying the server on every keypress. */
let openRendered: UsageRender | null = null
/** Scroll position (data-row offset) of the open dialog; reset on open/tab switch. */
let scrollOffset = 0
/** Max row offset of the current view — 0 when the table fits the viewport
 *  (scroll keys pass through to the host). */
let scrollMax = 0

const tui: TuiPlugin = async (api) => {
  initI18n(api)

  const hasDialog = typeof api.ui.dialog?.replace === "function"

  const cycleDimension = (delta: number) => {
    const idx = DIMENSIONS.indexOf(activeDim)
    void openDimension(DIMENSIONS[(idx + delta + DIMENSIONS.length) % DIMENSIONS.length])
  }

  /** Register global keypress interceptor: fires BEFORE DialogAlert.
   *  Matches 1/2/3/left/right for dimension switching and, while the table
   *  overflows the terminal, up/down/j/k for scrolling; stopPropagation()
   *  keeps the dialog from consuming them. */
  const installKeyHandler = () => {
    removeKeyHandler()
    keyHandler = (e: any) => {
      if (!dialogOpen) return
      const name: string = e.name
      // Table scroll — only while the viewport actually overflows, so
      // tables that fit keep the old key pass-through behavior.
      if (scrollMax > 0 && (name === "up" || name === "down" || name === "j" || name === "k")) {
        e.stopPropagation()
        scrollBy(name === "down" || name === "j" ? 1 : -1)
        return
      }
      // Dimension jump: 1/2/3
      if (name === "1" || name === "2" || name === "3") {
        e.stopPropagation()
        const dim = DIMENSIONS[parseInt(name) - 1]
        if (dim) void openDimension(dim)
        return
      }
      // Dimension cycle: left = prev, right = next
      if (name === "left") {
        e.stopPropagation()
        cycleDimension(-1)
        return
      }
      if (name === "right") {
        e.stopPropagation()
        cycleDimension(1)
        return
      }
    }
    api.renderer.keyInput.on("keypress", keyHandler)
  }

  const removeKeyHandler = () => {
    if (!keyHandler) return
    api.renderer.keyInput.off("keypress", keyHandler)
    keyHandler = null
  }

  /** Re-render the open dialog from the cached render at the current scroll
   *  offset. Pure string work — no server roundtrip, so scrolling stays
   *  instant even on huge conversation trees. */
  const presentView = () => {
    if (!openRendered) return
    const rendered = openRendered
    const flat = renderDimensionView(rendered, activeDim)
    let view = flat
    // Terminal height bounds the message (see DIALOG_CHROME). Hosts without
    // a measurable height (tests, exotic embedders) render the full view.
    const termHeight = Number(api.renderer?.height) || 0
    if (termHeight > 0) {
      const scrolled = renderScrollView(rendered, activeDim, termHeight, scrollOffset)
      scrollOffset = scrolled.offset
      scrollMax = scrolled.maxOffset
      view = scrolled.view
    } else {
      scrollMax = 0
    }
    if (!hasDialog) {
      // Hosts without the dialog API: toast fallback.
      api.ui.toast({ message: view, variant: "info", duration: TOAST_DURATION })
      return
    }
    // Size from the table only (not the tab strip or context-warning prose —
    // those wrap naturally inside the dialog, so they must not inflate the
    // width tier). The full table keeps the tier stable while wide rows
    // scroll out of (and back into) the visible window.
    const size = fitDialogSize(rendered.table)
    removeKeyHandler()
    const myGen = ++dialogGen
    dialogOpen = true
    installKeyHandler()
    api.ui.dialog.replace(
      () => api.ui.DialogAlert({ title: tr("usage.dialogTitle"), message: view }),
      () => {
        if (dialogGen === myGen) {
          dialogOpen = false
          removeKeyHandler()
        }
      },
    )
    api.ui.dialog.setSize(size)
  }

  /** Scroll the open dialog by `delta` data rows (clamped; no-op at rest). */
  const scrollBy = (delta: number) => {
    if (!openRendered || scrollMax <= 0) return
    const next = Math.min(Math.max(scrollOffset + delta, 0), scrollMax)
    if (next === scrollOffset) return
    scrollOffset = next
    presentView()
  }

  const openDimension = (dim: UsageDimension) => {
    activeDim = dim
    const sessionId = currentSessionID(api) || "default"
    // Warm the SWR cache: kicks a background refresh if the in-memory entry
    // is stale, but never blocks the dialog open path. First /usage open in
    // a fresh install will trigger one slow fetch (because there's nothing
    // on disk yet) — handled via the formatByDimension await below; all
    // subsequent opens are instant (background-only refresh).
    if (!modelsDevCatalog) {
      void getModelsDevAsync().catch(() => { /* network errors never block */ })
    }
    return formatByDimension(api.client, sessionId, dim)
      .then((rendered) => {
        if (!rendered.table) {
          api.ui.toast({ message: tr("usage.noData"), variant: "info" })
          return
        }
        openRendered = rendered
        scrollOffset = 0 // fresh view — always start at the top row
        presentView()
      })
      .catch((err) => {
        dialogOpen = false
        removeKeyHandler()
        api.ui.toast({ message: tr("usage.failed", { err: err instanceof Error ? err.message : String(err) }), variant: "warning" })
      })
  }

  // Slash command + command palette entry.
  // Key bindings are handled by the global keypress interceptor
  // (installKeyHandler) which fires BEFORE DialogAlert and calls
  // stopPropagation() to prevent the dialog from consuming the keys.
  api.keymap.registerLayer({
    commands: [
      {
        name: "usage.show",
        title: tr("usage.commandTitle"),
        desc: tr("usage.commandDesc"),
        category: "Session",
        namespace: "palette",
        slashName: SLASH_NAME,
        run(ctx: unknown) {
          const sub = parseSubcommand(ctx)
          const dim = sub === null ? "session" : DIM_SUBCOMMAND[sub]
          if (dim === undefined) {
            api.ui.toast({ message: tr("usage.unknownSub", { sub: sub ?? "" }), variant: "warning" })
            return Promise.resolve()
          }
          return openDimension(dim)
        },
      },
      ...DIMENSIONS.map((dim) => ({
        name: `usage.dim.${dim}`,
        title: tr(DIM_TITLE_KEY[dim] as Parameters<typeof tr>[0]),
        category: "Session",
        run() {
          if (dialogOpen) void openDimension(dim)
        },
      })),
      {
        name: "usage.dim.prev",
        title: tr("usage.dimPrev"),
        category: "Session",
        run() {
          if (dialogOpen) cycleDimension(-1)
        },
      },
      {
        name: "usage.dim.next",
        title: tr("usage.dimNext"),
        category: "Session",
        run() {
          if (dialogOpen) cycleDimension(1)
        },
      },
    ],
    bindings: [],
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "usage",
  tui,
}

export default plugin
