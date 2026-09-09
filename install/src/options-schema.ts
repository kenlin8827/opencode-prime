import fs from 'node:fs';
import path from 'node:path';
import { readJsoncFile, parseJsonc } from './merger';

/**
 * options-schema — pure JSONC option-schema parsing and in-place updates.
 *
 * Extracted from wizard.ts so the standalone OpenTUI host (app.tsx) and the
 * dashboard can consume it without pulling in an interactive UI runtime (wizard.ts is
 * clack-based; the OpenTUI child process must not depend on it).
 */

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
