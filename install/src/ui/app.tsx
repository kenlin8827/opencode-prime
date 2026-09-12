import { createEffect, createMemo, createSignal, For, on, Show } from 'solid-js'
import type { JSX } from '@opentui/solid'
import { useKeyboard, useRenderer } from '@opentui/solid'
import type { TuiPluginModule } from '@opencode-ai/plugin/tui'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import type { OcpRoute } from './router'
import { Modal } from './components/modal'
import { categoryRows, skipHeaderRow, SelectList, SELECT_PANEL_PAD, type SelectRow } from './components/select-list'
import { ocpTheme } from './theme'
import { executeInit, executeStatus, executeUninstall, getCurrentRepoVersion, getDefaultTargetDir, loadEffectiveOptions, loadToolRegistry } from '../installer'
import { parseDynamicOptionsSchema, updateOptionsJsoncInPlace } from '../options-schema'
import path from 'node:path'
import { writeFileSync } from 'node:fs'
import { createTuiHost, type Dialog, type DialogOption } from './tui-host'
import { writeClipboardText } from './clipboard'
import { UI_INSTALL_EXIT } from '../dashboard'
import { applyOpenCodeTheme } from './opencode-theme'
import providerWizard from '../../../plugins/tui/provider-wizard'
import profileWizard from '../../../plugins/tui/profile-wizard'
import projectWizard from '../../../plugins/tui/project-wizard'
import usagePlugin from '../../../plugins/tui/usage'
import { tr } from '../../../plugins/tui/i18n'
import { formatI18n, getAvailableLocales, getPreferredLocaleCode, loadLocale, setPreferredLocaleCode } from '../i18n'
import { getDefaultBinDir, isShimRegistered, runGlobalRegistration, unregisterShim } from '../shim'

export interface OcpUiContext { repoDir: string; root?: string; sessionId?: string; usageScope?: 'all' | 'current' }

/** `createOpencodeClient()` does not inherit the SDK singleton's default URL;
 * standalone OCP must provide the local OpenCode server origin explicitly.
 * The v2 client matches the plugin's TuiPluginApi client (flat parameters:
 * session.get({ sessionID }) etc.) and scopes requests via `directory`. */
export function createUsageClient(directory?: string) {
  return createOpencodeClient({
    baseUrl: process.env.OPENCODE_SERVER_URL || 'http://localhost:4096',
    ...(directory ? { directory } : {}),
  })
}

const DAY_MS = 86_400_000

/** Plain-Esc test for every "escape = back/exit" binding. Terminals that
 *  report modified keys in the kitty ALTERNATE-KEY form (CSI 27;5;<cp>u)
 *  arrive with name 'escape' + ctrl set; treating those as Esc silently
 *  ejected users from screens exactly when they pressed Ctrl+T. */
function isBareEscape(key: { name?: string; ctrl?: boolean; meta?: boolean }): boolean {
  return key.name === 'escape' && !key.ctrl && !key.meta
}

/** Selection & clipboard surface the OpenTUI renderer exposes. Kept structural
 *  (with optional members) because solid's `useRenderer()` returns an opaque
 *  context value — same convention as the `height` reads elsewhere in the app. */
type SelectionClipboardSurface = {
  getSelection?: () => { getSelectedText(): string } | null | undefined
  copyToClipboardOSC52?: (text: string) => boolean
}

/**
 * Host-level right-click copy: OpenTUI delivers mouse events while its mouse
 * tracking is on (default), and any `selectable` text renderable participates
 * in the renderer's built-in drag selection. This single root-box handler
 * (mouse events bubble up the renderable chain) turns that selection into a
 * clipboard write — OSC 52 first, platform clipboard tools as the fallback —
 * and keeps the selection highlighted afterwards (preventDefault stops the
 * renderer from clearing it right after this dispatch).
 */
function rightClickCopy(event: { button: number; preventDefault?: () => void }, renderer: unknown, notify: (message: string) => void): void {
  // OpenTUI MouseButton: 0 left, 1 middle, 2 right — only the right button
  // copies; other buttons keep the renderer's default behavior.
  if (event.button !== 2) return
  event.preventDefault?.()
  const surface = renderer as SelectionClipboardSurface
  const text = surface.getSelection?.()?.getSelectedText()?.trim() ?? ''
  if (!text) {
    notify(tr('host.copy.empty'))
    return
  }
  void writeClipboardText(text, { copyOsc52: (value) => surface.copyToClipboardOSC52?.(value) ?? false })
    .then((result) => notify(result === 'failed' ? tr('host.copy.failed') : tr('host.copy.copied', { count: text.length })))
}

/** Date bucket for the usage session picker — sessions arrive sorted by
 *  most-recently-updated, so the buckets render in chronological order. */
function dateBucket(updated: number | undefined): string {
  if (!updated) return tr('usage.picker.earlier')
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (updated >= startOfToday) return tr('usage.picker.today')
  if (updated >= startOfToday - DAY_MS) return tr('usage.picker.yesterday')
  if (updated >= startOfToday - 2 * DAY_MS) return tr('usage.picker.daysAgo')
  return tr('usage.picker.earlier')
}

// ─── TuiPluginApi compatibility host ─────────────────────────────────
// The standalone OpenTUI app loads the SAME wizard plugins that opencode's
// /provider and /profile slash commands run. This adapter implements only
// the generic host surface those plugins consume — dialog stack, dialog
// components, toast, keymap command registration, kv and a minimal client
// facade. Every wizard menu, flow and validation stays in plugins/tui/*.

/** Structural mirrors of TuiDialogSelectProps & friends (values are strings here). */
interface CompatSelectProps {
  title: string; placeholder?: string; current?: unknown; renderFilter?: boolean; skipFilter?: boolean; itemSpacing?: number;
  options: Array<{ title: string; value: unknown; description?: string; category?: string }>;
  onSelect?: (option: { title: string; value: unknown; description?: string; category?: string }) => void
}
interface CompatPromptProps {
  title: string; placeholder?: string; value?: string; busy?: boolean; busyText?: string;
  onConfirm?: (value: string) => void; onCancel?: () => void
}
interface CompatConfirmProps { title: string; message: string; onConfirm?: () => void; onCancel?: () => void }
interface CompatAlertProps { title: string; message: string; busy?: boolean; busyText?: string; onConfirm?: () => void }
interface CompatCommand { name: string; run(context?: unknown): void | Promise<void> }

