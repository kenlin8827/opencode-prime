import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { stripJsonc } from '../../../plugins/shared/opencode-prime'
import { BUILTIN_THEMES } from './builtin-themes'
import { darkBase, lightBase, ocpTheme, type OcpPalette } from './theme'

// ─── OpenCode theme compatibility ────────────────────────────────────
// The standalone host must look like opencode's own TUI, so it resolves
// the SAME theme the user picked: `theme` from tui.jsonc, then opencode's
// theme-file hierarchy (built-in table < ~/.config/opencode/themes/ <
// <cwd>/.opencode/themes/, later shadows — never merges), then the same
// color-value semantics: hex, ANSI number, defs/theme references,
// {dark,light} variants, and "none"/"transparent".

export type ThemeMode = 'dark' | 'light'

type ColorValue = string | number | { dark?: ColorValue; light?: ColorValue }
interface ThemeFile { defs?: Record<string, ColorValue>; theme: Record<string, ColorValue> }

export interface ThemeApplyOptions {
  mode?: ThemeMode
  configDir?: string
  cwd?: string
  themeName?: string
}

export interface ThemeApplyResult {
  name: string
  source: 'file' | 'builtin' | 'fallback'
  palette: OcpPalette
}

const ANSI16 = [
  '#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#c0c0c0',
  '#808080', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff',
]

function ansiToHex(code: number): string {
  if (code >= 0 && code < 16) return ANSI16[code]!
  if (code >= 16 && code < 232) {
    const index = code - 16
    const b = index % 6
    const g = Math.floor(index / 6) % 6
    const r = Math.floor(index / 36)
    const val = (x: number) => (x === 0 ? 0 : x * 40 + 55)
    return `#${[val(r)!, val(g)!, val(b)!].map((v) => v.toString(16).padStart(2, '0')).join('')}`
  }
  if (code >= 232 && code < 256) {
    const gray = (code - 232) * 10 + 8
    return `#${[gray, gray, gray].map((v) => v.toString(16).padStart(2, '0')).join('')}`
  }
  return '#000000'
}

function resolveColor(file: ThemeFile, value: ColorValue | undefined, mode: ThemeMode, chain: string[]): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') return ansiToHex(value)
  if (typeof value === 'string') {
    if (value === 'none' || value === 'transparent') return 'transparent'
    if (value.startsWith('#')) return value
    if (chain.includes(value)) return undefined // upstream throws; degrade instead
    const next = file.defs?.[value] ?? file.theme?.[value]
    if (next === undefined) return undefined
    return resolveColor(file, next, mode, [...chain, value])
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const picked = value[mode] ?? value.dark ?? value.light
    return resolveColor(file, picked, mode, chain)
  }
  return undefined
}

function loadThemeFile(file: string): ThemeFile | undefined {
  try {
    const parsed = JSON.parse(stripJsonc(readFileSync(file, 'utf8'))) as Partial<ThemeFile>
    if (parsed && typeof parsed.theme === 'object' && parsed.theme !== null) return { defs: parsed.defs, theme: parsed.theme }
  } catch { /* malformed theme file — behave like opencode: ignore it */ }
  return undefined
}

/** Read the user's chosen theme name from tui.jsonc / tui.json (config dir). */
export function readTuiThemeName(configDir: string): string {
  for (const file of ['tui.jsonc', 'tui.json']) {
    const full = path.join(configDir, file)
    if (!existsSync(full)) continue
    try {
      const parsed = JSON.parse(stripJsonc(readFileSync(full, 'utf8'))) as { theme?: unknown }
      if (typeof parsed.theme === 'string' && parsed.theme) return parsed.theme
    } catch { /* ignore malformed config */ }
  }
  return 'opencode'
}

function pickPalette(file: ThemeFile, mode: ThemeMode): Partial<OcpPalette> {
  const get = (key: string) => resolveColor(file, file.theme?.[key], mode, [])
  const opaque = (v: string | undefined) => (v && v !== 'transparent' ? v : undefined)
  const palette: Partial<OcpPalette> = {}
  const background = get('background')
  const panel = opaque(get('backgroundPanel')) ?? opaque(get('backgroundElement')) ?? opaque(background)
  // The inset list strip sits a step below the modal panel; prefer opencode's
  // `backgroundElement` (its recessed layer), falling back to the panel color.
  const inset = opaque(get('backgroundElement')) ?? panel
  const border = opaque(get('border')) ?? opaque(get('borderSubtle'))
  const text = opaque(get('text'))
  const muted = opaque(get('textMuted'))
  const accent = opaque(get('primary')) ?? opaque(get('accent'))
  const warning = opaque(get('warning'))
  if (background && background !== 'transparent') palette.background = background
  if (panel) palette.surface = panel
  if (inset) palette.panel = inset
  if (border) palette.border = border
  if (text) palette.text = text
  if (muted) palette.muted = muted
  if (accent) palette.accent = accent
  if (warning) palette.warning = warning
  return palette
}

/**
 * Resolve and apply the opencode-compatible palette to ocpTheme.
 * Exported result is informational (tests); the live palette is mutated
 * in place so every host component picks it up at element creation.
 */
export function applyOpenCodeTheme(options: ThemeApplyOptions = {}): ThemeApplyResult {
  const mode: ThemeMode = options.mode ?? 'dark'
  const configDir = options.configDir ?? process.env.OPENCODE_CONFIG_DIR ?? path.join(homedir(), '.config', 'opencode')
  const cwd = options.cwd ?? process.cwd()
  const name = options.themeName ?? readTuiThemeName(configDir)

  let file: ThemeFile | undefined
  let source: ThemeApplyResult['source'] = 'file'
  const builtin = (BUILTIN_THEMES as Record<string, ThemeFile>)[name]
  if (builtin) { file = builtin; source = 'builtin' }
  // Shadowing hierarchy: built-in < user config themes < cwd themes.
  for (const dir of [path.join(configDir, 'themes'), path.join(cwd, '.opencode', 'themes')]) {
    const candidate = path.join(dir, `${name}.json`)
    if (existsSync(candidate)) {
      const loaded = loadThemeFile(candidate)
      if (loaded) { file = loaded; source = 'file' }
    }
  }
  if (!file && name !== 'opencode') {
    const fallback = (BUILTIN_THEMES as Record<string, ThemeFile>).opencode
    if (fallback) { file = fallback; source = 'builtin' }
  }

  const base = mode === 'light' ? lightBase : darkBase
  const palette: OcpPalette = { ...base }
  if (file) Object.assign(palette, pickPalette(file, mode))
  else source = 'fallback'
  Object.assign(ocpTheme, palette)
  return { name, source, palette: { ...palette } }
}
