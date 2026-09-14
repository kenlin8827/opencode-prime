import { appendFile } from "node:fs/promises"
import { join } from "node:path"
import { getProjectLogDir } from "../shared/opencode-prime"
import type { TgrepOptions } from "./tgrep-config"
import type { TgrepSearchInput, TgrepSearchResult } from "./tgrep-search"

interface TgrepRequestTotals {
  backend: TgrepSearchResult["backend"]
  matchedFiles: number
  matchedLines: number
}

function normalizedInput(input: TgrepSearchInput): Record<string, unknown> {
  return {
    pattern: input.pattern,
    path: input.path ?? ".",
    glob: input.glob ?? [],
    ignoreCase: input.ignoreCase ?? false,
    literal: input.literal ?? false,
    noIndex: input.noIndex ?? false,
  }
}

/** Writes development diagnostics without allowing diagnostics to fail search. */
export async function logTgrepRequest(root: string, options: TgrepOptions, input: TgrepSearchInput, mode: "summary" | "locations" | "content", totals: TgrepRequestTotals): Promise<void> {
  if (!options.requestLog) return
  const record = JSON.stringify({ timestamp: new Date().toISOString(), input: normalizedInput(input), mode, ...totals }) + "\n"
  try {
    await appendFile(join(getProjectLogDir(root), "tgrep.jsonl"), record, "utf8")
  } catch (error) {
    // Diagnostics must not change the search result — but stay observable so
    // a silently-empty log is diagnosable.
    console.warn("tgrep request log write failed:", error)
  }
}
