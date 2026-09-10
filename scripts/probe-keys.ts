/**
 * Terminal key diagnostics — answers "what does my terminal actually send
 * for Ctrl+T / Ctrl+S?". The OCP dashboard binds install to Ctrl+T
 * (install/src/ui/app.tsx), but terminals encode that chord differently
 * (legacy 0x14, kitty disambiguated CSI 116;5u, kitty alternate-keys
 * CSI 27;5;116u) and some (tmux/screen with prefix C-t, or a terminal
 * binding that swallows Ctrl+T) never deliver it to the app at all.
 *
 * Run INSIDE the terminal where the shortcut misbehaves, from the repo root:
 *
 *   bun scripts/probe-keys.ts
 *
 * Then press Ctrl+T, then Ctrl+S. Each press is echoed as the exact key
 * event the TUI receives. `q` quits.
 *
 * Reading the result:
 *  - a row with  name="t" ctrl=true            → binding fires; app is fine
 *  - a row with  name="escape" ctrl=true      → alternate-keys form; app is fine (handled)
 *  - a row with  name="" ...                  → CSI-u sequence with kitty parsing off
 *  - NO row at all for Ctrl+T                 → the terminal/tmux prefix is
 *    swallowing the chord — it never reaches any TUI; that is a terminal
 *    config issue, not an OCP one.
 */
import { createCliRenderer, TextRenderable } from '@opentui/core'

const renderer = await createCliRenderer({ exitOnCtrlC: false })
const lines: string[] = []
const probe = new TextRenderable(renderer, { id: 'probe', content: 'Press Ctrl+T, then Ctrl+S… (q quits)' })
renderer.root.add(probe)

const render = () => {
  probe.content = ['Press Ctrl+T, then Ctrl+S… (q quits)', ...lines].join('\n')
}

// keyInput is an EventEmitter typed against node:events, which standalone
// tsc here cannot resolve — the runtime shape is what matters for a probe.
const keyInput = renderer.keyInput as unknown as { on(event: 'keypress', listener: (key: { name: string; ctrl: boolean; meta: boolean; raw: string; sequence: string }) => void): void }
keyInput.on('keypress', (key) => {
  lines.unshift(
    `name=${JSON.stringify(key.name)} ctrl=${key.ctrl} meta=${key.meta} raw=${JSON.stringify(key.raw)} sequence=${JSON.stringify(key.sequence)}`,
  )
  lines.length = Math.min(lines.length, 24)
  render()
  if (key.name === 'q' && !key.ctrl && !key.meta) renderer.destroy()
})
