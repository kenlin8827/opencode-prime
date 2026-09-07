import fs from 'node:fs';
import path from 'node:path';

// Directories and standalone files that belong to the installed config.
// `scripts/` is intentionally NOT in SHIPPED_DIRS — only the runtime scripts
// listed in SHIPPED_FILES below are installed (the rest of scripts/ contains
// release tooling like pack.sh/verify.sh that must stay repo-side).
// Agent prompt fragments ship as `prompts/`, never `agents/`: opencode
// auto-discovers agents/*.md as agent definitions that silently override the
// jsonc agent block (verified v1.18.25). prompts/ is not auto-discovered.
const SHIPPED_DIRS = ['commands', 'instructions', 'plugins', 'profiles', 'prompts', 'providers', 'skills'];
const SHIPPED_FILES = [
  'opencode.template.jsonc', //  core config template — merged into the target opencode.jsonc by installer/merger.ts (never copied verbatim)
  'plugin-scope.json', //  plugin scope policy — runtime gate data for plugins/shared/plugin-scope.ts (permission/tools live in the template instead)
  'tiers.json',     //  agent→tier map — merged by installer/merger.ts
  'tui.template.jsonc', //  TUI plugin registration — merged with user's tui.jsonc by installer/merger.ts (preserves user-added plugins; never copied verbatim)
  // Runtime script referenced by opencode.jsonc MCP config (serena command):
  //   node -e "import(... .config/opencode/scripts/serena-workspace-daemon.mjs)"
  'scripts/serena-workspace-daemon.mjs',
  // Runtime script referenced by opencode.jsonc MCP config (headroom command):
  //   node -e "import(... .config/opencode/scripts/headroom-proxy-daemon.mjs)"
  // Auto-launches `headroom proxy` (127.0.0.1:8787) if not running, then exec's `headroom mcp serve`.
  'scripts/headroom-proxy-daemon.mjs',
];

export function collectShippedFiles(repoDir: string): string[] {
  const files: string[] = [];

  for (const dirName of SHIPPED_DIRS) {
    const dirPath = path.join(repoDir, dirName);
    if (!fs.existsSync(dirPath)) continue;

    const walk = (curDir: string) => {
      const entries = fs.readdirSync(curDir, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(curDir, ent.name);
        if (ent.isDirectory()) {
          walk(full);
        } else if (ent.isFile()) {
          const rel = path.relative(repoDir, full).replace(/\\/g, '/');
          files.push(rel);
        }
      }
    };
    walk(dirPath);
  }

  for (const fileName of SHIPPED_FILES) {
    const full = path.join(repoDir, fileName);
    if (fs.existsSync(full)) {
      files.push(fileName);
    }
  }

  return files.sort();
}

export function getManifestPath(repoDir: string, version: string): string {
  return path.join(repoDir, 'install', 'versions', `${version}.manifest.txt`);
}

export function readManifest(manifestPath: string): string[] | null {
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const content = fs.readFileSync(manifestPath, 'utf8');
    return content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return null;
  }
}

/** Semver-aware comparison: true when a > b (non-numeric segments sort last). */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map((s) => parseInt(s, 10));
  const pb = b.split('.').map((s) => parseInt(s, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isNaN(pa[i]) ? Number.MAX_SAFE_INTEGER : pa[i] ?? 0;
    const y = Number.isNaN(pb[i]) ? Number.MAX_SAFE_INTEGER : pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export interface VersionInfo {
  version: string;
  minVersion?: string;
}

export function readVersionJson(repoDir: string): VersionInfo | null {
  const p = path.join(repoDir, 'install', 'version.json');
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!parsed || typeof parsed.version !== 'string' || !parsed.version.trim()) return null;
    const minVersion =
      typeof parsed.minVersion === 'string' && parsed.minVersion.trim() ? parsed.minVersion.trim() : undefined;
    return { version: parsed.version.trim(), minVersion };
  } catch {
    return null;
  }
}

