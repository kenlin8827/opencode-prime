import fs from 'node:fs';
import path from 'node:path';
import enLocale from '../locales/en.json' with { type: 'json' };
import zhLocale from '../locales/zh-CN.json' with { type: 'json' };
import { readOcpField, writeOcpField } from '../../plugins/shared/ocp-config';

export interface I18nMeta {
  code: string;
  name: string;
  hint: string;
}

export const EMBEDDED_LOCALES: Record<string, I18nText> = {
  'en': enLocale as unknown as I18nText,
  'zh-CN': zhLocale as unknown as I18nText,
};

export interface I18nText {
  _meta?: I18nMeta;
  wizardTitle: string;
  versionFreshPrompt: string;
  installedNote: string;
  notInstalledNote: string;
  menuPrompt: string;
  dashboardLabel: string;
  dashboardHint: string;
  dashboardTitle: string;
  dashboardTabBasic: string;
  dashboardTabTools: string;
  dashboardTabMcp: string;
  dashboardTabPlugins: string;
  dashboardTabReview: string;
  dashboardTabsLabel: string;
  dashboardTabsHint: string;
  dashboardTargetLabel: string;
  dashboardChangeSummaryLabel: string;
  dashboardEnabledSummary: string;
  dashboardReviewHint: string;
  quickInstallLabel: string;
  quickInstallHint: string;
  statusLabel: string;
  statusHint: string;
  registerLabel: string;
  registerHint: string;
  unregisterLabel: string;
  unregisterHint: string;
  unregisterDoneMsg: string;
  unregisterNothingMsg: string;
  globalUnregTitle: string;
  initLabel: string;
  initHint: string;
  uninstallLabel: string;
  uninstallHint: string;
  exitLabel: string;
  exitHint: string;
  targetDirPrompt: string;
  installingSpinner: string;
  installSuccessNote: string;
  saveOptionsSuccess: string;
  installSummaryTitle: string;
  primaryAgentLabel: string;
  primaryAgentHint: string;
  agentLabels: Record<string, { label: string; hint: string }>;
  rtkLabel: string;
  rtkHint: string;
  globalCommandsLabel: string;
  globalCommandsHint: string;
  openchamberWebLabel: string;
  openchamberWebHint: string;
  openchamberDesktopLabel: string;
  openchamberDesktopHint: string;
  openchamberVscodeLabel: string;
  openchamberVscodeHint: string;
  tuiModeLabel: string;
  tuiModeHint: string;
  toolLabels: Record<string, { label: string; hint: string }>;
  mcpLabels: Record<string, { label: string; hint: string }>;
  pluginLabels: Record<string, { label: string; hint: string }>;
  mcpSectionHeader: string;
  pluginSectionHeader: string;
  targetSectionHeader: string;
  targetHint: string;
  tiersSectionHeader: string;
  tiersHint: string;
  actionsSectionHeader: string;
  saveAndInstallBtn: string;
  saveAndInstallHint: string;
  saveOnlyBtn: string;
  saveOnlyHint: string;
  exitBtn: string;
  exitBtnHint: string;
  backBtn: string;
  backBtnHint: string;
  footerHelp: string;
  switchLangHint: string;
  enabled: string;
  disabled: string;
  on: string;
  off: string;
  stepRegisterPrompt: string;
  stepRegisterNote: string;
  globalRegDoneMsg: string;
  pathAddedMsg: string;
  pathPresentMsg: string;
  pathFailedMsg: string;
  selectLanguagePrompt: string;
  switchLanguageLabel: string;
  switchLanguageHint: string;
  thankYouOutro: string;
  configStatusDetail: string;
  globalRegTitle: string;
  confirmResetPrompt: string;
  confirmUninstallPrompt: string;
  confirmBtn: string;
  cancelBtn: string;
  confirmFooter: string;
  exitedDashboard: string;
  targetDirectoryPrompt: string;
  cycleTierHint: string;
  cycleAgentHint: string;
  installingTo: string;
  summaryVersion: string;
  summaryTarget: string;
  summaryInstalled: string;
  summaryBackup: string;
  unsavedChangesPrompt: string;
  statusRepoVersion: string;
  statusInstalledVersion: string;
  statusTargetDirectory: string;
  statusState: string;
  statusUpToDate: string;
  statusUpdateAvailable: string;
  statusShippedFiles: string;
  resetComplete: string;
  uninstallComplete: string;
  installComplete: string;
  backupSaved: string;
  registerGlobalYes: string;
  registerGlobalNo: string;
  installFailed: string;
  resetResult: string;
  uninstallResult: string;
}

