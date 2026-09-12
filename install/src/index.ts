import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { CliArgs, CommandAction, InstallOptions } from './types';
import { readJsoncFile } from './merger';
import {
  executeInstall,
  executeStatus,
  executeInit,
  executeUninstall,
  getCurrentRepoVersion,
  getDefaultTargetDir,
  loadEffectiveOptions,
} from './installer';
import { unregisterShim, runGlobalRegistration } from './shim';
import { formatI18n, getPreferredLocaleCode, loadLocale } from './i18n';
import { runInteractiveWizard } from './wizard';
import { runProjectWizard } from './project-wizard';
import { runProviderCli } from './provider-wizard';
import { runProfileCli } from './profile-wizard';
import { runUsageCli } from './usage';
import { runTuiDashboard } from './dashboard';
import { launchTui, launchServe, launchWeb, launchCode, launchDesktop } from './launcher';
import { runTuiEngine } from './tui-engine';
import { deployHerdrConfig, herdrUserConfigPath, HERDR_CONFIG_TEMPLATE } from './herdr-config';
import {
  checkOpenChamberDesktop,
  ensureOpenChamberWebCli,
  ensureOpenChamberVscodeExtension,
  isOpenChamberSurfaceEnabled,
} from './openchamber';
import { executeUpdate, executeUpgrade } from './updater';
import { executeClean, executeSessionProjects } from './session-clean';
import { normalizeTuiPassthrough } from './tui-args';
import { getOpencodeExecutable } from './shared/opencode-command';
import type { BackendResult } from '../../plugins/project-manager/project-manager-index';
import type { HookResult } from '../../plugins/project-manager/project-manager-hooks';
import { indexProject, initProject, syncProject } from '../../plugins/project-manager/project-manager-operations';
import type { ScaffoldResult, SyncResult } from '../../plugins/project-manager/project-manager-scaffold';

const execFileAsync = promisify(execFile);

/**
 * Shared UI→CLI install handoff (dashboard + wizard quick install): map a TUI
 * child's result onto the installer args. True → the parent falls through to
 * the `install` case, so executeInstall + global registration + surface checks
 * run exactly once, in the user's shell.
 */
function applyUiInstallHandoff(args: CliArgs, result: { action: string; target?: string }): boolean {
  if (result.action !== 'install') return false;
  args.action = 'install';
  args.force = true;
  args.yes = true;
  if (result.target) args.target = result.target;
  return true;
}

const IS_WINDOWS = process.platform === 'win32';
const IS_MACOS = process.platform === 'darwin';

const AUTH_FILE = path.join(homedir(), '.local', 'share', 'opencode', 'auth.json');

function ensureAuthFile(): void {
  if (fs.existsSync(AUTH_FILE)) return;
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, '{}\n', { encoding: 'utf-8', mode: 0o600 });
}

/**
 * `ocp herdr-config install` — deploy the bundled config to the user's
 * herdr config dir. Merges on every install: existing keys are preserved,
 * template keys missing from the user's file are appended. Pass
 * `force = true` to overwrite with the template verbatim.
 */
function executeHerdrConfigInstall(repoDir: string, force: boolean | undefined): number {
  const result = deployHerdrConfig(repoDir, !!force);
  if (result.action === 'failed') {
    console.error(`✗ ${result.message}`);
    return 1;
  } else if (result.action === 'skipped') {
    console.log(`ℹ ${result.message}`);
    console.log(`  To compare, see the bundled template at ${path.join(repoDir, HERDR_CONFIG_TEMPLATE)}.`);
  } else if (result.action === 'uptodate') {
    console.log(`ℹ ${result.message}`);
  } else {
    console.log(`✓ ${result.message}`);
    if (force) console.log('  (overwrote existing file because --force was set)');
  }
  return 0;
}

/**
 * `ocp herdr-config status` — report whether the user has a herdr config,
 * and where the bundled template lives (so the user can diff them).
 */
function executeHerdrConfigStatus(): number {
  const dest = herdrUserConfigPath();
  if (fs.existsSync(dest)) {
    console.log(`✓ herdr config installed: ${dest}`);
  } else {
    console.log(`ℹ No herdr config found at ${dest}`);
    console.log(`  Run \`ocp herdr-config install\` to deploy the bundled template.`);
  }
  return 0;
}

