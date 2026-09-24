/**
 * Prompt budget gate for the layered-disclosure architecture (dev-only).
 *
 * Estimates, in tokens (chars / 4), what the shipped template actually costs:
 *   L0 — the `instructions` array: paid on every step of every agent.
 *   L1 — each agent prompt: its prompts/*.md plus the rule files assembled
 *        via {file:} markers, paid only while that agent runs.
 *   L2 — skills/: only name+description stay resident; the body loads on demand.
 *   Per-step overhead — what every step pays ON TOP of L0+L1: the resident
 *        skills block (<available_skills>), MCP tool definitions, and the
 *        <mcp_instructions> block. Both honor permission denies using V2
 *        semantics (core/src/permission.ts evaluate(): ordered rules array,
 *        LAST matching rule wins, default ask; a tool is hidden when the
 *        effective effect for (action, "*") is deny). Agent rules are
 *        appended after the global `permissions` array.
 *        Permission policy lives in the template itself (native V2 fields:
 *        global `permissions` + per-agent `permissions`; there is no v1
 *        `tools` visibility map in V2 — gating is pure permission
 *        enforcement, and the code-mode `execute` dispatcher folds tool
 *        schemas out of the per-step prompt by default).
 *        MCP figures come from scripts/mcp-instructions.snapshot.json
 *        (regenerate: bun run scripts/capture-mcp-snapshot.ts).
 *
 * Fails (exit 1) when L0 or any single agent exceeds its budget, and prints
 * the layer attribution of every shipped prompt file so the routing matrix
 * stays self-checking instead of tribal knowledge.
 *
 * Usage: bun run scripts/measure-prompts.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsoncFile } from '../install/src/merger';

const repoDir = path.resolve(__dirname, '..');
const CONFIG_PREFIX = '~/.config/opencode/';

// Budgets in estimated tokens. L0 is paid every step × every agent, so it is
// the expensive layer; L1 is isolated to one role's runtime.
const L0_BUDGET = 2700;
const AGENT_BUDGET = 8000;

const estTokens = (text: string): number => Math.ceil(text.length / 4);

/** Wildcard.match semantics (opencode core/util/wildcard): * spans anything. */
function wildcardMatch(value: string, pattern: string): boolean {
  if (pattern === '*') return true;
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(value);
}

type Rule = { action: string; resource: string; effect: string };

/** Validates one V2 permissions array entry (schema/permission.ts Rule:
 *  {action, resource, effect}). Malformed entries are dropped like the
 *  runtime's normalize does — but loudly, so the gate notices. */
function rules(value: unknown, label: string): Rule[] {
  if (!Array.isArray(value)) return [];
  const out: Rule[] = [];
  for (const item of value) {
    if (
      item &&
      typeof item.action === 'string' &&
      typeof item.resource === 'string' &&
      (item.effect === 'allow' || item.effect === 'deny' || item.effect === 'ask')
    ) {
      out.push({ action: item.action, resource: item.resource, effect: item.effect });
    } else {
      console.error(`measure-prompts: malformed permission rule in ${label}: ${JSON.stringify(item)}`);
      process.exitCode = 1;
    }
  }
  return out;
}

/** Mirrors V2 Permission.evaluate (core/src/permission.ts): the LAST rule
 *  matching BOTH action and resource wins; no match = ask. */
function evaluateRule(action: string, resource: string, rules: Rule[]): string {
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i];
    if (wildcardMatch(action, r.action) && wildcardMatch(resource, r.resource)) return r.effect;
  }
  return 'ask';
}

/**
 * A tool is hidden for an agent when its effective effect at resource "*" is
 * deny (the resource a bare tool call is checked against for MCP/skills; the
 * wildcard `{action:"*"}` deny-all of whitelist agents falls through here
 * naturally instead of v1's separate Permission.disabled lookup).
 */
function toolDisabled(tool: string, rules: Rule[]): boolean {
  return evaluateRule(tool, '*', rules) === 'deny';
}

/** Maps a shipped config path (~/.config/opencode/<rel>) to the repo file. */
function toRepoPath(configPath: string): string | null {
  if (!configPath.startsWith(CONFIG_PREFIX)) return null;
  return path.join(repoDir, configPath.slice(CONFIG_PREFIX.length));
}