function createWizardApi(host: ReturnType<typeof createTuiHost>, context: OcpUiContext, renderer?: unknown) {
  let sessionId = context.sessionId
  const keyListeners = new Set<(event: unknown) => void>()
  const dialogStack = {
    replace(render: () => Dialog, onClose?: () => void) { host.replace(render(), onClose) },
    clear() { host.clear() },
    setSize(tier: 'medium' | 'large' | 'xlarge') { host.setSize(tier) },
  }
  return {
    ui: {
      dialog: dialogStack,
      DialogSelect(props: CompatSelectProps): Dialog {
        const mapped: DialogOption[] = props.options.map((option) => ({
          title: option.title,
          value: String(option.value),
          ...(option.description !== undefined ? { description: option.description } : {}),
          ...(option.category !== undefined ? { category: option.category } : {}),
        }))
        return {
          kind: 'select', title: props.title, placeholder: props.placeholder, options: mapped,
          current: props.current !== undefined ? String(props.current) : undefined,
          ...(props.renderFilter !== undefined ? { renderFilter: props.renderFilter } : {}),
          ...(props.skipFilter !== undefined ? { renderFilter: !props.skipFilter } : {}),
          ...(props.itemSpacing !== undefined ? { itemSpacing: props.itemSpacing } : {}),
          onSelect: (picked) => {
            const source = props.options[mapped.indexOf(picked)]
            if (source) props.onSelect?.(source)
          },
        }
      },
      DialogPrompt(props: CompatPromptProps): Dialog {
        return {
          kind: 'prompt', title: props.title, placeholder: props.placeholder, value: props.value ?? '',
          busy: props.busy, busyText: props.busyText,
          onConfirm: (value) => props.onConfirm?.(value),
          onCancel: props.onCancel ? () => props.onCancel?.() : undefined,
        }
      },
      DialogConfirm(props: CompatConfirmProps): Dialog {
        return { kind: 'confirm', title: props.title, message: props.message, onConfirm: () => props.onConfirm?.(), onCancel: props.onCancel }
      },
      DialogAlert(props: CompatAlertProps): Dialog {
        return {
          kind: 'alert',
          title: props.title,
          message: props.message,
          ...(props.busy !== undefined ? { busy: props.busy } : {}),
          ...(props.busyText !== undefined ? { busyText: props.busyText } : {}),
          onClose: props.onConfirm,
        }
      },
      toast(props: { title?: string; message: string }) { host.notify(props.message, props.title) },
    },
    keymap: {
      registerLayer(layer: { commands?: CompatCommand[] }) {
        for (const command of layer.commands ?? []) {
          host.register(command.name, (input) => { void command.run({ input }) })
        }
      },
      dispatchCommand(name: string) { return host.dispatch(name) },
    },
    route: { get current() { return { name: 'session', params: { sessionID: sessionId } } } },
    // Project wizard uses the native TUI's resolved workspace directory,
    // rather than process.cwd(), to avoid scaffolding the OCP install itself.
    state: { path: { directory: context.root ?? process.cwd() } },
    renderer: {
      // Real terminal height: the usage plugin derives its scrollable
      // viewport budget from it (0 disables scrolling and renders full view).
      get height() { return Number((renderer as unknown as { height?: number } | undefined)?.height) || 0 },
      keyInput: { on(_name: string, listener: (event: unknown) => void) { keyListeners.add(listener) }, off(_name: string, listener: (event: unknown) => void) { keyListeners.delete(listener) } },
    },
    kv: {
      get<T>(key: string, fallback?: T) { return host.kvGet<T>(key) ?? fallback },
      set() { /* wizard locales persist via ocp.json, not host kv */ },
    },
    // Provider/profile run without a server and fall back to file/public data.
    // Usage talks to the local OpenCode server through the same SDK client that
    // powers the in-app plugin, scoped to the invoking workspace.
    client: {
      global: { config: { async update() { return { error: new Error('standalone: no live opencode server') } } } },
      provider: { async list() { return { error: new Error('standalone: no live opencode server') } } },
      session: createUsageClient(context.usageScope === 'all' ? undefined : (context.root ?? process.cwd())).session,
    },
    setSessionId(next: string | undefined) { sessionId = next },
    /** Fire plugin-registered keypress interceptors (usage dimension keys /
     *  scrolling). True when one stopped propagation — the caller must then
     *  preventDefault so the focused renderable does not also react. */
    fireKey(event: { name?: string }): boolean {
      let stopped = false
      for (const listener of [...keyListeners]) listener({ name: event.name, stopPropagation: () => { stopped = true } })
      return stopped
    },
  }
}

async function registerWizard(plugin: TuiPluginModule, api: ReturnType<typeof createWizardApi>): Promise<void> {
  // The standalone host implements the wizard-used subset of TuiPluginApi;
  // host-only fields the wizards never touch are intentionally absent.
  await plugin.tui(api as unknown as Parameters<TuiPluginModule['tui']>[0], undefined, {
    id: plugin.id ?? 'standalone-wizard', source: 'internal', spec: 'standalone', target: 'standalone',
    first_time: 0, last_time: 0, time_changed: 0, load_count: 0, fingerprint: '', state: 'same',
  })
}

function Screen(props: { title: string; lines: () => string[]; onEnter?: () => void; onBack: () => void; footer: string }): JSX.Element {
  useKeyboard((key) => {
    if (isBareEscape(key) || (key.ctrl && key.name === 'c')) props.onBack()
    else if (key.name === 'return' || key.name === 'space') props.onEnter?.()
  })
  return <Modal title={props.title} footer={<>{props.footer}</>}>
    <For each={props.lines()}>{(line) => <text selectable fg={ocpTheme.text}>{line}</text>}</For>
  </Modal>
}

