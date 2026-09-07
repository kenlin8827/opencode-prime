import fs from 'node:fs';
import path from 'node:path';
import * as p from '@clack/prompts';
import { CliArgs, InstallOptions } from './types';
import {
  executeInstall,
  executeStatus,
  executeInit,
  executeUninstall,
  getDefaultTargetDir,
  getCurrentRepoVersion,
  loadEffectiveOptions,
} from './installer';
import { getDefaultBinDir, runGlobalRegistration, isShimRegistered, unregisterShim } from './shim';
import { readJsoncFile, parseJsonc } from './merger';
import { runTuiDashboard } from './dashboard';
import {
  checkOpenChamberDesktop,
  ensureOpenChamberWebCli,
  ensureOpenChamberVscodeExtension,
  isOpenChamberSurfaceEnabled,
} from './openchamber';
import { loadLocale, getAvailableLocales, detectDefaultLocaleCode, I18nText } from './i18n';

export interface DynamicOptionItem {
  key: string;
  value: boolean;
  hint: string;
}

export interface DynamicSchema {
  defaultAgent: {
    value: string;
    hint: string;
    choices: string[];
  };
  globalCommandsDefault: boolean;
  mcpItems: DynamicOptionItem[];
  pluginItems: DynamicOptionItem[];
  toolItems: DynamicOptionItem[];
}

export function parseDynamicOptionsSchema(content: string, repoDir?: string): DynamicSchema {
  const schema: DynamicSchema = {
    defaultAgent: { value: 'code', hint: 'Default active agent', choices: [] },
    globalCommandsDefault: true,
    mcpItems: [],
    pluginItems: [],
    toolItems: [],
  };

  if (repoDir) {
    // Candidates must come from the template config — it is the source of
    // truth for what the installer actually writes. Scanning prompts/*.md
    // would list subagent-only prompts (mode: "subagent") that can never be
    // the primary agent. "all" also qualifies as selectable.
    const template = readJsoncFile<Record<string, any>>(path.join(repoDir, 'opencode.template.jsonc'));
    const agentMap = template?.agent;
    if (agentMap && typeof agentMap === 'object') {
      schema.defaultAgent.choices = Object.entries(agentMap)
        .filter(([, def]) => {
          const mode = (def as Record<string, any>)?.mode;
          return mode === 'primary' || mode === 'all';
        })
        .map(([name]) => name);
    }
  }

  const lines = content.split(/\r?\n/);
  let currentSection: 'root' | 'mcp' | 'plugin' | 'tools' | '' = 'root';
  let pendingComments: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (trimmed.startsWith('//')) {
      const commentText = trimmed.replace(/^\/\/\s*/, '').trim();
      if (commentText) {
        pendingComments.push(commentText);
      }
      continue;
    }

    if (!trimmed) {
      pendingComments = [];
      continue;
    }

    if (/"mcp"\s*:\s*\{/.test(trimmed)) {
      currentSection = 'mcp';
      pendingComments = [];
      continue;
    }
    if (/"plugin"\s*:\s*\{/.test(trimmed)) {
      currentSection = 'plugin';
      pendingComments = [];
      continue;
    }
    if (/"tools"\s*:\s*\{/.test(trimmed)) {
      currentSection = 'tools';
      pendingComments = [];
      continue;
    }
    if (trimmed === '}' || trimmed === '},') {
      currentSection = 'root';
      pendingComments = [];
      continue;
    }

    const agentMatch = trimmed.match(/"default_agent"\s*:\s*"([^"]+)"/);
    if (agentMatch) {
      schema.defaultAgent.value = agentMatch[1];
      if (pendingComments.length > 0) {
        schema.defaultAgent.hint = pendingComments.join(' ');
      }
      pendingComments = [];
      continue;
    }

    const globalCommandsMatch = trimmed.match(/"global_commands"\s*:\s*(true|false)/);
    if (globalCommandsMatch) {
      schema.globalCommandsDefault = globalCommandsMatch[1] === 'true';
      pendingComments = [];
      continue;
    }

    const boolMatch = trimmed.match(/"([^"]+)"\s*:\s*(true|false)/);
    if (boolMatch) {
      const key = boolMatch[1];
      const val = boolMatch[2] === 'true';
      const hint = pendingComments.length > 0 ? pendingComments.join(' ') : '';

      if (currentSection === 'mcp') {
        schema.mcpItems.push({ key, value: val, hint });
      } else if (currentSection === 'plugin') {
        schema.pluginItems.push({ key, value: val, hint });
      } else if (currentSection === 'tools') {
        schema.toolItems.push({ key, value: val, hint });
      }
      pendingComments = [];
      continue;
    }
  }

  return schema;
}

