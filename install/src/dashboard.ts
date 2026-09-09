import { runOcpUi } from './ui/runtime'

export interface DashboardResult { action: 'exit' | 'back' | 'install'; locale: string; target?: string }

/**
 * Exit-code protocol between a TUI child process and the parent CLI — shared
 * by the dashboard AND the wizard's quick install: the TUI persists
 * options.jsonc itself, then exits with this code to hand control back to the
 * parent, which falls through to the installer so progress and the final
 * result render in the user's normal shell.
 */
export const UI_INSTALL_EXIT = 20

/** Compatibility entry point; rendering and terminal input are owned by OpenTUI. */
export async function runTuiDashboard(repoDir: string, initialLocale = ''): Promise<DashboardResult> {
  const { code, request } = await runOcpUi('dashboard', { repoDir })
  return { action: code === UI_INSTALL_EXIT ? 'install' : code === 0 ? 'exit' : 'back', locale: initialLocale, target: request?.target }
}