/**
 * Parse a fetched version payload: plain text (legacy install/VERSION
 * format) or JSON with a `version` field (install/version.json).
 */
export function parseVersionPayload(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed.version === 'string' && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {
    // not JSON — fall through to plain-text semantics
  }
  return trimmed;
}

const HISTORY_MANIFEST = 'history.manifest.txt';

export function getHistoryManifestPath(repoDir: string): string {
  return path.join(repoDir, 'install', 'versions', HISTORY_MANIFEST);
}

/**
 * Compact every loose manifest strictly below version.json's `minVersion`
 * into a single deduplicated install/versions/history.manifest.txt, then
 * delete the loose files. Repeated compactions accumulate: the existing
 * history union is merged with the newly compacted manifests. Per-version
 * attribution below the floor is intentionally dropped — the union serves
 * the install-time stale-file prune; uninstalling a below-floor install
 * falls back to a live repo scan (bounded orphans).
 */
export function compactHistoricalManifests(repoDir: string): { archived: string[]; historyPath: string | null } {
  const minVer = readVersionJson(repoDir)?.minVersion;
  const versionsDir = path.join(repoDir, 'install', 'versions');
  if (!minVer || !fs.existsSync(versionsDir)) return { archived: [], historyPath: null };

  const below: string[] = [];
  for (const entry of fs.readdirSync(versionsDir)) {
    if (!entry.endsWith('.manifest.txt') || entry === HISTORY_MANIFEST) continue;
    const v = entry.slice(0, -'.manifest.txt'.length);
    if (isNewerVersion(minVer, v)) below.push(entry);
  }
  if (below.length === 0) return { archived: [], historyPath: getHistoryManifestPath(repoDir) };

  const union = new Set<string>(readManifest(getHistoryManifestPath(repoDir)) ?? []);
  for (const entry of below) {
    for (const f of readManifest(path.join(versionsDir, entry)) ?? []) union.add(f);
  }
  const header = [
    '# Deduplicated union of every manifest below the supported floor (minVersion),',
    '# compacted by the manifest generation script. Per-version attribution is intentionally lost.',
    '# Do not edit by hand.',
  ];
  fs.writeFileSync(getHistoryManifestPath(repoDir), header.join('\n') + '\n' + [...union].sort().join('\n') + '\n', 'utf8');
  for (const entry of below) fs.rmSync(path.join(versionsDir, entry), { force: true });
  return { archived: below.map((e) => e.slice(0, -'.manifest.txt'.length)), historyPath: getHistoryManifestPath(repoDir) };
}

/**
 * Union of every historical manifest — loose files plus the compacted
 * history.manifest.txt. The skip set only applies to loose manifests; the
 * history union cannot exclude individual versions (attribution was dropped
 * at compaction). Feeds the install-time stale-file prune.
 */
export function collectHistoricalShippedFiles(repoDir: string, skip: Set<string>): string[] {
  const union = new Set<string>();
  const versionsDir = path.join(repoDir, 'install', 'versions');
  if (!fs.existsSync(versionsDir)) return [];
  for (const entry of fs.readdirSync(versionsDir)) {
    if (!entry.endsWith('.manifest.txt') || entry === HISTORY_MANIFEST) continue;
    const v = entry.slice(0, -'.manifest.txt'.length);
    if (skip.has(v)) continue;
    for (const f of readManifest(path.join(versionsDir, entry)) ?? []) union.add(f);
  }
  for (const f of readManifest(getHistoryManifestPath(repoDir)) ?? []) union.add(f);
  return [...union];
}

export function generateManifest(repoDir: string, version: string): { path: string; count: number } {
  const files = collectShippedFiles(repoDir);
  const versionsDir = path.join(repoDir, 'install', 'versions');
  if (!fs.existsSync(versionsDir)) {
    fs.mkdirSync(versionsDir, { recursive: true });
  }

  const manifestPath = getManifestPath(repoDir, version);
  fs.writeFileSync(manifestPath, files.join('\n') + '\n', 'utf8');
  return { path: manifestPath, count: files.length };
}
