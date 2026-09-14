export type TgrepDetailMode = "locations" | "content"
export type TgrepMode = "summary" | TgrepDetailMode

export type TgrepModeValidation =
  | { ok: true; mode: TgrepMode }
  | { ok: false; error: string }

const INVALID_MODE_ERROR = "Invalid mode: use `summary`, `locations`, or `content`; omit mode for `summary`. `files_with_matches` is a compatibility alias for `summary`."

/** Output rows are context-bounded. Detail (`locations`/`content`) requests
 * past this budget are refused (`complete: false`) instead of dumping
 * unbounded output into the caller's context; summary count output past the
 * same budget is truncated with an explicit omission marker. Callers narrow
 * path/glob or drill down per file. */
export const OUTPUT_ROW_BUDGET = 2_000

/** Character budget for materialized detail output: closes the long-line
 * window (few lines, huge lines — lockfiles/minified) and the growth race
 * between the summary probe and the detail run. Past it the tool refuses
 * (`complete: false`) rather than injecting ~40k+ tokens in one result. */
export const OUTPUT_CHAR_BUDGET = 150_000

/** True when a detail request must be refused rather than materialized. */
export function exceedsDetailBudget(mode: TgrepMode, matchedLines: number): boolean {
  return mode !== "summary" && matchedLines > OUTPUT_ROW_BUDGET
}

/** True when materialized detail output exceeds the character budget. */
export function exceedsDetailCharBudget(output: string): boolean {
  return output.length > OUTPUT_CHAR_BUDGET
}

/** Normalizes the one established semantic alias without accepting arbitrary typos. */
export function validateTgrepMode(value: unknown): TgrepModeValidation {
  if (value === undefined || value === "summary" || value === "files_with_matches") return { ok: true, mode: "summary" }
  if (value === "locations" || value === "content") return { ok: true, mode: value }
  return { ok: false, error: INVALID_MODE_ERROR }
}
