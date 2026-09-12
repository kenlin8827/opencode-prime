import { spawn } from 'node:child_process'

/**
 * Clipboard writes for the standalone OpenTUI host (right-click copy).
 *
 * Strategy, in order:
 *   1. OSC 52 — the in-band terminal clipboard escape. Works over SSH and in
 *      every modern emulator (Windows Terminal ≥1.18, WezTerm, kitty,
 *      Alacritty, iTerm2 with "applications may access clipboard" enabled,
 *      tmux with `set-clipboard on`). Supplied by the caller as a bound
 *      `renderer.copyToClipboardOSC52` — no renderer import here, keeping the
 *      module unit-testable.
 *   2. Platform clipboard tools — the local OS command line (PowerShell
 *      Set-Clipboard / pbcopy / wl-copy / xclip / xsel). Covers terminals
 *      without OSC 52 (notably legacy conhost). Opt out with
 *      OCP_TUI_NO_PLATFORM_CLIPBOARD=1 (tests and locked-down machines).
 */

/** Where the text landed ('failed' = neither strategy worked). */
export type ClipboardWriteResult = 'osc52' | 'platform' | 'failed'

/** One OS-level clipboard command attempt. `stdin` (when set) is piped in. */
export interface ClipboardCommand {
  readonly command: string
  readonly args: readonly string[]
  readonly stdin?: string
}

/** Pure command selection per platform — exported for unit tests. */
export function platformClipboardCommands(platform: NodeJS.Platform, text: string): ClipboardCommand[] {
  if (platform === 'win32') {
    // Pass the payload base64-encoded: no quoting hazards with CJK or quotes,
    // and no OEM-codepage mangling on the PowerShell side.
    const payload = Buffer.from(text, 'utf8').toString('base64')
    // Windows CreateProcess caps a command line at ~32k chars; decline rather
    // than fail cryptically (selections this large are vanishingly rare and
    // OSC 52 already carried them when supported).
    if (payload.length > 30_000) return []
    return [{
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command',
        `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | Set-Clipboard`],
    }]
  }
  if (platform === 'darwin') {
    return [{ command: 'pbcopy', args: [], stdin: text }]
  }
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    // Try Wayland first, then X11 clipboards; first exit-0 wins.
    return [
      { command: 'wl-copy', args: [], stdin: text },
      { command: 'xclip', args: ['-selection', 'clipboard'], stdin: text },
      { command: 'xsel', args: ['--clipboard', '--input'], stdin: text },
    ]
  }
  return []
}

async function runCommand(command: ClipboardCommand, timeoutMs: number): Promise<boolean> {
  return await new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      child.kill()
      resolve(ok)
    }
    const child = spawn(command.command, [...command.args], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    const timer = setTimeout(() => done(false), timeoutMs)
    ;(timer as { unref?: () => void }).unref?.()
    child.on('error', () => { clearTimeout(timer); done(false) })
    child.on('close', (code) => { clearTimeout(timer); done(code === 0) })
    if (command.stdin !== undefined) {
      child.stdin.on('error', () => { /* EPIPE when the tool exits early — close still decides */ })
      child.stdin.end(command.stdin)
    } else {
      child.stdin.end()
    }
  })
}

export interface WriteClipboardOptions {
  /** OSC 52 writer — usually `(text) => renderer.copyToClipboardOSC52(text)`. */
  readonly copyOsc52?: (text: string) => boolean
  /** Injectable command runner (unit tests); defaults to a real spawn. */
  readonly runCommand?: (command: ClipboardCommand) => Promise<boolean>
  /** Injectable platform (unit tests); defaults to process.platform. */
  readonly platform?: NodeJS.Platform
  /** Per-attempt timeout for platform commands. */
  readonly timeoutMs?: number
}

/**
 * Write `text` to the system clipboard. Never throws — a failed write is
 * reported as 'failed' so the caller can surface a toast instead of crashing
 * the UI mid-dialog.
 */
export async function writeClipboardText(text: string, options: WriteClipboardOptions = {}): Promise<ClipboardWriteResult> {
  if (options.copyOsc52?.(text)) return 'osc52'
  if (process.env.OCP_TUI_NO_PLATFORM_CLIPBOARD === '1') return 'failed'
  const platform = options.platform ?? process.platform
  const runner = options.runCommand ?? ((command) => runCommand(command, options.timeoutMs ?? 4000))
  for (const command of platformClipboardCommands(platform, text)) {
    if (await runner(command)) return 'platform'
  }
  return 'failed'
}