async function openAuthFile(): Promise<{ ok: boolean; message: string }> {
  ensureAuthFile();
  const command = IS_WINDOWS ? 'cmd' : IS_MACOS ? 'open' : 'xdg-open';
  const args = IS_WINDOWS ? ['/c', 'start', '', AUTH_FILE] : [AUTH_FILE];

  try {
    await execFileAsync(command, args, { timeout: 30_000, windowsHide: true });
    return { ok: true, message: `Opened ${AUTH_FILE}` };
  } catch (err: any) {
    const detail = err?.stderr || err?.stdout || err?.message || String(err);
    return { ok: false, message: `Failed to open ${AUTH_FILE}: ${detail}` };
  }
}

function parseCliArgs(rawArgs: string[]): CliArgs {
  const args: CliArgs = {
    action: 'install',
    force: false,
    noBackup: false,
    keepBackups: undefined,
    yes: false,
    projectMode: 'auto',
    isInteractive: process.stdout.isTTY && process.stdin.isTTY,
  };

  let hasExplicitAction = false;
  const printUnknownCommand = (command: string): never => {
    console.error(`✗ Unknown command: ${command}`);
    console.error('  Run `ocp --help` to see supported commands.');
    process.exit(2);
  };

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];

    if (arg === 'status') {
      args.action = 'status';
      hasExplicitAction = true;
    } else if (arg === 'install') {
      args.action = 'install';
      hasExplicitAction = true;
    } else if (arg === 'init') {
      args.action = 'init';
      hasExplicitAction = true;
    } else if (arg === 'uninstall') {
      args.action = 'uninstall';
      hasExplicitAction = true;
    } else if (arg === 'register') {
      args.action = 'register';
      hasExplicitAction = true;
    } else if (arg === 'unregister') {
      args.action = 'unregister';
      hasExplicitAction = true;
    } else if (arg === 'wizard' || arg === 'menu') {
      args.action = 'wizard';
      hasExplicitAction = true;
    } else if (arg === 'project') {
      // `project` namespace — init / index / sync mirror the `/project` slash command.
      const next = rawArgs[i + 1];
      if (next === 'init') {
        args.action = 'project-init';
        i++; // consume 'init'
        hasExplicitAction = true;
      } else if (next === 'index') {
        args.action = 'project-index';
        i++; // consume 'index'
        hasExplicitAction = true;
      } else if (next === 'sync') {
        args.action = 'project-sync';
        i++; // consume 'sync'
        hasExplicitAction = true;
      } else {
        if (next === '--help' || next === '-h' || next === 'help') {
          printHelp();
          process.exit(0);
        }
        // Match provider/profile: the namespace without a subcommand opens
        // its interactive wizard in a TTY (or runs headlessly otherwise).
        if (!next) {
          args.action = 'project-init';
          hasExplicitAction = true;
        } else {
          printUnknownCommand(`project ${next}`);
        }
      }
    } else if (arg === 'provider' || arg === 'profile' || arg === 'usage') {
      args.action = arg;
      args.passthrough = rawArgs.slice(i + 1);
      hasExplicitAction = true;
      break;
    } else if (arg === 'dashboard' || arg === 'matrix' || arg === 'cc') {
      args.action = 'dashboard';
      hasExplicitAction = true;
    } else if (arg === 'tui') {
      args.action = 'tui';
      args.passthrough = rawArgs.slice(i + 1);
      hasExplicitAction = true;
      break;
    } else if (arg === 'serve') {
      args.action = 'serve';
      args.passthrough = rawArgs.slice(i + 1);
      hasExplicitAction = true;
      break;
    } else if (arg === 'code') {
      // VS Code launcher — `--init` is handled by the TS launcher; a bare `.`
      // passes through (VS Code interprets it as "open the current folder").
      args.action = 'code';
      args.passthrough = rawArgs.slice(i + 1);
      hasExplicitAction = true;
      break;
    } else if (arg === 'update') {
      args.action = 'update';
      args.passthrough = rawArgs.slice(i + 1);
      hasExplicitAction = true;
      break;
    } else if (arg === 'upgrade') {
      args.action = 'upgrade';
      args.passthrough = rawArgs.slice(i + 1);
      hasExplicitAction = true;
      break;
    } else if (arg === 'desktop' || arg === 'ui') {
      args.action = 'desktop';
      args.passthrough = rawArgs.slice(i + 1);
      hasExplicitAction = true;
      break;
    } else if (arg === 'web') {
      args.action = 'web';
      args.passthrough = rawArgs.slice(i + 1);
      hasExplicitAction = true;
      break;
    } else if (arg === 'session') {
      // `session` namespace — look ahead for the subcommand.
      const next = rawArgs[i + 1];
      if (next === 'clean') {
        args.action = 'clean';
        i++; // consume 'clean'
        hasExplicitAction = true;
      } else if (next === 'projects') {
        args.action = 'session-projects';
        i++; // consume 'projects'
        hasExplicitAction = true;
      } else if (next === 'list' || next === 'delete') {
        // Passthrough to `opencode session <subcommand>`.
        args.action = 'session';
        args.passthrough = rawArgs.slice(i + 1);
        hasExplicitAction = true;
        break;
      } else {
        if (next === '--help' || next === '-h' || next === 'help') {
          printHelp();
          process.exit(0);
        }
        printUnknownCommand(`${arg}${next ? ` ${next}` : ''}`);
      }
    } else if (arg === 'auth') {
      // `auth` namespace — `open` launches the credential file editor,
      // `disconnect` removes a provider credential (the /connect logout
      // opencode never shipped; headless counterpart of /disconnect).
      const next = rawArgs[i + 1];
      if (next === 'open') {
        args.action = 'auth';
        i++; // consume 'open'
        hasExplicitAction = true;
      } else {
        if (next === '--help' || next === '-h' || next === 'help') {
          printHelp();
          process.exit(0);
        }
        printUnknownCommand(`auth${next ? ` ${next}` : ''}`);
      }
    } else if (arg === 'herdr' || arg === 'hr') {
      // `hr` is a short alias for `herdr` — same UX, 5 fewer chars.
      // Picked over `hd` for mnemonic clarity (first two letters of herdr).
      args.action = 'herdr';
      args.passthrough = rawArgs.slice(i + 1);
      hasExplicitAction = true;
      break;
    } else if (arg === 'herdr-config') {
      // `herdr-config` namespace — install / path / status helpers for the
      // bundled herdr config template.
      const next = rawArgs[i + 1];
      if (next === 'install') {
        args.action = 'herdr-config-install';
        i++; // consume 'install'
        hasExplicitAction = true;
      } else if (next === 'path') {
        args.action = 'herdr-config-path';
        i++; // consume 'path'
        hasExplicitAction = true;
      } else if (next === 'status') {
        args.action = 'herdr-config-status';
        i++; // consume 'status'
        hasExplicitAction = true;
      } else {
        if (next === '--help' || next === '-h' || next === 'help') {
          printHelp();
          process.exit(0);
        }
        printUnknownCommand(`herdr-config${next ? ` ${next}` : ''}`);
      }
    } else if (arg === '--force') {
      args.force = true;
    } else if (arg === '--days' || arg === '-d') {
      const n = parseInt(rawArgs[++i], 10);
      if (!Number.isNaN(n) && n > 0) args.cleanDays = n;
    } else if (arg === '--all') {
      args.cleanAll = true;
    } else if (arg === '--projects') {
      args.cleanAllProjects = true;
    } else if (arg === '--all-projects') {
      // Convenience form for `--all --projects`.
      args.cleanAll = true;
      args.cleanAllProjects = true;
    } else if (arg === '--dry-run') {
      args.cleanDryRun = true;
    } else if (arg === '--include-subagents') {
      args.cleanIncludeSubagents = true;
    } else if (arg === '--project') {
      args.cleanProject = rawArgs[++i];
    } else if (arg === '--project-name') {
      args.cleanProjectName = rawArgs[++i];
    } else if (arg === '--directory' || arg === '--dir') {
      args.cleanDirectory = rawArgs[++i];
    } else if (arg === '--cwd') {
      args.cleanDirectory = process.cwd();
    } else if (arg === '-Target' || arg === '--target' || arg === '-t') {
      args.target = rawArgs[++i];
    } else if (arg === '-Force' || arg === '--force' || arg === '-f') {
      args.force = true;
    } else if (arg === '-NoBackup' || arg === '--no-backup') {
      args.noBackup = true;
    } else if (arg === '-KeepBackups' || arg === '--keep-backups') {
      const n = parseInt(rawArgs[++i], 10);
      if (!Number.isNaN(n) && n >= 0) args.keepBackups = n;
    } else if (arg === '-Yes' || arg === '--yes' || arg === '-y') {
      args.yes = true;
    } else if (arg === '--wizard') {
      args.projectMode = 'wizard';
    } else if (arg === '--headless') {
      args.projectMode = 'headless';
    } else if (arg === '-BinDir' || arg === '--bin-dir') {
      args.binDir = rawArgs[++i];
    } else if (arg === '-OptionsFile' || arg === '--options-file') {
      args.optionsFile = rawArgs[++i];
    } else if (arg === '--help' || arg === '-h' || arg === 'help') {
      printHelp();
      process.exit(0);
    } else {
      printUnknownCommand(arg);
    }
  }

  // If no explicit action or flags provided and running in interactive TTY, launch wizard
  if (!hasExplicitAction && rawArgs.length === 0 && args.isInteractive) {
    args.action = 'wizard';
  }

  if (args.yes && args.projectMode === 'auto') {
    args.projectMode = 'headless';
  }

  if (args.cleanAllProjects && !args.cleanAll) {
    console.error('✗ --projects/--all-projects requires --all.');
    process.exit(2);
  }
  if (args.cleanAllProjects && (args.cleanProject || args.cleanProjectName || args.cleanDirectory)) {
    console.error('✗ --projects/--all-projects cannot be combined with --project, --directory, or --cwd.');
    process.exit(2);
  }

  return args;
}

