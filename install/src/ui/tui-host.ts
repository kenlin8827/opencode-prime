import { createSignal, type Accessor } from 'solid-js'

export type DialogOption = { title: string; value: string; description?: string; category?: string }
export type Dialog =
  | { kind: 'select'; title: string; placeholder?: string; options: DialogOption[]; current?: string; renderFilter?: boolean; itemSpacing?: number; onSelect: (option: DialogOption) => void }
  | { kind: 'prompt'; title: string; placeholder?: string; value?: string; busy?: boolean; busyText?: string; onConfirm: (value: string) => void; onCancel?: () => void }
  | { kind: 'confirm'; title: string; message: string; confirmLabel?: string; cancelLabel?: string; footer?: string; onConfirm: () => void; onCancel?: () => void }
  | { kind: 'alert'; title: string; message: string; onClose?: () => void }

/** Dialog width tiers mirroring opencode's DialogAlert sizes (60/88/116). */
export type DialogSize = 'medium' | 'large' | 'xlarge'

export interface TuiHost {
  readonly dialog: Accessor<Dialog | undefined>
  readonly toast: Accessor<string | undefined>
  readonly size: Accessor<DialogSize | undefined>
  replace(dialog: Dialog, onClose?: () => void): void
  clear(): void
  close(): void
  setSize(size: DialogSize | undefined): void
  setDefaultOnClose(fn: () => void): void
  notify(message: string, title?: string): void
  register(name: string, run: (input?: string) => void): void
  dispatch(name: string, input?: string): boolean
  kvGet<T>(key: string): T | undefined
}

/** How long a toast lingers before the host auto-dismisses it. */
const TOAST_MS = 5000

/**
 * OCP's standalone dialog-stack host. It mirrors the semantics of opencode's
 * `api.ui.dialog` (see @opencode-ai/plugin/tui TuiDialogStack):
 *   - replace() swaps the visible frame; the replaced frame's onClose still
 *     fires (wizards guard re-entry with their own `navigated` flag);
 *   - close() dismisses the current frame and runs its onClose, falling back
 *     to the route-level default when the frame registered none (root-level
 *     Esc — in the CLI that means leaving the wizard screen);
 *   - clear() drops the stack silently (used after apply/reset flows).
 */
export function createTuiHost(kv: ReadonlyMap<string, string> = new Map()): TuiHost {
  const [dialog, setDialog] = createSignal<Dialog>()
  const [toast, setToast] = createSignal<string>()
  const [size, setSize] = createSignal<DialogSize>()
  const commands = new Map<string, (input?: string) => void>()
  let onClose: (() => void) | undefined
  let defaultOnClose: (() => void) | undefined
  let toastTimer: ReturnType<typeof setTimeout> | undefined

  return {
    dialog,
    toast,
    size,
    replace(next, close) {
      const previous = onClose
      onClose = close
      // New frame, fresh size: plugins that manage width call setSize right
      // after replace; frames that never do fall back to the Modal default.
      setSize()
      setDialog(next)
      previous?.()
    },
    clear() { setDialog(); onClose = undefined },
    close() {
      const close = onClose
      onClose = undefined
      setDialog()
      ;(close ?? defaultOnClose)?.()
    },
    setSize,
    setDefaultOnClose(fn) { defaultOnClose = fn },
    notify(message, title) {
      setToast(title ? `${title}: ${message}` : message)
      if (toastTimer) clearTimeout(toastTimer)
      toastTimer = setTimeout(() => setToast(), TOAST_MS)
      // Never keep the process alive just to dismiss a toast.
      ;(toastTimer as { unref?: () => void }).unref?.()
    },
    register(name, run) { commands.set(name, run) },
    dispatch(name, input) { const run = commands.get(name); if (!run) return false; run(input); return true },
    kvGet(key) { return kv.get(key) as never },
  }
}
