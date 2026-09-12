import type { JSX } from '@opentui/solid'
import { useKeyboard } from '@opentui/solid'
import type { OcpRouter } from '../router'
import { ocpTheme } from '../theme'
import { Modal } from '../components/modal'

export function HomeScreen(props: { router: OcpRouter }): JSX.Element {
  useKeyboard((key) => {
    // Plain Esc only: kitty alternate-key encodings report modified keys as name 'escape'.
    if ((key.name === 'escape' && !key.ctrl && !key.meta) || (key.ctrl && key.name === 'c')) props.router.exit()
  })
  return <Modal title="OpenCode Prime — OpenTUI migration">
    <text fg={ocpTheme.text}>The shared OCP UI runtime is ready.</text>
    <text fg={ocpTheme.warning}>Dashboard, setup, and project screens are being migrated.</text>
    <text fg={ocpTheme.muted}>Press Esc or Ctrl+C to exit.</text>
  </Modal>
}
