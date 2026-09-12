/**
 * Scaffold logic for `/project init` — generates the baseline project files.
 *
 * Iron rule: NEVER overwrite. A target file is written only when it does not
 * already exist; anything present is reported as skipped and left untouched.
 * Every init/save entry point first runs the one-shot legacy migration
 * (`migrateLegacyProjectArtifacts`, ADR 0004 §3) BEFORE scaffolding, so
 * legacy `.opencode/` OCP state (switch keys, memory, styles, handoffs) is
 * moved into `.ocp/` exactly once and the report is surfaced in the output.
 *
 * Targets (relative to the project directory):
 *   .ocp/ocp.json            — project-level OpenCode Prime config (pure
 *                              JSON; absent keys = defaults)
 *   docs/git-commits.md      — conventional-commit convention for the repo
 *   AGENTS.md                — repo-level AI agent instructions stub
 *
 * Template bodies live as real files under `templates/` (next to this
 * module) — same pattern as grill/grill-me.md. Each is read once and
 * cached in memory.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  ensureOcpGitignore,
  migrateLegacyProjectArtifacts,
  ocpConfigFile,
  OCP_SWITCH_KEYS,
  upsertConfigField,
  type MigrationReport,
} from "../shared/opencode-prime"
import { CONFIG_REL, getProjectDir, resolveTarget, type ScaffoldTarget } from "./project-manager-config"

// ─── Templates ───────────────────────────────────────────────────────

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

function uniq(paths: string[]): string[] {
  return Array.from(new Set(paths.map((p) => resolve(p))))
}

/** Candidate template directories for source, installed-plugin, and bundled installer runs. */
function templateDirCandidates(): string[] {
  const candidates = [
    // Normal plugin/source runtime: plugins/project-manager/templates
    join(MODULE_DIR, "templates"),
    // Bundled installer runtime: install/dist/index.js or install/src/index.ts
    // importing this module gets rewritten into install/dist, but the real
    // templates still live in repo/plugins/project-manager/templates.
    join(MODULE_DIR, "..", "..", "plugins", "project-manager", "templates"),
  ]

  if (process.env.OCP_REPO_DIR) {
    candidates.push(join(process.env.OCP_REPO_DIR, "plugins", "project-manager", "templates"))
  }

  if (process.argv[1]) {
    const scriptDir = dirname(resolve(process.argv[1]))
    candidates.push(join(scriptDir, "..", "..", "plugins", "project-manager", "templates"))
  }

  return uniq(candidates)
}

export function resolveProjectTemplatePath(file: string): string {
  for (const dir of templateDirCandidates()) {
    const candidate = join(dir, file)
    if (existsSync(candidate)) return candidate
  }
  // Surface the searched locations in the thrown ENOENT path to make future
  // packaging issues obvious instead of reporting install/dist/templates/*.
  return join(templateDirCandidates()[0] ?? MODULE_DIR, file)
}

/** Baseline target (relative path) → template file under `templates/`. */
const TEMPLATE_FILES: Record<ScaffoldTarget, string> = {
  ".ocp/ocp.json": "ocp.json",
  "docs/git-commits.md": "git-commits.md",
  "AGENTS.md": "AGENTS.md",
}

// Cache template content (each file loaded once).
const templateCache = new Map<string, string>()
function readTemplate(file: string): string {
  const cached = templateCache.get(file)
  if (cached !== undefined) return cached
  const content = readFileSync(resolveProjectTemplatePath(file), "utf-8")
  templateCache.set(file, content)
  return content
}

function ensureParentDir(absPath: string): void {
  const parent = dirname(absPath)
  // On Windows, `mkdirSync("D:\\", { recursive: true })` can throw EPERM even
  // though the drive root already exists. Only create parents that are absent.
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
}

// ─── Generic scaffold ─────────────────────────────────────────────────

/** Scaffold `targetRel` in `root` from a template under `templates/`.
 * Never overwrites. Returns the same status vocabulary as baseline scaffolding. */
export function scaffoldFile(root: string, templateName: string, targetRel: string): ScaffoldStatus {
  const absPath = join(root, targetRel)
  if (existsSync(absPath)) return "skipped"
  ensureParentDir(absPath)
  writeFileSync(absPath, readTemplate(templateName), "utf-8")
  return "created"
}

// ─── dbhub.toml (conditional — init backend step, not a baseline file) ─