function fileTokens(configPath: string): { tokens: number; missing: boolean } {
  const p = toRepoPath(configPath);
  if (!p || !fs.existsSync(p)) return { tokens: 0, missing: true };
  return { tokens: estTokens(fs.readFileSync(p, 'utf8')), missing: false };
}

const template = readJsoncFile<Record<string, any>>(path.join(repoDir, 'opencode.template.jsonc'));
if (!template) {
  console.error('measure-prompts: opencode.template.jsonc missing or unparseable');
  process.exit(1);
}

// Policy sanity: per-step gating below relies on the template's native V2
// permission arrays — a policy-free template would silently measure without
// denies.
if (!Array.isArray(template.permissions) || typeof template.agents !== 'object' || !template.agents) {
  console.error('measure-prompts: template lost its native V2 permissions/agents — per-step gating would measure without denies');
  process.exit(1);
}
const globalRules = rules(template.permissions, 'root permissions');

let failures = 0;

// --- L0: instructions array ------------------------------------------------
const instructions: string[] = Array.isArray(template.instructions) ? template.instructions : [];
let l0Total = 0;
console.log('L0 (every step x every agent)');
for (const entry of instructions) {
  const { tokens, missing } = fileTokens(entry);
  l0Total += tokens;
  console.log(`  ${missing ? 'MISSING' : String(tokens).padStart(5) + ' tok'}  ${entry}`);
  if (missing) failures++;
}
const l0Ok = l0Total <= L0_BUDGET;
console.log(`  TOTAL: ${l0Total} tok (budget ${L0_BUDGET}) ${l0Ok ? 'OK' : 'OVER BUDGET'}`);
if (!l0Ok) failures++;

// --- L1: agent prompt assembly ----------------------------------------------
const agents: Record<string, any> = template.agents && typeof template.agents === 'object' ? template.agents : {};
console.log('\nL1 (per-agent system {file:} assembly)');
const l1Files = new Set<string>();
for (const [name, def] of Object.entries(agents)) {
  const prompt: string = typeof def?.system === 'string' ? def.system : '';
  const markers = [...prompt.matchAll(/\{file:([^}]+)\}/g)].map((m) => m[1]);
  let agentTotal = 0;
  const parts: string[] = [];
  for (const m of markers) {
    const { tokens, missing } = fileTokens(m);
    agentTotal += tokens;
    if (!missing) l1Files.add(m);
    parts.push(`${missing ? 'MISSING' : tokens + ' tok'} ${m.replace(CONFIG_PREFIX, '')}`);
    if (missing) failures++;
  }
  const ok = agentTotal <= AGENT_BUDGET;
  console.log(`  ${name}: ${agentTotal} tok (budget ${AGENT_BUDGET}) ${ok ? 'OK' : 'OVER BUDGET'}`);
  for (const p of parts.slice(1)) console.log(`      + ${p}`);
  if (!ok) failures++;
}

// --- L2: skills ---------------------------------------------------------------
const skillsDir = path.join(repoDir, 'skills');
console.log('\nL2 (skills — body loads on demand, name+description resident)');
if (fs.existsSync(skillsDir)) {
  for (const ent of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const skillFile = path.join(skillsDir, ent.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) {
      console.log(`  MISSING SKILL.md in skills/${ent.name}`);
      failures++;
      continue;
    }
    const body = fs.readFileSync(skillFile, 'utf8');
    console.log(`  ${ent.name}: ${estTokens(body)} tok on demand`);
  }
} else {
  console.log('  (no skills/ directory)');
}

// --- Per-step resident overhead (skills block + MCP) ---------------------------
// Everything below is paid on EVERY step of the agents listed, on top of L0+L1.
// Skill metadata: frontmatter of each shipped SKILL.md (name + description).
const skillMeta: Array<{ name: string; description: string; location: string }> = [];
if (fs.existsSync(skillsDir)) {
  for (const ent of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const skillFile = path.join(skillsDir, ent.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    const body = fs.readFileSync(skillFile, 'utf8');
    const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const name = fm?.[1].match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? ent.name;
    const description = fm?.[1].match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
    if (description) skillMeta.push({ name, description, location: CONFIG_PREFIX + `skills/${ent.name}/SKILL.md` });
  }
}
const skillsBlockText = (list: typeof skillMeta): string =>
  [
    'Skills provide specialized instructions and workflows for specific tasks.',
    'Use the skill tool to load a skill when a task matches its description.',
    '<available_skills>',
    ...list
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((s) => ['  <skill>', `    <name>${s.name}</name>`, `    <description>${s.description}</description>`, `    <location>${s.location}</location>`, '  </skill>']),
    '</available_skills>',
  ].join('\n');

// MCP cost basis: real initialize handshake snapshot (see capture-mcp-snapshot.ts).
const snapshotPath = path.join(repoDir, 'scripts', 'mcp-instructions.snapshot.json');
const snapshot: any = fs.existsSync(snapshotPath) ? JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) : null;
// V2 shape: servers under `mcp.servers`; `disabled: true` (the inverse of
// v1's `enabled`) keeps a server out of the running config.
const mcpConfig: Record<string, any> =
  template.mcp && typeof template.mcp.servers === 'object' ? template.mcp.servers : {};
