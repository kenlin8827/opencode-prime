import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseJsonc,
  readJsoncFile,
  readTierMap,
  extractPreserveBag,
  mergeConfig,
  mergeUserOptions,
  getUserOptionsPath,
  normalizeLegacyAgent,
} from '../install/src/merger';
import { mergeTuiConfig } from '../install/src/cli-merger';
import {
  collectHistoricalShippedFiles,
  collectShippedFiles,
  generateManifest,
  getHistoryManifestPath,
  readManifest,
  readVersionJson,
} from '../install/src/manifest';
import {
  executeInstall,
  executeStatus,
  executeInit,
  executeUninstall,
  computeTargetManagedFiles,
  ensurePluginRuntimeDeps,
  getCurrentRepoVersion,
  getTargetInstalledManifestPath,
  loadEffectiveOptions,
  LOCAL_PM_ORDER,
  localPmOrder,
  mcpProvisionPlan,
  migrateGlobalOcpConfig,
  readTargetInstalledManifest,
  TUI_PLUGIN_RUNTIME_DEPS,
} from '../install/src/installer';
import { findPackageManager } from '../install/src/package-manager';
import type { ShellCommandResult } from '../install/src/shared/shell-command';
import { registerShim, unregisterShim } from '../install/src/shim';
import {
  parseDynamicOptionsSchema,
  updateOptionsJsoncInPlace,
} from '../install/src/wizard';
import {
  getAvailableLocales,
  loadLocale,
  detectDefaultLocaleCode,
} from '../install/src/i18n';

const repoDir = path.resolve(__dirname, '..');
const testTargetDir = path.join(os.tmpdir(), `opencode-installer-test-${Date.now()}`);
const testBinDir = path.join(os.tmpdir(), `opencode-bin-test-${Date.now()}`);

console.log('=== Starting Comprehensive Installer Test Suite ===\n');

// 1. JSONC & Merger Tests
console.log('Test 1: JSONC Parser & Preserved Bag Extraction');
const sampleJsonc = `// Single line comment\n{\n  /* block comment */\n  "key": "value",\n  "num": 42\n}`;
const parsed = parseJsonc(sampleJsonc);
if (parsed.key !== 'value' || parsed.num !== 42) throw new Error('JSONC parsing failed');
console.log('✓ JSONC Parser passed');

// Bug guarded (P1 #2): parseJsonc's old regex `replace(/,(\s*[}\]])/g, "$1")`
// was string-unsafe — a value containing `,]` or `,}` inside quotes was
// silently mangled. Any provider/model block with prose like "fast (<200ms)"
// followed by `,}` hit this. The single-pass scanner is now string-aware.
const tricky = parseJsonc(`{ "a": "x, y]", "b": [1, 2,], "c": "ok", }`);
if (tricky.a !== 'x, y]' || !Array.isArray(tricky.b) || tricky.b.length !== 2 || tricky.c !== 'ok') {
  throw new Error(`parseJsonc mangled a quoted string or trailing comma: ${JSON.stringify(tricky)}`);
}
console.log('✓ JSONC string-safe trailing-comma passed');

// 2. Dynamic Locales
console.log('\nTest 2: Locales Auto-Discovery & Loading');
const locales = getAvailableLocales(repoDir);
if (locales.length < 2) throw new Error(`Expected at least 2 locales, got ${locales.length}`);
const zh = loadLocale(repoDir, 'zh-CN');
const en = loadLocale(repoDir, 'en');
if (!zh.wizardTitle || !en.wizardTitle) throw new Error('Locale loading failed');
console.log(`✓ Locales passed (${locales.map(l => l.code).join(', ')})`);

// 3. Dynamic Options Schema Parsing & In-Place Update
console.log('\nTest 3: Dynamic Options.jsonc Schema & Preserving Update');
const optionsPath = path.join(repoDir, 'install', 'options.jsonc');
const schema = parseDynamicOptionsSchema(fs.readFileSync(optionsPath, 'utf8'), repoDir);
if (!schema.defaultAgent.value || schema.mcpItems.length === 0 || schema.pluginItems.length === 0) {
  throw new Error('Dynamic options parsing failed');
}
// Agent candidates must be the template's primary/all agents — never a raw
// prompts/ dir scan, which would offer subagent-only prompts as primaries.
const tmplAgents = Object.entries(
  (readJsoncFile<Record<string, any>>(path.join(repoDir, 'opencode.template.jsonc'))?.agents ?? {}) as Record<string, any>
)
  .filter(([, def]) => def?.mode === 'primary' || def?.mode === 'all')
  .map(([name]) => name);
if (JSON.stringify(schema.defaultAgent.choices) !== JSON.stringify(tmplAgents)) {
  throw new Error(`defaultAgent.choices must mirror template primary agents — got [${schema.defaultAgent.choices}], expected [${tmplAgents}]`);
}
console.log(`✓ Schema passed (Found ${schema.mcpItems.length} MCPs, ${schema.pluginItems.length} Plugins)`);

// 3b. User options merging
console.log('\nTest 3b: User Options Merge Logic');
const merged = mergeUserOptions(
  { default_agent: 'code', tools: { rtk: true }, mcp: { serena: true, codegraph: true }, plugin: { 'opencode-mem@2.24.3': true } },
  { default_agent: 'build', mcp: { serena: false }, plugin: { 'opencode-qoder-bridge': true } }
);
if (merged.default_agent !== 'build') throw new Error('mergeUserOptions failed to override top-level key');
if (merged.tools?.rtk !== true) throw new Error('mergeUserOptions dropped an unchanged key');
if (merged.mcp?.serena !== false || merged.mcp?.codegraph !== true) throw new Error('mergeUserOptions failed to merge nested mcp map');
if (merged.plugin?.['opencode-mem@2.24.3'] !== true || merged.plugin?.['opencode-qoder-bridge'] !== true) throw new Error('mergeUserOptions failed to merge nested plugin map');
console.log('✓ User options merge passed');

// 3d. mergeTuiConfig — V2 cli.json model: first install writes the template;
// user plugins preserved on upgrade; a v1 tui.jsonc is migrated when no
// cli.json exists yet.
console.log('\nTest 3d: CLI Config Merge — preserves user-added plugins across reinstalls');
const tuiMergeDir = path.join(os.tmpdir(), `opencode-cli-merge-test-${Date.now()}`);
const tuiRepoDir = path.join(tuiMergeDir, 'repo');
const tuiTargetDir = path.join(tuiMergeDir, 'target');
fs.mkdirSync(tuiRepoDir, { recursive: true });
fs.mkdirSync(tuiTargetDir, { recursive: true });
// Minimal V2 template
fs.writeFileSync(
  path.join(tuiRepoDir, 'cli.template.jsonc'),
  '{\n  "$schema": "https://opencode.ai/v2/cli.json",\n  "session": { "thinking": "show" },\n  "plugins": [\n    "./plugins/tui/a.ts",\n    "./plugins/tui/b.ts",\n  ]\n}\n',
  'utf8'
);

// Subtest 1: first install — no existing cli.json, write the template directly.
mergeTuiConfig(tuiRepoDir, tuiTargetDir);
const firstInstall = readJsoncFile<Record<string, any>>(path.join(tuiTargetDir, 'cli.json'));
if (!firstInstall || firstInstall.plugins.length !== 2) {
  throw new Error('First-install merge should write all template plugins');
}
if (firstInstall.session?.thinking !== 'show') {
  throw new Error('First-install merge should write template scalar fields');
}
if (firstInstall.$schema !== 'https://opencode.ai/v2/cli.json') {
  throw new Error('First-install merge should write $schema from template');
}
console.log('✓ First install writes template plugins + scalars (cli.json)');

// Subtest 2: user adds a custom plugin, then merge runs again — user plugin survives.
const existing = readJsoncFile<Record<string, any>>(path.join(tuiTargetDir, 'cli.json'));
existing.plugins.push('./plugins/tui/user-extra.ts');
existing.theme = { name: 'custom-user-theme' };   // user customization on a section the template doesn't carry
fs.writeFileSync(
  path.join(tuiTargetDir, 'cli.json'),
  JSON.stringify(existing, null, 2) + '\n',
  'utf8'
);
mergeTuiConfig(tuiRepoDir, tuiTargetDir);
const afterUpgrade = readJsoncFile<Record<string, any>>(path.join(tuiTargetDir, 'cli.json'));
const pluginPaths = afterUpgrade.plugins as string[];
if (!pluginPaths.includes('./plugins/tui/a.ts') || !pluginPaths.includes('./plugins/tui/b.ts')) {
  throw new Error('Re-install dropped a template plugin');
}
if (!pluginPaths.includes('./plugins/tui/user-extra.ts')) {
  throw new Error('Re-install must preserve user-added plugins');
}
if (pluginPaths.indexOf('./plugins/tui/a.ts') > pluginPaths.indexOf('./plugins/tui/user-extra.ts')) {
  throw new Error('Template plugins should come first, user additions after');
}
if (afterUpgrade.theme?.name !== 'custom-user-theme') {
  throw new Error('User scalar customizations should be preserved');
}
if (afterUpgrade.$schema !== 'https://opencode.ai/v2/cli.json') {
  throw new Error('$schema must always come from template');
}
console.log('✓ Re-install preserves user-added plugins + section customizations');