function printHelp(): void {
  console.log(`
OpenCode Prime (OCP) Installer & Manager

Usage:
  pwsh install/install.ps1 [action] [options]
  ./install/install.sh [action] [options]
  bun run install/src/index.ts [action] [options]

Actions:
  (default)    Interactive setup wizard (in TTY) or install (in non-interactive)
  wizard       Launch the interactive TUI setup wizard
  tui          Launch the OpenCode terminal UI (exec opencode). With
                  tui_mode=herdr or tui_mode=luvus in options.jsonc launches a
                  managed workspace rooted at cwd. Default tui_mode is herdr.
                  Pass --herdr / --luvus / --direct to override
                 the config for this invocation
  serve        Launch the headless opencode server (opencode serve; all args pass through)
   web          Launch the OpenChamber web UI (auto-picks a free port unless --port is given)
                Subcommands: 'ocp web stop' stops; 'ocp web restart' restarts; '--daemon' runs in background
   code         Open the current project in VS Code (VSCodium / Cursor / Windsurf CLIs
                are probed too), auto-installing the OpenChamber editor extension
                (fedaykindev.openchamber) when missing. --init scaffolds/activates
                the OCP project first
   desktop      Launch the OpenChamber native desktop app (alias: ui)
  project      Project-level commands:
                 init   Launch the project wizard in a TTY; use --headless for scripts
                 index  Refresh existing code-intelligence indexes
                 sync   Append newly added template switches to the project config
  install      Install or update OpenCode Prime configuration files
  update       Check the suite + companion tools (opencode, openchamber) for updates;
               apply the selected ones in an interactive TTY (Enter = keep, n = skip);
               -y applies ALL pending updates without prompting; --check-only
               probes versions and applies nothing (default without -y when non-interactive)
  upgrade      Download the latest release tarball, overlay it onto the repo
               directory, and re-apply the installer (works the same whether
               you installed via \`git clone\` or not)
   session        Manage sessions: list, projects, delete (passthrough), clean
     provider       Manage providers; interactive mode embeds the /provider TUI wizard (list is non-interactive)
     profile        Manage profiles; interactive mode embeds the /profile TUI wizard (list, apply, reset --yes are non-interactive)
     usage [scope]  Show token/cost usage: --all (default) selects from every project;
                    . selects from the current directory; a session ID opens it directly
  auth           Open OpenCode's auth.json: 'auth open' (creates the file if missing)
  herdr          Launch Herdr (https://herdr.dev) and open the current directory
                 as a focused workspace (label = directory basename); passthrough
                 args (e.g. --session, --no-session) are forwarded to the TUI
                 (short alias: hr)
  herdr-config   Manage the bundled herdr config:
                   install   deploy to ~/.config/herdr/config.toml (non-destructive
                             unless --force is passed)
                   status    report whether the user's herdr config exists
                   path      print the path of the bundled template
  status         Check installed version and comparison with current repo
  init         Backup and reset the target configuration directory
  uninstall    Safely remove installed managed configuration files
  register     Register global 'opencode-prime' & 'ocp' command shims into PATH
  unregister   Remove global 'opencode-prime' & 'ocp' command shims

Options:
  -t, --target <path>      Custom target directory (default: ~/.config/opencode)
  -f, --force              Force install even if version is unchanged
  --no-backup              Skip automatic backup of existing configuration
  --keep-backups <n>       Max backups kept after each run (default: 5, env: OCP_MAX_BACKUPS)
  -y, --yes                Skip confirmation prompts (update: apply all pending)
  --wizard                 project init: force the interactive project wizard
  --headless               project init: skip prompts and run headless initialization
  --check-only             update: check versions only, apply nothing
  --bin-dir <path>         Target directory for global command shim (default: ~/.local/bin)
  -h, --help               Show this help message

Session subcommands:
  session list [args...]    List sessions (passthrough to opencode)
   session projects         List workspaces with saved sessions
  session delete <id>       Delete a session (passthrough to opencode)
   session clean [--days <n> | --all]  Delete old sessions (default: 7 days)
     --days, -d <n>           Delete sessions older than N days (default: 7)
     --all                    Delete every session in the current workspace, including subagents; requires confirmation
     --projects                With --all, delete sessions across every saved project; requires confirmation
     --all-projects            Alias for --all --projects; requires confirmation
    --project <id|name>      Delete sessions by project_id or project path/name
    --project-name <name>    Alias for --project when using a name/path
    --directory, --dir <path>  Delete sessions from a specific workspace path
    --cwd                    Shorthand for --directory <current directory>
    --dry-run                Preview what would be deleted without actually deleting
    --include-subagents      Also delete subagent (child) sessions
    -y, --yes                Skip the confirmation prompt
`);
}

