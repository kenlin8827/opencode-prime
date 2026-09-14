import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { loadTgrepOptions } from "./tgrep/tgrep-config"
import { validateTgrepMode } from "./tgrep/tgrep-mode"
import { tgrepLocation } from "./tgrep/tgrep-output"
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

/** Optional structured tgrep surface. It is not MCP and does not alter grep. */
export const TgrepPlugin: Plugin = async ({ directory }) => {
  const config = loadTgrepOptions(directory)
  // The switch defaults to ON (install/options.jsonc), so the gate is not
  // only the flag: the tool must also self-hide while the external CLI is
  // absent — otherwise every non-tgrep user carries a dead tool that pays a
  // failed probe on every search. hasTgrepCli hides only on ENOENT, so a
  // momentary --version timeout never uninstalls the tool mid-session.
  if (!config.enabled || !hasTgrepCli(directory)) return {}
return { tool: {
    tgrep_search: tool({
      description: TGREP_TOOL_DESCRIPTION,
      args: {
        pattern: tool.schema.string().describe("Text or regex pattern."),
        path: tool.schema.string().optional().describe("Path relative to the current working directory. Default: ."),
        glob: tool.schema.array(tool.schema.string()).optional().describe("Gitignore-style globs, each applied via -g."),
        ignoreCase: tool.schema.boolean().optional().describe("Case-insensitive search."),
        literal: tool.schema.boolean().optional().describe("Treat pattern as literal text instead of regex."),
        noIndex: tool.schema.boolean().optional().describe("When true, force `--no-index` (bypass the index, read from disk). Default: false (use the index)."),
        mode: tool.schema.enum(["summary", "locations", "content", "files_with_matches"]).optional().describe("Mode: summary (path:count), locations (path:line), or content (path:line:text). Omit for summary. files_with_matches is a compatibility alias for summary."),
      },
      execute: async (args) => {
        const config = loadTgrepOptions(directory)
        if (!config.enabled) return { title: "tgrep unavailable", output: "tgrep is disabled; use the native grep/ripgrep path." }
        const mode = validateTgrepMode(args.mode)
        if (!mode.ok) return { title: "tgrep invalid request", output: mode.error }
        const readiness = await ensureWatcher(directory, config)
        const input: TgrepSearchInput = { ...args, mode: mode.mode === "summary" ? undefined : mode.mode }
        const summary = summarizeTgrepSearch(directory, input, readiness, config)
        if (!summary.matchedLines) {
          await logTgrepRequest(directory, config, input, mode.mode, summary)
          return { title: "tgrep", output: "No matches.", metadata: { readiness, backend: summary.backend, matchedFiles: 0, matchedLines: 0, complete: true } }
        }
        if (mode.mode === "summary") {
          await logTgrepRequest(directory, config, input, "summary", summary)
          return { title: "tgrep summary", output: summary.counts.join("\n"), metadata: { readiness, backend: summary.backend, matchedFiles: summary.matchedFiles, matchedLines: summary.matchedLines, complete: true } }
        }
        const result = searchTgrep(directory, input, readiness, config, ["--with-filename", "--line-number"])
        if (result.status === "error") throw new Error(result.stderr || "tgrep search failed")
        const output = mode.mode === "locations"
          ? result.stdout.split(/\r?\n/).filter(Boolean).map(tgrepLocation).join("\n")
          : result.stdout.trim()
        await logTgrepRequest(directory, config, input, mode.mode, { backend: result.backend, matchedFiles: summary.matchedFiles, matchedLines: summary.matchedLines })
        return { title: `tgrep ${mode.mode}`, output: output || "No matches.", metadata: { readiness, backend: result.backend, matchedFiles: summary.matchedFiles, matchedLines: summary.matchedLines, complete: true } }
      },
    }),
  } }
}