// Subtest 3: dedupe — if user already has a template plugin, no duplicate.
const withDup = readJsoncFile<Record<string, any>>(path.join(tuiTargetDir, 'cli.json'));
withDup.plugins.push('./plugins/tui/a.ts');   // duplicate of template plugin
fs.writeFileSync(
  path.join(tuiTargetDir, 'cli.json'),
  JSON.stringify(withDup, null, 2) + '\n',
  'utf8'
);
mergeTuiConfig(tuiRepoDir, tuiTargetDir);
const afterDedupe = readJsoncFile<Record<string, any>>(path.join(tuiTargetDir, 'cli.json'));
const aCount = (afterDedupe.plugins as string[]).filter((p) => p === './plugins/tui/a.ts').length;
if (aCount !== 1) {
  throw new Error(`Plugin dedupe failed — ./plugins/tui/a.ts appears ${aCount} times`);
}
console.log('✓ Re-install dedupes plugins already present in template');

// Subtest 4: V1→V2 migration — no cli.json, legacy tui.jsonc plugins survive
// (tuple form → {package, options}) and display_thinking becomes session.thinking.
fs.rmSync(path.join(tuiTargetDir, 'cli.json'));
fs.writeFileSync(
  path.join(tuiTargetDir, 'tui.jsonc'),
  '{\n  "$schema": "https://opencode.ai/tui.json",\n  "display_thinking": false,\n  "theme": "gruvbox",\n  "plugin": [\n    "./plugins/tui/legacy-user.ts",\n    ["./plugins/tui/tuple.ts", { "enabled": true }],\n  ]\n}\n',
  'utf8'
);
mergeTuiConfig(tuiRepoDir, tuiTargetDir);
const migrated = readJsoncFile<Record<string, any>>(path.join(tuiTargetDir, 'cli.json'));
const migPaths = (migrated.plugins as Array<string | { package: string }>).map((p) => (typeof p === 'string' ? p : p.package));
if (!migPaths.includes('./plugins/tui/legacy-user.ts') || !migPaths.includes('./plugins/tui/tuple.ts')) {
  throw new Error('V1 tui.jsonc plugins must be migrated into cli.json');
}
const tuple = (migrated.plugins as Array<{ package: string; options?: { enabled?: boolean } }>).find((p) => typeof p !== 'string' && p.package === './plugins/tui/tuple.ts');
if (!tuple || tuple.options?.enabled !== true) {
  throw new Error('V1 tuple plugin must become { package, options }');
}
if (migrated.session?.thinking !== 'hide') {
  throw new Error('Migrated legacy display_thinking=false must win over the template default (existing wins)');
}
if (migrated.theme?.name !== 'gruvbox') {
  throw new Error('Legacy theme scalar must migrate to theme.name');
}
console.log('✓ Legacy tui.jsonc migrated on first V2 merge (plugins tuple→object, theme→theme.name)');

// Subtest 5: removed_plugins retirement — a plugin dropped from the template
// (and listed in removed_plugins) is stripped from the user's cli.json on the
// next merge; the marker itself must not leak into the output. Mirrors the
// removed_agents contract on the opencode.jsonc side: without the list, the
// template-first union preserves the dead entry forever while the stale-file
// prune has already deleted its files.
fs.writeFileSync(
  path.join(tuiRepoDir, 'cli.template.jsonc'),
  '{\n  "removed_plugins": ["./plugins/tui/legacy-user.ts"],\n  "$schema": "https://opencode.ai/v2/cli.json",\n  "plugins": [\n    "./plugins/tui/a.ts",\n  ]\n}\n',
  'utf8'
);
mergeTuiConfig(tuiRepoDir, tuiTargetDir);
const afterRetire = readJsoncFile<Record<string, any>>(path.join(tuiTargetDir, 'cli.json'));
const retirePaths = (afterRetire.plugins as Array<string | { package: string }>).map((p) => (typeof p === 'string' ? p : p.package));
if (retirePaths.includes('./plugins/tui/legacy-user.ts')) {
  throw new Error('removed_plugins entry must be stripped from the merged cli.json');
}
if (!retirePaths.includes('./plugins/tui/a.ts') || !retirePaths.includes('./plugins/tui/tuple.ts')) {
  throw new Error('removed_plugins must not touch template or surviving user plugins (incl. object-form entries)');
}
if (afterRetire.removed_plugins !== undefined) {
  throw new Error('removed_plugins marker must not leak into cli.json');
}
console.log('✓ removed_plugins retires deleted factory plugins, marker stripped from output');

// Subtest 6: leaf-granularity defaults fill — a NEW template key nested
// inside a section the user already customized must propagate (the old
// top-level shallow merge lost it: the user's `session` object blocked the
// whole section), while existing leaves (incl. explicit false) never move.
fs.writeFileSync(
  path.join(tuiRepoDir, 'cli.template.jsonc'),
  '{\n  "$schema": "https://opencode.ai/v2/cli.json",\n  "session": { "thinking": "show", "compact": "auto" },\n  "keybinds": { "leader": "ctrl+x" },\n  "plugins": [ "./plugins/tui/a.ts" ]\n}\n',
  'utf8'
);
{
  const cur = readJsoncFile<Record<string, any>>(path.join(tuiTargetDir, 'cli.json'));
  cur.session = { thinking: 'hide' };   // user customized the section
  cur.keybinds = { quit: false };       // explicit false must survive
  fs.writeFileSync(path.join(tuiTargetDir, 'cli.json'), JSON.stringify(cur, null, 2) + '\n', 'utf8');
}
mergeTuiConfig(tuiRepoDir, tuiTargetDir);
const afterDeep = readJsoncFile<Record<string, any>>(path.join(tuiTargetDir, 'cli.json'));
if (afterDeep.session?.thinking !== 'hide') {
  throw new Error('Deep merge must not overwrite an existing user leaf');
}
if (afterDeep.session?.compact !== 'auto') {
  throw new Error('New template key inside a user-customized section must propagate');
}
if (afterDeep.keybinds?.quit !== false || afterDeep.keybinds?.leader !== 'ctrl+x') {
  throw new Error('Deep merge: explicit-false user leaf must survive, missing template leaf must fill');
}
console.log('✓ Leaf-granularity merge: template defaults fill missing keys, user leaves never overwritten');

// Subtest 7: malformed cli.json (external, user-editable input) — a JSON
// scalar or array at the top level is garbage, not state: the merge must
// re-seed from the template instead of crashing (scalar: property assignment
// throws in strict mode) or writing the bare array back (plugins lost).
for (const garbage of ['"just a string"', '[1, 2, 3]']) {
  fs.writeFileSync(path.join(tuiTargetDir, 'cli.json'), garbage + '\n', 'utf8');
  mergeTuiConfig(tuiRepoDir, tuiTargetDir);
  const reseeded = readJsoncFile<Record<string, any>>(path.join(tuiTargetDir, 'cli.json'));
  if (!reseeded || typeof reseeded !== 'object' || Array.isArray(reseeded)) {
    throw new Error(`Malformed cli.json (${garbage}) was written back instead of re-seeded`);
  }
  if (!Array.isArray(reseeded.plugins) || !reseeded.plugins.includes('./plugins/tui/a.ts')) {
    throw new Error(`Malformed cli.json (${garbage}): template plugins must be re-seeded`);
  }
  if (reseeded.$schema !== 'https://opencode.ai/v2/cli.json') {
    throw new Error(`Malformed cli.json (${garbage}): $schema must come from the template`);
  }
}
console.log('✓ Malformed cli.json (scalar/array) re-seeds from template instead of crashing/corrupting');

if (fs.existsSync(tuiMergeDir)) fs.rmSync(tuiMergeDir, { recursive: true, force: true });

