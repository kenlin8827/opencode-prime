export type OcpRoute = 'home' | 'wizard' | 'dashboard' | 'setup' | 'project' | 'provider' | 'profile' | 'usage'

export interface OcpRouter {
  readonly route: () => OcpRoute
  readonly exited: () => boolean
  push(route: OcpRoute): void
  back(): void
  exit(): void
}

/** A tiny UI-owned route stack.  Business screens will be migrated onto it. */
export function createRouter(initial: OcpRoute = 'home'): OcpRouter {
  const stack: OcpRoute[] = [initial]
  let hasExited = false
  return {
    route: () => stack.at(-1) ?? 'home',
    exited: () => hasExited,
    push: (route) => { if (!hasExited) stack.push(route) },
    back: () => {
      if (hasExited) return
      if (stack.length > 1) stack.pop()
      else hasExited = true
    },
    exit: () => { hasExited = true },
  }
}
