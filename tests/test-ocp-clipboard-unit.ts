/**
 * ocp clipboard module — unit tests (no terminal / renderer dependency).
 *
 * Covers the writeClipboardText strategy chain (OSC 52 → platform tools →
 * failed) and the pure per-platform command selection, including the Windows
 * base64 payload roundtrip and the large-payload decline.
 */
import { strict as assert } from 'node:assert'
import { platformClipboardCommands, writeClipboardText, type ClipboardCommand } from '../install/src/ui/clipboard'

// ─── 01: OSC 52 success short-circuits platform commands ─────────────────
{
  const attempts: ClipboardCommand[] = []
  const result = await writeClipboardText('copy me', {
    copyOsc52: () => true,
    runCommand: (command) => { attempts.push(command); return Promise.resolve(true) },
  })
  assert.equal(result, 'osc52', 'a working OSC 52 writer wins immediately')
  assert.equal(attempts.length, 0, 'platform commands must not run when OSC 52 succeeded')
}

// ─── 02: OSC 52 failure falls through to the platform runner ─────────────
{
  const attempts: ClipboardCommand[] = []
  const result = await writeClipboardText('copy me', {
    copyOsc52: () => false,
    runCommand: (command) => { attempts.push(command); return Promise.resolve(command.command === 'pbcopy') },
    platform: 'darwin',
  })
  assert.equal(result, 'platform', 'the platform runner carries the write when OSC 52 is unsupported')
  assert.equal(attempts.length, 1, 'darwin has exactly one platform command (pbcopy)')
  assert.equal(attempts[0].command, 'pbcopy')
  assert.equal(attempts[0].stdin, 'copy me', 'pbcopy receives the text on stdin')
}

// ─── 03: every strategy failing reports 'failed' (never throws) ──────────
{
  const attempts: ClipboardCommand[] = []
  const result = await writeClipboardText('copy me', {
    copyOsc52: () => false,
    runCommand: (command) => { attempts.push(command); return Promise.resolve(false) },
    platform: 'linux',
  })
  assert.equal(result, 'failed', 'an exhausted strategy chain resolves to failed')
  assert.equal(attempts.length, 3, 'linux tries wl-copy, xclip and xsel in order')
  assert.deepEqual(attempts.map((command) => command.command), ['wl-copy', 'xclip', 'xsel'])
}

// ─── 04: mid-chain success stops the fallback walk ───────────────────────
{
  const attempts: ClipboardCommand[] = []
  const result = await writeClipboardText('copy me', {
    copyOsc52: () => false,
    runCommand: (command) => { attempts.push(command); return Promise.resolve(command.command === 'xclip') },
    platform: 'linux',
  })
  assert.equal(result, 'platform', 'the first successful platform command wins')
  assert.equal(attempts.length, 2, 'xsel is never attempted after xclip succeeded')
}

// ─── 05: OCP_TUI_NO_PLATFORM_CLIPBOARD opts out of the fallback ──────────
{
  const previous = process.env.OCP_TUI_NO_PLATFORM_CLIPBOARD
  process.env.OCP_TUI_NO_PLATFORM_CLIPBOARD = '1'
  try {
    const attempts: ClipboardCommand[] = []
    const result = await writeClipboardText('copy me', {
      copyOsc52: () => false,
      runCommand: (command) => { attempts.push(command); return Promise.resolve(true) },
      platform: 'win32',
    })
    assert.equal(result, 'failed', 'the opt-out env forces failed once OSC 52 declines')
    assert.equal(attempts.length, 0, 'no platform command spawns under the opt-out')
  } finally {
    if (previous === undefined) delete process.env.OCP_TUI_NO_PLATFORM_CLIPBOARD
    else process.env.OCP_TUI_NO_PLATFORM_CLIPBOARD = previous
  }
}

// ─── 06: Windows payload is base64 roundtrip-safe (CJK, quotes, newlines) ─
{
  const tricky = '模型 "quoted" ≠ 0\nline two\t✓'
  const commands = platformClipboardCommands('win32', tricky)
  assert.equal(commands.length, 1, 'win32 yields a single PowerShell command')
  assert.equal(commands[0].command, 'powershell.exe')
  const encoded = /FromBase64String\('([^']+)'\)/.exec(commands[0].args.join(' '))?.[1]
  assert.ok(encoded, 'the payload travels as a base64 argument')
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), tricky, 'payload decodes back byte-for-byte')
}

// ─── 07: oversized Windows payloads decline instead of blowing the ARG_MAX ─
{
  const commands = platformClipboardCommands('win32', 'x'.repeat(23_000))
  assert.equal(commands.length, 0, 'payloads whose base64 exceeds 30k chars are declined')
}

// ─── 08: unsupported platforms have no fallback commands ─────────────────
{
  assert.deepEqual(platformClipboardCommands('sunos', 'copy me'), [], 'unknown platforms yield no commands')
}

console.log('ocp clipboard write strategy and platform command tests passed')
