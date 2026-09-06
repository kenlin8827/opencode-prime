import { spawnSync } from 'node:child_process';

export type ShellOutput = 'inherit' | 'capture';
export type WindowsShell = 'native' | 'powershell';

export interface ShellCommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly output: ShellOutput;
  readonly timeoutMs: number;
  readonly windowsShell: WindowsShell;
  readonly powershellExecutable?: string;
}

export interface ShellCommandResult {
  readonly status: number | null;
  readonly error?: Error;
  readonly stdout: string;
  readonly stderr: string;
}

function text(value: string | Buffer | null | undefined): string {
  return value === null || value === undefined ? '' : value.toString();
}

export function runShellCommand(command: string, options: ShellCommandOptions): ShellCommandResult {
  const usePowerShell = process.platform === 'win32' && options.windowsShell === 'powershell';
  const executable = usePowerShell ? options.powershellExecutable ?? 'powershell' : command;
  const args = usePowerShell ? ['-NoProfile', '-Command', command] : [];
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    shell: !usePowerShell,
    stdio: options.output === 'capture' ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: options.timeoutMs,
  });
  return {
    status: result.status,
    error: result.error,
    stdout: text(result.stdout),
    stderr: text(result.stderr),
  };
}
