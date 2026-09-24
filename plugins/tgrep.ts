import type { Plugin } from "@opencode/plugin"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { loadTgrepOptions } from "./tgrep/tgrep-config"
import { validateTgrepMode, OUTPUT_ROW_BUDGET, OUTPUT_CHAR_BUDGET, exceedsDetailBudget, exceedsDetailCharBudget } from "./tgrep/tgrep-mode"
import { tgrepLocation, capSummaryCounts } from "./tgrep/tgrep-output"
import { logTgrepRequest } from "./tgrep/tgrep-request-log"
import { searchTgrep, summarizeTgrepSearch, type TgrepSearchInput } from "./tgrep/tgrep-search"
import { ensureWatcher, hasTgrepCli } from "./tgrep/tgrep-service"

/** Canonical tool description. Source of truth lives in
 * `tgrep/tgrep-tool-description.md` so the prose stays readable and
 * the agent prompts (`prompts/lite.md` etc.) can mirror it without
 * fighting `\n` escapes. Loaded once at module init — fail loud if the
 * canonical file is missing rather than silently degrade. */
const TGREP_TOOL_DESCRIPTION = readFileSync(
  join(import.meta.dir, "tgrep", "tgrep-tool-description.md"),
  "utf8",
)

/** v2 tool schemas are JSON Schema; the runtime validates model input
 * against this before execute, so inside execute the shape is trusted. */
const TGREP_INPUT_SCHEMA = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Text or regex pattern." },
    path: { type: "string", description: "Path relative to the project directory. Default: ." },
    glob: { type: "array", items: { type: "string" }, description: "Gitignore-style globs, each applied via -g." },
    ignoreCase: { type: "boolean", description: "Case-insensitive search." },
    literal: { type: "boolean", description: "Treat pattern as literal text instead of regex." },
    noIndex: { type: "boolean", description: "When true, force `--no-index` (bypass the index, read from disk). Default: false (use the index)." },
    mode: {
      type: "string",
      enum: ["summary", "locations", "content", "files_with_matches"],
      description: "Mode: summary (path:count), locations (path:line), or content (path:line:text). Omit for summary. files_with_matches is a compatibility alias for summary.",
    },
  },
  required: ["pattern"],
}

interface TgrepArgs {
  pattern: string
  path?: string
  glob?: string[]
  ignoreCase?: boolean
  literal?: boolean
  noIndex?: boolean
  mode?: "summary" | "locations" | "content" | "files_with_matches"
}

// OCP-V2-GAP: v1 results carried a UI `title`; v2 Tool.Result has no title
// field (output/content/metadata only). Titles dropped, text preserved.
const result = (content: string, metadata?: Record<string, unknown>) =>
  metadata === undefined ? { content } : { content, metadata }

/** Structured tgrep surface. It is not MCP and does not alter grep.
 * v2: registered through ctx.tool.transform as a first-class model tool
 * (options.codemode:false — without it the tool folds into the code-mode
 * dispatcher and the model never sees it). */
const plugin: Plugin.Plugin = {
  id: "tgrep",
  async setup(ctx) {
    const directory = ctx.location.directory
    const config = loadTgrepOptions(directory)
    // The switch defaults to ON (install/options.jsonc), so the gate is not
    // only the flag: the tool must also self-hide while the external CLI is
    // absent — otherwise every non-tgrep user carries a dead tool that pays a
    // failed probe on every search. hasTgrepCli hides only on ENOENT, so a
    // momentary --version timeout never uninstalls the tool mid-session.
    // The gate runs once at setup (probe is not transform-cheap); live
    // disable still works via the per-execute config.enabled check below.
    if (!config.enabled || !hasTgrepCli(directory)) return

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "tgrep_search",
        description: TGREP_TOOL_DESCRIPTION,
        input: TGREP_INPUT_SCHEMA,
        options: { codemode: false },
        execute: async (args) => {
          const input = args as TgrepArgs
          const config = loadTgrepOptions(directory)
          if (!config.enabled) return result("tgrep is disabled; use the native grep/ripgrep path.")
          const mode = validateTgrepMode(input.mode)
          if (!mode.ok) return result(mode.error)
          const readiness = await ensureWatcher(directory, config)
          const search: TgrepSearchInput = {
            pattern: input.pattern,
            path: input.path,
            glob: input.glob,
            ignoreCase: input.ignoreCase,
            literal: input.literal,
            noIndex: input.noIndex,
            mode: mode.mode === "summary" ? undefined : mode.mode,
          }
          const summary = summarizeTgrepSearch(directory, search, readiness, config)
          if (!summary.matchedLines) {
            await logTgrepRequest(directory, config, search, mode.mode, summary)
            return result("No matches.", { readiness, backend: summary.backend, matchedFiles: 0, matchedLines: 0, complete: true })
          }
          if (mode.mode === "summary") {
            const capped = capSummaryCounts(summary.counts)
            await logTgrepRequest(directory, config, search, "summary", summary)
            return result(capped.rows.join("\n"), { readiness, backend: summary.backend, matchedFiles: summary.matchedFiles, matchedLines: summary.matchedLines, complete: capped.complete })
          }
          if (exceedsDetailBudget(mode.mode, summary.matchedLines)) {
            await logTgrepRequest(directory, config, search, mode.mode, { backend: summary.backend, matchedFiles: summary.matchedFiles, matchedLines: summary.matchedLines })
            return result(`${summary.matchedLines} matched lines exceed the ${OUTPUT_ROW_BUDGET}-line detail budget; narrow path/glob, or use summary mode to pick files first.`, { readiness, backend: summary.backend, matchedFiles: summary.matchedFiles, matchedLines: summary.matchedLines, complete: false })
          }
          const found = searchTgrep(directory, search, readiness, config, ["--with-filename", "--line-number"])
          if (found.status === "error") throw new Error(found.stderr || "tgrep search failed")
          const output = mode.mode === "locations"
            ? found.stdout.split(/\r?\n/).filter(Boolean).map(tgrepLocation).join("\n")
            : found.stdout.trim()
          // Summary and detail are two spawns; if files changed between the two
          // spawns the detail run wins — never report totals the output contradicts.
          const totals = found.status === "no-matches"
            ? { matchedFiles: 0, matchedLines: 0 }
            : { matchedFiles: summary.matchedFiles, matchedLines: summary.matchedLines }
          // Row budget passed but the materialized output is still too large —
          // long lines (lockfiles/minified) or growth between the two spawns.
          if (exceedsDetailCharBudget(output)) {
            await logTgrepRequest(directory, config, search, mode.mode, { backend: found.backend, ...totals })
            return result(`Detail output is ${output.length.toLocaleString("en-US")} chars, over the ${OUTPUT_CHAR_BUDGET.toLocaleString("en-US")}-char budget (long lines or files changed mid-search); narrow path/glob${mode.mode === "content" ? `, or use locations mode` : ""}.`, { readiness, backend: found.backend, ...totals, complete: false })
          }
          await logTgrepRequest(directory, config, search, mode.mode, { backend: found.backend, ...totals })
          return result(output || "No matches.", { readiness, backend: found.backend, ...totals, complete: true })
        },
      })
    })
  },
}

export default plugin