/** Format one backend result for the project command report. */
function formatBackendLine(r: BackendResult): string {
  if (r.status === 'ran') return `  ✅ ${r.backend}: ${r.detail}`;
  if (r.status === 'failed') return `  ❌ ${r.backend}: ${r.detail}`;
  return `  ⏭️ ${r.backend}: ${r.detail}`;
}

/** Format one scaffold result for the project command report. */
function formatScaffoldLine(r: ScaffoldResult): string {
  if (r.status === 'created') return `  ✅ created ${r.relPath}`;
  if (r.status === 'updated') return `  ♻️ updated ${r.relPath} (template switches appended)`;
  if (r.status === 'invalid') return `  ⚠️ malformed ${r.relPath}`;
  return `  ⏭️ kept ${r.relPath}`;
}

/** Format one sync result for the project command report. */
function formatSyncLine(r: SyncResult): string {
  if (r.status === 'missing') return '  ⚠️ project config does not exist — run `ocp project init` first';
  if (r.status === 'invalid') return '  ⚠️ project config is malformed (no proper closing brace) — left untouched';
  if (r.status === 'up-to-date') return '  ⏭️ project config already has every template switch';
  return `  ♻️ appended ${r.added.length} new switch line(s)`;
}

function formatHookLine(r: HookResult): string {
  if (r.status === 'registered') return `  ✅ ${r.hook}: ${r.detail}`;
  if (r.status === 'updated') return `  ♻️ ${r.hook}: ${r.detail}`;
  if (r.status === 'failed') return `  ❌ ${r.hook}: ${r.detail}`;
  return `  ⏭️ ${r.hook}: skipped — ${r.detail}`;
}

