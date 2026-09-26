/**
 * Shared i18n module for all TUI wizard plugins.
 *
 * Centralizes locale detection, storage, and all translation strings
 * for profile-wizard, provider-wizard, project-wizard,
 * and usage. This module is the single source of truth for the locale
 * registry (`LOCALES`) and the ADR glossary (`ADR_GLOSSARY`); headless
 * CLI entry points share it via `initI18nHeadless` / `refreshLocale`.
 * String content lives per-locale in ./i18n/locales/ (en.ts = the key
 * registry; siblings fall back to English via tr()) and is assembled
 * into STRINGS below.
 *
 * The chosen language is persisted as the "language" key of the shared
 * user config (~/.config/opencode/ocp.json, via plugins/shared/ocp-config).
 *
 * Usage in plugins (v2 TUI API):
 *   import { initI18n, tr } from "./i18n"
 *   // in plugin setup(ctx): initI18n()
 *   // in dialog code:  tr("profile.mainTitle")
 *   // language switch:  await switchLanguage(ctx)  — the caller's menu
 *   // loop re-presents itself afterwards.
 */

import type { Context, DialogSelectOption } from "@opencode/plugin/tui/context"
import { readOcpField, writeOcpField } from "../shared/ocp-config"
import en from "./i18n/locales/en"
import zhCN from "./i18n/locales/zh-CN"
import es from "./i18n/locales/es"
import fr from "./i18n/locales/fr"
import ru from "./i18n/locales/ru"
import ar from "./i18n/locales/ar"
import pt from "./i18n/locales/pt"
import ja from "./i18n/locales/ja"
import type { StringKey } from "./i18n/locales/en"

// ─── Types ───────────────────────────────────────────────────────────

export type Locale = string

/**
 * Locale registry (menu order) — the 8 major world languages. "en" is the
 * mandatory fallback locale. `as const` so `GlossaryLocale` (below) derives
 * from these codes: registering a locale FORCES full `ADR_GLOSSARY` coverage
 * at compile time. To add a language: register it here and fill its glossary
 * meanings; detection, persistence, switching and menus pick it up
 * automatically. Both surfaces are complete per locale and enforced by
 * tests: `STRINGS` by tests/test-i18n-coverage-unit.ts (all 612 keys ×
 * 8 locales, structure/placeholder/slash-token parity), and glossary
 * meanings at compile time via `GlossaryLocale` (unit-test enforced too).
 * `tr()` still falls back to en — that is the runtime safety net for an
 * untranslated NEW key, not the shipping state.
 */
export const LOCALES = [
  { code: "en", name: "English" },
  { code: "zh-CN", name: "中文", match: /zh|cn|hans|shanghai|chongqing|urumqi|harbin|beijing|prc|taipei|hong_kong/i },
  { code: "es", name: "Español", match: /es[-_]|spanish|madrid|canary/i },
  { code: "fr", name: "Français", match: /fr[-_]|french|paris|montreal/i },
  { code: "ru", name: "Русский", match: /ru[-_]|russian|moscow/i },
  { code: "ar", name: "العربية", match: /ar[-_]|arabic|cairo|riyadh|dubai/i },
  { code: "pt", name: "Português", match: /pt[-_]|portuguese|lisbon|sao_paulo|brazil/i },
  { code: "ja", name: "日本語", match: /ja[-_]|japanese|tokyo|japan/i },
] as const

/** Closed union of registered locale codes — the glossary completeness contract. */
export type GlossaryLocale = (typeof LOCALES)[number]["code"]

const FALLBACK_LOCALE: Locale = "en"

/**
 * Convenience alias for dialog option objects used by all wizards
 * (v2 TUI plugin API shape — value, not the full option, comes back
 * from `ctx.ui.dialog.select`).
 */
export type DialogOption<V = string> = DialogSelectOption<V>

type StringEntry = Partial<Record<Locale, string>> & { en: string }

// ─── Locale state ────────────────────────────────────────────────────

let currentLocale: Locale = "en"

export function getLocale(): Locale {
  return currentLocale
}

function isRegistered(code: unknown): code is Locale {
  return typeof code === "string" && LOCALES.some((l) => l.code === code)
}

function detectLocale(): Locale {
  const probes = [
    process.env.LANG || "",
    process.env.LC_ALL || "",
    process.env.LANGUAGE || "",
  ]
  try {
    const opts = Intl.DateTimeFormat().resolvedOptions()
    probes.push(opts.locale, opts.timeZone)
  } catch { /* ignore */ }
  const haystack = probes.join(" ")
  for (const l of LOCALES) {
    if (l.code !== FALLBACK_LOCALE && "match" in l && l.match.test(haystack)) return l.code
  }
  return FALLBACK_LOCALE
}

