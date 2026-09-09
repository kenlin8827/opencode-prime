export interface OcpPalette {
  background: string
  surface: string
  border: string
  text: string
  muted: string
  accent: string
  warning: string
}

export const darkBase: OcpPalette = {
  background: '#0b1020',
  surface: '#141b2d',
  border: '#526179',
  text: '#e6edf7',
  muted: '#9aa8bc',
  accent: '#64d2ff',
  warning: '#ffd166',
}

export const lightBase: OcpPalette = {
  background: '#eef1f6',
  surface: '#ffffff',
  border: '#9aa7b8',
  text: '#1c2430',
  muted: '#5a6b81',
  accent: '#0a7ea4',
  warning: '#a06a00',
}

/**
 * Live palette used by the standalone OpenTUI host. Mutated in place by
 * applyOpenCodeTheme() before the first render, so element props read the
 * opencode-resolved colors (see ui/opencode-theme.ts).
 */
export const ocpTheme: OcpPalette = { ...darkBase }
