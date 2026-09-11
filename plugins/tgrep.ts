import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { loadTgrepOptions } from "./tgrep/tgrep-config"
import { searchTgrep, type TgrepSearchInput } from "./tgrep/tgrep-search"
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

/** Keep broad-match dumps out of the model context; callers can narrow with
 * path or glob instead. */
const MAX_OUTPUT_CHARS = 30_000

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
        pattern: tool.schema.string().describe("Text or regex pattern; passed as one argv value."),
        path: tool.schema.string().optional().describe("Relative workspace path. Default: ."),
        glob: tool.schema.array(tool.schema.string()).optional().describe("Gitignore-style globs, each applied via -g."),
        flags: tool.schema.array(tool.schema.enum(["-i", "--ignore-case", "-F", "--fixed-strings"])).optional().describe("Supported search flags only."),
        noIndex: tool.schema.boolean().optional().describe("When true, force `tgrep --no-index` (bypass the index, read from disk). Default: false (use the index)."),
      },
      execute: async (args) => {
        const config = loadTgrepOptions(directory)
        if (!config.enabled) return { title: "tgrep unavailable", output: "tgrep is disabled; use the native grep/ripgrep path." }
        const readiness = await ensureWatcher(directory, config)
        const result = searchTgrep(directory, args as TgrepSearchInput, readiness)
        const label = result.backend === "tgrep" ? `tgrep (${args.noIndex ? "no-index" : "indexed"})` : "rg fallback"
        const raw = result.status === "no-matches" ? "No matches." : `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`
        const output = raw.length > MAX_OUTPUT_CHARS
          ? `${raw.slice(0, MAX_OUTPUT_CHARS)}\n… output truncated at ${MAX_OUTPUT_CHARS} chars; narrow with path or glob`
          : raw
        return { title: label, output, metadata: { backend: result.backend, exitCode: result.code, status: result.status, readiness } }
      },
    }),
  } }
}
