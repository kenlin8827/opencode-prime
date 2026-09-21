/**
 * Recovery assist — make RTK elision visible to the model.
 *
 * RTK's compression is "fully transparent", which is exactly the problem:
 * when a filter elides output the model cannot tell "this is all the data"
 * from "this is a summary", so it re-runs commands hunting for data that
 * was thrown away. RTK marks elided output with a recovery hint, e.g.
 * `[see remaining: tail -n +1 "$HOME/AppData/Local/rtk/tee/...-hidden.log"]`.
 *
 * When that marker shows up in a bash/shell result, append one short line
 * teaching the model the reliable escape hatch: rerun prefixed with
 * `RTK_RAW=1 ` (honored by this plugin's before-hook). Zero token cost when
 * nothing was elided.
 */

/** Markers whose presence means RTK withheld output. Extend here when rtk
 * changes wording (matched case-insensitively against the tool output). */
const ELISION_MARKERS = [/\[see remaining:/i];

/** Command prefix that bypasses rtk-write rewriting entirely. */
const RAW_PREFIX = "RTK_RAW=1";

export function isRawBypass(command: string): boolean {
  return new RegExp(`^\\s*${RAW_PREFIX}\\s+`).test(command);
}

export function containsElisionMarker(output: string): boolean {
  return ELISION_MARKERS.some((marker) => marker.test(output));
}

/** One-line notice appended after elided output. Uses the actual command so
 * the model can copy-paste it with the prefix already in place. */
export function buildRecoveryNotice(command: string): string {
  const example = command.replace(/\s+/g, " ").trim();
  return `[rtk] Output above was compressed by RTK and may be incomplete. For the full output rerun: ${RAW_PREFIX} ${example}`;
}