// 3f. mergeConfig disclosure-layer upgrade propagation:
//   - `instructions` (L0) always takes the template value — a stale user array
//     must not block L0 slim-downs.
//   - Factory agents always follow the template (prompt/model upgrades reach
//     existing installs); only agents absent from the template are preserved.
//   - Retired factory agents (removed_agents) are dropped from the preserved
//     config and tiers.json, and the marker never leaks into the merged output.
//   - tiers.json presets are template-owned for factory agents — stale user
//     mappings never block repo-side tier-system adjustments; preserved
//     entries only stick for custom agents.
console.log('\nTest 3f: Config Merge — Template-Owned instructions & Factory Agents');
const cfgMergeDir = path.join(os.tmpdir(), `opencode-cfg-merge-test-${Date.now()}`);
const cfgRepoDir = path.join(cfgMergeDir, 'repo');
const cfgTargetDir = path.join(cfgMergeDir, 'target');
fs.mkdirSync(cfgRepoDir, { recursive: true });
fs.mkdirSync(cfgTargetDir, { recursive: true });
fs.writeFileSync(
  path.join(cfgRepoDir, 'opencode.template.jsonc'),
  '{\n  "removed_agents": ["ghost"],\n  "instructions": [\n    "~/.config/opencode/instructions/a.md",\n    "~/.config/opencode/instructions/b.md"\n  ],\n  "agents": {\n    "build": { "system": "T_BUILD" },\n    "code": { "system": "T_CODE" }\n  }\n}\n',
  'utf8'
);
fs.writeFileSync(
  path.join(cfgRepoDir, 'tiers.json'),
  '{\n  "$comment": "t",\n  "build": "standard",\n  "code": "pro"\n}\n',
  'utf8'
);
// Stale installed config: old L0 array + a MODIFIED factory agent + a RETIRED
// factory agent (ghost) + one custom agent
fs.writeFileSync(
  path.join(cfgTargetDir, 'opencode.jsonc'),
  '{\n  "instructions": ["old/1.md", "old/2.md", "old/3.md"],\n  "agents": {\n    "build": { "system": "OLD_MODIFIED_BUILD" },\n    "ghost": { "system": "RETIRED_FACTORY_AGENT" },\n    "my-agent": { "system": "CUSTOM_USER_AGENT" }\n  }\n}\n',
  'utf8'
);
fs.writeFileSync(
  path.join(cfgTargetDir, 'tiers.json'),
  '{\n  "$comment": "t",\n  "build": "max",\n  "ghost": "max",\n  "my-agent": "pro"\n}\n',
  'utf8'
);
const cfgBag = extractPreserveBag(cfgTargetDir);
mergeConfig(cfgRepoDir, cfgTargetDir, {} as any, cfgBag);
const cfgMerged = readJsoncFile<Record<string, any>>(path.join(cfgTargetDir, 'opencode.jsonc'));
if (JSON.stringify(cfgMerged?.instructions) !== JSON.stringify(['~/.config/opencode/instructions/a.md', '~/.config/opencode/instructions/b.md'])) {
  throw new Error('mergeConfig must take template instructions — stale user array leaked through');
}
if (cfgMerged?.agents?.build?.system !== 'T_BUILD') {
  throw new Error('Factory agent "build" must follow the template — stale user copy leaked through');
}
if (cfgMerged?.agents?.code?.system !== 'T_CODE') {
  throw new Error('Factory agent "code" missing — template agents must survive the merge');
}
if (cfgMerged?.agents?.['my-agent']?.system !== 'CUSTOM_USER_AGENT') {
  throw new Error('User-defined agent "my-agent" must be preserved verbatim');
}
if (cfgMerged?.agents?.ghost !== undefined) {
  throw new Error('Retired factory agent "ghost" must be dropped on upgrade');
}
if (cfgMerged?.removed_agents !== undefined) {
  throw new Error('removed_agents marker must not leak into the merged config');
}
const cfgTiers = readJsoncFile<Record<string, any>>(path.join(cfgTargetDir, 'tiers.json'));
if (cfgTiers?.ghost !== undefined) {
  throw new Error('Retired factory agent "ghost" must be dropped from tiers.json');
}
if (cfgTiers?.build !== 'standard') {
  throw new Error('tiers.json: stale factory-agent mapping "build: max" must be overwritten by the template preset');
}
if (cfgTiers?.code !== 'pro') {
  throw new Error('tiers.json: template preset for new factory agent "code" must survive the merge');
}
if (cfgTiers?.['my-agent'] !== 'pro') {
  throw new Error('tiers.json: preserved tier entry for custom agent "my-agent" must stick');
}
console.log('✓ instructions template-owned + factory-agent upgrade propagation + custom-agent preservation + retirement cleanup');
if (fs.existsSync(cfgMergeDir)) fs.rmSync(cfgMergeDir, { recursive: true, force: true });

// 3g. Native policy propagation (V2):
//   - opencode.template.jsonc carries `permissions` arrays as native V2
//     fields; mergeConfig copies them verbatim (no materialization step).
//   - Factory agents follow the template wholesale: a hand-edited rule set
//     on a factory agent is replaced on upgrade, not merged.
//   - Custom agents are preserved verbatim and stay policy-free unless the
//     user gave them policy — and a V1-legacy custom agent is converted
//     (prompt/disable/tools-map → system/disabled/permissions) on capture.
console.log('\nTest 3g: Config Merge — Native Policy Propagation');
const surfMergeDir = path.join(os.tmpdir(), `opencode-surface-test-${Date.now()}`);
const surfRepoDir = path.join(surfMergeDir, 'repo');
const surfTargetDir = path.join(surfMergeDir, 'target');
fs.mkdirSync(surfRepoDir, { recursive: true });
fs.mkdirSync(surfTargetDir, { recursive: true });
fs.writeFileSync(
  path.join(surfRepoDir, 'opencode.template.jsonc'),
  '{\n  "permissions": [{ "action": "*", "resource": "*", "effect": "allow" }],\n  "agents": {\n    "lite": { "system": "T_LITE", "permissions": [ { "action": "skill", "resource": "*", "effect": "deny" }, { "action": "serena_*", "resource": "*", "effect": "deny" }, { "action": "subagent", "resource": "*", "effect": "deny" }, { "action": "question", "resource": "*", "effect": "deny" } ] },\n    "build": { "system": "T_BUILD", "permissions": [ { "action": "serena_*", "resource": "*", "effect": "deny" } ] }\n  }\n}\n',
  'utf8'
);
fs.writeFileSync(
  path.join(surfRepoDir, 'tiers.json'),
  '{\n  "$comment": "t",\n  "lite": "flash",\n  "build": "standard"\n}\n',
  'utf8'
);
// Stale installed config (V1 legacy — exercises the upgrade path): a
// user-modified factory permission on lite (factory agents follow the
// template — hand edits are replaced, not merged), a V1 custom agent whose
// tools-map/permission-map must convert, and a clean V2 custom agent.
fs.writeFileSync(
  path.join(surfTargetDir, 'opencode.jsonc'),
  '{\n  "agent": {\n    "lite": { "prompt": "OLD_LITE", "permission": { "pencil_*": { "*": "deny" } } },\n    "my-legacy": { "prompt": "CUSTOM", "permission": { "edit": "deny", "bash": { "*": "deny", "git status*": "allow" } }, "tools": { "task": false, "write": false, "todowrite": true } },\n    "my-agent": { "system": "CUSTOM2" }\n  }\n}\n',
  'utf8'
);
const surfBag = extractPreserveBag(surfTargetDir);
mergeConfig(surfRepoDir, surfTargetDir, {} as any, surfBag);
const surfMerged = readJsoncFile<Record<string, any>>(path.join(surfTargetDir, 'opencode.jsonc'));
if (!Array.isArray(surfMerged?.permissions) || surfMerged.permissions[0]?.effect !== 'allow') {
  throw new Error('global permissions array must pass through from the template');
}
const litePermsJson = JSON.stringify(surfMerged?.agents?.lite?.permissions ?? []);
if (!litePermsJson.includes('"serena_*"') || !litePermsJson.includes('"skill"')) {
  throw new Error('lite permissions must propagate from the template');
}
if (litePermsJson.includes('pencil_')) {
  throw new Error('factory agents follow the template — hand-edited permission must be replaced, not merged');
}
const legacyCustom = surfMerged?.agents?.['my-legacy'];
if (legacyCustom?.system !== 'CUSTOM' || legacyCustom?.prompt !== undefined) {
  throw new Error('V1 custom agent: prompt must migrate to system on capture');
}
if (legacyCustom?.tools !== undefined || legacyCustom?.permission !== undefined) {
  throw new Error('V1 custom agent: legacy tools/permission maps must not survive the conversion');
}
const legacyPerms: Array<Record<string, string>> = legacyCustom?.permissions ?? [];
const findRule = (action: string, resource: string) =>
  legacyPerms.find((r) => r.action === action && r.resource === resource);
