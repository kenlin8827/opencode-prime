/**
 * Single source of truth for detecting the local OpenCode installation and
 * classifying ANY binary's install method by its path shape.
 *
 * Consolidates detection logic that used to live in three places:
 *   - install/src/shared/opencode-command.ts (executable resolution — deleted)
 *   - install/src/installer.ts (config-dir probes)
 *   - install/src/updater.ts (version spawn + PATH resolution)
 *
 * Self-contained on purpose: this module is a leaf (only node builtins) so
 * installer.ts / package-manager.ts / updater.ts can all import from it
 * without creating an import cycle.
 */
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** How a binary reached this machine — drives upgrade-channel decisions. */
export type InstallMethod = 'bun' | 'pnpm' | 'yarn' | 'npm' | 'official' | 'unknown';

/** Everything detectOpencode() knows about the local opencode install. */
export interface OpencodeInstall {
  /** Full path, shim-resolved (npm .cmd → node_modules/opencode-ai/bin/opencode.exe on Windows), spawn-ready. */
  executable: string | null;
  /** dirname(executable), or null when opencode was not found. */
  binDir: string | null;
  /** From `<exe> --version`, first semver token (15s timeout). */
  version: string | null;
  /** OPENCODE_CONFIG_DIR env → live-process probe → ~/.config/opencode default. */
  configDir: string;
  /** Install method classified from the executable's path. */
  installMethod: InstallMethod;
  /**
   * Derived convenience flag: `executable !== null`. Single source of truth
   * is `executable` — computed once inside detectOpencode(), never set
   * independently.
   */
  installed: boolean;
}

// ── Install-method classification (pure) ─────────────────────────────

/**
 * Anchored path-shape markers per install method, evaluated in order.
 * Each pattern matches a marker sequence at segment boundaries on a
 * normalized (lowercase, forward-slash) path; `(\/|$)` anchors the tail so
 * `.bun/bin` cannot match `.bun/binary-x`. Order matters: specific
 * package-manager dirs are checked before the generic ~/.local/bin.
 *
 * yarn has no marker on purpose: its global bin location varies too much
 * across yarn versions to classify reliably — yarn-installed binaries
 * classify as 'unknown' and callers fall back to PATH-based manager
 * detection.
 */
const METHOD_MARKERS: ReadonlyArray<{
  method: InstallMethod;
  patterns: RegExp[];
}> = [
  {
    // Bun's global bin dir: ~/.bun/bin (all platforms).
    method: 'bun',
    patterns: [/(^|\/)\.bun\/bin(\/|$)/],
  },
  {
    // pnpm's global bin dirs: %LOCALAPPDATA%\pnpm (Windows) and
    // ~/.local/share/pnpm (POSIX).
    method: 'pnpm',
    patterns: [/(^|\/)local\/pnpm(\/|$)/, /(^|\/)\.local\/share\/pnpm(\/|$)/],
  },
  {
    // npm's global tree: %APPDATA%\npm (Windows shims), the system
    // node_modules trees (/usr/local/lib, /usr/lib), a custom ~/.npm-global
    // prefix, and nvm-managed node installs (~/.nvm/).
    method: 'npm',
    patterns: [
      /(^|\/)npm(\/|$)/,
      /(^|\/)node_modules(\/|$)/,
      /(^|\/)\.npm-global(\/|$)/,
      /(^|\/)\.nvm(\/|$)/,
    ],
  },
  {
    // Official installer channels: ~/.opencode/bin (opencode's own installer)
    // and ~/.local/bin (generic user bin — deliberately LAST so a binary in
    // ~/.local/share/pnpm classifies as pnpm, not official).
    method: 'official',
    patterns: [/(^|\/)\.opencode\/bin(\/|$)/, /(^|\/)\.local\/bin(\/|$)/],
  },
];

/**
 * Classify the install method that owns a binary, from its path shape.
 * PURE: no fs / env / PATH access — safe for any binary and any machine.
 *
 * Matching is ANCHORED (markers must align to path-segment boundaries),
 * case-insensitive, and accepts both / and \ separators — the naive
 * `path.includes(manager)` substring check false-matched e.g.
 * `C:\Users\Bunny\bin` as bun ("Bunny" contains "bun").
 *
 * `platform` is accepted for call-site symmetry and future platform-specific
 * rules; current matching is separator-agnostic.
 */