/** "language" key in the shared user config (~/.config/opencode/ocp.json). */
const CONFIG_KEY = "language"

let initialized = false

/**
 * Resolve the locale from the shared user config, else environment
 * detection. Needs no plugin context — ocp.json is the single source of
 * truth across TUI and server processes (v1's api.kv legacy migration is
 * gone: the kv store died with the v1 host and pre-ocp.json users have
 * long since been migrated).
 */
export function initI18n(): void {
  // Guard against repeated calls from multiple plugins —
  // only the first call performs detection & persistence.
  if (initialized) return
  initialized = true

  const fromFile = readOcpField<Locale>(CONFIG_KEY)
  if (isRegistered(fromFile)) {
    currentLocale = fromFile
    return
  }
  // Env detection is not a user choice — don't persist it.
  currentLocale = detectLocale()
}

/** Initialize translations without the TUI API (used by headless CLI commands). */
export function initI18nHeadless(): void {
  if (initialized) return
  initialized = true
  const saved = readOcpField<Locale>(CONFIG_KEY)
  currentLocale = isRegistered(saved) ? saved : detectLocale()
}

/**
 * Re-resolve the locale from the shared user config (falling back to
 * environment detection). Server-side plugin processes do not share the
 * TUI's in-memory state, so user-visible command/announce text calls this
 * right before composing output — a `/lang` switch taken in the TUI is
 * picked up by the next guard command without a restart. Cost: one small
 * JSONC read per command invocation.
 */
export function refreshLocale(): Locale {
  initialized = true
  const saved = readOcpField<Locale>(CONFIG_KEY)
  currentLocale = isRegistered(saved) ? saved : detectLocale()
  return currentLocale
}

export function setLocale(locale: Locale): void {
  currentLocale = locale
  // Keep the in-memory value even if the file write fails (read-only home).
  writeOcpField(CONFIG_KEY, locale)
}

/** Locale the menu switch would move to (cycles through the registry). */
export function nextLocale(): Locale {
  const idx = LOCALES.findIndex((l) => l.code === currentLocale)
  return LOCALES[(idx + 1) % LOCALES.length].code
}

export function toggleLocale(): Locale {
  const next = nextLocale()
  setLocale(next)
  return next
}

export function localeName(locale: Locale): string {
  return LOCALES.find((l) => l.code === locale)?.name ?? locale
}

// ─── Translation table ──────────────────────────────────────────────
// Keys are namespaced: "common.xxx", "profile.xxx", "provider.xxx",
// "project.xxx", "usage.xxx".  Placeholders use {name} syntax.
// String CONTENT lives in ./i18n/locales/<code>.ts — one catalog per
// language: en.ts is the canonical key registry (`StringKey` derives from
// it). Every catalog is COMPLETE (612 keys) — completeness is asserted by
// tests/test-i18n-coverage-unit.ts, while the `Partial` type below keeps a
// missing translation a test failure rather than a compile error, so a newly
// added en key can land before its 7 translations. `tr()` still falls back to
// en as the runtime net. A typo'd key in a sibling is a compile error (its
// `satisfies`); a registered locale with no catalog is a compile error (the
// Record type below). Assembled once per process into the key-major Record
// shape every consumer imports.

const PARTIAL_CATALOGS: Readonly<Record<Exclude<GlossaryLocale, "en">, Partial<Record<StringKey, string>>>> = {
  "zh-CN": zhCN,
  es,
  fr,
  ru,
  ar,
  pt,
  ja,
}

function buildStrings(): Record<StringKey, StringEntry> {
  const built = {} as Record<StringKey, StringEntry>
  // en first: canonical key set + the fallback value for every entry.
  for (const key of Object.keys(en) as StringKey[]) built[key] = { en: en[key] }
  for (const [code, table] of Object.entries(PARTIAL_CATALOGS)) {
    for (const [key, value] of Object.entries(table)) {
      if (value === undefined) continue
      built[key as StringKey][code] = value
    }
  }
  return built
}

export const STRINGS: Record<StringKey, StringEntry> = buildStrings()

