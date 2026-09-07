import fs from 'node:fs';
import path from 'node:path';
import {
  executeInstall,
  executeStatus,
  getDefaultTargetDir,
  getCurrentRepoVersion,
  getInstalledVersion,
  loadEffectiveOptions,
  loadToolRegistry,
} from './installer';
import {
  parseDynamicOptionsSchema,
  updateOptionsJsoncInPlace,
} from './wizard';
import { runGlobalRegistration } from './shim';
import {
  checkOpenChamberDesktop,
  ensureOpenChamberWebCli,
  ensureOpenChamberVscodeExtension,
} from './openchamber';
import { CliArgs, InstallOptions } from './types';
import { loadLocale, getAvailableLocales, detectDefaultLocaleCode } from './i18n';

// ANSI color and formatting helpers
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  bgBlue: '\x1b[44m',
  bgCyan: '\x1b[46m',
  bgDark: '\x1b[48;5;236m',
  inverse: '\x1b[7m',
  clear: '\x1b[2J\x1b[3J\x1b[H',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
};

interface RowItem {
  id: string;
  type: 'lang' | 'agent' | 'tui_mode' | 'tool' | 'global_commands' | 'mcp' | 'plugin' | 'target' | 'action_install' | 'action_save' | 'action_back' | 'action_exit';
  key?: string;
  label: string;
  hint?: string;
}

interface InputKey {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
}

/**
 * Truncates a string safely to prevent terminal line wrapping
 */
function truncateText(str: string, maxLen: number): string {
  if (!str) return '';
  if (maxLen <= 3) return str.slice(0, Math.max(0, maxLen));
  const single = str.replace(/[\r\n]+/g, ' ').replace(/\s*\|\s*/g, ' — ').trim();
  return single.length > maxLen ? single.slice(0, maxLen - 3) + '...' : single;
}

/**
 * Approximate display width for terminal alignment. Most CJK characters
 * (Unified Ideographs, Hiragana, Katakana, Hangul, fullwidth forms) render
 * as two columns; everything else is one column. This is enough to keep
 * labels and colons aligned across Chinese/English mixes.
 */
