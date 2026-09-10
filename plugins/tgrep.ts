import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { loadTgrepOptions } from "./tgrep/tgrep-config"
import { searchTgrep, type TgrepSearchInput } from "./tgrep/tgrep-search"
import { ensureServer, probeTgrepStatus, tgrepVersion } from "./tgrep/tgrep-service"

/** Keep broad-match dumps out of the model context; callers can narrow with
 * path or glob instead. */
const MAX_OUTPUT_CHARS = 30_000

/** Optional structured tgrep surface. It is not MCP and does not alter grep. */
export const TgrepPlugin: Plugin = async ({ directory }) => {
  const config = loadTgrepOptions(directory)
  // The switch defaults to ON (install/options.jsonc), so the gate is not
  // only the flag: the tool must also self-hide while the external CLI is
  // absent — otherwise every non-tgrep user carries a dead tool that pays a
  // failed probe on every search. spawnSync fails fast (ENOENT) in that case.
  if (!config.enabled || !tgrepVersion(directory)) return {}
  return { tool: {
    tgrep_search: tool({
      description: "Optional indexed full-text search. Use only for repeated broad text/regex lookups when the project profile reports tgrep=ready. Use freshness=current after edits, for verification, or before asserting no matches; it bypasses the index. Falls back safely when unavailable.",
      args: {
        pattern: tool.schema.string().describe("Text or regex pattern; passed as one argv value."),
        path: tool.schema.string().optional().describe("Relative workspace path. Default: ."),
        glob: tool.schema.array(tool.schema.string()).optional().describe("Gitignore-style glob filters, each applied via -g."),
        flags: tool.schema.array(tool.schema.enum(["-i", "--ignore-case", "-F", "--fixed-strings"])).optional().describe("Supported search flags only."),
        freshness: tool.schema.enum(["indexed", "current"]).optional().describe("indexed for ready cache; current bypasses the cache for exact working-tree results."),
      },
      execute: async (args) => {
        const config = loadTgrepOptions(directory)
        if (!config.enabled) return { title: "tgrep unavailable", output: "tgrep is disabled; use the native grep/ripgrep path." }
        let readiness = probeTgrepStatus(directory, config)
        if (readiness === "disk-index") readiness = await ensureServer(directory, config)
        const result = searchTgrep(directory, args as TgrepSearchInput, readiness)
        const label = result.backend === "tgrep" ? `tgrep (${args.freshness ?? "indexed"})` : "rg fallback"
        const raw = result.status === "no-matches" ? "No matches." : `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`
        const output = raw.length > MAX_OUTPUT_CHARS
          ? `${raw.slice(0, MAX_OUTPUT_CHARS)}\n… output truncated at ${MAX_OUTPUT_CHARS} chars; narrow with path or glob`
          : raw
        return { title: label, output, metadata: { backend: result.backend, exitCode: result.code, status: result.status, readiness } }
      },
    }),
  } }
}
