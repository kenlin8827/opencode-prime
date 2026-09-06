import * as p from '@clack/prompts';
import { initProject } from '../../plugins/project-manager/project-manager-operations';
import { planDprintSetup, setupDprint } from '../../plugins/project-manager/project-manager-dprint';
import {
  detectProjectSwitches,
  PROJECT_SWITCH_OPTIONS,
} from '../../plugins/project-manager/project-manager-options';
import type { ProjectSwitches } from '../../plugins/project-manager/project-manager-scaffold';

interface ProjectOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly description: string;
}

async function choose<T extends string>(
  message: string,
  options: readonly ProjectOption<T>[],
  initialValue: T,
): Promise<T | null> {
  const selected = await p.select({
    message,
    initialValue,
    options: options.map((option) => ({
      value: option.value,
      label: option.label,
      hint: option.description,
    })),
  });
  if (p.isCancel(selected) || typeof selected !== 'string') return null;
  return options.find((option) => option.value === selected)?.value ?? null;
}

function resultLines(result: Awaited<ReturnType<typeof initProject>>): string[] {
  return [
    ...result.files.map((item) => `file ${item.status}: ${item.relPath}`),
    ...result.backends.map((item) => `backend ${item.status}: ${item.backend}`),
    ...result.hooks.map((item) => `hook ${item.status}: ${item.hook}`),
  ];
}

async function configureDprint(root: string): Promise<boolean> {
  const plan = planDprintSetup(root);
  if (plan.status !== 'eligible') {
    p.log.info(`dprint: ${plan.reason}`);
    return true;
  }

  const selected = await p.confirm({
    message: 'Set up dprint as the project formatter?',
    initialValue: false,
  });
  if (p.isCancel(selected)) return false;
  if (!selected) return true;

  await setupDprint(root);
  p.log.success('dprint configured');
  return true;
}

export async function runProjectWizard(root: string): Promise<number> {
  const detected = detectProjectSwitches(root);
  const current = detected.switches;
  const switches: ProjectSwitches = { ...current };

  p.intro(detected.exists ? 'OCP project wizard · existing project' : 'OCP project wizard · new project');

  const autoAdvisorMode = await choose(
    'autoAdvisorMode',
    PROJECT_SWITCH_OPTIONS.autoAdvisorMode,
    current.autoAdvisorMode ?? 'lite',
  );
  if (autoAdvisorMode === null) return 1;
  switches.autoAdvisorMode = autoAdvisorMode;

  const adrGuard = await choose('adrGuard', PROJECT_SWITCH_OPTIONS.adrGuard, current.adrGuard ?? 'on');
  if (adrGuard === null) return 1;
  switches.adrGuard = adrGuard;

  const adrGuardDir = await p.text({
    message: 'adrGuardDir',
    initialValue: current.adrGuardDir ?? 'docs/adr',
    placeholder: 'docs/adr',
    validate: (value) => value.trim() ? undefined : 'Enter a relative directory path.',
  });
  if (p.isCancel(adrGuardDir)) return 1;
  switches.adrGuardDir = adrGuardDir.trim();

  const adrMode = await choose('adrMode', PROJECT_SWITCH_OPTIONS.adrMode, current.adrMode ?? 'auto');
  if (adrMode === null) return 1;
  switches.adrMode = adrMode;

  const envGuard = await choose('envGuard', PROJECT_SWITCH_OPTIONS.envGuard, current.envGuard ?? 'on');
  if (envGuard === null) return 1;
  switches.envGuard = envGuard;

  const e2eGuard = await choose('e2eGuard', PROJECT_SWITCH_OPTIONS.e2eGuard, current.e2eGuard ?? 'on');
  if (e2eGuard === null) return 1;
  switches.e2eGuard = e2eGuard;

  if (!(await configureDprint(root))) return 1;

  const result = await initProject({ root, switches });
  p.note(resultLines(result).join('\n'), 'Project initialization');
  p.outro(`OCP project ${result.configExisted ? 'updated' : 'created'} in ${root}`);
  return 0;
}