function displayWidth(str: string): number {
  let width = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
      (code >= 0x3000 && code <= 0x303f) || // CJK Symbols and Punctuation
      (code >= 0xff00 && code <= 0xff60) || // Fullwidth ASCII
      (code >= 0xffe0 && code <= 0xffee) || // Fullwidth symbols
      (code >= 0x3040 && code <= 0x309f) || // Hiragana
      (code >= 0x30a0 && code <= 0x30ff) || // Katakana
      (code >= 0xac00 && code <= 0xd7af) || // Hangul Syllables
      (code >= 0x1100 && code <= 0x11ff) || // Hangul Jamo
      (code >= 0x1f000 && code <= 0x1ffff) || // Emoji + supplementary symbols (usually 2-col)
      (code >= 0x2600 && code <= 0x27bf)    // Misc symbols / dingbats
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function padDisplayEnd(str: string, targetWidth: number): string {
  const w = displayWidth(str);
  if (w >= targetWidth) return str;
  return str + ' '.repeat(targetWidth - w);
}

export interface DashboardResult {
  action: 'exit' | 'back';
  /** Final locale code selected inside the dashboard, so callers can stay in sync. */
  locale: string;
}

export async function runTuiDashboard(repoDir: string, initialLocale?: string): Promise<DashboardResult> {
  const version = getCurrentRepoVersion(repoDir);
  const repoOptionsPath = path.join(repoDir, 'install', 'options.jsonc');
  const availableLocales = getAvailableLocales(repoDir);
  let currentLocaleCode: string = initialLocale || detectDefaultLocaleCode();
  let targetDir = getDefaultTargetDir();

  // Load dynamic schema from repo defaults (read-only source of truth)
  const optionsContent = fs.existsSync(repoOptionsPath) ? fs.readFileSync(repoOptionsPath, 'utf8') : '{}';
  const schema = parseDynamicOptionsSchema(optionsContent, repoDir);

  // Mutable state: start from effective options (repo defaults + saved user overrides)
  // so the dashboard reflects what the next install would actually use.
  const effective = loadEffectiveOptions(repoDir, targetDir);
  let currentAgent = effective.default_agent ?? schema.defaultAgent.value;
  let currentGlobalCommands = effective.global_commands ?? schema.globalCommandsDefault;
  let currentTuiMode: 'direct' | 'herdr' = effective.tui_mode ?? 'direct';

  // Tool opt-ins come from install/tools.jsonc. Defaults: enabled; the user
  // can flip any of them. We seed from `effective.tools.<name>` so a saved
  // user override wins on the next install.
  const toolRegistry = loadToolRegistry(repoDir);
  const toolState: Record<string, boolean> = {};
  for (const name of Object.keys(toolRegistry?.tools ?? {})) {
    const userVal = effective.tools?.[name];
    toolState[name] = userVal !== false; // default-true
  }

  const mcpState: Record<string, boolean> = {};
  for (const item of schema.mcpItems) {
    mcpState[item.key] = (effective.mcp && typeof effective.mcp === 'object' && item.key in effective.mcp)
      ? Boolean(effective.mcp[item.key])
      : item.value;
  }
  const pluginState: Record<string, boolean> = {};
  for (const item of schema.pluginItems) {
    pluginState[item.key] = (effective.plugin && typeof effective.plugin === 'object' && item.key in effective.plugin)
      ? Boolean(effective.plugin[item.key])
      : item.value;
  }

  // Snapshot of the initial state so we can detect unsaved changes on Esc/Exit/Back.
  const initialAgent = currentAgent;
  const initialGlobalCommands = currentGlobalCommands;
  const initialTuiMode = currentTuiMode;
  const initialTargetDir = targetDir;
  const initialToolState = { ...toolState };
  const initialMcpState = { ...mcpState };
  const initialPluginState = { ...pluginState };

  // Available agent candidates — primary agents from opencode.template.jsonc;
  // fallback mirrors the template order if the template is unreadable.
  const availableAgents = schema.defaultAgent.choices.length > 0
    ? schema.defaultAgent.choices
    : ['lite', 'build', 'plan', 'code'];

  // Build selectable rows
  const buildRows = (): RowItem[] => {
    const t = loadLocale(repoDir, currentLocaleCode);
    const r: RowItem[] = [];

    // 0. Language / 语言
    const curLangMeta = availableLocales.find((l) => l.code === currentLocaleCode) || { name: currentLocaleCode };
    r.push({
      id: 'lang',
      type: 'lang',
      label: t.switchLanguageLabel || '🌐 Language / 语言',
      hint: `${t.switchLanguageHint} (Space/L to switch)`,
    });

    // 1. Agent
    r.push({
      id: 'agent',
      type: 'agent',
      label: t.primaryAgentLabel,
      hint: t.primaryAgentHint,
    });

    // 1b. TUI mode (direct | herdr) — how `ocp tui` launches
    r.push({
      id: 'tui_mode',
      type: 'tui_mode',
      label: t.tuiModeLabel,
      hint: t.tuiModeHint,
    });

    // 2. Tools (declared in install/tools.jsonc — fully data-driven)
    for (const [name, def] of Object.entries(toolRegistry?.tools ?? {})) {
      const labels = (t as any).toolLabels?.[name] || {};
      r.push({
        id: `tool:${name}`,
        type: 'tool',
        key: name,
        label: labels.label || def.description || name,
        hint: labels.hint || def.url || def.description || '',
      });
    }

    // 2b. Global Commands (ocp / opencode-prime)
    r.push({
      id: 'global_commands',
      type: 'global_commands',
      label: t.globalCommandsLabel,
      hint: t.globalCommandsHint,
    });

    // 3. MCP Servers
    for (const item of schema.mcpItems) {
      r.push({
        id: `mcp:${item.key}`,
        type: 'mcp',
        key: item.key,
        label: item.key,
        hint: item.hint,
      });
    }

    // 4. External Plugins
    for (const item of schema.pluginItems) {
      r.push({
        id: `plugin:${item.key}`,
        type: 'plugin',
        key: item.key,
        label: item.key,
        hint: item.hint,
      });
    }

    // 6. Target Directory
    r.push({
      id: 'target',
      type: 'target',
      label: t.targetSectionHeader.replace(/─/g, '').trim(),
      hint: t.targetHint,
    });

    // 7. Actions
    r.push({
      id: 'action_install',
      type: 'action_install',
      label: t.saveAndInstallBtn,
      hint: t.saveAndInstallHint,
    });
    r.push({
      id: 'action_save',
      type: 'action_save',
      label: t.saveOnlyBtn,
      hint: t.saveOnlyHint,
    });
    r.push({
      id: 'action_back',
      type: 'action_back',
      label: t.backBtn,
      hint: t.backBtnHint,
    });
    r.push({
      id: 'action_exit',
      type: 'action_exit',
      label: t.exitBtn,
      hint: t.exitBtnHint,
    });

    return r;
  };

  let rows = buildRows();
  let selectedIndex = 0;
  let inputMode: 'dashboard' | 'target' | 'confirm' = 'dashboard';
  let targetInput = '';
  let confirmAction: 'back' | 'exit' | null = null;

  const render = () => {
    const t = loadLocale(repoDir, currentLocaleCode);
    if (inputMode === 'confirm') {
      process.stdout.write(
        C.clear + C.hideCursor +
        `\n  ${C.bold}${t.unsavedChangesPrompt}${C.reset}\n` +
        `  ${C.dim}s = save, d = discard, c/Esc = cancel${C.reset}\n`
      );
      return;
    }

    if (inputMode === 'target') {
      const prompt = t.targetDirectoryPrompt.replace('{target}', targetDir);
      process.stdout.write(
        C.clear + C.showCursor +
        `\n  ${C.bold}${prompt}${C.reset}\n` +
        `  ${C.yellow}${targetInput}${C.reset}\n` +
        `  ${C.dim}Enter = confirm, Esc = cancel, Backspace = delete${C.reset}\n`
      );
      return;
    }

    const termWidth = process.stdout.columns || 100;
    const width = Math.max(76, Math.min(termWidth, 110));
    const line = '─'.repeat(width - 2);

    let buf = C.clear + C.hideCursor;

    // Header Box with Version Flow Detection
    const installedVer = getInstalledVersion(targetDir);
    let versionText = '';
    if (installedVer) {
      if (installedVer !== version) {
        versionText = `v${installedVer} ➔ v${version}`;
      } else {
        versionText = `v${version}`;
      }
    } else {
      versionText = `v${version} (${t.versionFreshPrompt || 'Fresh'})`;
    }

    const title = `${t.wizardTitle} [${versionText}] [Lang: ${currentLocaleCode}]`;
    buf += `${C.cyan}┌${line}┐${C.reset}\n`;
    buf += `${C.cyan}│${C.bold}  ${title}  ${C.reset}${' '.repeat(Math.max(0, width - title.length - 6))}${C.cyan}│${C.reset}\n`;
    buf += `${C.cyan}└${line}┘\n`;

    // Render Rows grouped by section in clean, compact layout
    let lastType = '';

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const isSelected = i === selectedIndex;
      const cursor = isSelected ? `${C.bold}${C.cyan} ▶ ${C.reset}` : '   ';

      // Section Dividers with concise 1-line margin
      if (row.type === 'mcp' && lastType !== 'mcp') {
        buf += `\n${C.bold}${C.cyan}  ${t.mcpSectionHeader}${C.reset}\n`;
      } else if (row.type === 'plugin' && lastType !== 'plugin') {
        buf += `\n${C.bold}${C.cyan}  ${t.pluginSectionHeader}${C.reset}\n`;
      } else if (row.type === 'target' && lastType !== 'target') {
        buf += `\n${C.bold}${C.cyan}  ${t.targetSectionHeader}${C.reset}\n`;
      } else if (row.type.startsWith('action_') && !lastType.startsWith('action_')) {
        buf += `\n${C.bold}${C.cyan}  ${t.actionsSectionHeader}${C.reset}\n`;
      }
      lastType = row.type;

      let valueDisplay = '';

      if (row.type === 'lang') {
        const curMeta = availableLocales.find((l) => l.code === currentLocaleCode) || { name: currentLocaleCode };
        valueDisplay = ` [ ${C.bold}${C.green}${curMeta.name}${C.reset} ]   ${C.dim}(Space / L to switch)${C.reset}`;
        buf += `  ${cursor}${padDisplayEnd(row.label, 20)}  ${valueDisplay}\n`;
      } else if (row.type === 'agent') {
        valueDisplay = ` [ ${C.bold}${C.yellow}${currentAgent}${C.reset} ]   ${C.dim}(${t.cycleAgentHint})${C.reset}`;
        buf += `  ${cursor}${padDisplayEnd(row.label, 20)}  ${valueDisplay}\n`;
      } else if (row.type === 'tui_mode') {
        valueDisplay = ` [ ${C.bold}${C.yellow}${currentTuiMode}${C.reset} ]   ${C.dim}(${t.cycleAgentHint})${C.reset}`;
        buf += `  ${cursor}${padDisplayEnd(row.label, 20)}  ${valueDisplay}\n`;
      } else if (row.type === 'tool' && row.key) {
        const enabled = toolState[row.key] !== false;
        valueDisplay = enabled
          ? ` [ ${C.green}${C.bold}✓ ${t.enabled}${C.reset} ]`
          : ` [ ${C.dim}  ${t.disabled}${C.reset} ]`;
        buf += `  ${cursor}${padDisplayEnd(row.label, 20)}  ${valueDisplay}\n`;
      } else if (row.type === 'global_commands') {
        valueDisplay = currentGlobalCommands
          ? ` [ ${C.green}${C.bold}✓ ${t.enabled}${C.reset} ]`
          : ` [ ${C.dim}  ${t.disabled}${C.reset} ]`;
        buf += `  ${cursor}${padDisplayEnd(row.label, 20)}  ${valueDisplay}\n`;
      } else if (row.type === 'mcp' && row.key) {
        const active = mcpState[row.key];
        const switchBadge = active
          ? `[ ${C.green}${C.bold}✓ ${t.on}${C.reset} ]`
          : `[ ${C.dim}  ${t.off}${C.reset} ]`;
        const nameBadge = isSelected ? `${C.bold}${C.yellow}${row.label.padEnd(16)}${C.reset}` : `${C.bold}${row.label.padEnd(16)}${C.reset}`;
        const maxHintLen = Math.max(10, width - 38);
        const safeHint = truncateText(row.hint || '', maxHintLen);
        buf += `  ${cursor}${switchBadge}  ${nameBadge}  ${C.dim}${safeHint}${C.reset}\n`;
      } else if (row.type === 'plugin' && row.key) {
        const active = pluginState[row.key];
        const switchBadge = active
          ? `[ ${C.green}${C.bold}✓ ${t.on}${C.reset} ]`
          : `[ ${C.dim}  ${t.off}${C.reset} ]`;
        const nameBadge = isSelected ? `${C.bold}${C.yellow}${row.label.padEnd(36)}${C.reset}` : `${C.bold}${row.label.padEnd(36)}${C.reset}`;
        const maxHintLen = Math.max(10, width - 58);
        const safeHint = truncateText(row.hint || '', maxHintLen);
        buf += `  ${cursor}${switchBadge}  ${nameBadge}  ${C.dim}${safeHint}${C.reset}\n`;
      } else if (row.type === 'target') {
        valueDisplay = `${C.yellow}${C.bold}${targetDir}${C.reset}`;
        buf += `  ${cursor}${row.label.padEnd(18)}: ${valueDisplay}\n`;
      } else if (row.type === 'action_install') {
        const btn = isSelected ? `${C.bgCyan}${C.bold}${row.label}  ${C.reset}` : `${C.bold}${C.green}${row.label}${C.reset}`;
        buf += `  ${cursor}${btn}\n`;
      } else if (row.type === 'action_save') {
        const btn = isSelected ? `${C.bgBlue}${C.bold}${row.label}  ${C.reset}` : `${C.cyan}${row.label}${C.reset}`;
        buf += `  ${cursor}${btn}\n`;
      } else if (row.type === 'action_back') {
        const btn = isSelected ? `${C.bgDark}${C.bold}${row.label}  ${C.reset}` : `${C.bold}${C.yellow}${row.label}${C.reset}`;
        buf += `  ${cursor}${btn}\n`;
      } else if (row.type === 'action_exit') {
        const btn = isSelected ? `${C.red}${C.bold}${row.label}${C.reset}` : `${C.dim}${row.label}${C.reset}`;
        buf += `  ${cursor}${btn}\n`;
      }
    }

    buf += `  ${C.dim}${t.footerHelp}${C.reset}\n`;

    process.stdout.write(buf);
  };

  return new Promise<DashboardResult>((resolve) => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    // Always leave stdin fully quiesced: no handlers, cooked mode, paused.
    // Callers re-arm with resume() before opening the next prompt — a paused
    // stream is the only deterministic hand-off between raw-mode TUIs.
    const cleanup = () => {
      process.stdout.write(C.clear + C.showCursor);
      // Detach our raw data handler; otherwise a "ghost" dashboard keeps
      // consuming keys behind the wizard/clack menu after returning.
      process.stdin.removeListener('data', handleInput);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    };

    const saveOptions = () => {
      // Persist user choices to the target directory, not the repo defaults,
      // so loadEffectiveOptions() can pick them up on the next install.
      const userOptionsPath = path.join(targetDir, 'options.jsonc');
      updateOptionsJsoncInPlace(userOptionsPath, {
        defaultAgent: currentAgent,
        tuiMode: currentTuiMode,
        tools: toolState,
        globalCommands: currentGlobalCommands,
        mcps: mcpState,
        plugins: pluginState,
      });
    };

    let settled = false;
    const settle = (result: DashboardResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const executeAndExit = (doInstall: boolean) => {
      const t = loadLocale(repoDir, currentLocaleCode);
      cleanup();

      saveOptions();
      console.log(`${C.green}✓ ${t.saveOptionsSuccess}${C.reset}\n`);

      if (doInstall) {
        console.log(`🚀 ${t.installingTo.replace('{target}', targetDir)}`);
        const latestOptions: InstallOptions = {
          default_agent: currentAgent,
          tui_mode: currentTuiMode,
          tools: toolState,
          global_commands: currentGlobalCommands,
          mcp: mcpState,
          plugin: pluginState,
        };

        const args: CliArgs = {
          action: 'install',
          target: targetDir,
          force: true,
          noBackup: false,
          yes: true,
          isInteractive: true,
        };

        const res = executeInstall(repoDir, args, latestOptions);
        console.log(`\n${C.bold}${C.green}${t.installSummaryTitle}${C.reset}`);
        console.log(`  • ${t.summaryVersion.padEnd(16)}: ${res.version}`);
        console.log(`  • ${t.summaryTarget.padEnd(16)}: ${res.targetDir}`);
        console.log(`  • ${t.summaryInstalled.padEnd(16)}: ${res.filesInstalled}`);
        if (res.backupPath) {
          console.log(`  • ${t.summaryBackup.padEnd(16)}: ${res.backupPath}`);
        }

        if (currentGlobalCommands) {
          const reg = runGlobalRegistration(repoDir);
          console.log(`  • ${t.globalCommandsLabel.padEnd(16)}: ${reg.shimMessage}`);
          console.log(`    ${reg.pathMessage}`);
        }

        // OpenChamber ships as three independent surfaces — each dashboard
        // toggle (tools.openchamber_web / _vscode / _desktop) provisions its
        // own surface at install time.
        const ocSurfaces: Array<[string, () => { message: string }]> = [
          ['openchamber_web', ensureOpenChamberWebCli],
          ['openchamber_vscode', () => ensureOpenChamberVscodeExtension()],
          ['openchamber_desktop', checkOpenChamberDesktop],
        ];
        for (const [key, run] of ocSurfaces) {
          if (toolState[key] === false) continue;
          const label = (t as any).toolLabels?.[key]?.label || key;
          console.log(`  • ${String(label).padEnd(16)}: ${run().message}`);
        }
      }

      settle({ action: 'exit', locale: currentLocaleCode });
    };

    const recordsEqual = (a: Record<string, boolean>, b: Record<string, boolean>): boolean => {
      const keysA = Object.keys(a);
      const keysB = Object.keys(b);
      if (keysA.length !== keysB.length) return false;
      return keysA.every((k) => a[k] === b[k]);
    };

    const hasChanges = (): boolean => {
      if (currentAgent !== initialAgent) return true;
      if (currentGlobalCommands !== initialGlobalCommands) return true;
      if (currentTuiMode !== initialTuiMode) return true;
      if (targetDir !== initialTargetDir) return true;
      if (!recordsEqual(toolState, initialToolState)) return true;
      if (!recordsEqual(mcpState, initialMcpState)) return true;
      if (!recordsEqual(pluginState, initialPluginState)) return true;
      return false;
    };

    const saveWithoutExit = () => {
      const t = loadLocale(repoDir, currentLocaleCode);
      try {
        saveOptions();
        console.log(`${C.green}✓ ${t.saveOptionsSuccess}${C.reset}`);
      } catch (err) {
        console.error(`${C.red}✗ Save failed: ${(err as Error).message}${C.reset}`);
      }
    };

    const resetToInitial = () => {
      currentAgent = initialAgent;
      currentGlobalCommands = initialGlobalCommands;
      currentTuiMode = initialTuiMode;
      targetDir = initialTargetDir;
      Object.assign(toolState, initialToolState);
      Object.assign(mcpState, initialMcpState);
      Object.assign(pluginState, initialPluginState);
      rows = buildRows();
    };

    const promptUnsavedChanges = (finalAction: 'back' | 'exit') => {
      confirmAction = finalAction;
      inputMode = 'confirm';
      render();
    };

    const handleKey = (str: string, key: InputKey) => {
      if (!key.name || settled) return;

      if (inputMode === 'confirm') {
        const lower = (str || '').toLowerCase();
        const action = confirmAction ?? 'back';

        if (key.name === 'escape' || lower === 'c' || key.name === 'return') {
          inputMode = 'dashboard';
          confirmAction = null;
          render();
          return;
        }

        if (lower === 's') {
          const t = loadLocale(repoDir, currentLocaleCode);
          try {
            saveOptions();
            cleanup();
            console.log(`${C.green}✓ ${t.saveOptionsSuccess}${C.reset}\n`);
            settle({ action, locale: currentLocaleCode });
          } catch (err) {
            inputMode = 'dashboard';
            confirmAction = null;
            console.error(`${C.red}✗ Save failed: ${(err as Error).message}${C.reset}`);
            render();
          }
          return;
        }

        if (lower === 'd') {
          cleanup();
          settle({ action, locale: currentLocaleCode });
          return;
        }

        inputMode = 'dashboard';
        confirmAction = null;
        render();
        return;
      }

      if (inputMode === 'target') {
        if (key.name === 'escape') {
          inputMode = 'dashboard';
          render();
          return;
        }

        if (key.name === 'return') {
          if (targetInput.trim()) {
            targetDir = path.resolve(targetInput.trim());
          }
          inputMode = 'dashboard';
          render();
          return;
        }

        if (key.name === 'backspace' || key.name === 'delete') {
          targetInput = targetInput.slice(0, -1);
          render();
          return;
        }

        if (!key.ctrl && !key.meta && str && str.length === 1) {
          targetInput += str;
          render();
        }
        return;
      }

      // Toggle Language: cycle available locales
      if ((str === 'l' || str === 'L') && rows[selectedIndex].type !== 'target') {
        const curIdx = availableLocales.findIndex((l) => l.code === currentLocaleCode);
        const nextIdx = (curIdx + 1) % availableLocales.length;
        currentLocaleCode = availableLocales[nextIdx].code;
        rows = buildRows();
        render();
        return;
      }

      // Quick shortcuts: save without exiting, reset, install, and quit.
      if (key.ctrl && key.name === 's') {
        saveWithoutExit();
        render();
        return;
      }
      if (key.ctrl && key.name === 'z') {
        resetToInitial();
        rows = buildRows();
        render();
        return;
      }
      if (key.ctrl && key.name === 'a') {
        executeAndExit(true);
        return;
      }
      if (key.ctrl && key.name === 'q') {
        if (hasChanges()) {
          promptUnsavedChanges('exit');
        } else {
          const t = loadLocale(repoDir, currentLocaleCode);
          cleanup();
          console.log(t.exitedDashboard);
          settle({ action: 'exit', locale: currentLocaleCode });
        }
        return;
      }

      // Back shortcut: Esc returns to previous level (wizard main menu)
      if (key.name === 'escape') {
        if (hasChanges()) {
          promptUnsavedChanges('back');
        } else {
          cleanup();
          settle({ action: 'back', locale: currentLocaleCode });
        }
        return;
      }

      // Exit shortcuts
      if ((key.ctrl && key.name === 'c') || (str === 'q' && rows[selectedIndex].type !== 'target')) {
        if (hasChanges()) {
          promptUnsavedChanges('exit');
        } else {
          const t = loadLocale(repoDir, currentLocaleCode);
          cleanup();
          console.log(t.exitedDashboard);
          settle({ action: 'exit', locale: currentLocaleCode });
        }
        return;
      }

      // Navigation
      if (key.name === 'up' || str === 'k') {
        selectedIndex = (selectedIndex - 1 + rows.length) % rows.length;
        render();
        return;
      }

      if (key.name === 'down' || str === 'j') {
        selectedIndex = (selectedIndex + 1) % rows.length;
        render();
        return;
      }

      // Actions on Space or Enter
      const currentRow = rows[selectedIndex];
      const t = loadLocale(repoDir, currentLocaleCode);

      if (key.name === 'space' || key.name === 'return') {
        if (currentRow.type === 'lang') {
          const curIdx = availableLocales.findIndex((l) => l.code === currentLocaleCode);
          const nextIdx = (curIdx + 1) % availableLocales.length;
          currentLocaleCode = availableLocales[nextIdx].code;
          rows = buildRows();
          render();
          return;
        } else if (currentRow.type === 'agent') {
          const curIdx = availableAgents.indexOf(currentAgent);
          const nextIdx = (curIdx + 1) % availableAgents.length;
          currentAgent = availableAgents[nextIdx];
        } else if (currentRow.type === 'tui_mode') {
          currentTuiMode = currentTuiMode === 'direct' ? 'herdr' : 'direct';
          // herdr mode implies tools.herdr=true — flip it here so the
          // panorama shows the dependency, and undo it on switch back.
          if (currentTuiMode === 'herdr') toolState.herdr = true;
          else toolState.herdr = false;
        } else if (currentRow.type === 'tool' && currentRow.key) {
          toolState[currentRow.key] = !toolState[currentRow.key];
        } else if (currentRow.type === 'global_commands') {
          currentGlobalCommands = !currentGlobalCommands;
        } else if (currentRow.type === 'mcp' && currentRow.key) {
          mcpState[currentRow.key] = !mcpState[currentRow.key];
        } else if (currentRow.type === 'plugin' && currentRow.key) {
          pluginState[currentRow.key] = !pluginState[currentRow.key];
        } else if (currentRow.type === 'target') {
          inputMode = 'target';
          targetInput = targetDir;
          render();
          return;
        } else if (currentRow.type === 'action_install') {
          executeAndExit(true);
          return;
        } else if (currentRow.type === 'action_save') {
          executeAndExit(false);
          return;
        } else if (currentRow.type === 'action_back') {
          if (hasChanges()) {
            promptUnsavedChanges('back');
          } else {
            cleanup();
            settle({ action: 'back', locale: currentLocaleCode });
          }
          return;
        } else if (currentRow.type === 'action_exit') {
          if (hasChanges()) {
            promptUnsavedChanges('exit');
          } else {
            cleanup();
            console.log(t.exitedDashboard);
            settle({ action: 'exit', locale: currentLocaleCode });
          }
          return;
        }

        render();
      }
    };

    const handleInput = (chunk: Buffer | string) => {
      const input = String(chunk);
      if (input === '\x1b[A') return handleKey('', { name: 'up', sequence: input });
      if (input === '\x1b[B') return handleKey('', { name: 'down', sequence: input });
      if (input === '\r' || input === '\n') return handleKey(input, { name: 'return', sequence: input });
      if (input === ' ') return handleKey(input, { name: 'space', sequence: input });
      if (input === '\x1b') return handleKey(input, { name: 'escape', sequence: input });
      if (input === '\x03') return handleKey(input, { name: 'c', sequence: input, ctrl: true });
      if (input === '\x13') return handleKey(input, { name: 's', sequence: input, ctrl: true });
      if (input === '\x1a') return handleKey(input, { name: 'z', sequence: input, ctrl: true });
      if (input === '\x01') return handleKey(input, { name: 'a', sequence: input, ctrl: true });
      if (input === '\x11') return handleKey(input, { name: 'q', sequence: input, ctrl: true });
      if (input === '\x7f' || input === '\b') return handleKey(input, { name: 'backspace', sequence: input });

      for (const ch of input) {
        handleKey(ch, { name: ch, sequence: ch });
      }
    };

    process.stdin.on('data', handleInput);
    render();
  });
}
