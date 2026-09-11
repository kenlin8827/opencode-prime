/**
 * Hook: command.execute.before — handle `/adr-guard <state>` and `/adr <subcommand>`.
 *
 * Supported commands:
 *   /adr-guard on | off | reset | status
 *   /adr new [layer|scope] <title>
 *   /adr supersede <old-id> <new-title>
 *   /adr tree | map
 *   /adr check | lint
 *   /adr help
 */

import type { PluginInput } from "@opencode-ai/plugin"
import { refreshLocale, tr } from "../tui/i18n"
import {
  analyzeAdrComplexity,
  checkAdrIntegrity,
  createAdr,
  executeAdrMigration,
  generateDecisionMap,
  planAdrMigration,
  supersedeAdr,
  type AdrLayer,
} from "./adr-engine"
import { announce, announceStatus, announceSwitch } from "./adr-guard-announce"
import {
  ADR_COMMAND,
  clearAdrLayout,
  clearState,
  COMMAND_NAME,
  getAdrLayout,
  getProjectDir,
  normalizeAdrLayout,
  parseResetArg,
  parseStateArg,
  setAdrLayout,
  setState,
} from "./adr-guard-config"
import { makeLogger } from "./adr-guard-runtime"

type Log = ReturnType<typeof makeLogger>

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
              ? `state=${state.toUpperCase()} — project opencode.jsonc written`
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
    const map = generateDecisionMap(projectDir)
    await announce(client, map, "info", sessionID)
    return { handled: true }
  }

  if (sub === "check" || sub === "lint") {
    const issues = checkAdrIntegrity(projectDir)
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

    if (complexity.recommendation) {
      report += tr("guard.adr.complexityHead")
      report += `${complexity.recommendation.reason}\n`
      report += tr("guard.adr.complexityRun", { mode: complexity.recommendation.suggestedLayout })
    }

    await announce(client, report, issues.length > 0 ? "warning" : "info", sessionID)
    return { handled: true }
  }


  if (sub === "new" || !["layout", "migrate", "refactor", "tree", "map", "check", "lint", "supersede"].includes(sub)) {
    const rawDecisionText = sub === "new" ? rest : trimmed
    const emptyFlagRegex = /(?:^|\s)(--empty|--scaffold|--no-draft)(?:\s|$)/i
    const isEmptyOnly = emptyFlagRegex.test(rawDecisionText)
    const cleanRest = rawDecisionText.replace(/(?:^|\s)(--empty|--scaffold|--no-draft)(?:\s|$)/gi, " ").trim()

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
      const created = createAdr({
        projectDir,
        title,
        layer,
        scope,
        targetDir,
      })
      await log("info", `scaffolded ADR: ${created.relPath}`)

      if (isEmptyOnly) {
        const successMsg = tr("guard.adr.createdScaffold", { id: created.id, layer, file: created.relPath })
        await announce(client, successMsg, "info", sessionID)
        return { handled: true }
      } else {
        const successMsg = tr("guard.adr.created", { id: created.id, layer, file: created.relPath })
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

