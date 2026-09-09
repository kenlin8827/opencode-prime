import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { applyOpenCodeTheme, readTuiThemeName } from '../install/src/ui/opencode-theme'
import { ocpTheme } from '../install/src/ui/theme'

const home = mkdtempSync(path.join(tmpdir(), 'ocp-theme-test-'))
const cfg = path.join(home, 'tui-home')
mkdirSync(path.join(cfg, 'themes'), { recursive: true })

// 1. tui.jsonc selection + JSONC comments survive parsing.
writeFileSync(path.join(cfg, 'tui.jsonc'), `{
  // chosen by /theme
  "theme": "nord",
}`, 'utf8')
assert.equal(readTuiThemeName(cfg), 'nord')

// 2. Built-in mirror resolves the same semantic colors opencode ships.
const nord = applyOpenCodeTheme({ configDir: cfg, cwd: home, themeName: undefined, mode: 'dark' })
assert.equal(nord.name, 'nord')
assert.equal(nord.source, 'builtin')
assert.equal(nord.palette.accent, '#88C0D0') // nord8 primary
assert.equal(nord.palette.text, '#ECEFF4')   // nord6 text
assert.equal(ocpTheme.accent, '#88C0D0', 'live palette mutated in place')

// 3. User file shadows the built-in with the exact opencode value semantics:
//    refs into defs, {dark,light} variants, ANSI numbers, none/transparent.
writeFileSync(path.join(cfg, 'themes', 'nord.json'), JSON.stringify({
  defs: { mybg: '#010203' },
  theme: {
    primary: 'mybg',
    text: { dark: '#111111', light: '#eeeeee' },
    backgroundPanel: 208, // ANSI 208 → #ff8700
    border: 'none',
    textMuted: '#222222',
  },
}), 'utf8')
const shadow = applyOpenCodeTheme({ configDir: cfg, cwd: home, mode: 'dark' })
assert.equal(shadow.source, 'file')
assert.equal(shadow.palette.surface, '#ff8700', 'ANSI cube color resolves')
assert.equal(shadow.palette.accent, '#010203', 'defs reference resolves')
assert.equal(shadow.palette.text, '#111111', 'dark variant picked')
assert.equal(shadow.palette.border, '#526179', 'border "none" keeps the base palette value')
const light = applyOpenCodeTheme({ configDir: cfg, cwd: home, mode: 'light' })
assert.equal(light.palette.text, '#eeeeee', 'light variant picked')

// 4. Unknown theme names fall back to the built-in default like opencode does.
writeFileSync(path.join(cfg, 'tui.jsonc'), '{"theme":"does-not-exist"}', 'utf8')
const fb = applyOpenCodeTheme({ configDir: cfg, cwd: home, mode: 'dark' })
assert.equal(fb.source, 'builtin')
assert.equal(fb.name, 'does-not-exist')
assert.equal(fb.palette.accent, '#fab283', 'opencode default darkStep9 primary')

// 5. No tui config at all → default theme name is 'opencode'.
const bare = mkdtempSync(path.join(tmpdir(), 'ocp-theme-bare-'))
assert.equal(readTuiThemeName(bare), 'opencode')
console.log('ocp theme compat: hierarchy, refs, variants, ansi and fallbacks all resolve')