if (findRule('edit', '*')?.effect !== 'deny') throw new Error('V1 permission "edit":"deny" must convert');
if (!findRule('shell', '*') || !findRule('shell', 'git status*')) throw new Error('V1 bash rules must rename to shell with resources intact');
if (findRule('subagent', '*')?.effect !== 'deny') throw new Error('V1 tools.task:false must become subagent deny');
if (findRule('edit', '*') === undefined || legacyPerms.filter((r) => r.action === 'edit').some((r) => r.effect === 'allow')) {
  throw new Error('V1 tools.write:false must fold into edit deny, no allow leak');
}
if (legacyPerms.some((r) => r.action === 'todowrite')) throw new Error('todowrite has no V2 action — must be dropped');
if (JSON.stringify(legacyPerms) !== JSON.stringify([
  { action: 'edit', resource: '*', effect: 'deny' },
  { action: 'shell', resource: '*', effect: 'deny' },
  { action: 'shell', resource: 'git status*', effect: 'allow' },
  { action: 'subagent', resource: '*', effect: 'deny' },
  { action: 'edit', resource: '*', effect: 'deny' },
])) {
  // (last edit-deny from write:false — duplicates kept deliberately: order is v1 semantics)
  throw new Error(`V1 tools→permissions conversion order/content drifted: ${JSON.stringify(legacyPerms)}`);
}
if (surfMerged?.agents?.build?.permissions?.[0]?.action !== 'serena_*') {
  throw new Error('build permission must propagate from the template');
}
if (surfMerged?.agents?.['my-agent']?.permissions !== undefined) {
  throw new Error('custom agents without template entries must stay policy-free');
}
if (surfMerged?.agent !== undefined) {
  throw new Error('legacy agent block must not survive the merge');
}
if (fs.existsSync(surfMergeDir)) fs.rmSync(surfMergeDir, { recursive: true, force: true });
console.log('✓ Native V2 policy propagation: global + per-agent permissions, V1 custom-agent conversion, factory semantics intact');

// 3g-b. normalizeLegacyAgent unit pins (pure).
{
  const conv = normalizeLegacyAgent({
    prompt: 'P', disable: true, temperature: 0.2, variant: 'high',
    model: 'prov/model', tools: { '*': false, read: true },
    permission: { edit: 'deny' },
  });
  if (conv.system !== 'P' || conv.prompt !== undefined) throw new Error('normalizeLegacyAgent: prompt→system');
  if (conv.disabled !== true || conv.disable !== undefined) throw new Error('normalizeLegacyAgent: disable→disabled');
  if (conv.model !== 'prov/model#high' || conv.variant !== undefined) throw new Error('normalizeLegacyAgent: variant joins model ref');
  if (conv.request?.body?.temperature !== 0.2 || conv.temperature !== undefined) throw new Error('normalizeLegacyAgent: temperature→request.body');
  const firstDeny = conv.permissions.findIndex((r: any) => r.action === '*' && r.effect === 'deny');
  const readAllow = conv.permissions.findIndex((r: any) => r.action === 'read' && r.effect === 'allow');
  if (!(conv.permissions[0].action === 'edit' && firstDeny > 0 && readAllow > firstDeny)) {
    throw new Error('normalizeLegacyAgent: permission rules precede tools whitelist; allow after deny-all');
  }
  const externalAllow = conv.permissions.findIndex((r: any) => r.action === 'external_directory' && r.effect === 'allow');
  if (!(externalAllow > firstDeny && externalAllow < readAllow)) {
    throw new Error('normalizeLegacyAgent: tools-whitelist must re-allow external_directory between deny-all and the tool allows');
  }
  const passthrough = normalizeLegacyAgent({ system: 'S', permissions: [{ action: 'x', resource: '*', effect: 'ask' }] });
  if (passthrough.system !== 'S' || !Array.isArray(passthrough.permissions)) throw new Error('normalizeLegacyAgent: V2-shaped entry must pass through untouched');
  console.log('✓ normalizeLegacyAgent conversion unit pins passed');
}

// 3h. Real repo regression: the shipped template carries V2-native permission
// policy (the template is the policy source of truth), and plugin injection
// policy lives in plugin-scope.json.
const realTemplate = readJsoncFile<Record<string, any>>(path.join(repoDir, 'opencode.template.jsonc'));
const ruleAt = (list: Array<Record<string, string>>, action: string, resource: string) =>
  (list ?? []).filter((r) => r.action === action && r.resource === resource);
const lastEffect = (list: Array<Record<string, string>>, action: string, resource: string) => {
  const m = ruleAt(list, action, resource);
  return m.length ? m[m.length - 1].effect : undefined;
};
if (!Array.isArray(realTemplate?.permissions) || lastEffect(realTemplate.permissions, '*', '*') !== 'allow') {
  throw new Error('opencode.template.jsonc must carry a global allow-all V2 permission — policy lives in the template');
}
const litePerms = realTemplate?.agents?.lite?.permissions;
if (lastEffect(litePerms, '*', '*') !== 'deny') {
  throw new Error('shipped template lost the lite wildcard deny');
}
// lite's whitelist shape (v1 tools map folded into the ordered array): deny-all
// FIRST, tool allows after it (last-match-wins), and external_directory
// re-allowed so the wildcard deny does not stomp the v1 root-allow parity.
if ((litePerms ?? []).findIndex((r: any) => r.action === '*' && r.effect === 'deny') !== 0) {
  throw new Error('lite permissions must open with the {action:"*"} deny');
}
if (lastEffect(litePerms, 'external_directory', '*') !== 'allow') {
  throw new Error('lite must re-allow external_directory after the deny-all');
}
// Whitelisted V2 native set (bash→shell, write folds into edit, task→subagent,
// todowrite dropped) + question + tgrep_search + memory_note.
const liteRequired = ['read', 'edit', 'shell', 'grep', 'glob', 'webfetch', 'websearch', 'subagent', 'question', 'tgrep_search', 'memory_note'];
const liteMissing = liteRequired.filter((t) => lastEffect(litePerms, t, '*') !== 'allow');
if (liteMissing.length) {
  throw new Error('lite allow-list lost required V2 actions: ' + liteMissing.join(', '));
}
// lite's skill access is scoped to the agent-less commands (/handoff,
// /git-merge, /git-pick, /git-pull, /git-push, /git-rebase) plus
// /memory-summarize (agent: lite); every other skill stays denied. The skill
// group must come AFTER the tool allows so its wildcard deny is the last match
// for unlisted skill IDs.
if (lastEffect(litePerms, 'skill', '*') !== 'deny') {
  throw new Error('lite skill permission must deny "*"');
}
for (const s of ['handoff', 'memory-summarize', 'git-merge', 'git-pick', 'git-pull', 'git-push', 'git-rebase']) {
  if (lastEffect(litePerms, 'skill', s) !== 'allow') {
    throw new Error(`lite must allow skill "${s}" (scoped roster)`);
  }
}
if ((litePerms ?? []).some((r: any) => r.action === 'todowrite' || r.action === 'bash' || r.action === 'task')) {
  throw new Error('lite permissions must not carry V1 action names (bash/task/todowrite)');
}
// V2-native top-level keys present, V1 shapes gone:
if (realTemplate?.agent !== undefined || realTemplate?.plugin !== undefined || realTemplate?.snapshot !== undefined || realTemplate?.permission !== undefined) {
  throw new Error('shipped template must not carry V1 keys (agent/plugin/snapshot/permission)');
}
if (realTemplate?.snapshots !== true || !Array.isArray(realTemplate?.plugins) || realTemplate?.mcp?.servers?.serena?.disabled !== true || realTemplate?.mcp?.servers?.codegraph?.disabled !== false) {
  throw new Error('shipped template lost V2-native snapshots/plugins/mcp.servers shapes (enabled→disabled inverted)');
}
const realScope = readJsoncFile<Record<string, any>>(path.join(repoDir, 'plugin-scope.json'));
if (!realScope?.plugins?.['*']?.deny?.includes('lite') || !realScope.plugins['*'].deny.includes('subagent:*')) {
  throw new Error('shipped plugin-scope.json lost the default deny policy');
}
if (!fs.existsSync(path.join(repoDir, 'cli.template.jsonc'))) {
  throw new Error('cli.template.jsonc (V2 terminal-client template) missing from the repo');
}
console.log('✓ Template carries V2-native policy + shapes; plugin-scope.json carries the injector policy; cli.template ships');