export const FALLBACK_EN: I18nText = {
  wizardTitle: '⚡ OpenCode Prime (OCP) — Interactive Setup Wizard',
  versionFreshPrompt: 'Fresh Installation',
  installedNote: 'Installed version: v{version} (Target: {target})',
  notInstalledNote: 'Target not yet initialized (Target: {target})',
  menuPrompt: 'Select an action to proceed:',
  dashboardLabel: '🎛️ Open Control Center (Single-Screen TUI Switch Matrix)',
  dashboardHint: 'Full overview of default agent, RTK, and all MCP/Plugin switches',
  dashboardTitle: 'Dashboard',
  dashboardTabBasic: 'Basic',
  dashboardTabTools: 'Tools',
  dashboardTabMcp: 'MCP',
  dashboardTabPlugins: 'Plugins',
  dashboardTabReview: 'Review',
  dashboardTabsLabel: 'Tabs',
  dashboardTabsHint: 'Tabs · ←/→',
  dashboardTargetLabel: 'Installation target',
  dashboardChangeSummaryLabel: 'Change summary',
  dashboardEnabledSummary: '{count} enabled integrations will be saved.',
  dashboardReviewHint: 'Use the shortcuts below to save or install.',
  quickInstallLabel: '⚡ Quick Install (Recommended defaults)',
  quickInstallHint: 'Apply options.jsonc directly to your config directory',
  statusLabel: '📊 Check Status & Tracked Files',
  statusHint: 'Compare local repo with installed target version',
  registerLabel: '➕ Register Global Commands (ocp / opencode-prime → ~/.local/bin)',
  registerHint: 'Write CLI wrapper scripts into ~/.local/bin and add it to PATH',
  unregisterLabel: '➖ Unregister Global Commands (remove from ~/.local/bin)',
  unregisterHint: 'Remove CLI wrapper scripts from ~/.local/bin (PATH untouched)',
  unregisterDoneMsg: 'Unregistered global commands from {binDir}',
  unregisterNothingMsg: 'No global command shims found in {binDir}',
  globalUnregTitle: '🌐 Global Command Unregistration',
  initLabel: '🧹 Reset OpenCode Config Directory {target} (Auto Backup)',
  initHint: 'Back up and wipe the installed config directory for a fresh start',
  uninstallLabel: '❌ Uninstall Managed Configs (Preserve user data)',
  uninstallHint: 'Safely remove only tracked open-code files',
  exitLabel: '🚪 Exit',
  exitHint: 'Quit without making further changes',
  targetDirPrompt: 'Target installation directory:',
  installingSpinner: 'Installing OpenCode Prime configuration files...',
  installSuccessNote: 'Configuration successfully installed!',
  saveOptionsSuccess: 'Updated options saved to ~/.config/opencode/options.jsonc',
  installSummaryTitle: '📦 Installation Summary',
  primaryAgentLabel: 'Primary Agent',
  primaryAgentHint: 'Default agent loaded on session start (default_agent)',
  agentLabels: {
    lite: { label: 'Lite', hint: 'Lean daily agent for quick fixes, lookups, Q&A, and small edits.' },
    code: { label: 'Code', hint: 'Direct developer for implementation, fixes, refactoring, and tests.' },
    build: { label: 'Build', hint: 'Task coordinator that routes coding work to the appropriate specialist.' },
    plan: { label: 'Plan', hint: 'Planning coordinator for analysis, structured plans, and execution handoffs.' },
  },
  rtkLabel: 'RTK Tokenizer',
  rtkHint: 'Rust Token Killer proxy & plugin',
  globalCommandsLabel: 'Global Commands',
  globalCommandsHint: 'Register ocp / opencode-prime shims into ~/.local/bin and add it to PATH',
  openchamberWebLabel: 'OpenChamber Web',
  openchamberWebHint: 'Install the OpenChamber web UI CLI powering `ocp web` (needs Node.js 22+)',
  openchamberDesktopLabel: 'OpenChamber Desktop',
  openchamberDesktopHint: 'Native desktop app powering `ocp desktop` / `ocp ui` — separate download (https://openchamber.dev/download); install only checks presence',
  openchamberVscodeLabel: 'OpenChamber VS Code',
  openchamberVscodeHint: 'Editor extension powering `ocp code` — auto-installs fedaykindev.openchamber via the editor CLI',
  tuiModeLabel: 'TUI Mode',
  tuiModeHint: 'How `ocp tui` starts: direct (current shell), Herdr workspace, or Luvus workspace. Selecting a workspace mode provisions its integration.',
  toolLabels: {
    rtk: { label: 'RTK Tokenizer', hint: 'Rust Token Killer proxy & plugin' },
    openchamber_web: { label: 'OpenChamber Web', hint: 'Install the OpenChamber web UI CLI powering `ocp web` (needs Node.js 22+)' },
    openchamber_desktop: { label: 'OpenChamber Desktop', hint: 'Native desktop app powering `ocp desktop` / `ocp ui` — separate download (https://openchamber.dev/download); install only checks presence' },
    openchamber_vscode: { label: 'OpenChamber VS Code', hint: 'Editor extension powering `ocp code` — auto-installs fedaykindev.openchamber via the editor CLI' },
    herdr: { label: 'Herdr', hint: 'Terminal workspace manager for AI coding agents (https://herdr.dev) — `ocp herdr` opens current dir as workspace' },
    opencode: { label: 'OpenCode', hint: 'AI coding agent — powers `ocp tui`' },
  },
  mcpLabels: {
    serena: { label: 'Serena', hint: 'Semantic code navigation and editing through its MCP server.' },
    codegraph: { label: 'CodeGraph', hint: 'Repository relationship analysis; run `codegraph init` once per project.' },
    gitnexus: { label: 'GitNexus', hint: 'Repository intelligence integration; enable only when licensed and indexed.' },
    dbhub: { label: 'DBHub', hint: 'Database gateway; requires a project `dbhub.toml` and DSN.' },
    headroom: { label: 'Headroom', hint: 'Local compression MCP; its first run downloads a runtime and model.' },
    idea: { label: 'JetBrains IDEA', hint: 'JetBrains IDE MCP integration; enable the server in the IDE first.' },
  },
  pluginLabels: {
    '@dietrichgebert/ponytail': { label: 'Ponytail', hint: 'Bundled OpenCode interface enhancements.' },
    'opencode-qoder-bridge': { label: 'Qoder Bridge', hint: 'Qoder integration; requires a supported Node.js version and `qoder login`.' },
    'opencode-mem@2.24.3': { label: 'OpenCode Memory', hint: 'Captures persistent memory and may incur an LLM cost after idle sessions.' },
  },
  mcpSectionHeader: '── 🔌 MCP Servers (Space to toggle) ──',
  pluginSectionHeader: '── 🧩 External Plugins (Space to toggle) ──',
  targetSectionHeader: '── 📁 Installation Target ──',
  targetHint: 'Press Enter or Space to edit target path',
  tiersSectionHeader: '── 🎯 Agent Tier Mappings (Space to cycle tier) ──',
  tiersHint: 'Model tier mapping (flash, standard, pro, max, vision) used by /profile wizard',
  actionsSectionHeader: '── ⚡ Execution Actions ──',
  saveAndInstallBtn: '🚀 SAVE & INSTALL NOW',
  saveAndInstallHint: 'Apply configuration and install all files to target',
  saveOnlyBtn: '💾 SAVE CONFIGURATION',
  saveOnlyHint: 'Persist settings to options.jsonc without copying files',
  exitBtn: '🚪 EXIT',
  exitBtnHint: 'Close control center without saving',
  backBtn: '↩ BACK TO MAIN MENU',
  backBtnHint: 'Return to the wizard main menu',
  footerHelp: '[ ↑/↓/j/k: Move ]  [ Space: Toggle ]  [ L: Lang ]  [ Enter: Apply ]  [ ^S: Save ]  [ ^Z: Reset ]  [ ^A: Install ]  [ ^Q: Quit ]  [ Esc: Back ]',
  switchLangHint: 'Language switched to English',
  enabled: 'ENABLED',
  disabled: 'DISABLED',
  on: 'ON',
  off: 'OFF',
  stepRegisterPrompt: 'Register global commands (ocp / opencode-prime) into {binDir} and add it to your PATH?',
  stepRegisterNote: 'Shims are written into the bin directory and the directory is appended to your user PATH environment variable so the commands resolve in new terminals.',
  globalRegDoneMsg: 'Registered global commands into {binDir}',
  pathAddedMsg: 'Added {binDir} to your user PATH (takes effect in new terminals)',
  pathPresentMsg: '{binDir} is already on PATH — no changes needed',
  pathFailedMsg: 'Failed to update PATH automatically — please add {binDir} manually',
  selectLanguagePrompt: '🌐 Select Language:',
  switchLanguageLabel: '🌐 Switch Language',
  switchLanguageHint: 'Change UI display language',
  thankYouOutro: 'Thank you for using OpenCode Prime!',
  configStatusDetail: '📊 Config Status Details',
  globalRegTitle: '🌐 Global Command Registration',
  confirmResetPrompt: 'Are you sure you want to reset and clear {target}? (Backup created)',
  confirmUninstallPrompt: 'Safely uninstall all managed files from {target}?',
  confirmBtn: 'Confirm',
  cancelBtn: 'Cancel',
  confirmFooter: 'Enter confirms · Esc cancels',
  exitedDashboard: 'Exited OpenCode Setup Control Center.',
  targetDirectoryPrompt: 'Enter new target directory [{target}]: ',
  cycleTierHint: 'Space/Enter to cycle tier',
  cycleAgentHint: 'Space/Enter to cycle',
  installingTo: 'Installing configuration into {target}...',
  summaryVersion: 'Version',
  summaryTarget: 'Target Directory',
  summaryInstalled: 'Files Installed',
  summaryBackup: 'Backup Saved',
  unsavedChangesPrompt: 'You have unsaved changes. Save before leaving? (s = Save, d = Discard, c = Cancel): ',
  statusRepoVersion: 'Repository Version',
  statusInstalledVersion: 'Installed Version',
  statusTargetDirectory: 'Target Directory',
  statusState: 'Status',
  statusUpToDate: 'Up to date',
  statusUpdateAvailable: 'Update available',
  statusShippedFiles: 'Shipped Files',
  resetComplete: 'Reset configuration target: {target}',
  uninstallComplete: 'Uninstalled {count} managed files from {target}',
  installComplete: 'Installed v{version} to {target} ({count} files applied)',
  backupSaved: 'Backup saved to {path}',
  registerGlobalYes: 'Register global commands',
  registerGlobalNo: 'Skip global commands',
  installFailed: 'Installation failed: {error}',
  resetResult: 'Cleared {target}. Backup: {backup}.',
  uninstallResult: 'Removed {count} files from {target}.',
};