export function installMethodFromPath(binPath: string, platform: NodeJS.Platform = process.platform): InstallMethod {
  void platform;
  if (!binPath) return 'unknown';
  const normalized = binPath.replace(/\\/g, '/').toLowerCase();
  for (const { method, patterns } of METHOD_MARKERS) {
    if (patterns.some((re) => re.test(normalized))) return method;
  }
  return 'unknown';
}

// ── Executable resolution (from shared/opencode-command.ts) ──────────

function firstExisting(paths: string[]): string | undefined {
  return paths.find((candidate) => fs.existsSync(candidate));
}

function directExecutable(candidate: string): string | undefined {
  if (process.platform !== 'win32' || /\.(exe|com)$/i.test(candidate)) return candidate;
  if (!/\.(cmd|bat)$/i.test(candidate)) return undefined;
  const packageBinary = path.join(path.dirname(candidate), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
  return fs.existsSync(packageBinary) ? packageBinary : undefined;
}

function findOnPath(): string | undefined {
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    const args = process.platform === 'win32' ? ['opencode'] : ['-a', 'opencode'];
    const output = execFileSync(command, args, { encoding: 'utf8', timeout: 1_000 });
    const candidates = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (process.platform === 'win32') {
      // Preserve `where`/PATH precedence while resolving npm/Bun shims to
      // their native targets for direct child-process execution.
      for (const candidate of candidates) {
        const executable = directExecutable(candidate);
        if (executable) return executable;
      }
      return undefined;
    }
    return candidates[0];
  } catch {
    return undefined;
  }
}

/**
 * Locate an executable OpenCode binary for direct child-process use.
 *
 * Resolution order: explicit OPENCODE_BIN override, PATH (`where`/`which`),
 * then the OpenChamber desktop bundle on Windows. The resolved absolute path
 * avoids platform-specific PATHEXT and shell-shim behavior.
 */
function resolveExecutable(): string | null {
  const configured = process.env.OPENCODE_BIN;
  if (configured) {
    const resolved = path.resolve(configured);
    const executable = fs.existsSync(resolved) ? directExecutable(resolved) : undefined;
    if (executable) return executable;
  }

  const fromPath = findOnPath();
  if (fromPath) return fromPath;

  if (process.platform === 'win32') {
    const bundled = firstExisting([
      path.join(process.env.LOCALAPPDATA ?? '', 'Programs', '@openchamberelectron', 'resources', 'opencode-cli', 'opencode.exe'),
      path.join(process.env.PROGRAMFILES ?? '', 'OpenChamber', 'resources', 'opencode-cli', 'opencode.exe'),
    ]);
    if (bundled) return bundled;
  }

  return null;
}

// ── PATH lookup + version spawn (from updater.ts / installer.ts) ─────