const mcpServers: Array<{ name: string; instructionsChars: number; schemaChars: number; tools: string[] }> = [];
for (const [name, def] of Object.entries(mcpConfig)) {
  if (!def || def.disabled === true) continue;
  const snap = snapshot?.servers?.[name];
  if (!snap || snap.error) {
    console.log(`\n  NOTE: no MCP snapshot for enabled server "${name}" (bun run scripts/capture-mcp-snapshot.ts) - cost not measured`);
    continue;
  }
  mcpServers.push({
    name,
    instructionsChars: String(snap.instructions ?? '').length,
    schemaChars: snap.toolSchemaChars ?? 0,
    tools: (snap.tools ?? []).map((t: string) => `${name}_${t}`),
  });
}

console.log('\nPer-step resident overhead (paid every step, on top of L0+L1)');
let fleetOverhead = 0;
for (const [name, def] of Object.entries(agents)) {
  // V2 precedence: global rules load first, agent rules are appended last.
  const agentRules: Rule[] = [...globalRules, ...rules(def?.permissions, `agents.${name}`)];
  // Skills block: entire block skipped when "skill" is denied with pattern *.
  let skillsTok = 0;
  if (!toolDisabled('skill', agentRules)) {
    const visible = skillMeta.filter((s) => evaluateRule('skill', s.name, agentRules) !== 'deny');
    if (visible.length > 0) skillsTok = estTokens(skillsBlockText(visible));
  }
  // MCP: tool definitions always dominate; <mcp_instructions> drops only when
  // every tool of a server is hidden for this agent.
  let mcpTok = 0;
  const mcpParts: string[] = [];
  for (const server of mcpServers) {
    const visibleCount = server.tools.filter((t) => !toolDisabled(t, agentRules)).length;
    if (visibleCount === 0) continue;
    const serverChars = server.instructionsChars + Math.ceil((server.schemaChars * visibleCount) / server.tools.length);
    const tok = Math.ceil(serverChars / 4);
    mcpTok += tok;
    mcpParts.push(`${server.name} ${tok} tok (${visibleCount}/${server.tools.length} tools)`);
  }
  const total = skillsTok + mcpTok;
  fleetOverhead += total;
  console.log(`  ${name}: ${total} tok/step (skills ${skillsTok}, mcp ${mcpTok}${mcpParts.length ? ' = ' + mcpParts.join(' + ') : ''})`);
}
console.log(`  FLEET TOTAL: ${fleetOverhead} tok/step summed over ${Object.keys(agents).length} agents`);

// --- Layer attribution table ---------------------------------------------------
console.log('\nLayer attribution');
const l0Set = new Set(instructions);
const rows: Array<[string, string]> = [];
for (const f of l0Set) rows.push([f.replace(CONFIG_PREFIX, ''), 'L0']);
for (const f of l1Files) if (!l0Set.has(f)) rows.push([f.replace(CONFIG_PREFIX, ''), 'L1']);
for (const [file, layer] of rows.sort()) console.log(`  ${layer}  ${file}`);
const instructionDir = path.join(repoDir, 'instructions');
for (const f of fs.readdirSync(instructionDir)) {
  const rel = `instructions/${f}`;
  const cfg = CONFIG_PREFIX + rel;
  if (!l0Set.has(cfg) && ![...l1Files].includes(cfg)) {
    console.log(`  --  ${rel} (not referenced by the template)`);
  }
}

console.log(failures === 0 ? '\nmeasure-prompts: OK' : `\nmeasure-prompts: FAILED (${failures} problem(s))`);
process.exit(failures === 0 ? 0 : 1);