const localeCache: Record<string, I18nText> = {};

export const BUILTIN_LOCALE_METAS: I18nMeta[] = [
  { code: 'zh-CN', name: '简体中文', hint: '简体中文界面' },
  { code: 'en', name: 'English', hint: 'US English interface' },
];

export function getLocalesDir(repoDir: string): string {
  return path.join(repoDir, 'install', 'locales');
}

export function getAvailableLocales(repoDir?: string): I18nMeta[] {
  if (!repoDir) return BUILTIN_LOCALE_METAS;
  const localesDir = getLocalesDir(repoDir);
  if (!fs.existsSync(localesDir)) {
    return BUILTIN_LOCALE_METAS;
  }

  const files = fs.readdirSync(localesDir).filter((f) => f.endsWith('.json'));
  const metas: I18nMeta[] = [];

  for (const file of files) {
    const code = path.basename(file, '.json');
    const fullPath = path.join(localesDir, file);
    try {
      const content = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      if (content._meta) {
        metas.push(content._meta);
      } else {
        metas.push({
          code,
          name: code === 'zh-CN' ? '简体中文' : code === 'en' ? 'English' : code,
          hint: `${code} locale`,
        });
      }
    } catch {
      metas.push({ code, name: code, hint: `${code} locale` });
    }
  }

  return metas.length > 0 ? metas : BUILTIN_LOCALE_METAS;
}