export function OcpApp(props: { initialRoute?: OcpRoute; context: OcpUiContext }): JSX.Element {
  const renderer = useRenderer()
  // Adopt the user's opencode theme (tui.jsonc `theme` + themes/*.json
  // hierarchy) before any element captures its colors; the renderer knows
  // the terminal's dark/light mode once the theme query resolved.
  applyOpenCodeTheme({
    mode: (renderer as unknown as { themeMode?: 'dark' | 'light' | null }).themeMode ?? undefined,
    cwd: props.context.root ?? process.cwd(),
  })
  const [route, setRoute] = createSignal<OcpRoute>(props.initialRoute ?? 'home')
  const exit = () => renderer.destroy()
  const back = () => route() === 'home' ? exit() : setRoute('home')
  /**
   * Shared UI→CLI install handoff (dashboard "save and install" AND the
   * wizard's quick install): the TUI persists its own options.jsonc selections,
   * reports the request (target dir, if non-default) via the OCP_UI_RESULT_FILE
   * sidecar, then exits with UI_INSTALL_EXIT so the parent CLI falls through to
   * the installer — one install path, with progress visible in the user's shell.
   */
  const requestInstall = (target?: string) => {
    const resultFile = process.env.OCP_UI_RESULT_FILE
    if (resultFile) {
      try { writeFileSync(resultFile, JSON.stringify({ action: 'install', ...(target ? { target } : {}) })) } catch { /* parent falls back to the default target */ }
    }
    process.exitCode = UI_INSTALL_EXIT
    renderer.destroy()
  }
  const repoDir = props.context.repoDir
  const host = createTuiHost()
  const wizardApi = createWizardApi(host, props.context, renderer)
  const providerReady = registerWizard(providerWizard, wizardApi)
  const profileReady = registerWizard(profileWizard, wizardApi)
  const projectReady = registerWizard(projectWizard, wizardApi)
  const usageReady = registerWizard(usagePlugin, wizardApi)

  // Global keypress forwarding: plugin interceptors (registered through the
  // keyInput facade above) run BEFORE the dialog layer, mirroring opencode's
  // ordering. A stopPropagation from the plugin keeps the focused renderable
  // (select lists) from also consuming the key.
  useKeyboard((key) => {
    if (wizardApi.fireKey({ name: key.name })) key.preventDefault?.()
  })

  // Global toast surface: rendered ONCE, top-right above the active route, so
  // every plugin toast (usage.noData, wizard errors, …) is visible on any
  // screen, dialog or picker — instead of relying on each Modal to opt in
  // with a local <ToastLine />.
  const ToastLine = () => (
    <Show when={host.toast()}>{(message: () => string) => (
      // opentui boxes default to column direction — justifyContent would act
      // on the vertical axis and the text would hug the LEFT edge. A row
      // direction makes the main axis horizontal so flex-end right-aligns.
      <box width="100%" flexDirection="row" justifyContent="flex-end" flexShrink={0}>
        <text fg={ocpTheme.muted}>{message()}</text>
      </box>
    )}</Show>
  )

  const DialogView = (viewProps: { dialog: Dialog }) => {
    const dialog = viewProps.dialog
    // Host-layer type-down filtering for select lists (mirrors opencode's
    // DialogSelect component, which the wizard plugins already talk to —
    // same contract: on by default, `renderFilter: false` opts out). The
    // kernel select keeps focus and its native arrow/return bindings;
    // printable keys + backspace are intercepted here instead — global key
    // listeners run BEFORE the focused renderable, so preventDefault stops
    // j/k from reaching the select's move bindings.
    const filterable = dialog.kind === 'select' && dialog.renderFilter !== false
    const [filter, setFilter] = createSignal('')
    const [confirmSelection, setConfirmSelection] = createSignal(0)
    // OpenTUI's select handles navigation, but terminal key naming differs
    // between Windows hosts (`enter` vs `return`). Keep the active row in the
    // compatibility host and explicitly activate it for both spellings.
    const [selectedRow, setSelectedRow] = createSignal(0)
    // The compat host now renders select lists itself (kernel `<select>` drew
    // descriptions on a second line; we want opencode's inline title + muted
    // description). So navigation, scrolling and the active-row highlight all
    // live here: `selectedRow` is the cursor, `scrollOffset` the first visible
    // row, and `listCap` the number of rows that fit the panel.
    const [scrollOffset, setScrollOffset] = createSignal(0)
    // Fit the list naturally; scroll only when the terminal is too short. The
    // filter line (when shown) costs two more rows of vertical budget, and the
    // panel's inner top/bottom padding (SELECT_PANEL_PAD) reserves two more.
    // Each row is exactly one cell line, so the line budget is also the row count.
    const listCap = () => Math.max(4, ((Number((renderer as unknown as { height?: number }).height) || 46) - 14) - (filterable ? 2 : 0) - SELECT_PANEL_PAD * 2)
    // Keep the cursor inside the window after a move.
    const revealRow = (index: number) => setScrollOffset((o) => {
      const visible = listCap()
      if (index < o) return index
      if (index >= o + visible) return index - visible + 1
      return o
    })

    const filteredOptions = (): DialogOption[] => {
      if (dialog.kind !== 'select') return []
      const needle = filter().trim().toLowerCase()
      if (!filterable || !needle) return dialog.options
      return dialog.options.filter((option) =>
        [option.title, option.description ?? '', option.category ?? ''].some((hay) => hay.toLowerCase().includes(needle)))
    }

    // Built from the FILTERED options so categories collapse as the filter
    // narrows the list.
    const buildRows = (): SelectRow[] => categoryRows(filteredOptions(), { spacers: true })

    useKeyboard((key) => {
      // Busy alerts (showBusyModal wrappers around async ops) swallow every
      // key until the operation resolves and the wizard replaces the frame.
      // Enter/Esc would otherwise dismiss the placeholder, leaving the async
      // op's setTimeout-driven result alert to land on an empty stack.
      if (dialog.kind === 'alert' && dialog.busy) return
      if (!isBareEscape(key)) {
        // Windows Terminal / conhost commonly report Enter as `linefeed`; the
        // synthetic OpenTUI test host reports it as `return`. Support both,
        // plus numpad Enter (`enter`), in the compatibility layer.
        if (dialog.kind === 'select' && (key.name === 'return' || key.name === 'linefeed' || key.name === 'enter' || key.name === 'space')) {
          key.preventDefault?.()
          const rows = buildRows()
          const selected = rows[selectedRow()]
          // Category headers are presentation rows. If focus lands on one,
          // activate the next real option rather than silently doing nothing.
          const target = selected?.option ?? rows.slice(selectedRow() + 1).find((row) => row.option)?.option ?? rows.slice(0, selectedRow()).reverse().find((row) => row.option)?.option
          if (target) dialog.onSelect(target)
          return
        }
        // Up/Down move the cursor through the custom list, skipping category
        // headers in the movement direction (the kernel select used to do
        // this; now the compat host owns navigation).
        if (dialog.kind === 'select' && (key.name === 'up' || key.name === 'down')) {
          key.preventDefault?.()
          const list = buildRows()
          if (list.length === 0) return
          const dir: 1 | -1 = key.name === 'down' ? 1 : -1
          const next = selectedRow() + dir
          if (next < 0 || next >= list.length) return
          const landed = skipHeaderRow(list, next, dir)
          setSelectedRow(landed)
          revealRow(landed)
          return
        }
        // Confirm dialogs use custom, vertically-spaced option rows rather
        // than the kernel select. Handle their keys in this dialog-level
        // listener: it is registered before child renderables and therefore
        // cannot be shadowed by a sibling/global listener.
        if (dialog.kind === 'confirm') {
          if (key.name === 'up' || key.name === 'down') { key.preventDefault?.(); setConfirmSelection((index) => index === 0 ? 1 : 0); return }
          if (key.name === 'return' || key.name === 'enter' || key.name === 'linefeed' || key.name === 'space') {
            key.preventDefault?.()
            if (confirmSelection() === 0) dialog.onConfirm()
            else dialog.onCancel?.()
            return
          }
        }
        // DialogAlert: opencode dismisses on Enter (fires onConfirm, mapped to
        // dialog.onClose by the compat api) AND on Esc (host.close path below).
        // The standalone host previously wired only Esc — Enter was a no-op
        // on every wizard result screen (init/update/save/sync/index reports).
        // showAlertModal's `navigated` flag guards the close callback against
        // double-firing when both keys land in the same tick.
        if (dialog.kind === 'alert' && (key.name === 'return' || key.name === 'enter' || key.name === 'linefeed' || key.name === 'space')) {
          key.preventDefault?.()
          dialog.onClose?.()
          host.close()
          return
        }
        if (!filterable) return
        if (key.name === 'backspace') { key.preventDefault?.(); setFilter((f) => f.slice(0, -1)); return }
        const ch = key.sequence
        if (!key.ctrl && !key.meta && !key.option && typeof ch === 'string' && ch.length === 1 && ch >= ' ') {
          key.preventDefault?.()
          setFilter((f) => f + ch)
        }
        return
      }
      // Mirrors the host dialogs: explicit cancel callbacks take Esc on
      // prompt/confirm frames; everything else unwinds via the stack onClose.
      if (dialog.kind === 'prompt' && dialog.onCancel) { dialog.onCancel(); host.clear(); return }
      if (dialog.kind === 'confirm' && dialog.onCancel) { dialog.onCancel(); host.clear(); return }
      host.close()
    })

    if (dialog.kind === 'select') {
      // Memo: the branch body runs once per dialog — only the JSX expressions
      // re-evaluate, so the row list must be reactive for the filter to narrow it.
      const rows = createMemo(buildRows)
      // Headers are presentation-only rows: focus must land on the first real
      // option (or the `current` pick), mirroring the host's non-selectable headers.
      const firstReal = rows().findIndex((row) => row.option)
      const currentIdx = dialog.current !== undefined ? rows().findIndex((row) => row.option?.value === dialog.current) : -1
      const initial = currentIdx >= 0 ? currentIdx : Math.max(0, firstReal)
      setSelectedRow(initial)
      revealRow(initial)
      // Filtering reshapes the list — land the selection on the first real
      // option (or the `current` pick) of the NEW list, like opencode does.
      createEffect(on(filter, () => {
        if (!filterable) return
        const next = buildRows()
        const cur = dialog.current !== undefined ? next.findIndex((row) => row.option?.value === dialog.current) : -1
        const first = next.findIndex((row) => row.option)
        setScrollOffset(0)
        setSelectedRow(cur >= 0 ? cur : Math.max(0, first))
      }, { defer: true }))
      // Windowed slice actually painted; `listCap` bounds the panel height and
      // `scrollOffset` keeps the cursor visible (reimplemented from the kernel
      // select's internal scrolling now that we draw the rows ourselves).
      const visible = () => rows().slice(scrollOffset(), scrollOffset() + listCap())
      return <Modal title={dialog.title} size={host.size()} footer={<>{(!filterable && dialog.placeholder) ? `${dialog.placeholder}\n` : ''}↑/↓ selects · Enter opens · Esc returns · Right-click copies</>}>
        <Show when={filterable}>
          <text fg={filter() ? ocpTheme.text : ocpTheme.muted}>{filter() ? `⌕ ${filter()}▏` : `⌕ ${dialog.placeholder ?? 'Type to filter'}`}</text>
        </Show>
        <Show when={filterable && rows().length === 0}>
          <text fg={ocpTheme.muted}>No matches</text>
        </Show>
        <SelectList rows={visible()} offset={scrollOffset()} selected={selectedRow} />
      </Modal>
    }
    const ConfirmOptions = (confirmDialog: Extract<Dialog, { kind: 'confirm' }>) => {
      const options = () => [confirmDialog.confirmLabel ?? 'Confirm', confirmDialog.cancelLabel ?? 'Cancel']
      // Mirror the compact select panel: same fill, a leading blank row, one
      // text row per option and a trailing gap after each (including the last)
      // so head and foot gaps inside the panel stay symmetric.
      return <box backgroundColor={ocpTheme.panel}>
        <box height={1} />
        <For each={options()}>{(label, index) => <>
          <box flexDirection="row" height={1} justifyContent="flex-start" alignItems="center" paddingLeft={1} backgroundColor={index() === confirmSelection() ? ocpTheme.accent : ocpTheme.panel}>
            <text fg={index() === confirmSelection() ? ocpTheme.surface : ocpTheme.text}>{`${index() === confirmSelection() ? '▶ ' : '  '}${label}`}</text>
          </box>
          <box height={1} />
        </>}</For>
      </box>
    }
    if (dialog.kind === 'confirm') return <Modal title={dialog.title} size={host.size()} footer={dialog.footer ?? 'Enter confirms · Esc cancels'}>
      <text selectable marginBottom={1} fg={ocpTheme.text}>{dialog.message}</text>
      <ConfirmOptions {...dialog} />
    </Modal>
    if (dialog.kind === 'alert') return <Modal title={dialog.title} size={host.size()} footer={dialog.busy ? `⏳ ${dialog.busyText ?? 'Working…'}` : 'Enter or Esc returns · Right-click copies'}>
      <Show when={dialog.busy}><text fg={ocpTheme.muted}>⏳</text><text> </text></Show>
      <text selectable fg={ocpTheme.text}>{dialog.message}</text>
    </Modal>
    return <Modal title={dialog.title} size={host.size()} footer={dialog.busy ? (dialog.busyText ?? 'Working…') : 'Enter confirms · Esc cancels'}>
      <input focused value={dialog.value ?? ''} placeholder={dialog.placeholder ?? ''}
        backgroundColor="transparent" textColor={ocpTheme.text}
        onSubmit={(value) => { if (typeof value === 'string' && !dialog.busy) dialog.onConfirm(value) }} />
    </Modal>
  }

  /**
   * Wizard route: opens the plugin's root dialog once its registration
   * resolves; when the stack empties (root Esc, apply/reset flows), shows a
   * closed screen with Enter to reopen and Esc to leave the wizard route.
   */
  const WizardRoute = (routeProps: { title: string; ready: Promise<void>; command: string }) => {
    const [opened, setOpened] = createSignal(false)
    // Root-level Esc (no frame onClose) dismisses the stack; the route then
    // shows the closed screen — same shape as opencode returning to prompt.
    host.setDefaultOnClose(() => {})
    void routeProps.ready.then(() => {
      if (!opened()) { host.dispatch(routeProps.command); setOpened(true) }
    })
    const reopen = () => host.dispatch(routeProps.command)
    return <Show when={host.dialog()} keyed fallback={
      <Screen title={`OpenCode Prime — ${routeProps.title}`} onBack={exit} onEnter={reopen}
        footer="Enter reopens the wizard · Esc exits"
        lines={() => [opened() ? 'Wizard closed.' : 'Loading wizard…']} />
    }>{(current: Dialog) => <DialogView dialog={current} />}</Show>
  }

  /** Standalone facade for the existing /usage plugin. The report rendering,
   * dimensions, pricing and scrolling all remain owned by plugins/tui/usage. */
  const UsageRoute = (routeProps: { ready: Promise<void>; sessionId?: string }) => {
    const [sessions, setSessions] = createSignal<Array<{ id: string; title?: string; time?: { updated?: number } }>>()
    const [error, setError] = createSignal('')
    const [requestedSessionValid, setRequestedSessionValid] = createSignal(!routeProps.sessionId)
    const open = (sessionID: string) => {
      wizardApi.setSessionId(sessionID)
      // `usage.show` has dimension-style arguments only (all/agent/model),
      // not session IDs. The selected id is exposed through `route.current`,
      // exactly like OpenCode's own /usage command. Dispatch with no argument
      // to request the plugin's default session view.
      void routeProps.ready.then(() => host.dispatch('usage.show'))
    }
    // The session picker (and loading/error fallbacks) live OUTSIDE the host
    // dialog stack, so DialogView's Esc handling never sees them. Esc exits —
    // same contract as the picker footer. Guarded on !host.dialog() so closing
    // the report dialog (DialogView's Esc) is not double-handled: this
    // listener registers BEFORE DialogView's, while the dialog is still open.
    useKeyboard((key) => {
      if (!host.dialog() && (isBareEscape(key) || (key.ctrl && key.name === 'c'))) exit()
    })
    if (routeProps.sessionId && !requestedSessionValid() && !error()) {
      // Do not let a typo turn into the usage plugin's generic empty-data
      // toast. Check the server's canonical session endpoint first, then open
      // the reusable report only when the requested id really exists.
      void createUsageClient(props.context.usageScope === 'all' ? undefined : (props.context.root ?? process.cwd())).session.get({ sessionID: routeProps.sessionId })
        .then((result) => {
          if (result.error || !result.data) throw result.error ?? new Error('Session not found')
          setRequestedSessionValid(true)
          open(routeProps.sessionId!)
        })
        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
    }
    else if (!sessions() && !error()) {
      // --all: the plain /session list defaults to the SERVER's own directory
      // (verified: no directory param → server-cwd scope), so cross-project
      // listing needs the experimental endpoint, which is explicitly
      // "across projects". roots=true keeps the picker to top-level sessions
      // (the report walks each session's subtree itself).
      const scopeAll = props.context.usageScope === 'all'
      const client = createUsageClient(scopeAll ? undefined : (props.context.root ?? process.cwd()))
      const list = scopeAll
        ? client.experimental.session.list({ roots: true, limit: 200 })
        : client.session.list({ roots: true })
      void list
        .then((result) => {
          if (result.error) throw result.error
          setSessions((result.data ?? []).sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0)))
        })
        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
    }
    return <Show when={host.dialog()} keyed fallback={
      <Show when={routeProps.sessionId} fallback={
        <Show when={error()} fallback={
          <Show when={sessions()} fallback={<Screen title="OpenCode Prime — Usage" onBack={exit} footer="Loading sessions…" lines={() => ['Connecting to the local OpenCode server…']} />}>
            {(items) => {
              // Type-to-filter (mirrors DialogView's select filter): printable
              // keys + backspace are intercepted BEFORE the focused select.
              const [filter, setFilter] = createSignal('')
              const filtered = (): Array<{ id: string; title?: string; time?: { updated?: number } }> => {
                const needle = filter().trim().toLowerCase()
                if (!needle) return items()
                return items().filter((item) =>
                  [item.title ?? '', item.id].some((hay) => hay.toLowerCase().includes(needle)))
              }
              useKeyboard((key) => {
                if (key.name === 'backspace') { key.preventDefault?.(); setFilter((f) => f.slice(0, -1)); return }
                const ch = key.sequence
                if (!key.ctrl && !key.meta && !key.option && typeof ch === 'string' && ch.length === 1 && ch >= ' ') {
                  key.preventDefault?.()
                  setFilter((f) => f + ch)
                }
              })
              // Group by last-activity date (Today / Yesterday / 2 days ago /
              // Earlier) via the shared category-header emulation. Built from
              // the FILTERED sessions so groups collapse as the filter narrows.
              const rows = createMemo(() => categoryRows(filtered().map((item) => ({
                title: item.title || 'Untitled session',
                value: item.id,
                description: item.id,
                category: dateBucket(item.time?.updated),
              }))))
              let pickerRef: { setSelectedIndex?: (i: number) => void } | null = null
              let lastIndex = 0
              // Filtering reshapes the list — land the selection on the first
              // real session of the NEW list, like DialogView does.
              createEffect(on(filter, () => {
                const next = rows()
                const first = skipHeaderRow(next, 0, 1)
                lastIndex = first
                pickerRef?.setSelectedIndex?.(first)
              }, { defer: true }))
              return <Modal title="OpenCode Prime — Usage" footer="↑/↓ selects · Enter opens · Esc exits">
                <text fg={filter() ? ocpTheme.text : ocpTheme.muted}>{filter() ? `⌕ ${filter()}▏` : `⌕ ${tr('usage.picker.filterHint')}`}</text>
                <Show when={items().length > 0} fallback={<text fg={ocpTheme.muted}>No sessions found for this workspace.</text>}>
                  <Show when={rows().length > 0} fallback={<text fg={ocpTheme.muted}>No matches</text>}>
                    <select focused height={Math.max(2, Math.min(rows().length * 2, 24))} backgroundColor={ocpTheme.surface} textColor={ocpTheme.text} descriptionColor={ocpTheme.muted} selectedBackgroundColor={ocpTheme.accent} selectedTextColor={ocpTheme.surface}
                      options={rows().map(({ name, value, description }) => ({ name, value, description }))}
                      ref={(el: { setSelectedIndex?: (i: number) => void } | null) => {
                        pickerRef = el
                        // Land on the first real session, never the header row.
                        const first = skipHeaderRow(rows(), 0, 1)
                        lastIndex = first
                        if (first > 0) queueMicrotask(() => el?.setSelectedIndex?.(first))
                      }}
                      onChange={(index: number) => {
                        const direction: 1 | -1 = index >= lastIndex ? 1 : -1
                        const target = skipHeaderRow(rows(), index, direction)
                        lastIndex = target
                        if (target !== index) pickerRef?.setSelectedIndex?.(target)
                      }}
                      onSelect={(_index: number, picked: { value?: string } | null) => {
                        // Category headers are presentation rows — activating one
                        // falls through to the next real option (DialogView policy).
                        const idx = rows().findIndex((row) => row.value === picked?.value)
                        const target = rows()[idx]?.option ?? rows().slice(idx + 1).find((row) => row.option)?.option
                        if (target) open(target.value)
                      }} />
                  </Show>
                </Show>
              </Modal>
            }}
          </Show>
        }>{(message) => <Screen title="OpenCode Prime — Usage" onBack={exit} footer="Esc exits" lines={() => [`Could not list sessions: ${message()}`]} />}</Show>
      }>
        <Show when={error()} fallback={<Screen title="OpenCode Prime — Usage" onBack={exit} footer="Checking session…" lines={() => [`Session: ${routeProps.sessionId}`]} />}>
          {(message) => <Screen title="OpenCode Prime — Usage" onBack={exit} footer="Esc exits" lines={() => [`Session '${routeProps.sessionId}' was not found or cannot be read.`, message()]} />}
        </Show>
      </Show>
    }>{(dialog: Dialog) => <DialogView dialog={dialog} />}</Show>
  }

  const Dashboard = () => {
    const target = getDefaultTargetDir()
    const optionsPath = path.join(repoDir, 'install', 'options.jsonc')
    const schema = parseDynamicOptionsSchema(Bun.file(optionsPath).size ? require('node:fs').readFileSync(optionsPath, 'utf8') : '{}', repoDir)
    const effective = loadEffectiveOptions(repoDir, target)
    const tools = loadToolRegistry(repoDir)
    const locales = getAvailableLocales(repoDir)
    const [agent, setAgent] = createSignal(effective.default_agent ?? schema.defaultAgent.value)
    const [tuiMode, setTuiMode] = createSignal<'direct' | 'herdr' | 'luvus'>(effective.tui_mode ?? 'herdr')
    const [globalCommands, setGlobalCommands] = createSignal(effective.global_commands !== false)
    const [toolState, setToolState] = createSignal<Record<string, boolean>>(Object.fromEntries(Object.keys(tools?.tools ?? {}).map((key) => [key, effective.tools?.[key] !== false])))
    const [mcpState, setMcpState] = createSignal<Record<string, boolean>>(Object.fromEntries(schema.mcpItems.map((item) => [item.key, effective.mcp?.[item.key] ?? item.value])))
    const [pluginState, setPluginState] = createSignal<Record<string, boolean>>(Object.fromEntries(schema.pluginItems.map((item) => [item.key, effective.plugin?.[item.key] ?? item.value])))
    const preferredLocale = getPreferredLocaleCode()
    const initialLocale = locales.some((locale) => locale.code === preferredLocale) ? preferredLocale : locales[0]?.code ?? 'en'
    const [localeCode, setLocaleCode] = createSignal(initialLocale)
    const [status, setStatus] = createSignal('')
    const [busy, setBusy] = createSignal(false)
    const [activeTab, setActiveTab] = createSignal(0)
    const [focusArea, setFocusArea] = createSignal<'rail' | 'panel'>('rail')
    const [panelIndex, setPanelIndex] = createSignal(0)
    const text = () => loadLocale(repoDir, localeCode())
    const copy = (key: keyof ReturnType<typeof text>, fallback: string) => String(text()[key] ?? fallback)
    const tabs = () => [
      copy('dashboardTabBasic', 'Basic'), copy('dashboardTabTools', 'Tools'), copy('dashboardTabMcp', 'MCP'),
      copy('dashboardTabPlugins', 'Plugins'), copy('dashboardTabReview', 'Review'),
    ]
    const persist = () => updateOptionsJsoncInPlace(path.join(target, 'options.jsonc'), { defaultAgent: agent(), tuiMode: tuiMode(), tools: toolState(), globalCommands: globalCommands(), mcps: mcpState(), plugins: pluginState() })
    const install = () => {
      if (busy()) return
      // Persist inside the TUI, then leave it before the parent CLI invokes
      // the installer (shared requestInstall handoff). This restores the
      // terminal so installation progress and the final result are visible in
      // the normal shell environment.
      persist()
      requestInstall()
    }
    type Row = { value: string; name: string; description: string; heading?: boolean }
    const confirmSave = (withInstall: boolean) => {
      host.replace({
        kind: 'confirm',
        title: withInstall ? copy('saveAndInstallBtn', 'Save and install') : copy('saveOnlyBtn', 'Save configuration'),
        message: withInstall ? copy('saveAndInstallHint', 'Save these settings and install OpenCode Prime?') : `${copy('saveOnlyHint', 'Write these settings to')} ${target}?`,
        confirmLabel: copy('confirmBtn', 'Confirm'),
        cancelLabel: copy('cancelBtn', 'Cancel'),
        footer: copy('confirmFooter', 'Enter confirms · Esc cancels'),
        onConfirm: () => { host.clear(); if (withInstall) install(); else { persist(); setStatus(`${copy('saveOptionsSuccess', 'Saved configuration to')} ${target}`) } },
        onCancel: () => host.clear(),
      })
    }
    const enabled = (state: Record<string, boolean>) => Object.values(state).filter(Boolean).length
    const changeCount = () => enabled(toolState()) + enabled(mcpState()) + enabled(pluginState())
    const rows = (): Row[] => {
      const section = activeTab()
      if (section === 0) return [
        { value: 'language', name: `${copy('switchLanguageLabel', 'Language')}: ${locales.find((locale) => locale.code === localeCode())?.name ?? localeCode()}`, description: copy('switchLanguageHint', 'Change UI display language') },
        { value: 'agent', name: `${copy('primaryAgentLabel', 'Primary agent')}: ${agent()}`, description: copy('primaryAgentHint', 'Choose the default primary agent') },
        { value: 'tui', name: `${copy('tuiModeLabel', 'TUI mode')}: ${tuiMode()}`, description: copy('tuiModeHint', 'Choose direct or herdr mode') },
        { value: 'global', name: `${copy('globalCommandsLabel', 'Global commands')}: ${globalCommands() ? copy('enabled', 'enabled') : copy('disabled', 'disabled')}`, description: copy('globalCommandsHint', 'Register command shims') },
      ]
      if (section === 1) return Object.keys(tools?.tools ?? {}).map((key) => ({ value: `tool:${key}`, name: `${toolState()[key] ? '✓' : '○'} ${text().toolLabels?.[key]?.label ?? key}`, description: text().toolLabels?.[key]?.hint ?? String(tools?.tools?.[key]?.description ?? '') }))
      if (section === 2) return schema.mcpItems.map((item) => ({ value: `mcp:${item.key}`, name: `${mcpState()[item.key] ? '✓' : '○'} ${text().mcpLabels?.[item.key]?.label ?? item.key}`, description: text().mcpLabels?.[item.key]?.hint ?? item.hint }))
      if (section === 3) return schema.pluginItems.map((item) => ({ value: `plugin:${item.key}`, name: `${pluginState()[item.key] ? '✓' : '○'} ${text().pluginLabels?.[item.key]?.label ?? item.key}`, description: text().pluginLabels?.[item.key]?.hint ?? item.hint }))
      return [
        { value: 'save', name: copy('saveOnlyBtn', 'Save configuration'), description: copy('saveOnlyHint', 'Write these settings to') },
        { value: 'install', name: copy('saveAndInstallBtn', 'Save and install'), description: copy('saveAndInstallHint', 'Save these settings and install OpenCode Prime?') },
      ]
    }
    const cycleLocale = () => {
      const index = locales.findIndex((locale) => locale.code === localeCode())
      const next = locales[(index + 1) % locales.length]
      if (!next) return
      setLocaleCode(next.code)
      setPreferredLocaleCode(next.code)
      setStatus(loadLocale(repoDir, next.code).switchLangHint)
    }
    const select = (picked: { value?: string } | null) => {
      const value = picked?.value
      if (!value || busy()) return
        if (value === 'language') cycleLocale()
        else if (value === 'agent') host.replace({ kind: 'select', title: copy('primaryAgentLabel', 'Primary agent'), placeholder: copy('primaryAgentHint', 'Choose the default primary agent'), current: agent(), options: schema.defaultAgent.choices.map((choice) => ({ title: text().agentLabels?.[choice]?.label ?? choice, value: choice, description: text().agentLabels?.[choice]?.hint ?? schema.defaultAgent.hint })), onSelect: (option) => { setAgent(option.value); host.clear() } })
        else if (value === 'tui') host.replace({ kind: 'select', title: copy('tuiModeLabel', 'TUI mode'), placeholder: copy('tuiModeHint', 'Choose how OpenCode opens its TUI'), current: tuiMode(), renderFilter: false, options: [{ title: 'Direct', value: 'direct', description: 'Open the TUI directly in the current shell' }, { title: 'Herdr', value: 'herdr', description: 'Open through a Herdr workspace' }, { title: 'Luvus', value: 'luvus', description: 'Open through a Luvus workspace with agent controls' }], onSelect: (option) => { setTuiMode(option.value === 'luvus' ? 'luvus' : option.value === 'herdr' ? 'herdr' : 'direct'); host.clear() } })
        else if (value === 'global') { const next = !globalCommands(); setGlobalCommands(next); setStatus(`${copy('globalCommandsLabel', 'Global commands')} ${next ? copy('enabled', 'enabled') : copy('disabled', 'disabled')}.`) }
        else if (value.startsWith('tool:')) { const key = value.slice(5); const next = !toolState()[key]; setToolState({ ...toolState(), [key]: next }); setStatus(`${key} ${next ? copy('enabled', 'enabled') : copy('disabled', 'disabled')}.`) }
        else if (value.startsWith('mcp:')) { const key = value.slice(4); const next = !mcpState()[key]; setMcpState({ ...mcpState(), [key]: next }); setStatus(`${key} ${next ? copy('enabled', 'enabled') : copy('disabled', 'disabled')}.`) }
        else if (value.startsWith('plugin:')) { const key = value.slice(7); const next = !pluginState()[key]; setPluginState({ ...pluginState(), [key]: next }); setStatus(`${key} ${next ? copy('enabled', 'enabled') : copy('disabled', 'disabled')}.`) }
       else if (value === 'save') confirmSave(false)
       else if (value === 'install') confirmSave(true)
    }
    const listHeight = () => {
      const terminalHeight = Number((renderer as unknown as { height?: number }).height) || 46
      return Math.max(2, Math.min(rows().length * 3, terminalHeight - 14))
    }
    const activateTab = (index: number) => {
      const next = Math.max(0, Math.min(index, tabs().length - 1))
      setActiveTab(next)
      setPanelIndex(0)
    }
    useKeyboard((key) => {
      // Ctrl+T / Ctrl+S reach us in three shapes: the legacy control byte
      // (0x14/0x13 → name 't'/'s' + ctrl), the kitty disambiguated form
      // (CSI 116;5u — also parsed as name + ctrl), and the kitty
      // ALTERNATE-KEY form (CSI 27;5;116u) where OpenTUI reports name
      // 'escape' and the base char survives only in `sequence`. Accept all
      // three; otherwise Ctrl+T misses this binding and lands on the
      // escape branch below, leaving the dashboard instead of installing.
      // Ctrl+T replaces Ctrl+A: A and S are adjacent on QWERTY, so a thumb
      // drift would silently land on "save only" instead of "save and
      // install". T is on the top row, far from S, with a clean control
      // byte (0x14) that no major terminal misroutes to Tab.
      const ctrlChar = (ch: string, controlByte: string) => (key.ctrl || key.meta) && (key.name === ch || key.sequence === ch || key.raw === controlByte)
      if (ctrlChar('t', '\u0014')) { key.preventDefault?.(); confirmSave(true); return }
      if (ctrlChar('s', '\u0013')) { key.preventDefault?.(); confirmSave(false); return }
      if (host.dialog()) return
      if (isBareEscape(key)) { setRoute('wizard'); return }
      if (key.name === 'l') { cycleLocale(); return }
      if (focusArea() === 'rail') {
        if (key.name === 'left') { key.preventDefault?.(); activateTab(activeTab() - 1); return }
        if (key.name === 'right') { key.preventDefault?.(); activateTab(activeTab() + 1); return }
        if (key.name === 'down' || key.name === 'return' || key.name === 'tab') { key.preventDefault?.(); setFocusArea('panel'); return }
        return
      }
      // Review tab: the panel is a static summary (no select to own Enter), so
      // a second Enter on the focused panel equals the install action —
      // rail Enter → panel → Enter opens the save-and-install confirmation.
      if (activeTab() === 4 && (key.name === 'return' || key.name === 'enter' || key.name === 'linefeed')) {
        key.preventDefault?.()
        confirmSave(true)
        return
      }
      if (key.name === 'left' || key.name === 'tab' || (key.name === 'up' && panelIndex() === 0)) {
        key.preventDefault?.()
        setFocusArea('rail')
      }
    })
    const content = () => <Modal title={`OpenCode Prime — ${copy('dashboardTitle', 'Dashboard')}`} footer={<>{copy('footerHelp', '↑/↓ selects · Enter opens choices or toggles · L language · Ctrl+T install · Esc exits')}{status() ? `\n${status()}` : ''}</>}>
      <box flexDirection="column">
        <text marginBottom={1} fg={focusArea() === 'rail' ? ocpTheme.accent : ocpTheme.muted}>{focusArea() === 'rail' ? copy('dashboardTabsHint', 'Tabs · ←/→') : copy('dashboardTabsLabel', 'Tabs')}</text>
        <box flexDirection="row" height={3}>
          <For each={tabs()}>{(name, index) => <box flexGrow={1} height="100%" justifyContent="center" alignItems="center" backgroundColor={index() === activeTab() ? ocpTheme.accent : ocpTheme.surface}>
            <text fg={index() === activeTab() ? ocpTheme.surface : ocpTheme.text}>{name}</text>
          </box>}</For>
        </box>
        <box flexDirection="column" paddingTop={1}>
          <Show when={activeTab() === 4} fallback={<select focused={focusArea() === 'panel'} selectedIndex={panelIndex()} height={listHeight()} showScrollIndicator={rows().length * 3 > listHeight()} backgroundColor={ocpTheme.surface} focusedBackgroundColor={ocpTheme.panel} textColor={ocpTheme.text} descriptionColor={ocpTheme.muted} selectedBackgroundColor={ocpTheme.accent} selectedTextColor={ocpTheme.surface} selectedDescriptionColor={ocpTheme.surface} itemSpacing={1} keyBindings={[{ name: 'space', action: 'select-current' }]} options={rows()} onChange={(index: number) => setPanelIndex(index)} onSelect={(_index: number, picked: { value?: string } | null) => select(picked)} />}>
            <box flexDirection="column" gap={1}>
              <text fg={ocpTheme.text}>{copy('dashboardTargetLabel', 'Installation target')}</text>
              <text selectable fg={ocpTheme.muted}>{target}</text>
              <text fg={ocpTheme.text}>{copy('dashboardChangeSummaryLabel', 'Change summary')}</text>
              <text selectable fg={ocpTheme.muted}>{copy('dashboardEnabledSummary', '{count} enabled integrations will be saved.').replace('{count}', String(changeCount()))}</text>
              <text selectable fg={ocpTheme.muted}>{copy('dashboardReviewHint', 'Use the shortcuts below to save or install.')}</text>
            </box>
          </Show>
        </box>
      </box>
      <box flexDirection="column" marginTop={1}>
        <text fg={ocpTheme.text}>{busy() ? copy('installingSpinner', 'Installing…') : `${copy('saveOnlyBtn', 'Save configuration')} Ctrl+S · ${copy('saveAndInstallBtn', 'Save and install')} Ctrl+T`}</text>
      </box>
    </Modal>
    return <Show when={host.dialog()} keyed fallback={content()}>{(dialog: Dialog) => <DialogView dialog={dialog} />}</Show>
  }
  const MainWizard = () => {
    const locales = getAvailableLocales(repoDir)
    const preferredLocale = getPreferredLocaleCode()
    const defaultLocale = locales.some((locale) => locale.code === preferredLocale) ? preferredLocale : locales[0]?.code ?? 'en'
    const [localeCode, setLocaleCode] = createSignal(defaultLocale)
    const [message, setMessage] = createSignal('')
    const [busy, setBusy] = createSignal(false)
    const text = () => loadLocale(repoDir, localeCode())
    const copy = (key: keyof ReturnType<typeof text>, fallback: string) => String(text()[key] ?? fallback)
    const target = () => getDefaultTargetDir()
    const showStatus = () => {
      const status = executeStatus(repoDir)
      host.replace({ kind: 'alert', title: copy('configStatusDetail', 'Configuration status'), message: `Repo version: ${status.repoVersion}\nInstalled version: ${status.installedVersion ?? 'None'}\nTarget: ${status.targetDir}\nStatus: ${status.isUpToDate ? 'Up to date' : 'Needs update'}\nTracked files: ${status.shippedFilesCount}` })
    }
    const register = () => {
      const result = runGlobalRegistration(repoDir)
      setMessage(result.pathSuccess ? result.pathChanged ? copy('pathAddedMsg', 'Global commands registered and PATH updated.').replace('{binDir}', result.binDir) : copy('pathPresentMsg', 'Global commands registered.').replace('{binDir}', result.binDir) : copy('pathFailedMsg', 'Global commands registered; update PATH manually.').replace('{binDir}', result.binDir))
    }
    const quickInstall = (installTarget: string, globalCommands: boolean) => {
      if (busy()) return
      setBusy(true)
      try {
        // The wizard's only delta vs the shared install path: persist the
        // global-commands choice. Installation itself is handed off to the
        // parent CLI (requestInstall) — same path as the dashboard, so
        // executeInstall + global registration + surface checks run exactly
        // once, in the user's shell.
        const previous = loadEffectiveOptions(repoDir, installTarget).global_commands !== false
        if (globalCommands !== previous) updateOptionsJsoncInPlace(path.join(installTarget, 'options.jsonc'), { globalCommands })
      } catch (error) {
        setMessage(formatI18n(copy('installFailed', 'Installation failed: {error}'), { error: error instanceof Error ? error.message : String(error) }))
        setBusy(false)
        return
      }
      requestInstall(installTarget)
    }
    const promptQuickInstall = () => host.replace({ kind: 'prompt', title: copy('quickInstallLabel', 'Quick install'), placeholder: target(), value: target(), onConfirm: (value) => {
      const installTarget = path.resolve(value || target())
      const enabled = loadEffectiveOptions(repoDir, installTarget).global_commands !== false
      host.replace({ kind: 'select', title: copy('stepRegisterPrompt', 'Register global commands?').replace('{binDir}', getDefaultBinDir()), placeholder: copy('stepRegisterNote', 'Choose whether to register ocp and opencode-prime commands.'), current: enabled ? 'yes' : 'no', renderFilter: false, options: [{ title: copy('registerGlobalYes', 'Register global commands'), value: 'yes' }, { title: copy('registerGlobalNo', 'Skip global commands'), value: 'no' }], onSelect: (option) => { host.clear(); quickInstall(installTarget, option.value === 'yes') } })
    }, onCancel: () => host.clear() })
    const reset = () => host.replace({ kind: 'confirm', title: copy('initLabel', 'Reset configuration').replace('{target}', target()), message: copy('confirmResetPrompt', 'Reset this target?').replace('{target}', target()), onConfirm: () => { host.clear(); const result = executeInit(repoDir, { action: 'init', force: true, noBackup: false, yes: true, isInteractive: true, projectMode: 'auto' }); setMessage(formatI18n(copy('resetResult', 'Cleared {target}. Backup: {backup}.'), { target: result.targetDir, backup: result.backupPath ?? 'None' })) }, onCancel: () => host.clear() })
    const uninstall = () => host.replace({ kind: 'confirm', title: copy('uninstallLabel', 'Uninstall'), message: copy('confirmUninstallPrompt', 'Uninstall managed files?').replace('{target}', target()), onConfirm: () => { host.clear(); const result = executeUninstall(repoDir, { action: 'uninstall', force: true, noBackup: false, yes: true, isInteractive: true, projectMode: 'auto' }); setMessage(formatI18n(copy('uninstallResult', 'Removed {count} files from {target}.'), { count: result.removedCount, target: result.targetDir })) }, onCancel: () => host.clear() })
    const menu = () => {
      const installed = Boolean(executeStatus(repoDir).installedVersion)
      const registered = isShimRegistered()
      const rows = [
        { value: 'dashboard', name: copy('dashboardLabel', 'Open dashboard'), description: copy('dashboardHint', 'Configure all installation settings') },
        { value: 'quick', name: copy('quickInstallLabel', 'Quick install'), description: copy('quickInstallHint', 'Install to a selected target') },
        { value: 'status', name: copy('statusLabel', 'Check status'), description: copy('statusHint', 'Show installed version and tracked files') },
        { value: 'register', name: registered ? copy('unregisterLabel', 'Unregister global commands') : copy('registerLabel', 'Register global commands'), description: registered ? copy('unregisterHint', 'Remove command shims') : copy('registerHint', 'Register command shims') },
        { value: 'init', name: copy('initLabel', 'Reset configuration').replace('{target}', target()), description: copy('initHint', 'Back up and reset the target') },
        { value: 'uninstall', name: copy('uninstallLabel', 'Uninstall'), description: copy('uninstallHint', 'Remove managed files') },
        { value: 'language', name: copy('switchLanguageLabel', 'Switch language'), description: copy('switchLanguageHint', 'Change the display language') },
        { value: 'exit', name: copy('exitLabel', 'Exit'), description: copy('exitHint', 'Quit the wizard') },
      ]
      if (!installed) [rows[0], rows[1]] = [rows[1], rows[0]]
      return rows
    }
    const choose = (picked: { value?: string } | null) => {
      switch (picked?.value) {
        case 'dashboard': setRoute('dashboard'); break
        case 'quick': promptQuickInstall(); break
        case 'status': showStatus(); break
        case 'register':
          if (isShimRegistered()) { const result = unregisterShim(); setMessage(result.removed.length ? `${copy('unregisterDoneMsg', 'Unregistered global commands from {binDir}').replace('{binDir}', getDefaultBinDir())}\n${result.removed.join('\n')}` : copy('unregisterNothingMsg', 'No global commands found in {binDir}').replace('{binDir}', getDefaultBinDir())) } else register()
          break
        case 'init': reset(); break
        case 'uninstall': uninstall(); break
        case 'language': { const index = locales.findIndex((locale) => locale.code === localeCode()); const next = locales[(index + 1) % locales.length]; if (next) { setLocaleCode(next.code); setPreferredLocaleCode(next.code); setMessage(loadLocale(repoDir, next.code).switchLangHint) }; break }
        case 'exit': exit(); break
      }
    }
    useKeyboard((key) => { if (!host.dialog() && (isBareEscape(key) || (key.ctrl && key.name === 'c'))) exit() })
    return <Show when={host.dialog()} keyed fallback={<Modal title={`${copy('wizardTitle', 'OpenCode Prime — Interactive Setup Wizard')} v${getCurrentRepoVersion(repoDir)}`} footer={<>{busy() ? copy('installingSpinner', 'Installing…') : '↑/↓ selects · Enter opens · Esc exits'}{message() ? `\n${message()}` : ''}</>}>
      <text selectable marginBottom={1} fg={ocpTheme.muted}>{executeStatus(repoDir).installedVersion ? copy('installedNote', 'Installed version: v{version} (Target: {target})').replace('{version}', executeStatus(repoDir).installedVersion ?? '').replace('{target}', target()) : copy('notInstalledNote', 'Target not initialized: {target}').replace('{target}', target())}</text>
      <box backgroundColor={ocpTheme.panel}>
        {/* Same head-gap symmetry as the compact host selects (itemSpacing
         * trails a gap row inside the panel; the kernel paints flush top). */}
        <box height={1} />
        <select focused height={Math.max(6, Math.min(menu().length * 3, 26))} backgroundColor={ocpTheme.surface} focusedBackgroundColor={ocpTheme.panel} textColor={ocpTheme.text} descriptionColor={ocpTheme.muted} selectedBackgroundColor={ocpTheme.accent} selectedTextColor={ocpTheme.surface} selectedDescriptionColor={ocpTheme.surface} itemSpacing={1} options={menu()} onSelect={(_index: number, picked: { value?: string } | null) => choose(picked)} />
      </box>
    </Modal>}>{(dialog: Dialog) => <DialogView dialog={dialog} />}</Show>
  }
  const Setup = () => <Screen title="OpenCode Prime — Setup" onBack={back} onEnter={() => setRoute('dashboard')} footer="Enter opens dashboard · Esc exits"
    lines={() => ['Configure installation defaults in the OpenTUI dashboard.', 'The installer and all option persistence remain in the existing business core.']} />
  return <box width="100%" height="100%" flexDirection="column" onMouseDown={(event) => rightClickCopy(event, renderer, (message) => host.notify(message))}>
    <box flexGrow={1} flexDirection="column">
      <Show when={route()} keyed>{(current: OcpRoute) => {
        if (current === 'dashboard') return <Dashboard />
        if (current === 'wizard') return <MainWizard />
        if (current === 'setup') return <Setup />
        if (current === 'project') return <WizardRoute title="Project wizard" ready={projectReady} command="project.wizard" />
        if (current === 'provider') return <WizardRoute title="Provider wizard" ready={providerReady} command="provider.wizard" />
        if (current === 'profile') return <WizardRoute title="Profile wizard" ready={profileReady} command="profile.switch" />
        if (current === 'usage') return <UsageRoute ready={usageReady} sessionId={props.context.sessionId} />
        return <Screen title="OpenCode Prime" onBack={exit} footer="Esc exits" lines={() => ['OpenCode Prime interactive UI']} />
      }}</Show>
    </box>
    <ToastLine />
  </box>
}