// 3i. Model preservation: reinstall must preserve the user's model picks
// (root `model`, the flash tier, and per-agent `model` overrides set via
// /profile apply). Without this, the template defaults overwrite them. The
// v1 root `small_model` migrates into `agents.title.model` on restore.
console.log('\nTest 3i: Config Merge — Model ID Preservation');
const modelMergeDir = path.join(os.tmpdir(), `opencode-model-merge-test-${Date.now()}`);
const modelRepoDir = path.join(modelMergeDir, 'repo');
const modelTargetDir = path.join(modelMergeDir, 'target');
fs.mkdirSync(modelRepoDir, { recursive: true });
fs.mkdirSync(modelTargetDir, { recursive: true });
// Template with default model picks
fs.writeFileSync(
  path.join(modelRepoDir, 'opencode.template.jsonc'),
  '{\n  "model": "template/standard",\n  "agents": {\n    "title": { "model": "template/flash" },\n    "build": { "system": "T_BUILD" },\n    "code": { "system": "T_CODE", "model": "template/pro" }\n  }\n}\n',
  'utf8'
);
fs.writeFileSync(
  path.join(modelRepoDir, 'tiers.json'),
  '{\n  "$comment": "t",\n  "build": "standard",\n  "code": "pro"\n}\n',
  'utf8'
);
// User's installed config with custom model picks (set via /profile apply) —
// a V1 shape install to prove the small_model → agents.title.model upgrade.
fs.writeFileSync(
  path.join(modelTargetDir, 'opencode.jsonc'),
  '{\n  "model": "anthropic/claude-sonnet-4-20250514",\n  "small_model": "anthropic/claude-haiku-4-20250414",\n  "agent": {\n    "build": { "prompt": "T_BUILD", "model": "anthropic/claude-sonnet-4-20250514" },\n    "code": { "prompt": "T_CODE", "model": "anthropic/claude-sonnet-4-20250514" }\n  }\n}\n',
  'utf8'
);
fs.writeFileSync(
  path.join(modelTargetDir, 'tiers.json'),
  '{\n  "$comment": "t",\n  "build": "standard",\n  "code": "pro"\n}\n',
  'utf8'
);
const modelBag = extractPreserveBag(modelTargetDir);
if (modelBag.userModel !== 'anthropic/claude-sonnet-4-20250514') {
  throw new Error(`extractPreserveBag failed to capture root model: got ${modelBag.userModel}`);
}
if (modelBag.userSmallModel !== 'anthropic/claude-haiku-4-20250414') {
  throw new Error(`extractPreserveBag failed to capture root small_model: got ${modelBag.userSmallModel}`);
}
if (modelBag.userAgentModels?.code !== 'anthropic/claude-sonnet-4-20250514') {
  throw new Error(`extractPreserveBag failed to capture per-agent model: got ${modelBag.userAgentModels?.code}`);
}
console.log('✓ extractPreserveBag captures model / small_model (v1) / per-agent models');
mergeConfig(modelRepoDir, modelTargetDir, {} as any, modelBag);
const modelMerged = readJsoncFile<Record<string, any>>(path.join(modelTargetDir, 'opencode.jsonc'));
if (modelMerged?.model !== 'anthropic/claude-sonnet-4-20250514') {
  throw new Error(`mergeConfig overwrote root model with template: got ${modelMerged?.model}`);
}
if (modelMerged?.small_model !== undefined) {
  throw new Error('merged config must not carry the removed v1 small_model key');
}
if (modelMerged?.agents?.title?.model !== 'anthropic/claude-haiku-4-20250414') {
  throw new Error(`flash tier must restore into agents.title.model (v1 small_model upgrade): got ${modelMerged?.agents?.title?.model}`);
}
if (modelMerged?.agents?.code?.model !== 'anthropic/claude-sonnet-4-20250514') {
  throw new Error(`mergeConfig overwrote per-agent model with template: got ${modelMerged?.agents?.code?.model}`);
}
// Factory agent system still follows the template (not the user's old copy)
if (modelMerged?.agents?.build?.system !== 'T_BUILD') {
  throw new Error('Factory agent system must follow the template');
}
console.log('✓ mergeConfig preserves user model picks (small_model→agents.title.model) while template upgrades propagate');
if (fs.existsSync(modelMergeDir)) fs.rmSync(modelMergeDir, { recursive: true, force: true });

// 3j. Rename migration: factory agent `explorer` → `explore`. The user's
// preserved model pick must follow the rename; the retired key's agent block
// and tier entry must be dropped (via removed_agents), not preserved as
// user-defined leftovers.
console.log('\nTest 3j: Config Merge — explorer→explore Rename Migration');
const renameDir = path.join(os.tmpdir(), `opencode-rename-test-${Date.now()}`);
const renameRepoDir = path.join(renameDir, 'repo');
const renameTargetDir = path.join(renameDir, 'target');
fs.mkdirSync(renameRepoDir, { recursive: true });
fs.mkdirSync(renameTargetDir, { recursive: true });
fs.writeFileSync(
  path.join(renameRepoDir, 'opencode.template.jsonc'),
  '{\n  "removed_agents": ["explorer"],\n  "agents": {\n    "explore": { "system": "T_EXPLORE" }\n  }\n}\n',
  'utf8'
);
fs.writeFileSync(
  path.join(renameRepoDir, 'tiers.json'),
  '{\n  "$comment": "t",\n  "explore": "flash"\n}\n',
  'utf8'
);
// Installed config from before the rename (V1 shape): explorer carries a user model pick
fs.writeFileSync(
  path.join(renameTargetDir, 'opencode.jsonc'),
  '{\n  "agent": {\n    "explorer": { "prompt": "OLD_PROMPT", "model": "prov/flash-model" }\n  }\n}\n',
  'utf8'
);
fs.writeFileSync(
  path.join(renameTargetDir, 'tiers.json'),
  '{\n  "$comment": "t",\n  "explorer": "flash"\n}\n',
  'utf8'
);
const renameBag = extractPreserveBag(renameTargetDir);
mergeConfig(renameRepoDir, renameTargetDir, {} as any, renameBag);
const renameMerged = readJsoncFile<Record<string, any>>(path.join(renameTargetDir, 'opencode.jsonc'));
if (renameMerged?.agents?.explore?.model !== 'prov/flash-model') {
  throw new Error(`Rename migration must carry the user's model pick to explore: got ${renameMerged?.agents?.explore?.model}`);
}
if (renameMerged?.agents?.explorer !== undefined || renameMerged?.agent !== undefined) {
  throw new Error('Retired explorer agent block must be dropped on upgrade');
}
const renameTiers = readJsoncFile<Record<string, any>>(path.join(renameTargetDir, 'tiers.json'));
if (renameTiers?.explorer !== undefined) {
  throw new Error('Retired explorer tier entry must be dropped from tiers.json');
}
if (renameTiers?.explore !== 'flash') {
  throw new Error(`explore tier must follow the template: got ${renameTiers?.explore}`);
}
console.log('✓ explorer→explore rename: model pick migrated, retired keys dropped');
if (fs.existsSync(renameDir)) fs.rmSync(renameDir, { recursive: true, force: true });

// 3e. updateOptionsJsoncInPlace can create and update a user options file from scratch
console.log('\nTest 3e: Options File In-Place Update');
const scratchOptionsDir = path.join(os.tmpdir(), `opencode-options-test-${Date.now()}`);
const scratchOptionsPath = path.join(scratchOptionsDir, 'options.jsonc');
updateOptionsJsoncInPlace(scratchOptionsPath, {
  defaultAgent: 'build',
  globalCommands: false,
  tools: { rtk: false, openchamber: false, herdr: true, luvus: true },
  mcps: { serena: false, codegraph: true },
  plugins: { 'opencode-mem@2.24.3': true },
});
if (!fs.existsSync(scratchOptionsPath)) throw new Error('updateOptionsJsoncInPlace did not create the file');
const writtenOptions = readJsoncFile<InstallOptions>(scratchOptionsPath);
if (writtenOptions?.default_agent !== 'build') throw new Error('default_agent not written to scratch file');
if (writtenOptions?.tools?.rtk !== false) throw new Error('tools.rtk not written to scratch file');
if (writtenOptions?.tools?.luvus !== true) throw new Error('tools.luvus not written to scratch file');
if (writtenOptions?.tools?.openchamber !== false) throw new Error('tools.openchamber not written to scratch file');
if (writtenOptions?.global_commands !== false) throw new Error('global_commands not written to scratch file');
if (writtenOptions?.mcp?.serena !== false || writtenOptions?.mcp?.codegraph !== true) throw new Error('mcp map not written to scratch file');
if (writtenOptions?.plugin?.['opencode-mem@2.24.3'] !== true) throw new Error('plugin map not written to scratch file');

// Update again to verify merge behavior
updateOptionsJsoncInPlace(scratchOptionsPath, {
  defaultAgent: 'plan',
  mcps: { dbhub: true },
});
const mergedOptions = readJsoncFile<InstallOptions>(scratchOptionsPath);
if (mergedOptions?.default_agent !== 'plan') throw new Error('default_agent not updated');
if (mergedOptions?.tools?.rtk !== false) throw new Error('tools.rtk was dropped on update');
if (mergedOptions?.mcp?.serena !== false || mergedOptions?.mcp?.codegraph !== true || mergedOptions?.mcp?.dbhub !== true) {
  throw new Error('mcp map not merged on update');
}
console.log('✓ Options file in-place update passed');

// Update with an unknown key to verify generic serialization preserves it
updateOptionsJsoncInPlace(scratchOptionsPath, {
  mcps: { dbhub: false },
});
const preservedOptions = readJsoncFile<InstallOptions>(scratchOptionsPath);
if (preservedOptions?.plugin?.['opencode-mem@2.24.3'] !== true) {
  throw new Error('plugin map was dropped by generic serialization');
}
if (preservedOptions?.default_agent !== 'plan') {
  throw new Error('default_agent was dropped by generic serialization');
}
console.log('✓ Generic serialization preserves existing keys');
if (fs.existsSync(scratchOptionsDir)) fs.rmSync(scratchOptionsDir, { recursive: true, force: true });

