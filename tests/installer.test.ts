import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseJsonc,
  readJsoncFile,
  readTierMap,
  extractPreserveBag,
  mergeConfig,
  mergeTuiConfig,
  mergeUserOptions,
  getUserOptionsPath,
  updateOptionsJsoncInPlace,
} from '../install/src/merger';
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
  getCurrentRepoVersion,
  getTargetInstalledManifestPath,
  loadEffectiveOptions,
  mcpProvisionPlan,
  readTargetInstalledManifest,
} from '../install/src/installer';
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
  (readJsoncFile<Record<string, any>>(path.join(repoDir, 'opencode.template.jsonc'))?.agent ?? {}) as Record<string, any>
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

// 3d. mergeTuiConfig — first install writes template; user plugins preserved on upgrade
console.log('\nTest 3d: TUI Config Merge — preserves user-added plugins across reinstalls');
const tuiMergeDir = path.join(os.tmpdir(), `opencode-tui-merge-test-${Date.now()}`);
const tuiRepoDir = path.join(tuiMergeDir, 'repo');
const tuiTargetDir = path.join(tuiMergeDir, 'target');
fs.mkdirSync(tuiRepoDir, { recursive: true });
fs.mkdirSync(tuiTargetDir, { recursive: true });
// Minimal template (3 OCP plugins)
fs.writeFileSync(
  path.join(tuiRepoDir, 'tui.template.jsonc'),
  '{\n  "$schema": "https://opencode.ai/tui.json",\n  "display_thinking": true,\n  "plugin": [\n    "./plugins/tui/a.ts",\n    "./plugins/tui/b.ts",\n  ]\n}\n',
  'utf8'
);

// Subtest 1: first install — no existing tui.jsonc, write the template directly.
mergeTuiConfig(tuiRepoDir, tuiTargetDir);
const firstInstall = readJsoncFile<Record<string, any>>(path.join(tuiTargetDir, 'tui.jsonc'));
if (!firstInstall || firstInstall.plugin.length !== 2) {
  throw new Error('First-install merge should write all template plugins');
}
if (firstInstall.display_thinking !== true) {
  throw new Error('First-install merge should write template scalar fields');
}
if (firstInstall.$schema !== 'https://opencode.ai/tui.json') {
  throw new Error('First-install merge should write $schema from template');
}
console.log('✓ First install writes template plugins + scalars');

// Subtest 2: user adds a custom plugin, then merge runs again — user plugin survives.
const existing = readJsoncFile<Record<string, any>>(path.join(tuiTargetDir, 'tui.jsonc'));
existing.plugin.push('./plugins/tui/user-extra.ts');
existing.theme = 'custom-user-theme';   // user customization on a scalar the template doesn't carry
fs.writeFileSync(
  path.join(tuiTargetDir, 'tui.jsonc'),
  JSON.stringify(existing, null, 2) + '\n',
  'utf8'
);
mergeTuiConfig(tuiRepoDir, tuiTargetDir);
const afterUpgrade = readJsoncFile<Record<string, any>>(path.join(tuiTargetDir, 'tui.jsonc'));
const pluginPaths = afterUpgrade.plugin as string[];
if (!pluginPaths.includes('./plugins/tui/a.ts') || !pluginPaths.includes('./plugins/tui/b.ts')) {
  throw new Error('Re-install dropped a template plugin');
}
if (!pluginPaths.includes('./plugins/tui/user-extra.ts')) {
  throw new Error('Re-install must preserve user-added plugins');
}
if (pluginPaths.indexOf('./plugins/tui/a.ts') > pluginPaths.indexOf('./plugins/tui/user-extra.ts')) {
  throw new Error('Template plugins should come first, user additions after');
}
if (afterUpgrade.theme !== 'custom-user-theme') {
  throw new Error('User scalar customizations should be preserved');
}
if (afterUpgrade.$schema !== 'https://opencode.ai/tui.json') {
  throw new Error('$schema must always come from template');
}
console.log('✓ Re-install preserves user-added plugins + scalar customizations');

