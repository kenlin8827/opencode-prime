import { initI18nHeadless, tr } from '../../plugins/tui/i18n'
import { applyProfile, getActiveProfile, listModelRefs, loadProfiles, loadTierMap, recordRecentProfile, setActiveProfile, sortedProfileEntries, stripModelRefs } from '../../plugins/shared/profile-core'
import { CONFIG_FILE, readConfig, writeConfigAtomic } from '../../plugins/shared/provider-creds'
import { runOcpUi } from './ui/runtime'

export type ProfileMode = 'wizard' | 'list' | 'apply' | 'reset-interactive' | 'reset-force' | 'usage'
export function resolveProfileMode(args: string[], isTTY: boolean): ProfileMode {
  if (!args.length) return 'wizard'
  if (args.length === 1 && args[0] === 'list') return 'list'
  if (args.length === 2 && args[0] === 'apply' && args[1]) return 'apply'
  if (args.length === 2 && args[0] === 'reset' && args[1] === '--yes') return 'reset-force'
  if (args.length === 1 && args[0] === 'reset') return isTTY ? 'reset-interactive' : 'usage'
  return 'usage'
}

function list(): number {
  const all = loadProfiles()
  if (!all.size) { console.log(tr('profile.cli.noProfiles')); return 0 }
  const active = getActiveProfile()
  console.log('NAME\tKIND\tACTIVE')
  for (const entry of sortedProfileEntries(all)) console.log(`${entry.name}\t${entry.kind}\t${entry.name === active ? 'yes' : ''}`)
  return 0
}

function apply(name: string): number {
  const profile = loadProfiles().get(name)
  if (!profile) { console.error(`Profile not found: ${name}`); return 1 }
  try {
    const config = readConfig(CONFIG_FILE)
    const result = applyProfile(config, profile, loadTierMap())
    writeConfigAtomic(CONFIG_FILE, config); setActiveProfile(name); recordRecentProfile(name)
    console.log(tr('profile.cli.applied', { name })); console.log(result.details.join('\n')); return 0
  } catch (error) { console.error(`Failed to apply '${name}': ${(error as Error).message}`); return 1 }
}

function reset(): number {
  try {
    const config = readConfig(CONFIG_FILE); const count = stripModelRefs(config)
    if (!count) { console.log(tr('profile.cli.nothing')); return 0 }
    writeConfigAtomic(CONFIG_FILE, config); console.log(tr('profile.resetDone', { count })); return 0
  } catch (error) { console.error(tr('profile.resetFailed', { err: (error as Error).message })); return 1 }
}

export async function runProfileCli(repoDir: string, args: string[]): Promise<number> {
  initI18nHeadless()
  const mode = resolveProfileMode(args, Boolean(process.stdin.isTTY && process.stdout.isTTY))
  if (mode === 'list') return list()
  if (mode === 'apply') return apply(args[1])
  if (mode === 'reset-force') return reset()
  if (mode === 'usage') {
    console.error(args[0] === 'reset' && args.length === 1 ? tr('tuiHost.interactiveRequired') : tr('profile.cli.usage'))
    return 1
  }
  if (mode === 'reset-interactive') {
    console.error(tr('profile.cli.usage'))
    return 1
  }
  return (await runOcpUi('profile', { repoDir })).code
}
