import type { JSX } from '@opentui/solid'
import { ocpTheme } from '../theme'
import type { DialogSize } from '../tui-host'

export interface ModalProps {
  title: string
  children: JSX.Element
  footer?: JSX.Element
  /** Width tier mirroring opencode's DialogAlert sizes (60/88/116 total
   *  columns). Absent → the default fluid width (76%, capped at 88). */
  size?: DialogSize
}

const SIZE_WIDTH: Record<DialogSize, number> = { medium: 60, large: 88, xlarge: 116 }

/** OCP-owned centered modal; OpenCode plugin dialogs remain OpenCode-owned. */
export function Modal(props: ModalProps): JSX.Element {
  return <box width="100%" height="100%" justifyContent="center" alignItems="center" backgroundColor={ocpTheme.background}>
    <box width={props.size ? SIZE_WIDTH[props.size] : '76%'} maxWidth={props.size ? undefined : 88} minWidth={36} border borderStyle="rounded" borderColor={ocpTheme.border} backgroundColor={ocpTheme.surface} padding={1} flexDirection="column" gap={1}>
      <text selectable fg={ocpTheme.accent}>{props.title}</text>
      <box flexDirection="column">{props.children}</box>
       {props.footer && <box><text selectable fg={ocpTheme.muted}>{props.footer}</text></box>}
    </box>
  </box>
}
