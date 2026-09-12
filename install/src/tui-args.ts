/**
 * Normalize `ocp tui` passthrough args before forwarding to the underlying
 * launcher. ONLY an explicit `--init` requests project initialization
 * (an earlier design aliased a bare `.` to it — dropped; see the ADR 0001
 * amendment). A bare `.` is not a valid passthrough argument for
 * opencode/herdr/luvus, so it is stripped as a no-op.
 */
export function normalizeTuiPassthrough(raw: string[]): { initRequested: boolean; passthrough: string[] } {
  return {
    initRequested: raw.includes('--init'),
    passthrough: raw.filter((a) => a !== '--init' && a !== '.'),
  };
}