/** Absolute path of a command on PATH, or null. */
export function resolveBinPath(cmd: string): string | null {
  try {
    const out = execSync(process.platform === 'win32' ? `where.exe ${cmd}` : `which ${cmd}`, {
      encoding: 'utf8',
      timeout: 2000,
    });
    return out.split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}

/** True when a command name resolves on PATH (where/which, 1s bound). */
export function isBinaryOnPath(cmdName: string): boolean {
  const checkCmd = process.platform === 'win32' ? `where.exe ${cmdName}` : `which ${cmdName}`;
  try {
    execSync(checkCmd, { stdio: 'ignore', timeout: 1000 });
    return true;
  } catch {
    return false;
  }
}

/** Run `<binary> --version` and extract the first semver-looking token. */
export function localBinaryVersion(binary: string): string | null {
  if (!isBinaryOnPath(binary)) return null;
  try {
    const res = spawnSync(binary, ['--version'], {
      encoding: 'utf8',
      timeout: 15000,
      shell: process.platform === 'win32',
    });
    const m = /\d+\.\d+\.\d+[\w.-]*/.exec(res.stdout ?? '');
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

/**
 * Version probe for a RESOLVED executable path. Unlike localBinaryVersion
 * (bare name, shell-resolved on Windows), the snapshot's executable is
 * shim-resolved and spawn-ready, so no shell is needed — this avoids
 * cmd.exe quoting on paths containing spaces.
 */
function spawnVersion(executable: string): string | null {
  try {
    const res = spawnSync(executable, ['--version'], {
      encoding: 'utf8',
      timeout: 15000,
    });
    const m = /\d+\.\d+\.\d+[\w.-]*/.exec(res.stdout ?? '');
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

// ── Config-dir resolution (from installer.ts, verbatim) ──────────────

/**
 * Probe a running opencode process and infer its effective config dir.
 *
 * Why this exists: the install writes to whatever `getDefaultTargetDir()`
 * resolves to (driven by `OPENCODE_CONFIG_DIR` in *this* shell). The opencode
 * TUI independently reads from `api.state.path.config`, which the opencode
 * server resolves from its OWN environment. If the two differ, an `ocp
 * install` will land in a directory opencode never sees — the classic
 * "shell has OPENCODE_CONFIG_DIR but opencode was started outside that
 * scope" divergence that the orca opencode-hooks wrapper can produce.
 *
 * Returns the inferred dir, or null when:
 *   - no opencode process is running
 *   - the probe fails / is not supported on this platform
 *   - the running process inherited its env without an explicit override
 *     and the platform doesn't expose per-process env vars to other UIDs
 *     (notably macOS: ps eww requires same UID; we fall back to silent)
 *
 * Detection strategy (cross-platform):
 *   - Windows: `wmic process where name='opencode.exe' get CommandLine`
 *     matches an explicit `--config-dir=X` flag.
 *   - Linux:   scan `/proc/<pid>/environ` for `OPENCODE_CONFIG_DIR=X`.
 *     Also matches `--config-dir=X` in `/proc/<pid>/cmdline` as a backup.
 *   - macOS:   `ps -p <pid> -wwE` (BSD `ps` env-var syntax). Falls back
 *     to `pgrep -af opencode` cmdline match when env-var probe fails
 *     (e.g. different UID, SIP-protected shell).
 */
export function probeRunningOpencodeConfigDir(): string | null {
  try {
    if (process.platform === 'win32') return probeWindows()
    if (process.platform === 'linux') return probeLinux()
    if (process.platform === 'darwin') return probeDarwin()
    return null
  } catch {
    return null
  }
}

// ── Per-platform probes ────────────────────────────────────────────

function probeWindows(): string | null {
  const res = spawnSync(
    'wmic',
    [
      'process', 'where', "name='opencode.exe'",
      'get', 'CommandLine', '/format:list',
    ],
    { encoding: 'utf8', timeout: 3000, windowsHide: true },
  )
  if (res.error || !res.stdout) return null
  return matchConfigDirFromString(res.stdout)
}

interface ProcListing {
  pid: number
  cmdline: string
}

function listOpencodeProcsLinux(): ProcListing[] {
  const res = spawnSync('pgrep', ['-x', 'opencode'], { encoding: 'utf8', timeout: 3000 })
  if (res.error || !res.stdout) return []
  return res.stdout.split(/\s+/).filter(Boolean).map((p) => ({ pid: Number(p), cmdline: '' }))
}

function probeLinux(): string | null {
  const procs = listOpencodeProcsLinux()
  for (const p of procs) {
    try {
      const envRaw = fs.readFileSync(`/proc/${p.pid}/environ`, 'utf8')
      const envParts = envRaw.split('\0')
      for (const kv of envParts) {
        const eq = kv.indexOf('=')
        if (eq < 0) continue
        if (kv.slice(0, eq) === 'OPENCODE_CONFIG_DIR') {
          return path.normalize(kv.slice(eq + 1))
        }
      }
    } catch { /* /proc not readable — fall through to cmdline */ }
    try {
      const cmdRaw = fs.readFileSync(`/proc/${p.pid}/cmdline`, 'utf8')
      const joined = cmdRaw.split('\0').filter(Boolean).join(' ')
      const m = matchConfigDirFromString(joined)
      if (m) return m
    } catch { /* ignore */ }
  }
  return null
}

function probeDarwin(): string | null {
  const pg = spawnSync('pgrep', ['-x', 'opencode'], { encoding: 'utf8', timeout: 3000 })
  if (pg.error || !pg.stdout) return null
  const pids = pg.stdout.split(/\s+/).filter(Boolean)
  for (const pid of pids) {
    const ps = spawnSync('ps', ['-p', pid, '-wwE'], { encoding: 'utf8', timeout: 3000 })
    if (ps.error || !ps.stdout) continue
    const lines = ps.stdout.split('\n')
    if (lines.length < 2) continue
    const cmdlineAndEnv = lines.slice(1).join('\n')
    for (const line of cmdlineAndEnv.split(/\s+/)) {
      if (line.startsWith('OPENCODE_CONFIG_DIR=')) {
        return path.normalize(line.slice('OPENCODE_CONFIG_DIR='.length))
      }
    }
    const m = matchConfigDirFromString(cmdlineAndEnv)
    if (m) return m
  }
  return null
}

/**
 * Extract an explicit --config-dir flag from a free-form string. Matches
 * both `--config-dir=X` and `--config-dir X` forms, and accepts both
 * Windows (`C:\...`) and POSIX (`/home/...`) path shapes. Returns null
 * when no explicit flag is present — the opencode process inherits its
 * env from its parent in that case, and we can't infer the effective
 * dir from outside the process.
 */
function matchConfigDirFromString(s: string): string | null {
  const m = s.match(/--config-dir(?:=|\s+)?["']?((?:[A-Za-z]:[\\\/][^\s"']+|\/[^\s"']+))["']?/)
  return m ? path.normalize(m[1]!) : null
}

/**
 * Effective opencode config dir for this machine: explicit
 * OPENCODE_CONFIG_DIR wins (same precedence as the installer's target
 * resolution), then a live probe of a running opencode process, then the
 * canonical ~/.config/opencode default.
 */
function resolveConfigDir(): string {
  const env = process.env.OPENCODE_CONFIG_DIR;
  if (env) return path.resolve(env);
  const probed = probeRunningOpencodeConfigDir();
  if (probed) return probed;
  return path.join(os.homedir(), '.config', 'opencode');
}

// ── Snapshot ─────────────────────────────────────────────────────────

let cachedInstall: OpencodeInstall | undefined;

/**
 * Probe the local opencode install once and cache the whole snapshot at
 * module level: executable resolution, a bounded `--version` spawn, the
 * config-dir probe chain, and the path-shape install-method classification.
 */
export function detectOpencode(): OpencodeInstall {
  if (cachedInstall !== undefined) return cachedInstall;
  const executable = resolveExecutable();
  cachedInstall = {
    executable,
    binDir: executable ? path.dirname(executable) : null,
    version: executable ? spawnVersion(executable) : null,
    configDir: resolveConfigDir(),
    installMethod: executable ? installMethodFromPath(executable) : 'unknown',
    installed: executable !== null,
  };
  return cachedInstall;
}

/** Thin accessor over the cached snapshot. */
export function getVersion(): string | null {
  return detectOpencode().version;
}

/** Thin accessor over the cached snapshot. */
export function getBinDir(): string | null {
  return detectOpencode().binDir;
}

/** Thin accessor over the cached snapshot. */
export function getConfigDir(): string {
  return detectOpencode().configDir;
}

/** Thin accessor over the cached snapshot. */
export function getInstallMethod(): InstallMethod {
  return detectOpencode().installMethod;
}

/** Thin accessor over the cached snapshot. */
export function isInstalled(): boolean {
  return detectOpencode().installed;
}

/**
 * Backward-compatible accessor (former shared/opencode-command.ts API).
 * Thin wrapper over the cached snapshot: the first call also pays for the
 * bounded version spawn + config-dir probe.
 */
export function getOpencodeExecutable(): string | null {
  return detectOpencode().executable;
}