// 3c. Effective options load from repo defaults + target user overrides
console.log('\nTest 3c: Effective Options Load');
const effective = loadEffectiveOptions(repoDir, testTargetDir, { tools: { openchamber: false } });
if (effective.tools?.openchamber !== false) throw new Error('loadEffectiveOptions failed to apply customOptions override');
if (!effective.mcp || typeof effective.mcp !== 'object') throw new Error('loadEffectiveOptions lost mcp defaults');

// Verify customOptions merge is nested, not wholesale replacement
const effective2 = loadEffectiveOptions(repoDir, testTargetDir, { mcp: { serena: false } });
if (effective2.mcp?.serena !== false) throw new Error('customOptions failed to override mcp.serena');
if (effective2.mcp?.codegraph !== true) throw new Error('customOptions replaced entire mcp map');
if (
  effective2.tui_mode !== 'herdr' ||
  effective2.tools?.openchamber_web !== false ||
  effective2.tools?.openchamber_vscode !== false
) {
  throw new Error('defaults must retain Herdr mode while opt-in surfaces stay disabled');
}
console.log('✓ Effective options load passed');

// 4. Manifest Generation
console.log('\nTest 4: Manifest Generation');
const version = getCurrentRepoVersion(repoDir);
const manifestRes = generateManifest(repoDir, version);
if (manifestRes.count === 0) throw new Error('Manifest is empty');
const manifestFiles = readManifest(manifestRes.path);
if (!manifestFiles || manifestFiles.length === 0) throw new Error('Failed to read manifest');
console.log(`✓ Manifest generated (${manifestRes.count} files)`);

// 4b. version.json + compacted historical manifest
const versionInfo = readVersionJson(repoDir);
if (!versionInfo || versionInfo.version !== version) throw new Error('version.json does not match repo version');
const histAll = collectHistoricalShippedFiles(repoDir, new Set());
const histSkipped = collectHistoricalShippedFiles(repoDir, new Set([version]));
if (histSkipped.length > histAll.length) throw new Error('historical manifest skip logic broken');
if (fs.existsSync(getHistoryManifestPath(repoDir))) {
  const historical = readManifest(getHistoryManifestPath(repoDir));
  if (!historical || historical.length === 0) throw new Error('history.manifest.txt is empty');
  if (!new Set(histAll).has(historical[0])) throw new Error('history.manifest.txt entries missing from the union');
}
console.log(`✓ version.json / history compaction passed (${histAll.length} historical entries)`);

// 4c. TUI plugin retirement coherence (BOM-derived check): a TUI plugin dir
// whose entrypoint (plugins/tui/<name>/tui.ts) appears in any historical
// manifest but not in the current one was REMOVED from the package — its
// registration must be retired via cli.template.jsonc `removed_plugins`, or
// existing installs keep a dangling cli.json entry forever (the union merge
// preserves it, the stale-file prune deletes its files). Auto-deriving the
// removal at RUNTIME was rejected: removed_plugins keys cover more than
// path-backed plugins, runtime derivation amplifies manifest-pollution
// accidents into user-config damage, and it couples registration lifecycle
// to file lifecycle. Explicit list executes; this BOM diff only verifies.
{
  const TUI_ENTRY_RE = /^plugins\/tui\/([^/]+)\/tui\.ts$/;
  const tuiDirsOf = (files: string[]) =>
    new Set(files.map((f) => TUI_ENTRY_RE.exec(f)?.[1]).filter((n): n is string => !!n));
  const histTui = tuiDirsOf(collectHistoricalShippedFiles(repoDir, new Set([version])));
  const curTui = tuiDirsOf(collectShippedFiles(repoDir));
  const cliTemplate = readJsoncFile<Record<string, any>>(path.join(repoDir, 'cli.template.jsonc'));
  const declaredRetired = new Set(
    (Array.isArray(cliTemplate?.removed_plugins) ? cliTemplate.removed_plugins : []).filter(
      (n: unknown): n is string => typeof n === 'string',
    ),
  );
  const undeclared = [...histTui]
    .filter((name) => !curTui.has(name))
    .filter((name) => !declaredRetired.has(`./plugins/tui/${name}`));
  if (undeclared.length > 0) {
    throw new Error(
      `TUI plugins removed from the package but not retired in cli.template.jsonc removed_plugins: ${undeclared.join(', ')}`,
    );
  }
  console.log(`✓ TUI plugin retirement coherent (historical ${histTui.size}, current ${curTui.size}, all removals declared)`);
}

// 5. Execution: Full Install with custom tiers
console.log('\nTest 5: Full Installation to Isolated Target');
const installRes = executeInstall(
  repoDir,
  {
    action: 'install',
    target: testTargetDir,
    force: true,
    noBackup: true,
    yes: true,
    isInteractive: false,
  },
  {
    tiers: {
      qa: 'flash',
      devops: 'max',
    },
  }
);
if (!installRes.success || installRes.filesInstalled === 0) throw new Error('Install failed');
if (!fs.existsSync(path.join(testTargetDir, 'opencode.jsonc'))) throw new Error('opencode.jsonc missing from target');
if (fs.existsSync(path.join(testTargetDir, 'opencode.template.jsonc'))) throw new Error('config template leaked into target — only the merged opencode.jsonc should be installed');
if (fs.existsSync(path.join(testTargetDir, 'cli.template.jsonc'))) throw new Error('CLI template leaked into target — only the merged cli.json should be installed');
if (!fs.existsSync(path.join(testTargetDir, 'cli.json'))) throw new Error('cli.json missing from target');
if (!fs.existsSync(path.join(testTargetDir, 'installed.version'))) throw new Error('installed.version missing');
if (!fs.existsSync(getTargetInstalledManifestPath(testTargetDir))) throw new Error('.ocp/installed.manifest.txt missing');
if (!fs.existsSync(path.join(testTargetDir, 'tiers.json'))) throw new Error('tiers.json missing from target');
const targetManagedManifest = readTargetInstalledManifest(testTargetDir);
if (!targetManagedManifest || targetManagedManifest.length === 0) throw new Error('Failed to read target installed manifest');
if (targetManagedManifest.includes('opencode.template.jsonc') || targetManagedManifest.includes('cli.template.jsonc')) {
  throw new Error('Target installed manifest must not include template input files');
}
if (!targetManagedManifest.includes('providers/llm-router.json')) {
  throw new Error('First-install target manifest should include seeded provider preset');
}

// Verify custom tiers were written and `code` keeps the shipped template value.
const targetTiers = readTierMap(testTargetDir);
if (targetTiers.qa !== 'flash' || targetTiers.devops !== 'max' || targetTiers.code !== 'pro') {
  throw new Error('Custom tiers merging failed');
}
console.log(`✓ Install passed (${installRes.filesInstalled} files written, custom tiers merged)`);

// 5a. Stale prune uses the target-managed set, not the package manifest. This
// catches files that remain package inputs but should never remain in target.
// The historical basis (install/versions/*.manifest.txt) is versioned per
// release line and may be empty on a fresh line (manifests compacted away at
// the minVersion floor), so this test SEEDS a self-contained historical
// manifest fixture — same repo, cleaned up in finally — instead of depending
// on accumulated release history being present.
console.log('\nTest 5a: Stale Prune Removes Non-Target Package Inputs');
fs.writeFileSync(path.join(testTargetDir, 'opencode.template.jsonc'), 'stale template\n', 'utf8');
fs.writeFileSync(path.join(testTargetDir, 'tui.template.jsonc'), 'stale tui template (v1 name)\n', 'utf8');
fs.writeFileSync(path.join(testTargetDir, 'cli.template.jsonc'), 'stale cli template\n', 'utf8');
const packageFiles = collectShippedFiles(repoDir);
const managedAfterFirstInstall = computeTargetManagedFiles(packageFiles, false);
if (
  managedAfterFirstInstall.includes('opencode.template.jsonc') ||
  managedAfterFirstInstall.includes('cli.template.jsonc')
) {
  throw new Error('computeTargetManagedFiles leaked template input files');
}
const fixtureManifestRel = path.join('install', 'versions', '1.99.9.manifest.txt');
const fixtureManifest = path.join(repoDir, fixtureManifestRel);
fs.mkdirSync(path.dirname(fixtureManifest), { recursive: true });
fs.writeFileSync(
  fixtureManifest,
  ['opencode.template.jsonc', 'tui.template.jsonc', 'cli.template.jsonc', 'instructions/ghost-v1.md'].join('\n') + '\n',
  'utf8',
);
fs.writeFileSync(path.join(testTargetDir, 'instructions', 'ghost-v1.md'), 'stale shipped instruction\n', 'utf8');
try {
  const staleRes = executeInstall(repoDir, {
    action: 'install',
    target: testTargetDir,
    force: true,
    noBackup: true,
    yes: true,
    isInteractive: false,
  });
  if (!staleRes.success) throw new Error('Stale-prune reinstall failed');
  if (fs.existsSync(path.join(testTargetDir, 'opencode.template.jsonc'))) {
    throw new Error('Stale opencode.template.jsonc survived reinstall');
  }
  if (fs.existsSync(path.join(testTargetDir, 'tui.template.jsonc'))) {
    throw new Error('Stale v1 tui.template.jsonc survived reinstall (renamed to cli.template.jsonc)');
  }
  if (fs.existsSync(path.join(testTargetDir, 'cli.template.jsonc'))) {
    throw new Error('Stale cli.template.jsonc survived reinstall');
  }
  if (fs.existsSync(path.join(testTargetDir, 'instructions', 'ghost-v1.md'))) {
    throw new Error('Stale historical shipped file survived reinstall');
  }
  const targetManagedManifestAfterReinstall = readTargetInstalledManifest(testTargetDir);
  if (!targetManagedManifestAfterReinstall || targetManagedManifestAfterReinstall.includes('providers/llm-router.json')) {
    throw new Error('Upgrade target manifest should exclude user-owned provider presets');
  }
} finally {
  fs.rmSync(fixtureManifest, { force: true });
}
console.log('✓ Stale prune removes template inputs (v1 + v2 names) and writes target-managed manifest');