// ─── ADR label glossary (8-locale one-time decoding) ──────────────────
/** Complete across ALL registered locales (`Record<GlossaryLocale, string>`
 * — compile-time enforced via the `LOCALES as const` derivation). Labels
 * stay English (grammar authority, ADR-0.40.0#02); fixed tokens inside
 * meanings (`Chosen option: …`, `✅ accepted`, metadata keys) stay verbatim.
 * Surfaces: generated ADL ROOT index renders the ENGLISH column only
 * (byte-stable contract, §13 Phase 5 / §15 — locale-following content would
 * flip bytes per generating session); the locale-following decoding is the
 * TUI view (`/adr glossary [locale]`, adr-views.ts
 * renderLabelGlossaryLocalized). All non-English strings live in this
 * catalog because plugin source outside it stays zero-non-English
 * (engineering red line). */
export const ADR_GLOSSARY: ReadonlyArray<{ label: string; style: string; meanings: Record<GlossaryLocale, string> }> = [
  { label: "`## Context`", style: "nygard", meanings: { en: "Forces at play: technical, business, project context", "zh-CN": "背景：技术、业务、项目环境中的各方力量", es: "Fuerzas en juego: contexto técnico, de negocio y de proyecto", fr: "Forces en présence : contexte technique, métier et projet", ru: "Действующие силы: технический, деловой и проектный контекст", ar: "القوى المؤثرة: السياق التقني والتجاري والمشروعي", pt: "Forças em jogo: contexto técnico, de negócio e de projeto", ja: "働く力：技術・ビジネス・プロジェクトの状況" } },
  { label: "`## Decision`", style: "nygard", meanings: { en: "The decision made in response to the context", "zh-CN": "决策：针对上述背景做出的决定", es: "La decisión tomada en respuesta al contexto", fr: "La décision prise en réponse au contexte", ru: "Решение, принятое в ответ на контекст", ar: "القرار المتخذ استجابةً للسياق", pt: "A decisão tomada em resposta ao contexto", ja: "状況に応じて下した決定" } },
  { label: "`## Consequences`", style: "nygard · madr", meanings: { en: "Resulting context: what becomes easier or harder", "zh-CN": "后果：决策带来的结果，什么变得更容易或更难", es: "Contexto resultante: qué se vuelve más fácil o más difícil", fr: "Contexte résultant : ce qui devient plus facile ou plus difficile", ru: "Итоговый контекст: что стало проще или сложнее", ar: "السياق الناتج: ما أصبح أسهل أو أصعب", pt: "Contexto resultante: o que fica mais fácil ou mais difícil", ja: "結果の状況：何が容易になり、何が難しくなるか" } },
  { label: "`## Context and Problem Statement`", style: "madr", meanings: { en: "Architectural context, the problem, and constraints", "zh-CN": "背景与问题陈述：架构上下文、问题与约束", es: "Contexto arquitectónico, el problema y las restricciones", fr: "Contexte architectural, le problème et les contraintes", ru: "Архитектурный контекст, проблема и ограничения", ar: "السياق المعماري، والمشكلة، والقيود", pt: "Contexto arquitetural, o problema e as restrições", ja: "アーキテクチャの状況、問題、制約" } },
  { label: "`## Decision Drivers`", style: "madr (optional)", meanings: { en: "Forces driving the decision (scalability, security, …)", "zh-CN": "决策驱动因素：驱动决策的关键力量（可扩展性、安全性等）", es: "Fuerzas que impulsan la decisión (escalabilidad, seguridad, …)", fr: "Forces qui motivent la décision (scalabilité, sécurité, …)", ru: "Факторы, определяющие решение (масштабируемость, безопасность, …)", ar: "الدافعات وراء القرار (قابلية التوسع، الأمان، …)", pt: "Forças que impulsionam a decisão (escalabilidade, segurança, …)", ja: "決定を駆動する要因（拡張性、セキュリティなど）" } },
  { label: "`## Considered Options`", style: "madr (optional)", meanings: { en: "Alternatives evaluated, each with pros/cons", "zh-CN": "备选方案：被评估的各选项及其优缺点", es: "Alternativas evaluadas, cada una con pros y contras", fr: "Alternatives évaluées, chacune avec avantages/inconvénients", ru: "Рассмотренные альтернативы, каждая с плюсами и минусами", ar: "البدائل التي قُيّمت، مع إيجابيات وسلبيات كل منها", pt: "Alternativas avaliadas, cada uma com prós e contras", ja: "検討した選択肢それぞれの長所・短所" } },
  { label: "`## Decision Outcome`", style: "madr", meanings: { en: "The chosen option and rationale (`Chosen option: …, because …`)", "zh-CN": "决策结果：选定方案及理由（`Chosen option: …, because …`）", es: "La opción elegida y su justificación (`Chosen option: …, because …`)", fr: "L'option retenue et sa justification (`Chosen option: …, because …`)", ru: "Выбранный вариант и обоснование (`Chosen option: …, because …`)", ar: "الخيار المختار ومبرراته (`Chosen option: …, because …`)", pt: "A opção escolhida e sua justificativa (`Chosen option: …, because …`)", ja: "選択した案とその理由（`Chosen option: …, because …`）" } },
  { label: "`## Pros and Cons of the Options`", style: "madr (optional)", meanings: { en: "Per-option advantage/disadvantage detail", "zh-CN": "各选项的优缺点明细", es: "Detalle de ventajas/desventajas por opción", fr: "Détail des avantages/inconvénients par option", ru: "Плюсы и минусы каждого варианта подробно", ar: "تفصيل الإيجابيات والسلبيات لكل خيار", pt: "Detalhe de vantagens/desvantagens por opção", ja: "選択肢ごとの長所・短所の詳細" } },
  { label: "`### Confirmation`", style: "madr (optional)", meanings: { en: "How the decision's outcomes will be verified", "zh-CN": "确认：如何验证决策产生的效果", es: "Cómo se verificarán los resultados de la decisión", fr: "Comment les résultats de la décision seront vérifiés", ru: "Как будут проверяться результаты решения", ar: "كيف سيتم التحقق من نتائج القرار", pt: "Como os resultados da decisão serão verificados", ja: "決定の成果をどう検証するか" } },
  { label: "`## More Information`", style: "madr (optional)", meanings: { en: "Supplementary material and references", "zh-CN": "更多信息：补充材料与引用", es: "Material complementario y referencias", fr: "Documents complémentaires et références", ru: "Дополнительные материалы и ссылки", ar: "مواد تكميلية ومراجع", pt: "Material complementário e referências", ja: "補足資料と参照先" } },
  { label: "`**Positive**` / `**Negative / Risks**`", style: "madr", meanings: { en: "Good impacts / trade-offs and mitigations", "zh-CN": "正面影响 / 负面影响与风险及缓解", es: "Impactos positivos / contrapartidas y mitigaciones", fr: "Impacts positifs / compromis et atténuations", ru: "Положительные эффекты / компромиссы и их снижение", ar: "الآثار الإيجابية / المقايضات والتخفيف", pt: "Impactos positivos / trade-offs e mitigações", ja: "良い影響 / トレードオフと緩和策" } },
  { label: "`## Cheatsheet` / `## Quick view`", style: "ocp", meanings: { en: "Reader's primary entry / restatement layer (graphs + tables)", "zh-CN": "速查表（读者主入口）/ 快览（图 + 表的复述层）", es: "Entrada principal del lector / capa de resumen (gráficos + tablas)", fr: "Entrée principale du lecteur / couche de reformulation (graphes + tableaux)", ru: "Главный вход для читателя / слой повторения (графы + таблицы)", ar: "المدخل الرئيسي للقارئ / طبقة إعادة الصياغة (رسوم + جداول)", pt: "Entrada principal do leitor / camada de reafirmação (grafos + tabelas)", ja: "読者の主入口 / 再説明層（図 + 表）" } },
  { label: "`**Status**`", style: "ocp", meanings: { en: "Section status line: emoji + fixed token (`✅ accepted`, …)", "zh-CN": "小节状态行：emoji + 固定状态词（`✅ accepted` 等）", es: "Línea de estado de la sección: emoji + token fijo (`✅ accepted`, …)", fr: "Ligne de statut de la section : emoji + jeton fixe (`✅ accepted`, …)", ru: "Строка статуса раздела: эмодзи + фиксированный токен (`✅ accepted`, …)", ar: "سطر حالة القسم: رمز تعبيري + كلمة ثابتة (`✅ accepted`, …)", pt: "Linha de status da seção: emoji + token fixo (`✅ accepted`, …)", ja: "セクションの状態行：絵文字 + 固定トークン（`✅ accepted` など）" } },
  { label: "`**Background**`", style: "ocp", meanings: { en: "Situation and pain, ≤ 3 sentences", "zh-CN": "背景：情境与痛点，≤ 3 句", es: "Situación y dolor, ≤ 3 frases", fr: "Situation et problème, ≤ 3 phrases", ru: "Ситуация и боль, ≤ 3 предложений", ar: "الموقف والألم، ≤ 3 جمل", pt: "Situação e dor, ≤ 3 frases", ja: "状況と課題、3文以内" } },
  { label: "`**Decision**`", style: "ocp", meanings: { en: "Decision points as a `# / Point / Content` table", "zh-CN": "决策：以 `# / Point / Content` 表格呈现的决策点", es: "Puntos de decisión en una tabla `# / Point / Content`", fr: "Points de décision dans un tableau `# / Point / Content`", ru: "Пункты решения в таблице `# / Point / Content`", ar: "نقاط القرار في جدول `# / Point / Content`", pt: "Pontos de decisão numa tabela `# / Point / Content`", ja: "`# / Point / Content` 表形式の決定ポイント" } },
  { label: "`**Rationale**`", style: "ocp", meanings: { en: "Why — bold-keyword-led bullets", "zh-CN": "理由：加粗关键词引导的论据列表", es: "Por qué — viñetas lideradas por palabras clave en negrita", fr: "Pourquoi — puces introduites par des mots-clés en gras", ru: "Почему — пункты с жирными ключевыми словами", ar: "لماذا — نقاط تقودها كلمات مفتاحية بالخط العريض", pt: "Por quê — marcadores liderados por palavras-chave em negrito", ja: "理由 — 太字キーワード先導の箇条書き" } },
  { label: "`**Rejected**`", style: "ocp", meanings: { en: "Alternatives not taken, as an `Option / Reason rejected` table", "zh-CN": "已否决：未采纳的备选方案及否决原因（`Option / Reason rejected` 表格）", es: "Alternativas no adoptadas, en una tabla `Option / Reason rejected`", fr: "Alternatives non retenues, dans un tableau `Option / Reason rejected`", ru: "Отклонённые альтернативы в таблице `Option / Reason rejected`", ar: "البدائل غير المتبناة في جدول `Option / Reason rejected`", pt: "Alternativas não adotadas, numa tabela `Option / Reason rejected`", ja: "不採用の代替案（`Option / Reason rejected` 表）" } },
  { label: "`**Impact**`", style: "ocp", meanings: { en: "Layered change list (plugins / runtime / tests / docs / …)", "zh-CN": "影响：分层变更清单（插件 / 运行时 / 测试 / 文档等）", es: "Lista de cambios por capas (plugins / runtime / tests / docs / …)", fr: "Liste des changements par couche (plugins / runtime / tests / docs / …)", ru: "Многослойный список изменений (плагины / рантайм / тесты / документация / …)", ar: "قائمة تغييرات طبقية (إضافات / تشغيل / اختبارات / مستندات / …)", pt: "Lista de mudanças em camadas (plugins / runtime / testes / docs / …)", ja: "層別の変更リスト（プラグイン / ランタイム / テスト / ドキュメントなど）" } },
  { label: "`**Future extensions**`", style: "ocp", meanings: { en: "Deliberately deferred follow-ups", "zh-CN": "未来扩展：有意推迟的后续工作", es: "Trabajos posteriores deliberadamente aplazados", fr: "Suites délibérément reportées", ru: "Последующие работы, отложенные намеренно", ar: "أعمال لاحقة مؤجلة عمداً", pt: "Trabalhos futuros deliberadamente adiados", ja: "意図的に先送りした後続作業" } },
  { label: "status enum", style: "frontmatter", meanings: { en: "`proposed` → `accepted` or `rejected`; `superseded`, `deprecated`", "zh-CN": "状态枚举：提议中 → 已接受或已否决；已被取代、已废弃", es: "`proposed` → `accepted` o `rejected`; `superseded`, `deprecated`", fr: "`proposed` → `accepted` ou `rejected` ; `superseded`, `deprecated`", ru: "`proposed` → `accepted` или `rejected`; `superseded`, `deprecated`", ar: "`proposed` → `accepted` أو `rejected`؛ `superseded`، `deprecated`", pt: "`proposed` → `accepted` ou `rejected`; `superseded`, `deprecated`", ja: "`proposed` → `accepted` または `rejected`。`superseded`、`deprecated`" } },
  { label: "metadata keys", style: "frontmatter", meanings: { en: "`style` `status` `created` `date` `layer` `scope` `baseline` `iteration` `domain` `parent` `supersedes` `superseded_by` — machine-read, never localized", "zh-CN": "元数据键 —— 机器读取，永不本地化", es: "`style` `status` `created` `date` `layer` `scope` `baseline` `iteration` `domain` `parent` `supersedes` `superseded_by` — los lee la máquina, nunca se localizan", fr: "`style` `status` `created` `date` `layer` `scope` `baseline` `iteration` `domain` `parent` `supersedes` `superseded_by` — lus par la machine, jamais localisés", ru: "`style` `status` `created` `date` `layer` `scope` `baseline` `iteration` `domain` `parent` `supersedes` `superseded_by` — читаются машиной, никогда не локализуются", ar: "`style` `status` `created` `date` `layer` `scope` `baseline` `iteration` `domain` `parent` `supersedes` `superseded_by` — تقرأها الآلة، لا تُترجم أبداً", pt: "`style` `status` `created` `date` `layer` `scope` `baseline` `iteration` `domain` `parent` `supersedes` `superseded_by` — lidos pela máquina, nunca localizados", ja: "`style` `status` `created` `date` `layer` `scope` `baseline` `iteration` `domain` `parent` `supersedes` `superseded_by` — 機械が読むキー。決してローカライズしない" } },
]

