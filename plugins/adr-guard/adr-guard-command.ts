/**
 * Hook: command.execute.before — handle `/adr-guard <state>` and `/adr <subcommand>`.
 *
 * Supported commands:
 *   /adr-guard on | off | reset | status
 *   /adr new [layer|scope] <title>
 *   /adr decide <ADR-ID> [note]        (strict governance only)
 *   /adr supersede <old-id> <new-title>
 *   /adr tree | map
 *   /adr check | lint
 *   /adr help
 */

import type { PluginInput } from "@opencode-ai/plugin"
import { refreshLocale, tr } from "../tui/i18n"
import {
  analyzeAdrComplexity,
  appendAdrSection,
  checkAdrIntegrity,
  createAdr,
  createAdrContainer,
  executeAdrMigration,
  generateDecisionMap,
  getNormalizedAdrs,
  planAdrMigration,
  regenerateAdlIndexes,
  regenerateIterationIndex,
  supersedeAdr,
  type AdrLayer,
} from "./adr-engine"
import { decideAdr } from "./adr-governance"
import { buildIterationContext, checkEvolutionProfile, renderIterationContext, EVOLUTION_PROFILE_NAME } from "./adr-evolution"
import {
  auditAdrStyles,
  executeAdrStyleMigration,
  planAdrStyleMigration,
  renderMigrationReport,
  type AdrStyleMigrationLabels,
} from "./adr-migration"
import { findAdrStyleAdapter } from "./adr-style-registry"
import type { AdrStyle } from "./adr-types"
import {
  ADR_TREE_GROUP_BY,
  buildAdrContext,
  buildAdrHistory,
  buildSectionEdges,
  renderAdrContext,
  renderAdrHistory,
  renderTreeView,
  type AdrTreeGroupBy,
} from "./adr-views"
import { announce, announceStatus, announceSwitch } from "./adr-guard-announce"
import {
  ADR_COMMAND,
  clearAdrLayout,
  clearState,
  COMMAND_NAME,
  detectAdrInitSignals,
  getAdrConfig,
  getAdrLayout,
  getProjectDir,
  isAdrStyleAvailable,
  normalizeAdrGovernance,
  normalizeAdrLayout,
  normalizeAdrNumbering,
  normalizeAdrStyle,
  normalizeAdrSuite,
  parseResetArg,
  parseStateArg,
  resolveAdrSuite,
  setAdrConfigFields,
  setAdrLayout,
  setState,
} from "./adr-guard-config"
import { makeLogger } from "./adr-guard-runtime"

type Log = ReturnType<typeof makeLogger>

/** Locale-bound labels for the deterministic migration report. English
 *  structure is authoritative (EN_MIGRATION_LABELS); tr() supplies the
 *  same templates in the current locale. */
function migrationLabels(): AdrStyleMigrationLabels {
  const take = (key: Parameters<typeof tr>[0]): string => tr(key)
  return {
    summary: take("guard.adr.migStyleSummary"),
    recordHead: take("guard.adr.migStyleRecordHead"),
    sourceLine: take("guard.adr.migStyleSource"),
    destinationLine: take("guard.adr.migStyleDest"),
    destinationUnchanged: take("guard.adr.migStyleDestSame"),
    idLine: take("guard.adr.migStyleId"),
    linksNone: take("guard.adr.migStyleLinksNone"),
    linksHead: take("guard.adr.migStyleLinksHead"),
    linksRow: take("guard.adr.migStyleLinksRow"),
    warningsNone: take("guard.adr.migStyleWarnNone"),
    warningsHead: take("guard.adr.migStyleWarnHead"),
    warnDropped: take("guard.adr.migStyleWarnDropped"),
    warnAdded: take("guard.adr.migStyleWarnAdded"),
    warnMissing: take("guard.adr.migStyleWarnMissing"),
  }
}

