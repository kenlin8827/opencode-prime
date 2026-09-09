import { runOcpUi } from './ui/runtime';
import { UI_INSTALL_EXIT } from './dashboard';

export interface WizardResult { action: 'exit' | 'back' | 'install'; target?: string }

// Compatibility entry point for callers that still invoke the wizard module.
// Interactive rendering and input now belong exclusively to the OpenTUI host.
// Quick install hands off to the parent CLI via the shared UI_INSTALL_EXIT
// protocol (same path as the dashboard) — the wizard's only delta is the
// global-commands options.jsonc persist, done inside the TUI before exiting.
export async function runInteractiveWizard(repoDir: string): Promise<WizardResult> {
  const { code, request } = await runOcpUi('wizard', { repoDir });
  return { action: code === UI_INSTALL_EXIT ? 'install' : code === 0 ? 'exit' : 'back', target: request?.target };
}

export { parseDynamicOptionsSchema, updateOptionsJsoncInPlace } from './options-schema';
export type { DynamicOptionItem, DynamicSchema } from './options-schema';