// 5b. MCP CLI provisioning plan
console.log('\nTest 5b: MCP CLI Provisioning Plan');
const provisionPlan = mcpProvisionPlan(repoDir, { mcp: { serena: true, codegraph: true, dbhub: true, gitnexus: false, headroom: false } });
if (!Array.isArray(provisionPlan)) throw new Error('mcpProvisionPlan did not return an array');
// Disabled entries must never reach the plan, regardless of install field or PATH state.
if (provisionPlan.some((item) => item.name === 'headroom')) {
  throw new Error('mcpProvisionPlan included disabled headroom entry');
}
// Serena is installed on this machine (verified by checkExternalTools), so it should not appear.
// The plan should include only enabled MCPs that declare an install field and whose binary is missing.
for (const item of provisionPlan) {
  if (typeof item.name !== 'string' || typeof item.install !== 'string') {
    throw new Error('mcpProvisionPlan returned malformed entry');
  }
}
console.log(`✓ MCP provision plan passed (${provisionPlan.length} entries)`);

// 5c. Preset provider lives in providers/llm-router.json (not inlined into
// opencode.jsonc) and the install must not silently re-ship a user-deleted
// preset — the directory is user-owned after first install.
console.log('\nTest 5c: Preset Providers — Ship-Once, User-Owned');
const providersDir = path.join(testTargetDir, 'providers');
const llmRouterPresetPath = path.join(providersDir, 'llm-router.json');
if (!fs.existsSync(llmRouterPresetPath)) {
  throw new Error('First install did not seed providers/llm-router.json preset');
}
const userConfigAfterInstall = readJsoncFile<Record<string, any>>(path.join(testTargetDir, 'opencode.jsonc'));
if (userConfigAfterInstall?.provider?.['llm-router']) {
  throw new Error('opencode.jsonc inlines llm-router — should only live in providers/llm-router.json');
}
console.log('✓ First install seeds providers/llm-router.json, opencode.jsonc stays clean of inline providers');

// User deletes the preset file — install must not bring it back.
fs.rmSync(llmRouterPresetPath, { force: true });
const upgradeRes = executeInstall(repoDir, {
  action: 'install',
  target: testTargetDir,
  force: true,
  noBackup: true,
  yes: true,
  isInteractive: false,
});
if (!upgradeRes.success) throw new Error('Upgrade install failed');
if (fs.existsSync(llmRouterPresetPath)) {
  throw new Error('Upgrade silently re-shipped the user-deleted providers/llm-router.json preset');
}
console.log('✓ User-deleted preset stays deleted after upgrade');

// 5d. Provider seeding ledger (.ocp/providers.seeded.txt): seen-once, then
// user-owned — no version/manifest reasoning anywhere.
//   (a) a preset new to this machine (absent on disk, not in ledger) is seeded
//   (b) a same-named user file is adopted into the ledger, never clobbered
//   (c) a seen preset deleted by the user stays deleted on any later install
console.log('\nTest 5d: Provider Seeding Ledger');
const newPresetRel = 'providers/test-new-preset.json';
const newPresetSrc = path.join(repoDir, newPresetRel);
const newPresetDst = path.join(testTargetDir, newPresetRel);
const ledgerPath = path.join(testTargetDir, '.ocp', 'providers.seeded.txt');
const reInstall = () => executeInstall(repoDir, {
  action: 'install',
  target: testTargetDir,
  force: true,
  noBackup: true,
  yes: true,
  isInteractive: false,
});
fs.writeFileSync(newPresetSrc, '{"name":"test-new-preset"}\n', 'utf8');
try {
  fs.rmSync(newPresetDst, { force: true });
  if (!reInstall().success) throw new Error('Ledger seed install failed');
  if (!fs.existsSync(newPresetDst)) {
    throw new Error('Preset new to this machine was not seeded');
  }

  // (b) user content under the same name is adopted, not overwritten.
  fs.writeFileSync(newPresetDst, 'user-owned\n', 'utf8');
  if (!reInstall().success) throw new Error('No-clobber install failed');
  if (fs.readFileSync(newPresetDst, 'utf8') !== 'user-owned\n') {
    throw new Error('Seeding overwrote a same-named user file in providers/');
  }

  // (c) after adoption the ledger owns its fate: deletion sticks.
  fs.rmSync(newPresetDst, { force: true });
  if (!reInstall().success) throw new Error('Post-delete install failed');
  if (fs.existsSync(newPresetDst)) {
    throw new Error('Ledger failed to keep a user-deleted preset deleted');
  }
  if (!readManifest(ledgerPath)?.includes(newPresetRel)) {
    throw new Error('Ledger did not record the preset');
  }
  console.log('✓ Seed / no-clobber / deletion-sticks via .ocp/providers.seeded.txt');
} finally {
  fs.rmSync(newPresetSrc, { force: true });
  fs.rmSync(newPresetDst, { force: true });
}

// 6. Status Check
console.log('\nTest 6: Status Check');
const st = executeStatus(repoDir, testTargetDir);
if (!st.isUpToDate || st.installedVersion !== version) throw new Error('Status check mismatch');
console.log(`✓ Status check passed (Version: ${st.installedVersion}, Up-to-date: ${st.isUpToDate})`);

