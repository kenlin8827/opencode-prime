import { OUTPUT_ROW_BUDGET } from "./tgrep-mode"

/** Extracts the first `:<line>:` delimiter after the filename, preserving colons in content. */
export function tgrepLocation(line: string): string {
  const delimiter = /^(.+?):(\d+):/.exec(line)
  return delimiter ? `${delimiter[1]}:${delimiter[2]}` : line
}

/** Caps summary count rows at the output budget. Past the cap, returns the
 * first BUDGET rows plus an explicit omission marker (complete: false) —
 * partial aggregates stay truthful; metadata totals stay complete. */
export function capSummaryCounts(counts: string[]): { rows: string[]; complete: boolean } {
  if (counts.length <= OUTPUT_ROW_BUDGET) return { rows: counts, complete: true }
  const hidden = counts.length - OUTPUT_ROW_BUDGET
  return { rows: [...counts.slice(0, OUTPUT_ROW_BUDGET), `… ${hidden} more matching files not shown; narrow path/glob`], complete: false }
}