/** Per-project DBHub config — scaffolded by `/project init` only when the
 * dbhub MCP is enabled and its CLI is installed; NOT part of SCAFFOLD_TARGETS,
 * so a project without dbhub is never nagged about it. Same iron rule:
 * never overwrite. */
export const DBHUB_TOML_REL = "dbhub.toml"

/** Create dbhub.toml in `root` when missing; an existing file is preserved. */
export function writeDbhubToml(root: string): ScaffoldStatus {
  return scaffoldFile(root, "dbhub.toml", DBHUB_TOML_REL)
}

// ─── Init ────────────────────────────────────────────────────────────

export type ScaffoldStatus = "created" | "updated" | "skipped" | "invalid"

export interface ScaffoldResult {
  relPath: ScaffoldTarget
  status: ScaffoldStatus
}

/** Append the local tgrep cache rule once, without modifying non-Git folders. */
export function ensureTgrepGitignore(root: string): "added" | "present" | "not-git" {
  if (!existsSync(join(root, ".git"))) return "not-git"
  const target = join(root, ".gitignore")
  const existing = existsSync(target) ? readFileSync(target, "utf-8") : ""
  // Equivalent ignore spellings: .tgrep, .tgrep/, /.tgrep/, .tgrep/**,
  // **/.tgrep/, **/.tgrep/**
  if (/^(?:\*\*\/)?\/?\.tgrep(?:\/\*\*)?\/?\s*$/m.test(existing)) return "present"
  const prefix = existing && !existing.endsWith("\n") ? "\n" : ""
  writeFileSync(target, `${existing}${prefix}.tgrep/\n`, "utf-8")
  return "added"
}

/** One init pass: the §3 migration report plus per-file scaffold results. */
export interface InitScaffoldResult {
  files: ScaffoldResult[]
  migration: MigrationReport
}

/**
 * Run `/project init`: first the one-shot legacy migration (so legacy
 * `.opencode/` OCP state lands in `.ocp/` before any target is checked),
 * then create each missing target file. Existing files are never
 * overwritten — an existing `.ocp/ocp.json` keeps its bytes; the migration
 * only adds keys it lacks. Parent directories are created on demand.
 * Errors propagate to the caller (command hook reports them to the user).
 */
export function runInit(): InitScaffoldResult {
  const migration = migrateLegacyProjectArtifacts(getProjectDir())
  ensureOcpGitignore(getProjectDir())
  const results: ScaffoldResult[] = []
  for (const relPath of Object.keys(TEMPLATE_FILES) as ScaffoldTarget[]) {
    const absPath = resolveTarget(relPath)
    if (existsSync(absPath)) {
      results.push({ relPath, status: "skipped" })
      continue
    }
    ensureParentDir(absPath)
    writeFileSync(absPath, readTemplate(TEMPLATE_FILES[relPath]), "utf-8")
    results.push({ relPath, status: "created" })
  }
  return { files: results, migration }
}

// ─── Switches & config generation ────────────────────────────────────

export interface ProjectSwitches {
  autoAdvisorMode?: "off" | "lite" | "full"
  adrGuard?: "on" | "off"
  adrDir?: string
  adrLayout?: "auto" | "flat" | "hierarchical"
  envGuard?: "on" | "off"
  e2eGuard?: "on" | "off"
  projectMemory?: "on" | "off"
}

/**
 * Apply project switch settings to a config string (template or existing),
 * converging on the shared text surgery (`upsertConfigField`): each defined
 * entry replaces its active line, uncomments a commented template line in
 * place, or appends into the root object keeping the result STRICT-JSON
 * valid (P1-2: no trailing comma on the last member). Undefined entries are
 * skipped (absent keys = defaults). Comments and unrelated lines survive.
 */
export function applySwitchesToConfigContent(
  content: string,
  switches: ProjectSwitches,
): string {
  let result = content
  for (const key of OCP_SWITCH_KEYS) {
    const value = switches[key]
    if (value === undefined) continue
    result = upsertConfigField(result, key, value)
  }
  return result
}


/** Read base template and apply the given switches. */
export function generateConfigContent(switches: ProjectSwitches): string {
  const base = readTemplate(TEMPLATE_FILES[CONFIG_REL])
  return applySwitchesToConfigContent(base, switches)
}

/** A config-only save: the written file plus the §3 migration it ran first. */
export interface UpdateSwitchesResult {
  file: ScaffoldResult
  migration: MigrationReport
}