// 6.5 Global ocp.jsonc → ocp.json one-shot migration (ADR 0004 §3)
console.log('\nTest 6.5: Global OCP config migration (rename / collision / move / idempotency)');
{
  const migBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ocp-mig-test-'));
  const mkDir = (n: string) => {
    const d = path.join(migBase, n);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
  const origXdg = process.env.XDG_CONFIG_HOME;
  try {
    // Pin XDG to the sandbox for (a)/(b) so no branch can ever touch the
    // real ~/.config/opencode on the test machine.
    process.env.XDG_CONFIG_HOME = migBase;
    const d1 = mkDir('opencode'); // pluginDir === targetDir (common case)
    fs.writeFileSync(path.join(d1, 'ocp.jsonc'), '{ "language": "zh-CN" }');
    const r1 = migrateGlobalOcpConfig(d1);
    if (r1.action !== 'renamed') throw new Error(`mig a: expected renamed, got ${r1.action}`);
    if (fs.readFileSync(path.join(d1, 'ocp.json'), 'utf8') !== '{ "language": "zh-CN" }') throw new Error('mig a: content lost');
    if (fs.existsSync(path.join(d1, 'ocp.jsonc'))) throw new Error('mig a: legacy source remains');
    const r1b = migrateGlobalOcpConfig(d1);
    if (r1b.action !== 'skipped') throw new Error('mig a: re-run must be skipped (idempotent)');
    console.log('✓ rename + idempotent re-run');

    // (b) collision: both exist → keep both, warn, never delete
    fs.writeFileSync(path.join(d1, 'ocp.jsonc'), '{ "language": "en" }');
    const r2 = migrateGlobalOcpConfig(d1);
    if (r2.action !== 'collision') throw new Error('mig b: expected collision');
    if (!fs.existsSync(path.join(d1, 'ocp.jsonc')) || !fs.existsSync(path.join(d1, 'ocp.json'))) throw new Error('mig b: files must both survive');
    console.log('✓ collision keeps both');

    // (c) XDG-aware: runtime dir ≠ target — wrong-base legacy is MOVED
    const xdg = mkDir('xdg');
    const pluginDir = path.join(xdg, 'opencode');
    fs.mkdirSync(pluginDir, { recursive: true });
    const wrongBase = mkDir('wrongbase');
    fs.writeFileSync(path.join(wrongBase, 'ocp.jsonc'), '{ "language": "ja" }');
    process.env.XDG_CONFIG_HOME = xdg;
    const r3 = migrateGlobalOcpConfig(wrongBase);
    if (r3.action !== 'renamed' || !r3.message.includes('Moved')) throw new Error('mig c: expected move reported as renamed');
    if (JSON.parse(fs.readFileSync(path.join(pluginDir, 'ocp.json'), 'utf8')).language !== 'ja') throw new Error('mig c: not at runtime path');
    if (fs.existsSync(path.join(wrongBase, 'ocp.jsonc'))) throw new Error('mig c: source remains');
    // collision at the runtime dir while current exists there → skipped, no warning
    fs.writeFileSync(path.join(wrongBase, 'ocp.jsonc'), '{}');
    const r3b = migrateGlobalOcpConfig(wrongBase);
    if (r3b.action !== 'skipped' || fs.readFileSync(path.join(pluginDir, 'ocp.json'), 'utf8').includes('ja') === false) throw new Error('mig c: runtime current must win untouched');
    console.log('✓ XDG move + wrong-base leftover skipped when runtime dir has ocp.json');

    // (d) default base (no XDG): homedir/.config/opencode
    delete process.env.XDG_CONFIG_HOME;
    const fakeHome = mkDir('home');
    const homePlugin = path.join(fakeHome, '.config', 'opencode');
    fs.mkdirSync(homePlugin, { recursive: true });
    fs.writeFileSync(path.join(homePlugin, 'ocp.jsonc'), '{}');
    const realHomedir = os.homedir;
    (os as { homedir: () => string }).homedir = () => fakeHome;
    try {
      const r4 = migrateGlobalOcpConfig(homePlugin);
      if (r4.action !== 'renamed' || !fs.existsSync(path.join(homePlugin, 'ocp.json'))) throw new Error('mig d: default-base rename failed');
    } finally {
      (os as { homedir: () => string }).homedir = realHomedir;
    }
    console.log('✓ default (homedir) base renames in place');

    // (e) rename failure degrades to an error action, never throws
    const d5 = mkDir('blocked');
    process.env.XDG_CONFIG_HOME = d5;
    fs.mkdirSync(path.join(d5, 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(d5, 'opencode', 'ocp.jsonc'), '{}');
    const realRename = fs.renameSync;
    (fs as { renameSync: typeof fs.renameSync }).renameSync = (() => {
      throw Object.assign(new Error('EPERM simulated'), { code: 'EPERM' });
    }) as typeof fs.renameSync;
    let r5;
    try {
      r5 = migrateGlobalOcpConfig(d5);
    } finally {
      (fs as { renameSync: typeof fs.renameSync }).renameSync = realRename;
    }
    if (r5.action !== 'error' || !r5.message.includes('EPERM')) throw new Error(`mig e: expected error action, got ${r5.action}`);
    if (!fs.existsSync(path.join(d5, 'opencode', 'ocp.jsonc'))) throw new Error('mig e: legacy must survive a failed rename');
    const r5b = migrateGlobalOcpConfig(d5);
    if (r5b.action !== 'renamed') throw new Error('mig e: transient failure must recover on re-run');
    console.log('✓ rename failure → error action, never throws, recovers on re-run');
  } finally {
    if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdg;
    fs.rmSync(migBase, { recursive: true, force: true });
  }
}
console.log('✓ Global OCP config migration passed');

// 7. Shims & Global Command Registration
console.log('\nTest 7: Shim Registration & Unregistration');
const regRes = registerShim(repoDir, testBinDir);
if (!regRes.success) throw new Error('Register shim failed');
const unregRes = unregisterShim(testBinDir);
if (!unregRes.success || unregRes.removed.length === 0) throw new Error('Unregister shim failed');
console.log(`✓ Shim registration and cleanup passed`);

// 8. Safe Uninstall
console.log('\nTest 8: Manifest-Driven Safe Uninstall');
const uninstRes = executeUninstall(repoDir, {
  action: 'uninstall',
  target: testTargetDir,
  force: true,
  noBackup: true,
  yes: true,
  isInteractive: false,
});
if (uninstRes.removedCount === 0) throw new Error('Uninstall did not remove files');
console.log(`✓ Safe uninstall passed (${uninstRes.removedCount} files safely removed)`);

// 8.5 Plugin runtime deps: local PM probe order + honest post-install re-check
console.log('\nTest 8.5: Plugin runtime dep PM order & marker re-check');
{
  const depDir = path.join(os.tmpdir(), `opencode-dep-test-${Date.now()}`);
  fs.mkdirSync(depDir, { recursive: true });
  const okResult: ShellCommandResult = { status: 0, stdout: '', stderr: '' };
  try {
    // 8.5a selection: flat-layout PMs (bun→npm) always beat isolated/PnP layouts
    const sel = (avail: string[]) => findPackageManager(LOCAL_PM_ORDER, (pm) => avail.includes(pm));
    if (sel(['npm', 'pnpm']) !== 'npm') throw new Error('must pick npm over yarn/pnpm when bun missing');
    if (sel(['pnpm', 'yarn']) !== 'yarn') throw new Error('must pick yarn before pnpm (last resort)');
    if (sel(['bun', 'npm']) !== 'bun') throw new Error('bun must win when available');
    if (sel([]) !== null) throw new Error('must return null when nothing usable');
    // 8.5a2 opencode-install-method may re-order the flat pair, never promote a demoted layout
    const flatOnly = (pm: string) => !['yarn', 'pnpm'].includes(pm);
    if (localPmOrder('npm').join(',') !== 'npm,bun,yarn,pnpm')
      throw new Error(`detect=npm must lead with npm, keep flat-first tail: ${localPmOrder('npm').join(',')}`);
    if (localPmOrder('bun').join(',') !== LOCAL_PM_ORDER.join(',')) throw new Error('detect=bun must be the baseline order');
    for (const dead of ['pnpm', 'yarn', 'official', 'unknown'] as const) {
      if (localPmOrder(dead) !== LOCAL_PM_ORDER)
        throw new Error(`detect=${dead} must fall through to the baseline (no layout violation)`);
    }
    // detect-driven selection stays inside the contract even when followed
    if (findPackageManager(localPmOrder('npm'), flatOnly) !== 'npm') throw new Error('npm detect must select npm');
    if (findPackageManager(localPmOrder('pnpm'), flatOnly) !== 'bun') throw new Error('pnpm detect must NOT select pnpm/yarn head');
    // 8.5b exit-0 install WITHOUT markers = honest failure (non-flat layout), not fake success
    const r1 = ensurePluginRuntimeDeps(depDir, { run: () => okResult, pmMethod: 'unknown' });
    if (r1.install !== 'failed' || !r1.message.includes('non-flat layout'))
      throw new Error(`missing-marker install must report failed/non-flat: ${r1.message}`);
    const merged = JSON.parse(fs.readFileSync(path.join(depDir, 'package.json'), 'utf8'));
    if (merged.dependencies?.['@opentui/solid'] !== TUI_PLUGIN_RUNTIME_DEPS['@opentui/solid'])
      throw new Error('target package.json must pin @opentui/solid');
    // 8.5c install writing markers → ok; foreign lockfile surfaced in message, never deleted
    const r2 = ensurePluginRuntimeDeps(depDir, {
      pmMethod: 'bun',
      run: (_cmd, opts) => {
        for (const dep of ['@opentui/solid', 'solid-js']) {
          const d = path.join(opts.cwd, 'node_modules', dep);
          fs.mkdirSync(d, { recursive: true });
          fs.writeFileSync(path.join(d, 'package.json'), '{}');
        }
        fs.writeFileSync(path.join(opts.cwd, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');
        return okResult;
      },
    });
    if (r2.install !== 'ok' || !r2.message.includes('foreign lockfile') || !r2.message.includes('pnpm-lock.yaml'))
      throw new Error(`marker-complete install must be ok + foreign-lock note: ${r2.message}`);
    if (!fs.existsSync(path.join(depDir, 'pnpm-lock.yaml')))
      throw new Error('foreign lockfile must be left untouched');
    // 8.5d markers already present → fast path skips the network install entirely
    const r3 = ensurePluginRuntimeDeps(depDir, {
      run: () => {
        throw new Error('install must not run when markers are present');
      },
    });
    if (r3.install !== 'skipped' || !r3.message.includes('present'))
      throw new Error(`expected skipped fast path: ${r3.message}`);
  } finally {
    fs.rmSync(depDir, { recursive: true, force: true });
  }
  console.log('✓ Plugin runtime dep PM order & re-check passed');
}

// 9. Clean up scratch dirs
if (fs.existsSync(testTargetDir)) fs.rmSync(testTargetDir, { recursive: true, force: true });
if (fs.existsSync(testBinDir)) fs.rmSync(testBinDir, { recursive: true, force: true });

console.log('\n======================================================');
console.log('🎉 ALL COMPREHENSIVE TESTS PASSED WITH 100% SUCCESS!');
console.log('======================================================\n');