export function makeCommandHook(client: PluginInput["client"], handled: () => never) {
  const log: Log = makeLogger(client, "adr-guard")

  return async (input: { command?: string; arguments?: string; sessionID?: string }) => {
    if (input.command === COMMAND_NAME) {
      if (parseResetArg(input.arguments)) {
        const cleared = clearState()
        await log(
          cleared ? "info" : "warn",
          cleared
            ? "adrGuard field removed — reverted to default off"
            : "reset failed — project config not writable",
        )
        await announceStatus(client, input.sessionID)
      } else {
        const state = parseStateArg(input.arguments)
        if (state) {
          const written = setState(state)
          await log(
            written ? "info" : "warn",
            written
              ? `state=${state.toUpperCase()} — project .ocp/ocp.json written`
              : `state=${state.toUpperCase()} — project config write failed (not writable)`,
          )
          await announceSwitch(client, state, input.sessionID)
        } else {
          await announceStatus(client, input.sessionID)
        }
      }
      return handled()
    }

    if (input.command === ADR_COMMAND) {
      const res = await handleAdrCommand(client, input.arguments || "", input.sessionID, log)
      if (res?.handled) {
        return handled()
      }
      return
    }
  }
}

async function handleAdrCommand(
  client: PluginInput["client"],
  rawArgs: string,
  sessionID: string | undefined,
  log: Log,
): Promise<{ handled: boolean }> {
  const projectDir = getProjectDir()
  refreshLocale()
  const trimmed = rawArgs.trim()
  if (!trimmed || trimmed === "help") {
    const helpText = tr("guard.adr.help", { mode: getAdrLayout() })
    await announce(client, helpText, "info", sessionID)
    return { handled: true }
  }

  const parts = trimmed.split(/\s+/)
  const sub = parts[0].toLowerCase()
  const rest = trimmed.slice(parts[0].length).trim()

  if (sub === "layout") {
    if (!rest) {
      const layout = getAdrLayout()
      await announce(
        client,
        tr("guard.adr.layoutCurrent", { mode: layout }),
        "info",
        sessionID,
      )
      return { handled: true }
    }
    const targetLayout = normalizeAdrLayout(rest)
    if (!targetLayout) {
      await announce(
        client,
        tr("guard.adr.layoutInvalid", { rest }),
        "warning",
        sessionID,
      )
      return { handled: true }
    }
    const written = setAdrLayout(targetLayout)
    await log(
      written ? "info" : "warn",
      written
        ? `adrLayout=${targetLayout} written to project config`
        : `failed to write adrLayout=${targetLayout} to project config`,
    )
    
    // Check if migration is available
    const migrationPlan = planAdrMigration(projectDir, targetLayout)
    let extraNotice = ""
    if (migrationPlan.moves.length > 0) {
      extraNotice = `\n\n${tr("guard.adr.migrateHint", { count: migrationPlan.moves.length, mode: targetLayout })}`
    }

    await announce(
      client,
      tr("guard.adr.layoutSet", { mode: targetLayout }) + extraNotice,
      "info",
      sessionID,
    )
    return { handled: true }
  }

  if (sub === "migrate" || sub === "refactor") {
    // Two migration surfaces share the verb (§10): `--to <style>` is an
    // explicit STYLE conversion (dry-run by default, `--confirm` writes);
    // a bare layout argument keeps the legacy flat↔hierarchical
    // restructuring below.
    const toFlag = /(?:^|\s)--to(?:\s+|=)("([^"]*)"|'[^']*'|[^\s"']+)/.exec(rest)
    if (toFlag) {
      const targetRaw = (toFlag[2] ?? toFlag[1].replace(/^["']|["']$/g, "")).trim().toLowerCase()
      const targetStyle = normalizeAdrStyle(targetRaw)
      if (!targetStyle || !findAdrStyleAdapter(targetStyle)) {
        await announce(client, tr("guard.adr.migrateStyleInvalid", { style: targetRaw }), "warning", sessionID)
        return { handled: true }
      }
      if (targetStyle === "ocp") {
        // The container grammar is not reachable by per-file conversion
        // (planAdrStyleMigration throws); surface adoption guidance here.
        await announce(client, tr("guard.adr.migrateStyleOcp"), "warning", sessionID)
        return { handled: true }
      }
      const isConfirm = /(?:^|\s)(--confirm|-y)(?:\s|$)/.test(rest)
      const plan = planAdrStyleMigration(projectDir, targetStyle)
      const labels = migrationLabels()

      if (plan.records.length === 0) {
        await announce(
          client,
          tr("guard.adr.migrateStyleNone", { to: targetStyle, count: plan.skippedPaths.length }),
          "info",
          sessionID,
        )
        return { handled: true }
      }

      if (!isConfirm) {
        // §6.2: dry-run is the DEFAULT — this path NEVER writes.
        let preview = tr("guard.adr.migrateStylePreviewHead", { to: targetStyle, count: plan.records.length })
        preview += renderMigrationReport(plan, labels)
        preview += tr("guard.adr.migrateNoWrite")
        preview += `\`\`\`bash\n/adr migrate --to ${targetStyle} --confirm\n\`\`\``
        await announce(client, preview, "info", sessionID)
        return { handled: true }
      }

      const result = executeAdrStyleMigration(projectDir, plan)
      // Refresh generated views so the style column stays truthful.
      regenerateAdlIndexes(projectDir)
      regenerateIterationIndex(projectDir)
      let msg = tr("guard.adr.migrateStyleDoneHead", { to: targetStyle, count: result.written.length })
      for (const w of result.written) {
        msg += `- \`${w}\`\n`
      }
      if (!result.verification.ok) {
        msg += tr("guard.adr.migrateStyleVerifyFail", { count: result.verification.issues.length })
        for (const iss of result.verification.issues) {
          msg += `- ❌ \`[${iss.type}]\` **${iss.file}**: ${iss.message}\n`
        }
      }
      await announce(client, msg, result.verification.ok ? "info" : "warning", sessionID)
      return { handled: true }
    }

    const isConfirm = rest.includes("--confirm") || rest.includes("-y")
    const cleanRest = rest.replace(/--confirm|-y|--dry-run/g, "").trim()
    const targetLayout = normalizeAdrLayout(cleanRest) || (getAdrLayout() === "flat" ? "hierarchical" : "flat")

    const plan = planAdrMigration(projectDir, targetLayout)

    if (plan.moves.length === 0) {
      await announce(
        client,
        tr("guard.adr.migrateNone", { cur: plan.currentLayout, target: plan.targetLayout }),
        "info",
        sessionID,
      )
      return { handled: true }
    }

    if (isConfirm) {
      const result = executeAdrMigration(projectDir, plan)
      await log("info", `executed ADR migration: ${result.executedCount} files moved`)
      let msg = tr("guard.adr.migrateDoneHead", { cur: plan.currentLayout, target: plan.targetLayout, count: result.executedCount })
      for (const m of plan.moves) {
        msg += `- \`${m.fromRelPath}\` $\\to$ \`${m.toRelPath}\`\n`
      }
      await announce(client, msg, "info", sessionID)
    } else {
      let preview = tr("guard.adr.migratePreviewHead", { cur: plan.currentLayout, target: plan.targetLayout, count: plan.moves.length })
      preview += tr("guard.adr.migrateTableHead")
      for (const m of plan.moves) {
        preview += `| \`${m.fromRelPath}\` | \`${m.toRelPath}\` | ${m.title} | \`${m.targetLayer}\` |\n`
      }
      preview += tr("guard.adr.migrateNoWrite")
      preview += `\`\`\`bash\n/adr migrate ${targetLayout} --confirm\n\`\`\``
      await announce(client, preview, "info", sessionID)
    }
    return { handled: true }
  }

  if (sub === "tree" || sub === "map") {
    // `/adr tree --by path|layer|domain|iteration` (Phase 4, §9.4):
    // deterministic logical views over normalized records. Bare
    // `/adr tree` keeps the legacy decision-map + Mermaid DAG rendering.
    const byFlag = /(?:^|\s)--by(?:\s+|=)("([^"]*)"|'[^']*'|[^\s"']+)/.exec(rest)
    const byRaw = byFlag ? (byFlag[2] ?? byFlag[1].replace(/^["']|["']$/g, "")).trim().toLowerCase() : undefined
    if (byRaw !== undefined) {
      if (!ADR_TREE_GROUP_BY.includes(byRaw as AdrTreeGroupBy)) {
        await announce(client, tr("guard.adr.treeByInvalid", { by: byRaw }), "warning", sessionID)
        return { handled: true }
      }
      const view = renderTreeView(getNormalizedAdrs(projectDir), "docs/adr", byRaw as AdrTreeGroupBy)
      await announce(client, view, "info", sessionID)
      return { handled: true }
    }
    const map = generateDecisionMap(projectDir)
    await announce(client, map, "info", sessionID)
    return { handled: true }
  }

  if (sub === "history") {
    // `/adr history <ADR-ID>` (Phase 4, §9.4): traversal over the
    // normalized supersession relationships — backward `supersedes` chain
    // plus forward `supersededBy`, cross-style safe (§9.5 rule 4).
    const ref = rest.replace(/^["']|["']$/g, "").trim()
    if (!ref) {
      await announce(client, tr("guard.adr.historyUsage"), "warning", sessionID)
      return { handled: true }
    }
    const records = getNormalizedAdrs(projectDir)
    const history = buildAdrHistory(records, ref)
    if (!history) {
      await announce(client, tr("guard.adr.historyNotFound", { ref }), "warning", sessionID)
      return { handled: true }
    }
    // Section-level annotation edges around the chain (§7 amendment):
    // prose cross-references between sub-decisions — surfaced for
    // readability, never promoted to graph edges.
    const chainIds = new Set(history.entries.map((e) => e.record.id))
    const sectionEdges = buildSectionEdges(records).filter((e) => chainIds.has(e.toContainer))
    await announce(client, renderAdrHistory(history, sectionEdges), "info", sessionID)
    return { handled: true }
  }

  if (sub === "check" || sub === "lint") {
    // Optional validation profile (§7.3 req 5): `--profile evolution`
    // layers opt-in discipline on top of the default structural check.
    const profileFlag = /(?:^|\s)--profile(?:\s+|=)("([^"]*)"|'[^']*'|[^\s"']+)/.exec(rest)
    const profile = profileFlag
      ? (profileFlag[2] ?? profileFlag[1].replace(/^["']|["']$/g, "")).trim().toLowerCase()
      : undefined
    if (profile && profile !== EVOLUTION_PROFILE_NAME) {
      await announce(client, tr("guard.adr.profileUnknown", { profile }), "warning", sessionID)
      return { handled: true }
    }
    // Style audit (§13 Phase 5): `--report-style` lists every document's
    // resolved style incl. the `legacy` flag (Phase 1 style-less files
    // dispatch to madr and are reported, never silently rewritten).
    const reportStyle = /(?:^|\s)--report-style(?:\s|$)/.test(rest)

    const issues = checkAdrIntegrity(projectDir)
    const profileFindings = profile === EVOLUTION_PROFILE_NAME ? checkEvolutionProfile(getNormalizedAdrs(projectDir)) : []
    const complexity = analyzeAdrComplexity(projectDir)

    let report = ""
    if (issues.length === 0) {
      report += tr("guard.adr.checkOk")
    } else {
      report += tr("guard.adr.checkIssues", { count: issues.length })
      for (const iss of issues) {
        const icon = iss.severity === "error" ? "❌" : "⚠️"
        report += `- ${icon} \`[${iss.type}]\` **${iss.file}**: ${iss.message}\n`
      }
      report += `\n`
    }

    if (reportStyle) {
      const audit = auditAdrStyles(projectDir)
      const legacyCount = audit.filter((e) => e.isLegacy).length
      report += tr("guard.adr.reportStyleHead", { count: audit.length, legacy: legacyCount })
      report += tr("guard.adr.reportStyleTableHead")
      for (const entry of audit) {
        const marker = entry.isLegacy ? tr("guard.adr.reportStyleYes") : "—"
        report += `| \`${entry.sourcePath}\` | \`${entry.resolvedStyle}\` | ${marker} |\n`
      }
      report += `\n`
    }

    if (profile === EVOLUTION_PROFILE_NAME) {
      if (profileFindings.length === 0) {
        report += tr("guard.adr.checkProfilePass")
      } else {
        report += tr("guard.adr.checkProfileIssues", { count: profileFindings.length })
        for (const finding of profileFindings) {
          report += `- ⚠️ **${finding.file}**: ${finding.message}\n`
        }
        report += `\n`
      }
    }

    if (complexity.recommendation) {
      report += tr("guard.adr.complexityHead")
      report += `${complexity.recommendation.reason}\n`
      report += tr("guard.adr.complexityRun", { mode: complexity.recommendation.suggestedLayout })
    }

    await announce(client, report, issues.length + profileFindings.length > 0 ? "warning" : "info", sessionID)
    return { handled: true }
  }

  if (sub === "context") {
    // Phase 3: `/adr context --iteration <id>` bundles the iteration's
    // active records + their supersession chains (bounded) and refreshes
    // the generated per-iteration view. Phase 4 (§9.1) adds ID and domain
    // targets through the same progressive-disclosure algorithm: nearest
    // index first, selected records only, direct parent / supersession /
    // same-iteration relations — never the full corpus — with a reported
    // retrieval path.
    const iterFlag = /(?:^|\s)--iteration(?:\s+|=)("([^"]*)"|'[^']*'|[^\s"']+)/.exec(rest)
    const iteration = iterFlag ? (iterFlag[2] ?? iterFlag[1].replace(/^["']|["']$/g, "")) : undefined
    const domainFlag = /(?:^|\s)--domain(?:\s+|=)("([^"]*)"|'[^']*'|[^\s"']+)/.exec(rest)
    const domain = domainFlag ? (domainFlag[2] ?? domainFlag[1].replace(/^["']|["']$/g, "")) : undefined
    const idArg = rest
      .replace(/(?:^|\s)--iteration(?:\s+|=)("([^"]*)"|'[^']*'|[^\s"']+)/, " ")
      .replace(/(?:^|\s)--domain(?:\s+|=)("([^"]*)"|'[^']*'|[^\s"']+)/, " ")
      .trim()

    if (iteration) {
      regenerateIterationIndex(projectDir)
      const ctx = buildIterationContext(getNormalizedAdrs(projectDir), iteration)
      if (ctx.matched.length === 0) {
        await announce(client, tr("guard.adr.contextNotFound", { iteration }), "warning", sessionID)
        return { handled: true }
      }
      await announce(client, renderIterationContext(ctx), "info", sessionID)
      return { handled: true }
    }

    if (domain || idArg) {
      regenerateAdlIndexes(projectDir)
      const records = getNormalizedAdrs(projectDir)
      const selector = domain ? ({ kind: "domain", value: domain } as const) : ({ kind: "id", value: idArg } as const)
      const bundle = buildAdrContext(records, selector)
      if (!bundle) {
        await announce(client, tr("guard.adr.contextNoMatch", { target: domain ?? idArg }), "warning", sessionID)
        return { handled: true }
      }
      await announce(client, renderAdrContext(bundle), "info", sessionID)
      return { handled: true }
    }

    await announce(client, tr("guard.adr.contextUsage"), "warning", sessionID)
    return { handled: true }
  }


  if (sub === "init") {
    return handleAdrInit(client, rest, projectDir, sessionID, log)
  }


  if (sub === "decide") {
    // `/adr decide <ADR-ID> [note]` (§11/§13 Phase 6) — the ONLY
    // proposed → accepted path under strict governance. Refuses in
    // none/review modes (convention mode: the human flips the line by
    // hand). Flips ONLY the status line + appends one ledger line.
    const spaceIdx = rest.indexOf(" ")
    const ref = (spaceIdx === -1 ? rest : rest.slice(0, spaceIdx)).trim().replace(/^["']|["']$/g, "")
    const note = (spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1).trim()).replace(/^["']|["']$/g, "")
    if (!ref) {
      await announce(client, tr("guard.adr.decideUsage"), "warning", sessionID)
      return { handled: true }
    }
    try {
      const result = decideAdr(projectDir, ref, note)
      await log("info", `decided ADR: ${result.id} (${result.relPath})`)
      await announce(client, tr("guard.adr.decided", { id: result.id, file: result.relPath }), "info", sessionID)
    } catch (err) {
      await announce(client, tr("guard.adr.decideFail", { err: String(err) }), "warning", sessionID)
    }
    return { handled: true }
  }

  if (sub === "section") {
    // `/adr section <container-ref> <title>` — append one section
    // to an ocp container. Sequence allocation is the container's own
    // business (scan parsed sections, never cross-file ID guessing).
    const spaceIdx = rest.indexOf(" ")
    if (spaceIdx === -1) {
      await announce(client, tr("guard.adr.sectionUsage"), "warning", sessionID)
      return { handled: true }
    }
    const containerRef = rest.slice(0, spaceIdx).trim().replace(/^["']|["']$/g, "")
    const title = rest.slice(spaceIdx + 1).trim().replace(/^["']|["']$/g, "")
    if (!title) {
      await announce(client, tr("guard.adr.sectionMissingTitle"), "warning", sessionID)
      return { handled: true }
    }
    try {
      const appended = appendAdrSection(projectDir, containerRef, title)
      await log("info", `appended section: ${appended.id} → ${appended.relPath}`)
      await announce(client, tr("guard.adr.sectionDone", { id: appended.id, file: appended.relPath }), "info", sessionID)
    } catch (err) {
      await announce(client, tr("guard.adr.sectionFail", { err: String(err) }), "warning", sessionID)
    }
    return { handled: true }
  }

  if (sub === "new" || !["layout", "migrate", "refactor", "tree", "map", "check", "lint", "context", "history", "supersede", "init", "decide", "section"].includes(sub)) {
    const rawDecisionText = sub === "new" ? rest : trimmed
    const emptyFlagRegex = /(?:^|\s)(--empty|--scaffold|--no-draft)(?:\s|$)/i
    const isEmptyOnly = emptyFlagRegex.test(rawDecisionText)
    let cleanRest = rawDecisionText.replace(/(?:^|\s)(--empty|--scaffold|--no-draft)(?:\s|$)/gi, " ").trim()

    // Orthogonal creation options (§6/§6.1): --style, --numbering,
    // --baseline, --iteration, --domain. Explicit always beats config.
    let explicitStyle: string | undefined
    let numbering: string | undefined
    let baseline: string | undefined
    let iteration: string | undefined
    let domain: string | undefined
    const optWithValue = (name: string): string | undefined => {
      const m = new RegExp(`(?:^|\\s)${name}\\s+("([^"]*)"|'[^']*'|[^\\s"']+)`).exec(cleanRest)
      if (!m) return undefined
      cleanRest = (cleanRest.slice(0, m.index) + " " + cleanRest.slice(m.index + m[0].length)).trim()
      return m[2] ?? m[1].replace(/^["']|["']$/g, "")
    }
    explicitStyle = optWithValue("--style")
    numbering = optWithValue("--numbering")
    baseline = optWithValue("--baseline")
    iteration = optWithValue("--iteration")
    domain = optWithValue("--domain")

    if (!cleanRest) {
      await announce(
        client,
        tr("guard.adr.newUsage"),
        "warning",
        sessionID,
      )
      return { handled: true }
    }

    let layer: AdrLayer = "system"
    let scope: string | undefined
    let targetDir: string | undefined
    let title = cleanRest

    const firstWord = cleanRest.split(/\s+/)[0].toLowerCase()
    if (firstWord === "system" || firstWord === "domain" || firstWord === "component") {
      layer = firstWord as AdrLayer
      title = cleanRest.slice(firstWord.length).trim().replace(/^["']|["']$/g, "")
    } else if (firstWord.includes("/")) {
      // e.g. domain/order or packages/api
      const segs = firstWord.split("/")
      if (segs[0] === "domain" || segs[0] === "apps" || segs[0] === "packages") {
        layer = "domain"
        scope = segs[1]
      }
      title = cleanRest.slice(firstWord.length).trim().replace(/^["']|["']$/g, "")
    } else {
      title = cleanRest.replace(/^["']|["']$/g, "")
    }

    try {
      // Explicit --style always beats config; the persisted default
      // (adr.style) applies when no flag is given. ocp is a
      // CONTAINER style either way — it routes to createAdrContainer and
      // requires --baseline/--iteration.
      const style = explicitStyle?.toLowerCase() ?? getAdrConfig().style
      if (!findAdrStyleAdapter(style)) {
        await announce(client, tr("guard.adr.styleUnavailable", { style }), "warning", sessionID)
        return { handled: true }
      }
      const normalizedNumbering = normalizeAdrNumbering(numbering) ?? undefined
      // ocp routes to the container creation path: a container IS one
      // iteration's record, so --baseline/--iteration are mandatory
      // (createAdrContainer throws a clear error when they are missing).
      const created =
        style === "ocp"
          ? createAdrContainer({
              projectDir,
              title,
              baseline,
              iteration,
              domain,
              targetDir,
            })
          : createAdr({
              projectDir,
              title,
              layer,
              scope,
              targetDir,
              style: style as AdrStyle | undefined,
              numbering: normalizedNumbering,
              baseline,
              iteration,
              domain,
            })
      await log("info", `scaffolded ADR: ${created.relPath}`)

      let warningNote = ""
      for (const w of created.warnings) {
        warningNote += `\n- ⚠️ ${w}`
        await log("warn", w)
      }

      if (isEmptyOnly) {
        const successMsg = tr("guard.adr.createdScaffold", { id: created.id, layer, file: created.relPath }) + warningNote
        await announce(client, successMsg, "info", sessionID)
        return { handled: true }
      } else {
        const successMsg = tr("guard.adr.created", { id: created.id, layer, file: created.relPath }) + warningNote
        await announce(client, successMsg, "info", sessionID)
        // Return handled: false so OpenCode dispatches the prompt to LLM!
        return { handled: false }
      }
    } catch (err) {
      await announce(client, tr("guard.adr.createFail", { err: String(err) }), "warning", sessionID)
      return { handled: true }
    }
  }

  if (sub === "supersede") {
    const emptyFlagRegex = /(?:^|\s)(--empty|--scaffold|--no-draft)(?:\s|$)/i
    const isEmptyOnly = emptyFlagRegex.test(rest)
    const cleanRest = rest.replace(/(?:^|\s)(--empty|--scaffold|--no-draft)(?:\s|$)/gi, " ").trim()
    const spaceIdx = cleanRest.indexOf(" ")
    if (spaceIdx === -1) {
      await announce(
        client,
        tr("guard.adr.supUsage"),
        "warning",
        sessionID,
      )
      return { handled: true }
    }

    const oldRef = cleanRest.slice(0, spaceIdx).trim().replace(/^["']|["']$/g, "")
    const newTitle = cleanRest.slice(spaceIdx + 1).trim().replace(/^["']|["']$/g, "")

    if (!newTitle) {
      await announce(
        client,
        tr("guard.adr.supMissingTitle"),
        "warning",
        sessionID,
      )
      return { handled: true }
    }

    try {
      const { newAdr, oldAdr } = supersedeAdr(projectDir, oldRef, newTitle)
      await log("info", `superseded ADR: ${oldAdr.id} -> ${newAdr.id}`)

      if (isEmptyOnly) {
        const successMsg = tr("guard.adr.supDoneScaffold", { old: oldAdr.id, new: newAdr.id, oldPath: oldAdr.relPath, newPath: newAdr.relPath })
        await announce(client, successMsg, "info", sessionID)
        return { handled: true }
      } else {
        const successMsg = tr("guard.adr.supDone", { old: oldAdr.id, new: newAdr.id, oldPath: oldAdr.relPath, newPath: newAdr.relPath })
        await announce(client, successMsg, "info", sessionID)
        // Return handled: false so OpenCode dispatches the prompt to LLM!
        return { handled: false }
      }
    } catch (err) {
      await announce(client, tr("guard.adr.supFail", { err: String(err) }), "warning", sessionID)
      return { handled: true }
    }
  }

  await announce(
    client,
    tr("guard.adr.unknown", { sub }),
    "warning",
    sessionID,
  )
  return { handled: true }
}

/**
 * `/adr init [standard|evolution|ocp|custom] [--style s] [--numbering n]
 *          [--layout l] [--governance g]` (§6.3).
 *
 * Detection (.opencode/, packages, migrations/) PRE-SELECTS a suite but
 * never applies it silently: bare `/adr init` announces the recommendation
 * and writes nothing. A named suite persists its resolved adr.* values
 * plus the informational adr.suite label and prints exactly what it sets.
 * Re-running with the same selection is a stable no-op (no drift). The
 * legacy keys (adrGuard/adrDir/adrLayout) are never touched here.
 */
async function handleAdrInit(
  client: PluginInput["client"],
  rest: string,
  projectDir: string,
  sessionID: string | undefined,
  log: Log,
): Promise<{ handled: boolean }> {
  const signals = detectAdrInitSignals(projectDir)
  const parts = rest.split(/\s+/).filter(Boolean)
  const suiteArg = normalizeAdrSuite(parts[0])

  // Per-option overrides — only meaningful with `custom` (or to adjust a
  // named suite at creation time).
  const overrides: Record<string, string> = {}
  const flag = (name: string): string | undefined => {
    // Both spellings: `--governance strict` and `--governance=strict`.
    const m = new RegExp(`(?:^|\\s)${name}(?:\\s+|=)("([^"]*)"|'[^']*'|[^\\s"']+)`).exec(rest)
    return m ? (m[2] ?? m[1].replace(/^["']|["']$/g, "")) : undefined
  }
  const style = flag("--style")?.toLowerCase()
  // Symmetric with the /adr new guard: never persist a style whose adapter
  // is not registered — that would break every later `/adr new` that
  // resolves adr.style (§6).
  if (style && !isAdrStyleAvailable(style)) {
    await announce(client, tr("guard.adr.styleUnavailable", { style }), "warning", sessionID)
    return { handled: true }
  }
  const numbering = normalizeAdrNumbering(flag("--numbering"))
  const layout = normalizeAdrLayout(flag("--layout"))
  // Symmetric with the --style guard: never persist a governance value the
  // normalizer rejects — an unknown mode would silently degrade to 'none'
  // on every later read instead of failing loudly at init time (§6.3).
  const governanceRaw = flag("--governance")
  const governance = normalizeAdrGovernance(governanceRaw)
  if (governanceRaw !== undefined && !governance) {
    await announce(client, tr("guard.adr.governanceInvalid", { value: governanceRaw }), "warning", sessionID)
    return { handled: true }
  }
  if (style) overrides.style = style
  if (numbering) overrides.numbering = numbering
  if (layout) overrides.layout = layout
  if (governance) overrides.governance = governance

  if (!suiteArg) {
    // Reconnaissance only — pre-select, never apply.
    await announce(
      client,
      tr("guard.adr.initRecommend", {
        suite: signals.recommendedSuite,
        agent: signals.hasAgentConfig ? "yes" : "no",
        pkgs: signals.packageCount,
        migrations: signals.hasMigrations ? "yes" : "no",
      }),
      "info",
      sessionID,
    )
    return { handled: true }
  }

  if (suiteArg === "custom" && Object.keys(overrides).length === 0) {
    await announce(client, tr("guard.adr.initCustomFlags"), "info", sessionID)
    return { handled: true }
  }

  const selection = resolveAdrSuite(suiteArg, overrides)
  const written = setAdrConfigFields(selection.fields)
  await log(
    written ? "info" : "warn",
    written ? `/adr init ${suiteArg}: adr.* config written` : `/adr init ${suiteArg}: project config write failed (not writable)`,
  )
  await announce(
    client,
    tr("guard.adr.initApplied", {
      suite: suiteArg,
      style: selection.fields.style ?? "-",
      numbering: selection.fields.numbering ?? "-",
      layout: selection.fields.layout ?? "-",
      governance: selection.fields.governance ?? "-",
      ok: written ? "yes" : "no",
    }),
    written ? "info" : "warning",
    sessionID,
  )
  return { handled: true }
}

