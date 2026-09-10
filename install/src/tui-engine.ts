import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { isBinaryOnPath, loadToolRegistry } from './installer';
import { launchBinary, stripOcpTuiControlArgs } from './launcher';

// Generic TUI launch engine — the runtime counterpart of post_install.
//
// Model: the engine has ZERO domain knowledge of workspace/server/agent
// concepts. A tool's launch sequence is pure data in install/tools.jsonc
// (`tools.<id>.tui`):
//
//   pre_launch: [command, ...]   ordered, fire-and-forget shell steps run
//                                before the TUI attaches. Each step talks to
//                                its tool directly (Node scripts under
//                                install/scripts/engines/<id>/, sharing
//                                install/scripts/engines/lib/ocp-cli.js).
//   attach: <bin>                the engine execs this at the end with the
//                                user's passthrough args (stdio inherited).
//
// Step exit-code convention (mirrors the ocp.auto-opencode plugin):
//   0 = ok, continue · 2 = warn but continue · anything else = abort launch.
//
// Context env vars handed to every step:
//   OCP_CWD          target workspace directory (where `ocp` was invoked)
//   OCP_LABEL        basename of OCP_CWD (workspace label convention)
//   OCP_TUI_ARGS     JSON array of passthrough args already stripped of
//                    OCP-only control flags
//   OCP_ENGINE_ID    registry key ('herdr', 'luvus', ...)
//   OCP_ENGINE_BIN   attach binary name (steps invoke it via the CLI helper)
//   OCP_REPO_DIR     repo root (also substituted into command strings,
//                    same convention as post_install)
//
// Adding a new TUI provider = one tools.jsonc `tui` block + Node scripts
// under install/scripts/engines/<id>/. The engine itself never changes.
// Set OCP_TUI_DRY_RUN=1 to print the resolved plan without running anything.

export interface TuiEngineStep {
  name?: string;
  /** Shell command; supports $OCP_REPO_DIR / %OCP_REPO_DIR% placeholders. */
  command: string;
}

export interface TuiEngineSpec {
  /** Binary to exec at the end (also exported as OCP_ENGINE_BIN). */
  bin: string;
  /** Shown when `bin` is missing from PATH. */
  install_hint?: string;
  /** Ordered fire-and-forget steps run before attaching. */
  pre_launch?: Array<string | TuiEngineStep>;
  /** Static args always passed to the attach binary. */
  attach_args?: string[];
  /** Forward OCP passthrough args to the TUI. Default true. */
  forward_args?: boolean;
  /** Printed (once) when forward_args is false and passthrough is non-empty. */
  args_warning?: string;
}

/**
 * Run a tool's declared TUI launch sequence from install/tools.jsonc.
 * Returns the process exit code (caller does process.exit with it).
 */
export function runTuiEngine(
  repoDir: string,
  engineId: string,
  extraArgs: string[]
): number {
  const registry = loadToolRegistry(repoDir);
  const entry = registry?.tools?.[engineId];
  if (!entry) {
    console.error(`✗ TUI engine "${engineId}" is not declared in install/tools.jsonc.`);
    return 1;
  }
  const spec = entry.tui as TuiEngineSpec | undefined;
  if (!spec || typeof spec.bin !== 'string' || spec.bin.length === 0) {
    console.error(`✗ install/tools.jsonc tool "${engineId}" has no valid "tui" block.`);
    return 1;
  }

  const args = stripOcpTuiControlArgs(extraArgs);
  const cwd = process.cwd();
  const label = path.basename(cwd) || 'workspace';
  const hint = spec.install_hint ?? `  Install ${spec.bin} first (or re-run \`ocp install\`).`;
  const steps: TuiEngineStep[] = [];
  const rawSteps = Array.isArray(spec.pre_launch) ? spec.pre_launch : [];
  for (let i = 0; i < rawSteps.length; i++) {
    const step = rawSteps[i];
    const command = typeof step === 'string' ? step : step?.command;
    const name = (typeof step === 'string' ? undefined : step?.name) || `step ${i + 1}`;
    if (typeof command !== 'string' || command.trim() === '') {
      console.error(`✗ [tui:${engineId}] pre_launch "${name}" has no command string (install/tools.jsonc).`);
      return 1;
    }
    steps.push({ name, command });
  }

  if (process.env.OCP_TUI_DRY_RUN === '1') {
    console.log(`[tui:${engineId}] dry run — resolved plan:`);
    for (const [i, step] of steps.entries()) {
      console.log(`  pre_launch ${i + 1}. ${step.name}: ${resolveRepoDirPlaceholders(step.command, repoDir)}`);
    }
    console.log(`  attach: ${spec.bin} ${buildAttachArgs(spec, args).join(' ')}`.trimEnd());
    return 0;
  }

  // Fast PATH check so a missing binary prints the install hint instead of
  // every pre_launch step failing on ENOENT (and, for herdr, a 15s poll stall).
  if (!isBinaryOnPath(spec.bin)) {
    console.error(`✗ ${spec.bin} was not found on PATH.`);
    console.error(hint);
    return 1;
  }

  if (spec.forward_args === false && args.length > 0 && spec.args_warning) {
    console.log(spec.args_warning);
  }

  const env = {
    ...process.env,
    OCP_REPO_DIR: repoDir,
    OCP_ENGINE_ID: engineId,
    OCP_ENGINE_BIN: spec.bin,
    OCP_CWD: cwd,
    OCP_LABEL: label,
    OCP_TUI_ARGS: JSON.stringify(args),
  };

  for (const step of steps) {
    const command = resolveRepoDirPlaceholders(step.command, repoDir);
    // spawnSync({shell:true}) = cmd.exe on Windows / sh on POSIX — NOT the
    // installer's runShellCommand (PowerShell): a native `exit 2` survives
    // exactly here, while `powershell -Command` collapses any nonzero code
    // to 1 (measured: want 2|5 -> shell:true 2|5, powershell 1|1), which
    // would silently break the 0/2/abort convention and turn every soft
    // warn into an abort. Consequence: step commands must stay portable
    // one-liners (canonical form: `node "<script>"`), no PowerShell syntax.
    const res = spawnSync(command, { stdio: 'inherit', shell: true, env, cwd });
    if (res.error) {
      console.error(`✗ [tui:${engineId}] ${step.name} failed to run: ${res.error.message}`);
      return 1;
    }
    const status = res.status ?? 1;
    if (status === 2) continue; // warn-but-continue (the step already printed why)
    if (status !== 0) {
      console.error(`✗ [tui:${engineId}] ${step.name} failed (exit ${status}) — not attaching.`);
      return status;
    }
  }

  return launchBinary(spec.bin, hint, buildAttachArgs(spec, args), { cwd });
}

function buildAttachArgs(spec: TuiEngineSpec, args: string[]): string[] {
  const staticArgs = spec.attach_args ?? [];
  return spec.forward_args === false ? [...staticArgs] : [...staticArgs, ...args];
}

/** Same placeholder convention as post_install (installer.ts runPostInstall). */
function resolveRepoDirPlaceholders(command: string, repoDir: string): string {
  return command.replace(/\$OCP_REPO_DIR/g, repoDir).replace(/%OCP_REPO_DIR%/g, repoDir);
}