// Re-exported from the en catalog — the canonical key registry.
export type { StringKey }

// ─── tr() function ───────────────────────────────────────────────────

export function tr(key: StringKey, params?: Record<string, string | number>): string {
  const entry = STRINGS[key] as StringEntry | undefined
  if (!entry) return key
  const text: string = entry[currentLocale] ?? entry.en
  if (!params) return text
  // Single pass: values are never rescanned for placeholders (no chained
  // substitution) and a function-replacer avoids `$&`/`$1` expansion when
  // an interpolated path or name contains `$`. Unknown {tokens} survive.
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole)
}

/**
 * Extract the first slash-argument token from a v2 keymap command's raw
 * input. v2 passes the prompt's trailing text (everything after the
 * command name) to `run(input)`, so the command-name tokens `commandTokens`
 * are only skipped defensively — a host variant that prepends the command
 * name still yields the same result. Returns null when no argument exists.
 */
export function parseSlashArgs(input: string | undefined, commandTokens: string[]): string | null {
  if (!input || input.trim() === "") return null
  const known = new Set(commandTokens.map((t) => t.toLowerCase()))
  const tokens = input.trim().split(/\s+/).map((t) => t.toLowerCase())
  let i = 0
  while (i < tokens.length && known.has(tokens[i])) i++
  return i < tokens.length ? tokens[i] : null
}

