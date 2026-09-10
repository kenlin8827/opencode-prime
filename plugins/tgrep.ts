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
      description: "Default tool for codebase-wide text/regex search. Do NOT dispatch `@explore` (or any subagent) for plain text/regex matching — call `tgrep_search` directly.\n\nThe `[PROJECT CAPABILITIES]` block reports tgrep readiness as `tgrep=<state>`. Canonical state — freshness mapping:\n  ready       — freshness=indexed   (fastest: watcher live, index current)\n  stale       — freshness=current   (index built under different policy; rebuild via /project index)\n  building    — freshness=current   (rebuild in flight; result would be partial)\n  no-watcher  — freshness=current   (disk-index exists, no live serve; tool falls back to rg)\n  no-index    — freshness=current   (CLI present, .tgrep/ missing; tool falls back to rg)\n  no-cli      — tool NOT registered (tgrep binary not on PATH) — use native grep/glob\n  unavailable — tool NOT registered (tools.tgrep = false)         — use native grep/glob\n\nShortcut: `ready` — `freshness=indexed`; everything else — `freshness=current`. `freshness=indexed` is safe in any REGISTERED state — the tool transparently falls back to rg when the watcher is not usable, so the agent never has to switch tools inside one of the 5 registered states.\n\nAfter edits, validation, or any no-match claim, always re-run with `freshness=current`; never trust a null indexed result without a current-mode follow-up.",
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