/**
 * `ocp project init|index|sync` — project-level scaffolding and index refresh.
 * Mirrors the `/project` slash command family, but driven from the terminal.
 */
async function executeProjectAction(action: 'project-init' | 'project-index' | 'project-sync'): Promise<number> {
  const rootDir = process.cwd();
  try {
    if (action === 'project-sync') {
      console.log(`[ocp] Syncing project config in ${rootDir}...`);
      const syncResult = syncProject(rootDir);
      console.log(formatSyncLine(syncResult));
      if (syncResult.added.length > 0) {
        console.log(syncResult.added.map((k) => `    + ${k}`).join('\n'));
      }
      return 0;
    }

    if (action === 'project-index') {
      console.log(`[ocp] Refreshing indexes in ${rootDir}...`);
      const backends = await indexProject(rootDir);
      console.log('Backends:');
      for (const r of backends) console.log(formatBackendLine(r));
      return 0;
    }

    // project-init: create if missing, sync + refresh if present.
    const result = await initProject({ root: rootDir, refreshExistingIndexes: true });
    console.log(result.configExisted
      ? `[ocp] Activating existing OCP project in ${rootDir}...`
      : `[ocp] No OCP project detected in ${rootDir} — creating one...`);
    console.log(`[ocp] project ${result.configExisted ? 'activated' : 'created'} in ${rootDir}`);
    console.log('');
    console.log('Files:');
    for (const r of result.files) console.log(formatScaffoldLine(r));
    console.log('');
    console.log('Backends:');
    for (const r of result.backends) console.log(formatBackendLine(r));
    console.log('');
    console.log('Hooks:');
    for (const r of result.hooks) console.log(formatHookLine(r));
    return 0;
  } catch (err: any) {
    console.error(`[ocp] project ${action.replace('project-', '')} failed: ${err?.message ?? String(err)}`);
    return 1;
  }
}

