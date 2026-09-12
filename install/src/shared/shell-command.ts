import { spawnSync } from 'node:child_process';

export type ShellOutput = 'inherit' | 'capture';

export interface ShellCommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly output?: ShellOutput;
  readonly timeoutMs?: number;
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

/**
 * Execute a shell expression with platform-owned shell selection. Windows
 * always uses its inbox PowerShell host: tool registry commands are authored
 * as PowerShell expressions and this avoids PATH-visible `pwsh` shims that
 * reject Bun/Node process creation. POSIX delegates to the user's shell.
 */
export function runShellCommand(command: string, options: ShellCommandOptions = {}): ShellCommandResult {
  const usePowerShell = process.platform === 'win32';
  const result = spawnSync(usePowerShell ? 'powershell.exe' : command, usePowerShell ? ['-NoProfile', '-Command', command] : [], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    shell: !usePowerShell,
    stdio: options.output === 'capture' ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: options.timeoutMs ?? 600000,
  });
  return {
    status: result.status,
    error: result.error,
    stdout: text(result.stdout),
    stderr: text(result.stderr),
  };
}
