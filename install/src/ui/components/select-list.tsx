import { For, Show } from 'solid-js'
import type { JSX } from '@opentui/solid'
import { ocpTheme } from '../theme'
import type { DialogOption } from '../tui-host'

/** Blank lines inside the panel, above the first row and below the last — gives
 *  the list breathing room against the modal edge without making any row
 *  taller. The owning dialog reserves `2 × SELECT_PANEL_PAD` lines from its
 *  window budget so the padded panel never overflows. */
export const SELECT_PANEL_PAD = 1

/** One painted line in a select list. `option` is undefined for presentation
 *  rows: category headers (which carry their `── Label ──` text in
 *  `description`) and, when `spacers` are on, the blank gap rows inserted
 *  before each group. Every row is exactly one cell line tall, so the owning
 *  dialog's scroll window is a plain row count. */
export type SelectRow = { name: string; description: string; value: string; option?: DialogOption }

/**
 * Flatten options into a row list, emitting a non-selectable header row on each
 * category change. With `spacers`, a blank row precedes every header except the
 * first — the compact inline layout (one line per option) otherwise collapses
 * the visual grouping the kernel select got for free from its two-line rows.
 * Mirrors opencode's `paddingTop={index() > 0 ? 1 : 0}`.
 */
export function categoryRows(options: DialogOption[], opts?: { spacers?: boolean }): SelectRow[] {
  const rows: SelectRow[] = []
  let lastCategory: string | undefined
  for (const option of options) {
    if (option.category && option.category !== lastCategory) {
      if (opts?.spacers && rows.length > 0) {
        rows.push({ name: '', description: '', value: `__spacer_${rows.length}__` })
      }
      rows.push({ name: '', description: `── ${option.category} ──`, value: `__category_${rows.length}__` })
    }
    lastCategory = option.category
    rows.push({ name: option.title, description: option.description ?? '', value: option.value, option })
  }
  return rows
}

/** Nearest real (non-header) row index — headers and spacer rows are
 *  presentation-only, so navigation that lands on one skips past it IN THE
 *  MOVEMENT DIRECTION (otherwise upward navigation could never cross a header),
 *  falling back to the other direction at list edges. */
export function skipHeaderRow(rows: SelectRow[], index: number, direction: 1 | -1): number {
  // A filter can narrow the rows between an emit and this handler — clamp
  // before probing so a transient mismatch navigates, never crashes.
  if (rows.length === 0) return index
  const at = Math.max(0, Math.min(index, rows.length - 1))
  if (rows[at].option) return at
  if (direction === 1) {
    const next = rows.slice(at + 1).find((row) => row.option)
    if (next) return rows.indexOf(next)
    for (let i = at - 1; i >= 0; i--) {
      if (rows[i].option) return i
    }
  } else {
    for (let i = at - 1; i >= 0; i--) {
      if (rows[i].option) return i
    }
    const next = rows.slice(at + 1).find((row) => row.option)
    if (next) return rows.indexOf(next)
  }
  return at
}

export interface SelectListProps {
  /** The windowed slice to paint (already clipped to the panel height). */
  rows: SelectRow[]
  /** Absolute index of `rows[0]` in the full list, for cursor matching. */
  offset: number
  /** Absolute index of the active row (a signal accessor so it stays reactive). */
  selected: () => number
}

/**
 * Presentational select list — one cell line per row, the title on the left and
 * the description rendered inline in a muted `<span>`, matching opencode's
 * `dialog-select.tsx`. The kernel `<select>` renderable always drew the
 * description on a SECOND line (its layout is hardcoded), so the compat host
 * draws its own rows to get opencode's compact inline look. A terminal line is
 * exactly one glyph tall, so rows are not padded: text fills its line (nothing
 * to center) and groups are separated by blank spacer rows instead. Cursor,
 * scrolling and keyboard navigation stay in the owning dialog; this paints.
 */
export function SelectList(props: SelectListProps): JSX.Element {
  return <box backgroundColor={ocpTheme.panel} paddingTop={SELECT_PANEL_PAD} paddingBottom={SELECT_PANEL_PAD}>
    <For each={props.rows}>{(row, index) => {
      const active = () => props.offset + index() === props.selected()
      if (!row.option) {
        // Header (`── Label ──`) or blank spacer: muted, non-selectable.
        return <box height={1} paddingLeft={1}><text fg={ocpTheme.muted}>{row.name || row.description}</text></box>
      }
      return <box height={1} flexDirection="row" paddingLeft={1} backgroundColor={active() ? ocpTheme.accent : ocpTheme.panel}>
        <text flexGrow={1} wrapMode="none" overflow="hidden" fg={active() ? ocpTheme.surface : ocpTheme.text}>{`${active() ? '▶ ' : '  '}${row.name}`}<Show when={row.description}><span style={{ fg: active() ? ocpTheme.surface : ocpTheme.muted }}> {row.description}</span></Show></text>
      </box>
    }}</For>
  </box>
}