export function updateOptionsJsoncInPlace(
  filePath: string,
  updates: {
    defaultAgent?: string;
    globalCommands?: boolean;
    tuiMode?: 'direct' | 'herdr';
    tools?: Record<string, boolean>;
    mcps?: Record<string, boolean>;
    plugins?: Record<string, boolean>;
  }
): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let current: Record<string, any> = {};
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      current = parseJsonc(raw) || {};
    } catch {
      current = {};
    }
  }

  if (updates.defaultAgent !== undefined) current.default_agent = updates.defaultAgent;
  if (updates.globalCommands !== undefined) current.global_commands = updates.globalCommands;
  if (updates.tuiMode !== undefined) current.tui_mode = updates.tuiMode;
  if (updates.tools) {
    current.tools = { ...(current.tools || {}), ...updates.tools };
  }
  if (updates.mcps) {
    current.mcp = { ...(current.mcp || {}), ...updates.mcps };
  }
  if (updates.plugins) {
    current.plugin = { ...(current.plugin || {}), ...updates.plugins };
  }

  // Generic serialization: preserves any keys the user hand-edited (e.g. tiers),
  // unlike a hardcoded allow-list.
  const entries = Object.entries(current).filter(([, v]) => v !== undefined);
  const body = entries
    .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v, null, 2).replace(/\n/g, '\n  ')}`)
    .join(',\n');

  const content = body
    ? `// User option overrides — merged on top of repo defaults on every install.\n{\n${body}\n}\n`
    : '{}\n';

  fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * Register global command shims (ocp / opencode-prime) into
 * the default bin directory and make sure that directory is on the user's
 * PATH environment variable.
 */
function applyGlobalRegistration(repoDir: string, t: I18nText): void {
  const reg = runGlobalRegistration(repoDir);
  p.log.success(t.globalRegDoneMsg.replace('{binDir}', reg.binDir));

  if (!reg.pathSuccess) {
    p.log.warn(t.pathFailedMsg.replace('{binDir}', reg.binDir));
    return;
  }
  if (!reg.pathChanged) {
    p.log.info(t.pathPresentMsg.replace('{binDir}', reg.binDir));
    return;
  }
  p.log.success(t.pathAddedMsg.replace('{binDir}', reg.binDir));
}

