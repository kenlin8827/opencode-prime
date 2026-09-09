import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { tgrepOptionsFrom } from "./tgrep/tgrep-config"
import { searchTgrep, type TgrepSearchInput } from "./tgrep/tgrep-search"
import { ensureServer, probeTgrepStatus } from "./tgrep/tgrep-service"

function options(root: string) {
  try { return tgrepOptionsFrom(root, readFileSync(join(homedir(), ".config", "opencode", "options.jsonc"), "utf8")) }
  catch { return { enabled: false } }
}

/** Optional structured tgrep surface. It is not MCP and does not alter grep. */
export const TgrepPlugin: Plugin = async ({ directory }) => {
  // Do not expose a dead tool or spend schema tokens unless users explicitly
  // opt into this external binary integration.
  if (!options(directory).enabled) return {}
  return { tool: {
    tgrep_search: tool({
      description: "Optional indexed full-text search. Use only for repeated broad text/regex lookups when the project profile reports tgrep=ready. Use freshness=current after edits, for verification, or before asserting no matches; it bypasses the index. Falls back safely when unavailable.",
      args: {
        pattern: tool.schema.string().describe("Text or regex pattern; passed as one argv value."),
        path: tool.schema.string().optional().describe("Relative workspace path. Default: ."),
        flags: tool.schema.array(tool.schema.enum(["-i", "--ignore-case", "-F", "--fixed-strings", "-g", "--glob"])).optional().describe("Supported search flags only."),
        freshness: tool.schema.enum(["indexed", "current"]).optional().describe("indexed for ready cache; current bypasses the cache for exact working-tree results."),
      },
      execute: async (args) => {
        const config = options(directory)
        if (!config.enabled) return { title: "tgrep unavailable", output: "tgrep is disabled; use the native grep/ripgrep path." }
        let readiness = probeTgrepStatus(directory, config)
        if (readiness === "disk-index") readiness = await ensureServer(directory, config)
        const result = searchTgrep(directory, args as TgrepSearchInput, readiness)
        const label = result.backend === "tgrep" ? `tgrep (${args.freshness ?? "indexed"})` : "rg fallback"
        const output = result.status === "no-matches" ? "No matches." : `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`
        return { title: label, output, metadata: { backend: result.backend, exitCode: result.code, status: result.status, readiness } }
      },
    }),
  } }
}
