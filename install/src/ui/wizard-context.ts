import { OpenCode } from '@opencode/client'
import type { Context, KeymapLayer } from '@opencode/plugin/tui'
import { ocpTheme } from './theme'
import type { TuiHost } from './tui-host'

/**
 * Standalone V2 TUI-plugin context for `ocp provider|profile|project|usage`.
 *
 * OpenCode's real TUI provides the full `Context` from `@opencode/plugin/tui`;
 * the standalone OpenTUI host implements the subset the four standalone-loaded
 * wizards actually call and keeps unimplemented surfaces fail-loud, so a
 * future wizard touching a missing API errors visibly instead of misbehaving.
 *
 * Directory scoping note: the V2 client has no `directory` client option — the
 * v1 SDK's `/v2` preview mapped it to the `x-opencode-directory` header
 * (URL-encoded), which we replicate here for workspace-scoped usage queries.
 */
export interface WizardContextOptions {
  /** Workspace directory the wizard operates on (drives location + client scoping). */
  root?: string
  /** Preselected session for /usage (from `ocp usage <id>`). */
  sessionId?: string
  /** OpenCode server origin; defaults to OPENCODE_SERVER_URL or localhost:4096. */
  baseUrl?: string
  /** The OpenTUI renderer (usage reads `renderer.height` for scroll budgeting). */
  renderer?: unknown
}

export interface WizardContextHandle {
  context: Context
  setSessionId(sessionID: string | undefined): void
  /** Dispatch a terminal keypress to the keymap command bound to that key. True when consumed. */
  dispatchKey(name: string): boolean
}

/** V2 client has no cross-project session listing (`roots` was a v1 preview
 *  endpoint); `--all` therefore lists the server's default scope. */
export function createUsageClient(directory?: string) {
  return OpenCode.make({
    baseUrl: process.env.OPENCODE_SERVER_URL || 'http://localhost:4096',
    ...(directory ? { headers: { 'x-opencode-directory': encodeURIComponent(directory) } } : {}),
  })
}