export function loadLocale(repoDir: string, code: string): I18nText {
  const cacheKey = `${repoDir}:${code}`;
  if (localeCache[cacheKey]) {
    return localeCache[cacheKey];
  }

  // 1. Try embedded in-memory locale (fastest, standalone safe)
  if (EMBEDDED_LOCALES[code]) {
    localeCache[cacheKey] = EMBEDDED_LOCALES[code];
    return EMBEDDED_LOCALES[code];
  }

  // 2. Try file system locale if available
  const localesDir = getLocalesDir(repoDir);
  const localeFile = path.join(localesDir, `${code}.json`);

  if (fs.existsSync(localeFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(localeFile, 'utf8'));
      const merged = { ...FALLBACK_EN, ...raw };
      localeCache[cacheKey] = merged;
      return merged;
    } catch { }
  }

  const fallback = EMBEDDED_LOCALES['en'] || FALLBACK_EN;
  localeCache[cacheKey] = fallback;
  return fallback;
}

export function detectDefaultLocaleCode(): string {
  // 1. Environment variables
  const envLang = process.env.LANG || process.env.LC_ALL || process.env.LANGUAGE || '';
  if (/zh|cn|hans/i.test(envLang)) {
    return 'zh-CN';
  }

  // 2. Intl system locale
  try {
    const sysLocale = Intl.DateTimeFormat().resolvedOptions().locale;
    if (/zh|cn/i.test(sysLocale)) return 'zh-CN';
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (/Shanghai|Chongqing|Urumqi|Harbin|Beijing|PRC|Asia\/Taipei|Asia\/Hong_Kong/i.test(tz)) {
      return 'zh-CN';
    }
  } catch { }

  return 'en';
}

/** The locale selected in any OCP wizard is shared by the TUI and CLI. */
export function getPreferredLocaleCode(): string {
  const saved = readOcpField<string>('language');
  return EMBEDDED_LOCALES[saved ?? ''] ? saved! : detectDefaultLocaleCode();
}

/** Persist an explicit user choice; environment detection remains transient. */
export function setPreferredLocaleCode(code: string): void {
  if (EMBEDDED_LOCALES[code]) writeOcpField('language', code);
}

export function formatI18n(template: string, values: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => String(values[key] ?? `{${key}}`));
}