/**
 * Resolve the repository root directory at runtime.
 *
 * When the installer is run from source (bun run install/src/index.ts),
 * __dirname correctly points to install/src/ and two levels up gives the repo root.
 *
 * However, when run from the bundled dist/index.js (produced by `bun build`),
 * Bun hard-codes __dirname to the build machine's absolute path (e.g.
 * "D:\\OpenHub\\opencode-prime\\install\\src"), which does not exist on
 * end-user machines. This causes ENOTSUP errors when trying to mkdir
 * manifest paths under a non-existent directory tree.
 *
 * Fallback chain:
 *   1. __dirname (works for source mode)
 *   2. dirname(process.argv[1]) (works for bundled mode — argv[1] is the script path)
 *   3. process.cwd() (last resort)
 */
function resolveRepoDir(): string {
  // Try __dirname first (two levels up: install/src/ -> repo root)
  const candidates: string[] = [
    path.resolve(__dirname, '..', '..'),
  ];

  // In bundled mode, process.argv[1] is the actual script path on the user's machine
  if (process.argv[1]) {
    const scriptDir = path.dirname(path.resolve(process.argv[1]));
    // dist/index.js is at install/dist/index.js, so repo root is two levels up
    candidates.push(path.resolve(scriptDir, '..', '..'));
    // If script is install/src/index.ts, repo root is also two levels up
    candidates.push(path.resolve(scriptDir, '..', '..'));
  }

  // Last resort: cwd
  candidates.push(process.cwd());

  // Return the first candidate that contains install/version.json
  // (a legacy install/VERSION also qualifies, for pre-migration repos)
  for (const c of candidates) {
    if (
      fs.existsSync(path.join(c, 'install', 'VERSION')) ||
      fs.existsSync(path.join(c, 'install', 'version.json'))
    ) {
      return c;
    }
  }

  // If none matched, return the first candidate (let downstream errors surface naturally)
  return candidates[0];
}

