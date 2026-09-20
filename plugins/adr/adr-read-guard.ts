/** Context-efficiency guard, NOT a filesystem security boundary.
 * Supported built-in read/grep and obvious shell reads only; arbitrary scripts,
 * Git history, and external MCP transports are intentionally not claimed covered.
 */
import { existsSync, realpathSync } from "node:fs"
import { ocpConfigFile, readProjectConfig } from "../shared/opencode-prime"
import { relative, resolve } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import { getAdrConfig, getAdrDir, normalizeAdrReadGuard } from "./adr-config"
import { CONTEXT_BUDGET, currentState, isArchived, recordRoot, takeSnapshot } from "./adr-context"
import { readOptional } from "./adr-storage"
import { scopedForTool } from "../shared/plugin-scope"

export function createReadGuard(project: string, client: PluginInput["client"]) {
  const warned = new Set<string>()
  let lastMode: "off" | "warn" | "guard" = "off", degraded = false
  return async (input: { tool?: string; sessionID?: string; agent?: string }, output: { args?: unknown }) => {
    const parsed = readProjectConfig(project)
    const raw = (parsed?.adr as Record<string, unknown> | undefined)?.readGuard
    const invalid = (!parsed && existsSync(ocpConfigFile(project))) || (raw !== undefined && normalizeAdrReadGuard(raw) === null)
    if (invalid && !degraded) {
      const message = `ADR readGuard configuration is invalid; retaining last known mode (${lastMode}). Restart without a valid config defaults to off. Protection is degraded until repaired.`
      try { await client.tui.showToast({ body: { message, variant: "warning" } }) } catch { console.warn(message) }
    }
    degraded = invalid
    const mode = invalid ? lastMode : getAdrConfig(project).readGuard
    lastMode = mode
    const scopeAllowed = await scopedForTool(input, "adr-context-tool", client)
    if (mode === "off" || !scopeAllowed) return
    const tool = input.tool?.toLowerCase() ?? ""
    if (!["read", "read_file", "grep", "bash", "shell"].includes(tool)) return
    const args = output.args && typeof output.args === "object" ? output.args as Record<string, unknown> : {}
    const value = args.filePath ?? args.file_path ?? args.path
    let path = typeof value === "string" ? relative(project, resolve(project, value)).replace(/\\/g, "/") : ""
    if (typeof value === "string") {
      try { path = relative(realpathSync(project), realpathSync(resolve(project, value))).replace(/\\/g, "/") } catch { /* Native reader reports nonexistent paths. */ }
    }
    const s = takeSnapshot(project)
    const roots = new Set([getAdrDir(project), ...s.records.map(r => recordRoot(r.sourcePath, s.root))])
    const containsSources = (p: string) => !p || p === "." || [...roots].some(root => root === p || root.startsWith(`${p}/`) || p.startsWith(`${root}/`))
    let reason = ""
    if (tool === "read" || tool === "read_file") {
      const target = s.records.find(r => r.sourcePath === path)
      if (target) {
        const offset = typeof args.offset === "number" && args.offset > 0 ? args.offset - 1 : 0
        const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : Infinity
        if (Array.from(target.rawContent.split("\n").slice(offset, offset + limit).join("\n")).length > CONTEXT_BUDGET) reason = "Requested ADR body exceeds the response budget; narrow or use continuation"
      }
      if (s.records.some(r => r.sourcePath === path && isArchived(r.sourcePath, s.root))) reason = "Archive bodies require targeted history retrieval"
      if ([...roots].some(root => path === `${root}/CURRENT.md`)) {
        if (currentState(project, s).status !== "fresh") reason = "CURRENT is missing, stale, or modified; retrieve current source evidence"
        else {
          const offset = typeof args.offset === "number" && args.offset > 0 ? args.offset - 1 : 0
          const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : Infinity
          const body = readOptional(project, path) ?? ""
          if (Array.from(body.split("\n").slice(offset, offset + limit).join("\n")).length > CONTEXT_BUDGET) reason = "CURRENT body exceeds the response budget; use scoped ADR retrieval"
        }
      }
      if (containsSources(path) && /[*?]/.test(path)) reason = "Unscoped ADR body read"
    } else if (tool === "grep") {
      // Filename-only searches are discovery, not source body exposure.
      const include = args.include ?? args.glob
      const codeOnly = typeof include === "string" && /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|c|cpp|h|cs|rb|php|swift|vue|svelte|sql)$/.test(include)
      if (!codeOnly && args.output_mode !== "files_with_matches" && containsSources(path) && s.records.length) reason = "Scope content search outside the ADL or use adr_context"
    } else {
      const command = typeof args.command === "string" ? args.command : ""
      if (/(?:^|[\s;|&(])(?:cat|head|tail|sed|awk|rg|grep|Get-Content)\b/.test(command)) {
        const touches = [...roots].some(root => command.includes(root))
        const broad = /(?:\s\.\s*$|\s\.\s*[|;]|--files-with-matches\b)/.test(command)
        if (touches && (/archive[\/\\]|\*|find\b|xargs\b|for\b|-[A-Za-z]*[rR]/.test(command))) reason = "Recognized bulk/archive shell read; use bounded ADR retrieval"
        else if (broad && s.records.length && !/--files-with-matches\b/.test(command)) reason = "Recognized repository-wide content search; narrow the path"
      }
    }
    if (!reason) return
    const message = `[ADR-READ-GUARD] ${reason}. Call adr_context with an ID/domain and intent current, rationale, or history. File discovery is allowed. This guard does not cover arbitrary scripts/MCP/Git.`
    if (mode === "guard") throw new Error(message)
    const key = `${input.sessionID ?? "unknown"}:${reason}`
    if (!warned.has(key)) {
      warned.add(key)
      if (warned.size > 1000) warned.delete(warned.values().next().value!)
      try { await client.tui.showToast({ body: { message, variant: "warning" } }) } catch { console.warn(message) }
    }
  }
}
