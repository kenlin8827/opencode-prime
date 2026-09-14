export type TgrepDetailMode = "locations" | "content"
export type TgrepMode = "summary" | TgrepDetailMode

export type TgrepModeValidation =
  | { ok: true; mode: TgrepMode }
  | { ok: false; error: string }

const INVALID_MODE_ERROR = "Invalid mode: use `summary`, `locations`, or `content`; omit mode for `summary`. `files_with_matches` is a compatibility alias for `summary`."

/** Normalizes the one established semantic alias without accepting arbitrary typos. */
export function validateTgrepMode(value: unknown): TgrepModeValidation {
  if (value === undefined || value === "summary" || value === "files_with_matches") return { ok: true, mode: "summary" }
  if (value === "locations" || value === "content") return { ok: true, mode: value }
  return { ok: false, error: INVALID_MODE_ERROR }
}