// ─── Language switch (shared by all wizard main menus) ─────────────

export const SWITCH_LANG = "__switch_lang__"

/**
 * Central language-switch action (v2). With two registered locales it
 * toggles directly (one-click); with more it opens a promise-based locale
 * picker. Returns nothing meaningful — the caller's menu loop simply
 * re-presents itself afterwards, which is what "reopen" did in v1.
 * Adding a locale requires NO wizard-side changes.
 *
 * Usage:
 *   import { languageOption, switchLanguage, SWITCH_LANG } from "./i18n"
 *   // in options array:  languageOption()
 *   // in the menu loop:
 *   if (pick === SWITCH_LANG) { await switchLanguage(ctx); continue }
 */
export async function switchLanguage(ctx: Context): Promise<void> {
  const apply = (code: Locale) => {
    setLocale(code)
    ctx.ui.toast.show({
      title: tr("common.langTitle"),
      message: tr("common.langSwitched", { lang: localeName(code) }),
      variant: "info",
    })
  }
  if (LOCALES.length <= 2) {
    apply(nextLocale())
    return
  }
  const code = await ctx.ui.dialog.select<Locale>({
    title: tr("common.langTitle"),
    placeholder: tr("common.langPickPlaceholder"),
    options: LOCALES.map((l) => ({ title: l.name, value: l.code })),
    current: currentLocale,
  })
  // Esc on the picker = no change; the caller's menu loop re-opens either way.
  if (code) apply(code)
}

/**
 * Menu option for language switching, inserted into any wizard's main
 * select dialog options array. Handle it via `switchLanguage` above.
 */
export function languageOption(): DialogOption<string> {
  // two locales → show the direct toggle target; more → the picker decides
  const title = LOCALES.length <= 2
    ? `🌐 ${localeName(currentLocale)} → ${localeName(nextLocale())}`
    : `🌐 ${localeName(currentLocale)}`
  return {
    title,
    value: SWITCH_LANG,
    description: tr("common.langDesc"),
  }
}
