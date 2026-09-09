import { render } from '@opentui/solid'
import { OcpApp } from './app'
import type { OcpRoute } from './router'

const [route = 'home', repoDir = process.cwd(), root, sessionId, usageScope] = process.argv.slice(2)

function isRoute(value: string): value is OcpRoute {
  return ['home', 'wizard', 'dashboard', 'setup', 'project', 'provider', 'profile', 'usage'].includes(value)
}

await render(() => <OcpApp initialRoute={isRoute(route) ? route : 'home'} context={{ repoDir, root: root || undefined, sessionId: sessionId || undefined, usageScope: usageScope === 'all' ? 'all' : 'current' }} />)