// Subtest 3: dedupe — if user already has a template plugin, no duplicate.
const withDup = readJsoncFile<Record<string, any>>(path.join(tuiTargetDir, 'tui.jsonc'));
withDup.plugin.push('./plugins/tui/a.ts');   // duplicate of template plugin
fs.writeFileSync(
  path.join(tuiTargetDir, 'tui.jsonc'),
  JSON.stringify(withDup, null, 2) + '\n',
  'utf8'
);
mergeTuiConfig(tuiRepoDir, tuiTargetDir);
const afterDedupe = readJsoncFile<Record<string, any>>(path.join(tuiTargetDir, 'tui.jsonc'));
const aCount = (afterDedupe.plugin as string[]).filter((p) => p === './plugins/tui/a.ts').length;
if (aCount !== 1) {
  throw new Error(`Plugin dedupe failed — ./plugins/tui/a.ts appears ${aCount} times`);
}
console.log('✓ Re-install dedupes plugins already present in template');

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
  '{\n  "removed_agents": ["ghost"],\n  "instructions": [\n    "~/.config/opencode/instructions/a.md",\n    "~/.config/opencode/instructions/b.md"\n  ],\n  "agent": {\n    "build": { "prompt": "T_BUILD" },\n    "code": { "prompt": "T_CODE" }\n  }\n}\n',
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
  '{\n  "instructions": ["old/1.md", "old/2.md", "old/3.md"],\n  "agent": {\n    "build": { "prompt": "OLD_MODIFIED_BUILD" },\n    "ghost": { "prompt": "RETIRED_FACTORY_AGENT" },\n    "my-agent": { "prompt": "CUSTOM_USER_AGENT" }\n  }\n}\n',
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
if (cfgMerged?.agent?.build?.prompt !== 'T_BUILD') {
  throw new Error('Factory agent "build" must follow the template — stale user copy leaked through');
}
if (cfgMerged?.agent?.code?.prompt !== 'T_CODE') {
  throw new Error('Factory agent "code" missing — template agents must survive the merge');
}
if (cfgMerged?.agent?.['my-agent']?.prompt !== 'CUSTOM_USER_AGENT') {
  throw new Error('User-defined agent "my-agent" must be preserved verbatim');
}
if (cfgMerged?.agent?.ghost !== undefined) {
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

// 3g. Native policy propagation:
//   - opencode.template.jsonc carries permission/tools as native opencode
//     fields; mergeConfig copies them verbatim (no materialization step).
//   - Factory agents follow the template wholesale: a hand-edited permission
//     on a factory agent is replaced on upgrade, not merged.
//   - Custom agents are preserved verbatim and stay policy-free unless the
//     user gave them policy.
console.log('\nTest 3g: Config Merge — Native Policy Propagation');
const surfMergeDir = path.join(os.tmpdir(), `opencode-surface-test-${Date.now()}`);
const surfRepoDir = path.join(surfMergeDir, 'repo');
const surfTargetDir = path.join(surfMergeDir, 'target');
fs.mkdirSync(surfRepoDir, { recursive: true });
fs.mkdirSync(surfTargetDir, { recursive: true });
fs.writeFileSync(
  path.join(surfRepoDir, 'opencode.template.jsonc'),
  '{\n  "permission": "allow",\n  "agent": {\n    "lite": { "prompt": "T_LITE", "permission": { "skill": { "*": "deny" }, "serena_*": { "*": "deny" } }, "tools": { "task": false, "question": false } },\n    "build": { "prompt": "T_BUILD", "permission": { "serena_*": { "*": "deny" } } }\n  }\n}\n',
  'utf8'
);
fs.writeFileSync(
  path.join(surfRepoDir, 'tiers.json'),
  '{\n  "$comment": "t",\n  "lite": "flash",\n  "build": "standard"\n}\n',
  'utf8'
);
// Stale installed config: a user-modified factory permission on lite (factory
// agents follow the template — hand edits are replaced, not merged) plus a
// custom agent
fs.writeFileSync(
  path.join(surfTargetDir, 'opencode.jsonc'),
  '{\n  "agent": {\n    "lite": { "prompt": "OLD_LITE", "permission": { "pencil_*": { "*": "deny" } } },\n    "my-agent": { "prompt": "CUSTOM" }\n  }\n}\n',
  'utf8'
);
const surfBag = extractPreserveBag(surfTargetDir);
mergeConfig(surfRepoDir, surfTargetDir, {} as any, surfBag);
const surfMerged = readJsoncFile<Record<string, any>>(path.join(surfTargetDir, 'opencode.jsonc'));
if (surfMerged?.permission !== 'allow') {
  throw new Error('global permission must pass through from the template');
}
if (surfMerged?.agent?.lite?.permission?.skill?.['*'] !== 'deny' || surfMerged?.agent?.lite?.permission?.['serena_*']?.['*'] !== 'deny') {
  throw new Error('lite permission must propagate from the template');
}
if (surfMerged?.agent?.lite?.permission?.['pencil_*'] !== undefined) {
  throw new Error('factory agents follow the template — hand-edited permission must be replaced, not merged');
}
if (surfMerged?.agent?.lite?.tools?.task !== false || surfMerged?.agent?.lite?.tools?.question !== false) {
  throw new Error('lite tools map must propagate from the template verbatim');
}
if (surfMerged?.agent?.build?.permission?.['serena_*']?.['*'] !== 'deny') {
  throw new Error('build permission must propagate from the template');
}
if (surfMerged?.agent?.build?.tools !== undefined) {
  throw new Error('agents without template tools entries must not gain a tools map');
}
if (surfMerged?.agent?.['my-agent']?.permission !== undefined) {
  throw new Error('custom agents without template entries must stay policy-free');
}
if (fs.existsSync(surfMergeDir)) fs.rmSync(surfMergeDir, { recursive: true, force: true });
console.log('✓ Native policy propagation: global + per-agent permission/tools, factory semantics intact');

// 3h. Real repo regression: the shipped template carries native permission
// policy (the template is the policy source of truth again), and plugin
// injection policy lives in plugin-scope.json.
const realTemplate = readJsoncFile<Record<string, any>>(path.join(repoDir, 'opencode.template.jsonc'));
if (realTemplate?.permission !== 'allow') {
  throw new Error('opencode.template.jsonc must carry global permission "allow" — policy lives in the template');
}
if (realTemplate?.agent?.lite?.permission?.['*']?.['*'] !== 'deny') {
  throw new Error('shipped template lost the lite wildcard deny');
}
// lite's skill access is scoped to the six agent-less commands (/handoff,
// /git-merge, /git-pick, /git-pull, /git-push, /git-rebase) that follow the
// current agent; every other skill stays denied.
const liteSkill = realTemplate?.agent?.lite?.permission?.skill;
if (liteSkill?.['*'] !== 'deny' || liteSkill?.['git-merge'] !== 'allow' || liteSkill?.['git-pick'] !== 'allow' || liteSkill?.['git-pull'] !== 'allow' || liteSkill?.['git-push'] !== 'allow' || liteSkill?.['git-rebase'] !== 'allow') {
  throw new Error('lite skill permission must deny "*" and allow exactly git-merge + git-pick + git-pull + git-push + git-rebase');
}
const liteTools = realTemplate?.agent?.lite?.tools;
if (!liteTools || typeof liteTools !== 'object' || liteTools['*'] !== false) {
  throw new Error('lite tools must wildcard-deny then whitelist the capable set');
}
// Whitelisted core set + the skill tool (needed to load git-merge/git-pick/git-pull/git-push/git-rebase)
// + question (interactive ask for the default primary; measured ~216 tok/step with the lite-tools override).
const liteRequired = ['read', 'edit', 'write', 'bash', 'grep', 'glob', 'webfetch', 'websearch', 'todowrite', 'task', 'skill', 'question'];
const liteMissing = liteRequired.filter((t) => liteTools?.[t] !== true);
if (liteMissing.length) {
  throw new Error('lite tools whitelist lost required tools: ' + liteMissing.join(', '));
}
if (liteTools && 'list' in liteTools) {
  throw new Error('lite tools whitelist must not carry list (not a real opencode tool)');
}
const realScope = readJsoncFile<Record<string, any>>(path.join(repoDir, 'plugin-scope.json'));
if (!realScope?.plugins?.['*']?.deny?.includes('lite') || !realScope.plugins['*'].deny.includes('subagent:*')) {
  throw new Error('shipped plugin-scope.json lost the default deny policy');
}
console.log('✓ Template carries native policy; plugin-scope.json carries the injector policy');

// 3i. Model preservation: reinstall must preserve the user's model picks
// (root `model`, `small_model`, and per-agent `model` overrides set via
// /profile apply). Without this, the template defaults overwrite them.
console.log('\nTest 3i: Config Merge — Model ID Preservation');
const modelMergeDir = path.join(os.tmpdir(), `opencode-model-merge-test-${Date.now()}`);
const modelRepoDir = path.join(modelMergeDir, 'repo');
const modelTargetDir = path.join(modelMergeDir, 'target');
fs.mkdirSync(modelRepoDir, { recursive: true });
fs.mkdirSync(modelTargetDir, { recursive: true });
// Template with default model picks
fs.writeFileSync(
  path.join(modelRepoDir, 'opencode.template.jsonc'),
  '{\n  "model": "template/standard",\n  "small_model": "template/flash",\n  "agent": {\n    "build": { "prompt": "T_BUILD" },\n    "code": { "prompt": "T_CODE", "model": "template/pro" }\n  }\n}\n',
  'utf8'
);
fs.writeFileSync(
  path.join(modelRepoDir, 'tiers.json'),
  '{\n  "$comment": "t",\n  "build": "standard",\n  "code": "pro"\n}\n',
  'utf8'
);
// User's installed config with custom model picks (set via /profile apply)
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
console.log('✓ extractPreserveBag captures model / small_model / per-agent models');
mergeConfig(modelRepoDir, modelTargetDir, {} as any, modelBag);
const modelMerged = readJsoncFile<Record<string, any>>(path.join(modelTargetDir, 'opencode.jsonc'));
if (modelMerged?.model !== 'anthropic/claude-sonnet-4-20250514') {
  throw new Error(`mergeConfig overwrote root model with template: got ${modelMerged?.model}`);
}
if (modelMerged?.small_model !== 'anthropic/claude-haiku-4-20250414') {
  throw new Error(`mergeConfig overwrote root small_model with template: got ${modelMerged?.small_model}`);
}
if (modelMerged?.agent?.code?.model !== 'anthropic/claude-sonnet-4-20250514') {
  throw new Error(`mergeConfig overwrote per-agent model with template: got ${modelMerged?.agent?.code?.model}`);
}
// Factory agent prompt still follows the template (not the user's old copy)
if (modelMerged?.agent?.build?.prompt !== 'T_BUILD') {
  throw new Error('Factory agent prompt must follow the template');
}
console.log('✓ mergeConfig preserves user model picks while template prompt upgrades propagate');
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
  '{\n  "removed_agents": ["explorer"],\n  "agent": {\n    "explore": { "prompt": "T_EXPLORE" }\n  }\n}\n',
  'utf8'
);
fs.writeFileSync(
  path.join(renameRepoDir, 'tiers.json'),
  '{\n  "$comment": "t",\n  "explore": "flash"\n}\n',
  'utf8'
);
// Installed config from before the rename: explorer carries a user model pick
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
if (renameMerged?.agent?.explore?.model !== 'prov/flash-model') {
  throw new Error(`Rename migration must carry the user's model pick to explore: got ${renameMerged?.agent?.explore?.model}`);
}
if (renameMerged?.agent?.explorer !== undefined) {
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
if (fs.existsSync(path.join(testTargetDir, 'tui.template.jsonc'))) throw new Error('TUI template leaked into target — only the merged tui.jsonc should be installed');
if (!fs.existsSync(path.join(testTargetDir, 'tui.jsonc'))) throw new Error('tui.jsonc missing from target');
if (!fs.existsSync(path.join(testTargetDir, 'installed.version'))) throw new Error('installed.version missing');
if (!fs.existsSync(getTargetInstalledManifestPath(testTargetDir))) throw new Error('.ocp/installed.manifest.txt missing');
if (!fs.existsSync(path.join(testTargetDir, 'tiers.json'))) throw new Error('tiers.json missing from target');
const targetManagedManifest = readTargetInstalledManifest(testTargetDir);
if (!targetManagedManifest || targetManagedManifest.length === 0) throw new Error('Failed to read target installed manifest');
if (targetManagedManifest.includes('opencode.template.jsonc') || targetManagedManifest.includes('tui.template.jsonc')) {
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
console.log('\nTest 5a: Stale Prune Removes Non-Target Package Inputs');
fs.writeFileSync(path.join(testTargetDir, 'opencode.template.jsonc'), 'stale template\n', 'utf8');
fs.writeFileSync(path.join(testTargetDir, 'tui.template.jsonc'), 'stale tui template\n', 'utf8');
const packageFiles = collectShippedFiles(repoDir);
const managedAfterFirstInstall = computeTargetManagedFiles(packageFiles, false);
if (managedAfterFirstInstall.includes('opencode.template.jsonc') || managedAfterFirstInstall.includes('tui.template.jsonc')) {
  throw new Error('computeTargetManagedFiles leaked template input files');
}
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
  throw new Error('Stale tui.template.jsonc survived reinstall');
}
const targetManagedManifestAfterReinstall = readTargetInstalledManifest(testTargetDir);
if (!targetManagedManifestAfterReinstall || targetManagedManifestAfterReinstall.includes('providers/llm-router.json')) {
  throw new Error('Upgrade target manifest should exclude user-owned provider presets');
}
console.log('✓ Stale prune removes template inputs and writes target-managed manifest');

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

// 6. Status Check
console.log('\nTest 6: Status Check');
const st = executeStatus(repoDir, testTargetDir);
if (!st.isUpToDate || st.installedVersion !== version) throw new Error('Status check mismatch');
console.log(`✓ Status check passed (Version: ${st.installedVersion}, Up-to-date: ${st.isUpToDate})`);

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

// 9. Clean up scratch dirs
if (fs.existsSync(testTargetDir)) fs.rmSync(testTargetDir, { recursive: true, force: true });
if (fs.existsSync(testBinDir)) fs.rmSync(testBinDir, { recursive: true, force: true });

console.log('\n======================================================');
console.log('🎉 ALL COMPREHENSIVE TESTS PASSED WITH 100% SUCCESS!');
console.log('======================================================\n');
