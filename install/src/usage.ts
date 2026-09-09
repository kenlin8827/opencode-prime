import { initI18nHeadless } from '../../plugins/tui/i18n'
import { runOcpUi } from './ui/runtime'

export type UsageMode = 'all' | 'current' | 'session' | 'usage'

/** `ocp usage [--all|.|sessionId]`: no argument defaults to every project. */
export function resolveUsageMode(args: string[]): UsageMode {
  if (args.length === 0 || (args.length === 1 && args[0] === '--all')) return 'all'
  if (args.length === 1 && args[0] === '.') return 'current'
  if (args.length === 1 && args[0] && !args[0].startsWith('-')) return 'session'
  return 'usage'
}

export async function runUsageCli(repoDir: string, args: string[]): Promise<number> {
  initI18nHeadless()
  const mode = resolveUsageMode(args)
  if (mode === 'usage') {
    console.error('Usage: ocp usage [--all | . | sessionId]')
    return 1
  }
  return (await runOcpUi('usage', {
    repoDir,
    // An omitted directory asks the OpenCode server for sessions in all
    // projects. `.` scopes the picker and report to the invoking workspace.
    root: mode === 'current' ? process.cwd() : undefined,
    sessionId: mode === 'session' ? args[0] : undefined,
  })).code
}