export async function runInteractiveWizard(repoDir: string): Promise<void> {
  const version = getCurrentRepoVersion(repoDir);
  const repoOptionsPath = path.join(repoDir, 'install', 'options.jsonc');
  const availableLocales = getAvailableLocales(repoDir);
  let currentLocaleCode: string = detectDefaultLocaleCode();

  // 1. Language Prompt dynamically populated from locales directory
  const localeOptions = availableLocales.map((l) => ({
    value: l.code,
    label: l.name,
    hint: l.hint,
  }));

  const pickedLocale = await p.select({
    message: '🌐 Select Language / Language Picker:',
    initialValue: currentLocaleCode,
    options: localeOptions,
  });

  if (!p.isCancel(pickedLocale)) {
    currentLocaleCode = pickedLocale as string;
  }

  let t = loadLocale(repoDir, currentLocaleCode);
  p.intro(`${t.wizardTitle} (v${version})`);

  const status = executeStatus(repoDir);
  const installedVer = status.installedVersion;
  if (installedVer) {
    p.log.step(`🚀 ${t.installedNote.replace('{version}', installedVer).replace('{target}', status.targetDir)}`);
  } else {
    p.log.step(`✨ ${t.notInstalledNote.replace('{target}', status.targetDir)}`);
  }

  while (true) {
    t = loadLocale(repoDir, currentLocaleCode);

    // Adaptive menu order: on a fresh (not yet installed) machine lead with
    // the fastest path to a working setup; once installed, the dashboard is
    // the high-frequency entry and keeps the top spot.
    const installedNow = !!executeStatus(repoDir).installedVersion;
    const registeredNow = isShimRegistered();
    const defaultTarget = getDefaultTargetDir();

    const menuOptions = [
      {
        value: 'dashboard',
        label: t.dashboardLabel,
        hint: t.dashboardHint,
      },
      {
        value: 'quick_install',
        label: t.quickInstallLabel,
        hint: t.quickInstallHint,
      },
      {
        value: 'status',
        label: t.statusLabel,
        hint: t.statusHint,
      },
      {
        value: 'register',
        label: registeredNow ? t.unregisterLabel : t.registerLabel,
        hint: registeredNow ? t.unregisterHint : t.registerHint,
      },
      {
        value: 'init',
        label: t.initLabel.replace('{target}', defaultTarget),
        hint: t.initHint.replace('{target}', defaultTarget),
      },
      {
        value: 'uninstall',
        label: t.uninstallLabel,
        hint: t.uninstallHint,
      },
      {
        value: 'switch_lang',
        label: t.switchLanguageLabel,
        hint: t.switchLanguageHint,
      },
      {
        value: 'exit',
        label: t.exitLabel,
        hint: t.exitHint,
      },
    ];
    if (!installedNow) {
      const [first, second] = menuOptions;
      menuOptions[0] = second;
      menuOptions[1] = first;
    }

    const action = await p.select({
      message: t.menuPrompt,
      options: menuOptions,
    });

    if (p.isCancel(action) || action === 'exit') {
      p.outro(t.thankYouOutro);
      process.exit(0);
    }

    if (action === 'switch_lang') {
      const curIdx = availableLocales.findIndex((l) => l.code === currentLocaleCode);
      const nextIdx = (curIdx + 1) % availableLocales.length;
      currentLocaleCode = availableLocales[nextIdx].code;
      p.log.success(loadLocale(repoDir, currentLocaleCode).switchLangHint);
      continue;
    } else if (action === 'dashboard') {
      const result = await runTuiDashboard(repoDir, currentLocaleCode);
      if (result.action === 'back') {
        // Stay in sync with language switches made inside the dashboard
        currentLocaleCode = result.locale;
        // The dashboard always pauses stdin on exit; re-arm it so the next
        // clack prompt receives keystrokes again.
        process.stdin.resume();
        continue;
      }
      break;
    } else if (action === 'quick_install') {
      const targetInput = await p.text({
        message: t.targetDirPrompt,
        initialValue: defaultTarget,
        placeholder: defaultTarget,
      });

      if (p.isCancel(targetInput)) {
        continue;
      }

      const resolvedTarget = path.resolve(targetInput || defaultTarget);

      // Effective defaults: repo defaults < any previously saved user options
      const effectiveOptions = loadEffectiveOptions(repoDir, resolvedTarget);

      // Global Command Registration (ocp / opencode-prime) — default from effective options
      const defaultBinDir = getDefaultBinDir();
      const globalCmdsDefault = effectiveOptions.global_commands !== false;
      const registerGlobalCmds = await p.confirm({
        message: `${t.stepRegisterPrompt.replace('{binDir}', defaultBinDir)}\n  (${t.stepRegisterNote})`,
        initialValue: globalCmdsDefault,
      });
      if (p.isCancel(registerGlobalCmds)) {
        continue;
      }

      // Persist the choice back so subsequent installs / --yes respect it.
      if (registerGlobalCmds !== globalCmdsDefault) {
        const userOptionsPath = path.join(resolvedTarget, 'options.jsonc');
        updateOptionsJsoncInPlace(userOptionsPath, { globalCommands: registerGlobalCmds });
        console.log(`Options saved to: ${userOptionsPath}`);
      }

      const s = p.spinner();
      s.start(t.installingSpinner);

      const args: CliArgs = {
        action: 'install',
        target: resolvedTarget,
        force: true,
        noBackup: false,
        yes: true,
        isInteractive: true,
      };

      // Only pass the explicit choice this session; loadEffectiveOptions inside
      // executeInstall will merge repo defaults + saved user options again.
      const res = executeInstall(repoDir, args, { global_commands: registerGlobalCmds });
      s.stop(t.installSuccessNote);

      if (registerGlobalCmds) {
        applyGlobalRegistration(repoDir, t);
      }

      // OpenChamber ships as three independent surfaces, one
      // tools.openchamber_* switch each (web / vscode / desktop).
      if (isOpenChamberSurfaceEnabled(effectiveOptions.tools, 'web')) {
        p.log.step(ensureOpenChamberWebCli().message);
      }
      if (isOpenChamberSurfaceEnabled(effectiveOptions.tools, 'vscode')) {
        p.log.step(ensureOpenChamberVscodeExtension().message);
      }
      if (isOpenChamberSurfaceEnabled(effectiveOptions.tools, 'desktop')) {
        p.log.step(checkOpenChamberDesktop().message);
      }

      p.note(
        `Target: ${res.targetDir}\nVersion: ${res.version}\nFiles Installed: ${res.filesInstalled}${
          res.backupPath ? `\nBackup saved at: ${res.backupPath}` : ''
        }${registerGlobalCmds ? `\nGlobal Commands: Registered at ${defaultBinDir}` : ''}`,
        t.installSummaryTitle
      );
      break;
    } else if (action === 'status') {
      const st = executeStatus(repoDir);
      p.note(
        `Repo Version: ${st.repoVersion}\nInstalled Version: ${st.installedVersion || 'None'}\nTarget Directory: ${
          st.targetDir
        }\nStatus: ${st.isUpToDate ? '✓ Up to date' : '⚠ Out of sync / Needs update'}\nTracked Files: ${
          st.shippedFilesCount
        }`,
        t.configStatusDetail
      );
    } else if (action === 'register') {
      if (registeredNow) {
        const res = unregisterShim();
        const detail = res.removed.length > 0
          ? `${t.unregisterDoneMsg.replace('{binDir}', getDefaultBinDir())}\n${res.removed.map((f) => `- ${f}`).join('\n')}`
          : t.unregisterNothingMsg.replace('{binDir}', getDefaultBinDir());
        p.note(detail, t.globalUnregTitle);
      } else {
        applyGlobalRegistration(repoDir, t);
      }
    } else if (action === 'init') {
      const confirmInit = await p.confirm({
        message: t.confirmResetPrompt.replace('{target}', defaultTarget),
        initialValue: false,
      });
      if (confirmInit && !p.isCancel(confirmInit)) {
        const res = executeInit(repoDir, {
          action: 'init',
          force: true,
          noBackup: false,
          yes: true,
          isInteractive: true,
        });
        p.note(`Cleared ${res.targetDir}\nBackup saved: ${res.backupPath || 'None'}`, '🧹 Target Reset');
      }
    } else if (action === 'uninstall') {
      const confirmUninstall = await p.confirm({
        message: t.confirmUninstallPrompt.replace('{target}', defaultTarget),
        initialValue: false,
      });
      if (confirmUninstall && !p.isCancel(confirmUninstall)) {
        const res = executeUninstall(repoDir, {
          action: 'uninstall',
          force: true,
          noBackup: false,
          yes: true,
          isInteractive: true,
        });
        p.note(`Removed ${res.removedCount} files from ${res.targetDir}`, '❌ Uninstalled');
      }
    }
  }

  p.outro(t.thankYouOutro);
}
