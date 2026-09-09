import { initI18nHeadless, tr } from '../../plugins/tui/i18n'
import { CONFIG_FILE, naturalCmp, readConnections, readConfig } from '../../plugins/shared/provider-creds'
import { runOcpUi } from './ui/runtime'

export type ProviderMode = 'wizard' | 'list' | 'usage'
export function resolveProviderMode(args: string[]): ProviderMode {
  if (!args.length) return 'wizard'
  if (args.length === 1 && args[0] === 'list') return 'list'
  return 'usage'
}

function printProviders(): number {
  let config: ReturnType<typeof readConfig> = {}
  try { config = readConfig(CONFIG_FILE) } catch { /* An empty config has no providers. */ }
  const connected = new Set(readConnections().map((item) => item.id))
  const entries = Object.entries(config.provider ?? {}).sort(([a], [b]) => naturalCmp(a, b))
  if (!entries.length) { console.log(tr('provider.cli.noProviders')); return 0 }
  console.log('ID\tModels\tConnection')
  for (const [id, provider] of entries) console.log(`${id}\t${Object.keys(provider.models ?? {}).length}\t${connected.has(id) ? 'connected' : 'disconnected'}`)
  return 0
}

export async function runProviderCli(repoDir: string, args: string[]): Promise<number> {
  initI18nHeadless()
  const mode = resolveProviderMode(args)
  if (mode === 'list') return printProviders()
  if (mode === 'usage') { console.error(tr('provider.cli.usage')); return 1 }
  return (await runOcpUi('provider', { repoDir })).code
}