export function createWizardContext(host: TuiHost, options: WizardContextOptions = {}): WizardContextHandle {
  const directory = options.root ?? process.cwd()
  const client = OpenCode.make({
    baseUrl: options.baseUrl ?? process.env.OPENCODE_SERVER_URL || 'http://localhost:4096',
    headers: { 'x-opencode-directory': encodeURIComponent(directory) },
  })
  let sessionId = options.sessionId
  const location = { directory }

  // ---- keymap: V2 reactive layers → host command registry + bind routing ----
  const bound = new Map<string, (input?: string) => void | false | Promise<void>>()
  const keymap = {
    layer(input: () => KeymapLayer | undefined): void {
      const layer = input()
      for (const command of layer?.commands ?? []) {
        if (command.enabled === false) continue
        const id = command.id ?? command.slash?.name
        if (id) host.register(id, (argv) => { void command.run(argv) })
        if (typeof command.bind === 'string') bound.set(command.bind, command.run)
      }
    },
    dispatch(id: string, input?: string): void { host.dispatch(id, input) },
    shortcuts: () => [] as readonly string[],
    commands: () => [] as readonly never[],
    pending: () => [] as readonly never[],
    active: () => [] as readonly never[],
    mode: { current: () => 'global', push: () => () => {} },
  }

  // ---- data: thin client-backed cache over the collections the wizards use ----
  const cache = new Map<string, unknown[]>()
  const collection = <T,>(key: string, fetch: () => Promise<T[]>) => ({
    list: () => cache.get(key),
    sync: async () => { cache.set(key, await fetch()) },
    invalidate: () => { cache.delete(key) },
  })
  const unimplemented = (what: string): never => { throw new Error(`standalone host: ctx.${what} is not implemented`) }
  const data = {
    on: () => () => {},
    listen: () => () => {},
    session: {
      list: () => unimplemented('data.session.list'),
      get: () => unimplemented('data.session.get'),
      root: () => unimplemented('data.session.root'),
      family: () => unimplemented('data.session.family'),
      cost: () => unimplemented('data.session.cost'),
      status: () => unimplemented('data.session.status'),
      sync: () => unimplemented('data.session.sync'),
      invalidate: () => unimplemented('data.session.invalidate'),
      pending: { list: () => unimplemented('data.session.pending.list'), sync: () => unimplemented('data.session.pending.sync'), invalidate: () => unimplemented('data.session.pending.invalidate') },
      message: {
        list: (id: string) => cache.get(`session-message:${id}`),
        get: () => unimplemented('data.session.message.get'),
        sync: async (id: string) => { cache.set(`session-message:${id}`, await client.session.context({ sessionID: id })) },
        invalidate: (id: string) => { cache.delete(`session-message:${id}`) },
      },
      permission: { list: () => unimplemented('data.session.permission.list'), sync: () => unimplemented('data.session.permission.sync'), invalidate: () => unimplemented('data.session.permission.invalidate') },
      form: { list: () => unimplemented('data.session.form.list'), sync: () => unimplemented('data.session.form.sync'), invalidate: () => unimplemented('data.session.form.invalidate'), reply: () => unimplemented('data.session.form.reply'), cancel: () => unimplemented('data.session.form.cancel') },
    },
    project: { list: () => unimplemented('data.project.list'), get: () => unimplemented('data.project.get'), sync: () => unimplemented('data.project.sync'), invalidate: () => unimplemented('data.project.invalidate'), permission: { list: () => unimplemented('data.project.permission.list'), sync: () => unimplemented('data.project.permission.sync'), invalidate: () => unimplemented('data.project.permission.invalidate') } },
    shell: { list: () => unimplemented('data.shell.list'), get: () => unimplemented('data.shell.get'), sync: () => unimplemented('data.shell.sync'), invalidate: () => unimplemented('data.shell.invalidate') },
    location: {
      default: () => location,
      sync: async () => {},
      invalidate: () => {},
      vcs: { info: () => undefined, sync: async () => {}, invalidate: () => {} },
      agent: { list: () => unimplemented('data.location.agent.list'), sync: () => unimplemented('data.location.agent.sync'), invalidate: () => unimplemented('data.location.agent.invalidate') },
      command: { list: () => unimplemented('data.location.command.list'), sync: () => unimplemented('data.location.command.sync'), invalidate: () => unimplemented('data.location.command.invalidate') },
      integration: { list: () => unimplemented('data.location.integration.list'), sync: () => unimplemented('data.location.integration.sync'), invalidate: () => unimplemented('data.location.integration.invalidate') },
      mcp: { server: { list: () => unimplemented('data.location.mcp.server.list'), sync: () => unimplemented('data.location.mcp.server.sync'), invalidate: () => unimplemented('data.location.mcp.server.invalidate') }, resource: { list: () => unimplemented('data.location.mcp.resource.list'), sync: () => unimplemented('data.location.mcp.resource.sync'), invalidate: () => unimplemented('data.location.mcp.resource.invalidate') } },
      model: collection('model', async () => (await client.model.list()).data),
      provider: collection('provider', async () => (await client.provider.list()).data),
      reference: { list: () => unimplemented('data.location.reference.list'), sync: () => unimplemented('data.location.reference.sync'), invalidate: () => unimplemented('data.location.reference.invalidate') },
      skill: { list: () => unimplemented('data.location.skill.list'), sync: () => unimplemented('data.location.skill.sync'), invalidate: () => unimplemented('data.location.skill.invalidate') },
    },
  }

  // ---- ui: promise-based dialogs over the host's frame stack ----
  const settle = <T,>(resolve: (value: T) => void) => {
    let done = false
    return (value: T) => { if (!done) { done = true; resolve(value) } }
  }
  const ui = {
    dialog: {
      alert(options: { title: string; message: string }): Promise<void> {
        return new Promise<void>((resolve) => {
          const done = settle(resolve)
          host.replace({ kind: 'alert', title: options.title, message: options.message, onClose: () => done(undefined) })
        })
      },
      confirm(options: { title: string; message: string; label?: { confirm?: string; cancel?: string } }): Promise<boolean | undefined> {
        return new Promise<boolean | undefined>((resolve) => {
          const done = settle(resolve)
          host.replace({
            kind: 'confirm', title: options.title, message: options.message,
            confirmLabel: options.label?.confirm, cancelLabel: options.label?.cancel,
            onConfirm: () => { done(true); host.clear() },
            onCancel: () => { done(undefined); host.clear() },
            onClose: () => done(undefined),
          })
        })
      },
      prompt(options: { title: string; placeholder?: string; value?: string }): Promise<string | undefined> {
        return new Promise<string | undefined>((resolve) => {
          const done = settle(resolve)
          host.replace({
            kind: 'prompt', title: options.title, placeholder: options.placeholder, value: options.value,
            onConfirm: (value) => { done(value); host.clear() },
            onCancel: () => { done(undefined); host.clear() },
            onClose: () => done(undefined),
          })
        })
      },
      select<Value>(options: { title: string; placeholder?: string; options: readonly { title: string; value: Value; description?: string; category?: string; disabled?: boolean }[]; current?: Value }): Promise<Value | undefined> {
        return new Promise<Value | undefined>((resolve) => {
          const done = settle(resolve)
          // Host dialogs carry string values; map positions so the ORIGINAL
          // value objects (numbers/objects) resolve unchanged, like opencode.
          const mapped = options.options.map((option, index) => ({
            title: option.title, value: String(index),
            ...(option.description !== undefined ? { description: option.description } : {}),
            ...(option.category !== undefined ? { category: option.category } : {}),
            ...(option.disabled !== undefined ? { disabled: option.disabled } : {}),
          }))
          const currentIdx = options.current !== undefined
            ? options.options.findIndex((option) => option.value === options.current)
            : -1
          host.replace({
            kind: 'select', title: options.title, placeholder: options.placeholder,
            ...(currentIdx >= 0 ? { current: String(currentIdx) } : {}),
            options: mapped,
            onSelect: (picked) => {
              const index = Number(picked?.value)
              done(Number.isInteger(index) ? options.options[index]?.value : undefined)
              host.clear()
            },
            onClose: () => done(undefined),
          })
        })
      },
      show(render: () => unknown, onClose?: () => void): void {
        host.replace({ kind: 'custom', render: render as () => never, ...(onClose ? { onClose } : {}) })
      },
      set(options: { size?: 'medium' | 'large' | 'xlarge' }): void { host.setSize(options.size) },
      clear(): void { host.clear() },
    },
    toast: { show(options: { title?: string; message: string }): void { host.notify(options.message, options.title) } },
    format: { path: (value: string) => value },
    router: {
      register: () => () => {},
      navigate: () => {},
      current: () => ({ type: 'session', sessionID: sessionId ?? '' } as const),
    },
    panel: { open: () => false, close: () => {}, current: () => undefined },
    tabs: { enabled: () => false },
    slot: () => () => {},
  }

  const context = {
    options: {},
    location,
    app: { version: '0.0.0', channel: 'stable' },
    renderer: options.renderer,
    client,
    data,
    attention: { notify: async () => ({ ok: false, notification: false, sound: false, skipped: 'attention_disabled' as const }) },
    // Theme tokens follow the ocp-adopted opencode palette; only token paths
    // the standalone wizards read are wired (text.base, text.feedback.info.base).
    theme: { text: { base: ocpTheme.text, feedback: { info: { base: ocpTheme.text } } } },
    themeMode: 'dark' as const,
    markdown: { registerCodeBlockRenderer: () => () => {} },
    keymap,
    storage: { store: () => unimplemented('ctx.storage.store'), memory: () => unimplemented('ctx.storage.memory') },
    ui,
  } as unknown as Context

  return {
    context,
    setSessionId(next: string | undefined) { sessionId = next },
    dispatchKey(name: string): boolean {
      const run = bound.get(name)
      if (!run) return false
      void run()
      return true
    },
  }
}
