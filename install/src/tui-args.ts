/**
 * Normalize `ocp tui .` / `ocp tui --init` before forwarding args to the
 * underlying launcher. `.` is OCP syntax for "activate this directory" and is
 * not a valid passthrough argument for either opencode or herdr.
 */
export function normalizeTuiPassthrough(raw: string[]): { initRequested: boolean; passthrough: string[] } {
  const initRequested = raw.includes('--init') || raw.includes('.');
  return {
    initRequested,
    passthrough: raw.filter((a) => a !== '--init' && !(initRequested && a === '.')),
  };
}