/**
 * Update ONLY the project config (`.ocp/ocp.json`) with the given switches —
 * the wizard save path. Runs the one-shot legacy migration first (ADR 0004
 * §3: the wizard save is an init entry point), so a first save in a legacy
 * project moves old state forward instead of silently shadowing it.
 * Does NOT touch AGENTS.md, docs/git-commits.md, or any other baseline
 * file — that's the main-menu "Apply Init/Update" skeleton's job. When the
 * config is missing, creates it from the template with the switches applied
 * (skeleton-free first-time save in an empty project directory).
 *
 * Same iron rule as runInit: never overwrite unrelated content. An existing
 * file with the same switch values is reported as "skipped" with no write.
 */
export function updateSwitchesOnly(switches: ProjectSwitches): UpdateSwitchesResult {
  const migration = migrateLegacyProjectArtifacts(getProjectDir())
  const configPath = resolveTarget(CONFIG_REL)
  if (existsSync(configPath)) {
    const existing = readFileSync(configPath, "utf-8")
    const updated = applySwitchesToConfigContent(existing, switches)
    if (updated !== existing) {
      writeFileSync(configPath, updated, "utf-8")
      return { file: { relPath: CONFIG_REL, status: "updated" }, migration }
    }
    return { file: { relPath: CONFIG_REL, status: "skipped" }, migration }
  }

  // First-time: create the config from the template with switches applied.
  // Parent dirs created on demand; other baseline files (AGENTS.md,
  // docs/git-commits.md) are intentionally NOT created here. Mirror the
  // shared `setConfigField` contract: a freshly created `.ocp/` also gets
  // its gitignore bootstrap.
  ensureParentDir(configPath)
  writeFileSync(configPath, generateConfigContent(switches), "utf-8")
  ensureOcpGitignore(getProjectDir())
  return { file: { relPath: CONFIG_REL, status: "created" }, migration }
}

/**
 * Run `/project init` with explicit switches configured.
 * Runs the §3 legacy migration first, like `runInit`.
 * When `.ocp/ocp.json` already exists, updates the switches in place.
 * When missing, creates it with the configured switches.
 * Also scaffolds docs/git-commits.md and AGENTS.md.
 */
export function runInitWithSwitches(switches: ProjectSwitches): InitScaffoldResult {
  const migration = migrateLegacyProjectArtifacts(getProjectDir())
  ensureOcpGitignore(getProjectDir())
  const results: ScaffoldResult[] = []
  for (const relPath of Object.keys(TEMPLATE_FILES) as ScaffoldTarget[]) {
    const absPath = resolveTarget(relPath)
    if (existsSync(absPath)) {
      if (relPath === CONFIG_REL) {
        const existing = readFileSync(absPath, "utf-8")
        const updated = applySwitchesToConfigContent(existing, switches)
        if (updated !== existing) {
          writeFileSync(absPath, updated, "utf-8")
          results.push({ relPath, status: "updated" })
        } else {
          results.push({ relPath, status: "skipped" })
        }
        continue
      }
      results.push({ relPath, status: "skipped" })
      continue
    }

    ensureParentDir(absPath)
    if (relPath === CONFIG_REL) {
      writeFileSync(absPath, generateConfigContent(switches), "utf-8")
    } else {
      writeFileSync(absPath, readTemplate(TEMPLATE_FILES[relPath]), "utf-8")
    }
    results.push({ relPath, status: "created" })
  }
  return { files: results, migration }
}

export type SyncStatus = "added" | "up-to-date" | "missing"

export interface SyncResult {
  status: SyncStatus
  /** Migrated items (switch keys + moved artifact paths) — report lines. */
  added: string[]
  /** Full §3 report, including per-item warnings. */
  migration: MigrationReport
}

/**
 * Run `/project sync`: on-demand re-invocation of the §3 legacy migration
 * — the explicit escape hatch for users who upgraded and skipped the
 * wizard. Idempotent: a second run finds nothing. `missing` = nothing to
 * migrate and no `.ocp/ocp.json` yet (that is init's job).
 */
export function runSync(): SyncResult {
  const migration = migrateLegacyProjectArtifacts(getProjectDir())
  const added = [...migration.switchedKeys, ...migration.movedFiles]
  if (added.length > 0) return { status: "added", added, migration }
  if (!existsSync(ocpConfigFile(getProjectDir()))) return { status: "missing", added, migration }
  return { status: "up-to-date", added, migration }
}