async function main() {
  // Find repo root at runtime (see resolveRepoDir for fallback logic)
  const repoDir = resolveRepoDir();
  const text = loadLocale(repoDir, getPreferredLocaleCode());
  const copy = (key: keyof typeof text, fallback: string) => String(text[key] ?? fallback);
  const rawArgs = process.argv.slice(2);
  const args = parseCliArgs(rawArgs);

  if (args.action === 'tui') {
    // Mode resolution: tui_mode config is the default; explicit mode flags
    // on the command line override it for this invocation. The flags are
    // stripped from passthrough before forwarding to the launcher so
    // opencode and workspace providers don't see unknown mode args.
    const effectiveOptions = loadEffectiveOptions(repoDir, getDefaultTargetDir());
    const rawPassthrough = args.passthrough ?? [];
    const cliMode = rawPassthrough.includes('--luvus')
      ? 'luvus'
      : rawPassthrough.includes('--herdr')
        ? 'herdr'
        : rawPassthrough.includes('--direct')
          ? 'direct'
          : null;
    const withoutModeFlags = rawPassthrough.filter(
      (a) => a !== '--herdr' && a !== '--luvus' && a !== '--direct'
    );
    const { initRequested, passthrough } = normalizeTuiPassthrough(withoutModeFlags);
    if (initRequested) {
      const initCode = await executeProjectAction('project-init');
      if (initCode !== 0) process.exit(initCode);
    }
    const mode = cliMode ?? effectiveOptions.tui_mode ?? 'direct';
    if (mode === 'herdr') {
      process.exit(runTuiEngine(repoDir, 'herdr', passthrough));
    }
    if (mode === 'luvus') {
      process.exit(runTuiEngine(repoDir, 'luvus', passthrough));
    }
    process.exit(launchTui(passthrough));
  }

  if (args.action === 'serve') {
    process.exit(launchServe(args.passthrough ?? []));
  }

  if (args.action === 'update') {
    process.exit(await executeUpdate(repoDir, args.passthrough ?? []));
  }

  if (args.action === 'upgrade') {
    process.exit(await executeUpgrade(repoDir, args.passthrough ?? []));
  }

  if (args.action === 'web') {
    process.exit(launchWeb(args.passthrough ?? []));
  }

  if (args.action === 'code') {
    // Honor tools.openchamber_vscode for the auto-install, but still open
    // the editor either way — the command's primary job is launching VS Code.
    const effectiveOptions = loadEffectiveOptions(repoDir, getDefaultTargetDir());
    process.exit(
      await launchCode(args.passthrough ?? [], {
        ensureExtension: isOpenChamberSurfaceEnabled(effectiveOptions.tools, 'vscode'),
      })
    );
  }

  if (args.action === 'project-init') {
    const useWizard = args.projectMode === 'wizard' || (args.projectMode === 'auto' && args.isInteractive);
    if (useWizard) {
      if (!args.isInteractive) {
        console.error('[ocp] --wizard requires an interactive terminal; use --headless in CI or scripts.');
        process.exit(2);
      }
      process.exit(await runProjectWizard(process.cwd(), repoDir));
    }
    process.exit(await executeProjectAction('project-init'));
  }

  if (args.action === 'project-index' || args.action === 'project-sync') {
    process.exit(await executeProjectAction(args.action));
  }

  if (args.action === 'provider') process.exit(await runProviderCli(repoDir, args.passthrough ?? []));
  if (args.action === 'profile') process.exit(await runProfileCli(repoDir, args.passthrough ?? []));
  if (args.action === 'usage') process.exit(await runUsageCli(repoDir, args.passthrough ?? []));

  if (args.action === 'desktop') {
    process.exit(await launchDesktop(args.passthrough ?? []));
  }

  if (args.action === 'dashboard') {
    // The dashboard persisted its selections and exited cleanly. Continue in
    // this parent process so installer output is rendered in the user's shell.
    if (!applyUiInstallHandoff(args, await runTuiDashboard(repoDir))) return;
  }

  if (args.action === 'session') {
    // Passthrough to `opencode session <subcommand> <args>`.
    const { execFileSync } = require('node:child_process');
    try {
      const executable = getOpencodeExecutable();
      if (!executable) {
        console.error('✗ opencode CLI was not found.');
        console.error('  Install OpenCode first: https://opencode.ai');
        process.exit(1);
      }
      execFileSync(executable, ['session', ...(args.passthrough ?? [])], {
        stdio: 'inherit',
      });
    } catch {
      process.exit(1);
    }
    return;
  }

  if (args.action === 'session-projects') {
    await executeSessionProjects();
    return;
  }

  if (args.action === 'clean') {
    await executeClean({
      days: args.cleanDays ?? 7,
      all: args.cleanAll ?? false,
      allProjects: args.cleanAllProjects ?? false,
      dryRun: args.cleanDryRun ?? false,
      yes: args.yes,
      includeSubagents: args.cleanIncludeSubagents ?? false,
      project: args.cleanProject,
      projectName: args.cleanProjectName,
      // `--all` clears the current workspace unless cross-project scope was
      // explicitly requested. --directory and --project remain authoritative.
      directory: args.cleanDirectory ?? (args.cleanAll && !args.cleanAllProjects && !args.cleanProject && !args.cleanProjectName ? process.cwd() : undefined),
    });
    return;
  }

  if (args.action === 'auth') {
    const { ok, message } = await openAuthFile();
    console.log(message);
    process.exit(ok ? 0 : 1);
  }

  if (args.action === 'herdr') {
    process.exit(runTuiEngine(repoDir, 'herdr', args.passthrough ?? []));
  }

  if (args.action === 'herdr-config-install') {
    process.exit(executeHerdrConfigInstall(repoDir, args.force));
  }
  if (args.action === 'herdr-config-path') {
    process.stdout.write(`${repoDir}/install/herdr-config/config.toml\n`);
    process.exit(0);
  }
  if (args.action === 'herdr-config-status') {
    process.exit(executeHerdrConfigStatus());
  }

  if (args.action === 'wizard') {
    // Quick install hands off via the same shared protocol as the dashboard:
    // the wizard persisted its global-commands delta, the parent runs the
    // installer (with the wizard-chosen target, if any) in the user's shell.
    if (!applyUiInstallHandoff(args, await runInteractiveWizard(repoDir))) return;
  }

  const curVersion = getCurrentRepoVersion(repoDir);

  switch (args.action) {
    case 'status': {
      const st = executeStatus(repoDir, args.target);
      console.log(`${copy('statusRepoVersion', 'Repository Version')} : ${st.repoVersion}`);
      console.log(`${copy('statusInstalledVersion', 'Installed Version')}  : ${st.installedVersion || 'None'}`);
      console.log(`${copy('statusTargetDirectory', 'Target Directory')}   : ${st.targetDir}`);
      console.log(`${copy('statusState', 'Status')}             : ${st.isUpToDate ? copy('statusUpToDate', 'Up to date') : copy('statusUpdateAvailable', 'Update available')}`);
      console.log(`${copy('statusShippedFiles', 'Shipped Files')}      : ${st.shippedFilesCount}`);
      break;
    }
    case 'init': {
      const res = executeInit(repoDir, args);
      console.log(formatI18n(copy('resetComplete', 'Reset configuration target: {target}'), { target: res.targetDir }));
      if (res.backupPath) console.log(formatI18n(copy('backupSaved', 'Backup saved to {path}'), { path: res.backupPath }));
      break;
    }
    case 'uninstall': {
      const res = executeUninstall(repoDir, args);
      console.log(formatI18n(copy('uninstallComplete', 'Uninstalled {count} managed files from {target}'), { count: res.removedCount, target: res.targetDir }));
      break;
    }
    case 'register': {
      const reg = runGlobalRegistration(repoDir, args.binDir);
      console.log(reg.shimMessage);
      console.log(reg.pathMessage);
      break;
    }
    case 'unregister': {
      const res = unregisterShim(args.binDir);
      console.log(`Unregistered global command. Removed: ${res.removed.join(', ') || 'None'}`);
      break;
    }
    case 'install':
    default: {
      const effectiveOptions = loadEffectiveOptions(repoDir, args.target || getDefaultTargetDir(), args.optionsFile ? readJsoncFile<InstallOptions>(args.optionsFile) || {} : undefined);
      const wantGlobal = effectiveOptions.global_commands !== false;

      const res = executeInstall(repoDir, args);
      console.log(formatI18n(copy('installComplete', 'Installed v{version} to {target} ({count} files applied)'), { version: res.version, target: res.targetDir, count: res.filesInstalled }));
      if (res.backupPath) console.log(formatI18n(copy('backupSaved', 'Backup saved to {path}'), { path: res.backupPath }));

      if (wantGlobal) {
        const reg = runGlobalRegistration(repoDir, args.binDir);
        console.log(reg.shimMessage);
        console.log(reg.pathMessage);
      }

      // OpenChamber ships as three independent surfaces, one
      // tools.openchamber_* switch each (web / vscode / desktop).
      if (isOpenChamberSurfaceEnabled(effectiveOptions.tools, 'web')) {
        console.log(ensureOpenChamberWebCli().message);
      }
      if (isOpenChamberSurfaceEnabled(effectiveOptions.tools, 'vscode')) {
        console.log(ensureOpenChamberVscodeExtension().message);
      }
      if (isOpenChamberSurfaceEnabled(effectiveOptions.tools, 'desktop')) {
        console.log(checkOpenChamberDesktop().message);
      }
      break;
    }
  }
}

main().catch((err) => {
  console.error('Installer encountered an error:', err);
  process.exit(1);
});
