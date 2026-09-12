/**
 * Scaffold logic for `/project init` — generates the baseline project files.
 *
 * Iron rule: NEVER overwrite. A target file is written only when it does not
 * already exist; anything present is reported as skipped and left untouched.
 * The single, append-only exception: an EXISTING project config gets switch
 * lines the template gained since init appended before its closing `}`
 * (existing content byte-preserved; reported as "updated").
 *
 * Targets (relative to the project directory):
 *   .opencode/opencode.jsonc — project-level OpenCode Prime stub; when it
 *                               already exists, an append-only top-up adds
 *                               switch lines the template gained since init
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
import { ensureOpencodeGitignore } from "../shared/opencode-prime"
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
  ".opencode/opencode.jsonc": "opencode.jsonc",
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

export { ensureOpencodeGitignore }

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

/**
 * Run `/project init`: create each missing target file. Existing files are
 * never overwritten — EXCEPT the project config, which gets an append-only
 * top-up with template switch lines it does not have yet (template
 * evolution; existing content untouched, reported as "updated"). Parent
 * directories are created on demand. Errors propagate to the caller
 * (command hook reports them to the user).
 */
export function runInit(): ScaffoldResult[] {
  ensureOpencodeGitignore()
  const results: ScaffoldResult[] = []
  for (const relPath of Object.keys(TEMPLATE_FILES) as ScaffoldTarget[]) {
    const absPath = resolveTarget(relPath)
    if (existsSync(absPath)) {
      if (relPath === CONFIG_REL) {
        const sync = runSync()
        const status: ScaffoldStatus =
          sync.status === "added" ? "updated" : sync.status === "invalid" ? "invalid" : "skipped"
        results.push({ relPath, status })
        continue
      }
      results.push({ relPath, status: "skipped" })
      continue
    }
    ensureParentDir(absPath)
    writeFileSync(absPath, readTemplate(TEMPLATE_FILES[relPath]), "utf-8")
    results.push({ relPath, status: "created" })
  }
  return results
}

// ─── Sync (template evolution) ──────────────────────────────────────
// init's never-overwrite rule means an existing .opencode/opencode.jsonc
// never receives switch lines added to the template AFTER init. `/project
// sync` closes that gap with an APPEND-ONLY merge: template switch lines
// whose key is entirely absent from the existing file are inserted right
// before the closing `}`; existing content is never edited, deleted, or
// reordered.

export interface SwitchLine {
  key: string
  line: string
}

export interface ProjectSwitches {
  autoAdvisorMode?: "off" | "lite" | "full"
  adrGuard?: "on" | "off"
  adrDir?: string
  adrLayout?: "auto" | "flat" | "hierarchical"
  envGuard?: "on" | "off"
  e2eGuard?: "on" | "off"
  projectMemory?: "on" | "off"
}

/** Commented switch lines (`// "key": ...`) offered by the config template. */
export function extractSwitchLines(templateContent: string): SwitchLine[] {
  const out: SwitchLine[] = []
  for (const line of templateContent.split(/\r?\n/)) {
    const m = line.match(/^\s*\/\/\s*"([^"]+)"\s*:/)
    if (m) out.push({ key: m[1], line })
  }
  return out
}

/** True when `content` already carries the key — active OR commented out. */
export function contentHasKey(content: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`"${escaped}"\\s*:`).test(content)
}

/**
 * Apply project switch settings to a JSONC config string (template or existing).
 * Each entry's `value` (when set) replaces the matching line in active form
 * `"key": "value",` — replacing a previously commented template line or
 * appending before the closing `}` when the key is absent. Undefined entries
 * are skipped (template defaults stay commented). Indentation, comments, and
 * unrelated lines are preserved.
 */
export function applySwitchesToConfigContent(
  content: string,
  switches: ProjectSwitches,
): string {
  let result = content
  const eol = content.includes("\r\n") ? "\r\n" : "\n"

  const switchEntries: Array<{
    key: string
    value?: string
  }> = [
      { key: "autoAdvisorMode", value: switches.autoAdvisorMode },
      { key: "adrGuard", value: switches.adrGuard },
      { key: "adrLayout", value: switches.adrLayout },
      { key: "adrDir", value: switches.adrDir },
      { key: "envGuard", value: switches.envGuard },
      { key: "e2eGuard", value: switches.e2eGuard },
      { key: "projectMemory", value: switches.projectMemory },
    ]

  for (const entry of switchEntries) {
    if (entry.value === undefined) continue
    const escaped = entry.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    // Match active or commented switch line: e.g. `  // "key": "val", ...` or `  "key": "val", ...`
    const lineRegex = new RegExp(`^(\\s*)(//\\s*)?("${escaped}"\\s*:\\s*)"([^"]*)"(.*)$`, "m")
    const match = lineRegex.exec(result)
    const val = entry.value

    if (match) {
      const indent = match[1] || "  "
      const prefix = match[3]
      const suffix = match[5]
      const newLine = `${indent}${prefix}"${val}"${suffix}`
      result = result.replace(match[0], newLine)
    } else {
      // Key absent in existing content: append before closing brace
      const close = result.lastIndexOf("}")
      if (close >= 0) {
        const line = `  "${entry.key}": "${val}",`
        result = result.slice(0, close) + line + eol + result.slice(close)
      }
    }
  }

  return result
}


/** Read base template and apply the given switches. */
export function generateConfigContent(switches: ProjectSwitches): string {
  const base = readTemplate(TEMPLATE_FILES[CONFIG_REL])
  return applySwitchesToConfigContent(base, switches)
}

/**
 * Update ONLY the project config (opencode.jsonc) with the given switches.
 * Does NOT touch AGENTS.md, docs/git-commits.md, or any other baseline file
 * — that's the main-menu "Apply Init/Update" skeleton's job. When the config
 * is missing, creates it from the template with the switches applied
 * (skeleton-free first-time init path for sub-dialog Save in an empty
 * project directory).
 *
 * Same iron rule as runInit: never overwrite unrelated content. An existing
 * file with the same switch values is reported as "skipped" with no write.
 *
 * Mirrors `runInitWithSwitches`'s root-fallback: a legacy project with only
 * a root-level `opencode.jsonc` is updated in place (returning that relPath)
 * rather than spawning a second config under `.opencode/` — the wizard
 * detects and the runtime reads the same file throughout.
 */
export function updateSwitchesOnly(switches: ProjectSwitches): ScaffoldResult {
  const configPath = resolveTarget(CONFIG_REL)
  if (existsSync(configPath)) {
    const existing = readFileSync(configPath, "utf-8")
    const updated = applySwitchesToConfigContent(existing, switches)
    if (updated !== existing) {
      writeFileSync(configPath, updated, "utf-8")
      return { relPath: CONFIG_REL, status: "updated" }
    }
    return { relPath: CONFIG_REL, status: "skipped" }
  }

  // Legacy fallback: root opencode.jsonc, no .opencode/ yet.
  const rootConfigPath = resolveTarget("opencode.jsonc" as ScaffoldTarget)
  if (existsSync(rootConfigPath)) {
    const existing = readFileSync(rootConfigPath, "utf-8")
    const updated = applySwitchesToConfigContent(existing, switches)
    if (updated !== existing) {
      writeFileSync(rootConfigPath, updated, "utf-8")
      return { relPath: "opencode.jsonc" as ScaffoldTarget, status: "updated" }
    }
    return { relPath: "opencode.jsonc" as ScaffoldTarget, status: "skipped" }
  }

  // First-time: create the config from the template with switches applied.
  // Parent dirs created on demand; other baseline files (AGENTS.md,
  // docs/git-commits.md) are intentionally NOT created here.
  ensureParentDir(configPath)
  writeFileSync(configPath, generateConfigContent(switches), "utf-8")
  return { relPath: CONFIG_REL, status: "created" }
}

/**
 * Run `/project init` with explicit switches configured.
 * When config already exists, it updates the switches in-place.
 * When missing, creates .opencode/opencode.jsonc with the configured switches.
 * Also scaffolds docs/git-commits.md and AGENTS.md.
 */
export function runInitWithSwitches(switches: ProjectSwitches): ScaffoldResult[] {
  ensureOpencodeGitignore()
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

    // Fallback check for root opencode.jsonc if .opencode/opencode.jsonc is absent
    if (relPath === CONFIG_REL) {
      const rootConfigPath = resolveTarget("opencode.jsonc" as ScaffoldTarget)
      if (existsSync(rootConfigPath)) {
        const existing = readFileSync(rootConfigPath, "utf-8")
        const updated = applySwitchesToConfigContent(existing, switches)
        if (updated !== existing) {
          writeFileSync(rootConfigPath, updated, "utf-8")
          results.push({ relPath: "opencode.jsonc" as ScaffoldTarget, status: "updated" })
        } else {
          results.push({ relPath: "opencode.jsonc" as ScaffoldTarget, status: "skipped" })
        }
        continue
      }
    }

    ensureParentDir(absPath)
    if (relPath === CONFIG_REL) {
      writeFileSync(absPath, generateConfigContent(switches), "utf-8")
    } else {
      writeFileSync(absPath, readTemplate(TEMPLATE_FILES[relPath]), "utf-8")
    }
    results.push({ relPath, status: "created" })
  }
  return results
}

/**
 * Additive merge of template switch lines into `existing`. Returns the
 * rewritten content plus the keys that were added; null when `existing`
 * is malformed — no closing brace, or anything but whitespace after it
 * (the file must not be touched). Zero missing keys → content returned
 * unchanged.
 */
export function mergeSwitchLines(
  existing: string,
  templateContent: string,
): { content: string; added: string[] } | null {
  const close = existing.lastIndexOf("}")
  if (close < 0 || existing.slice(close + 1).trim() !== "") return null
  const missing = extractSwitchLines(templateContent).filter((s) => !contentHasKey(existing, s.key))
  if (missing.length === 0) return { content: existing, added: [] }
  const eol = existing.includes("\r\n") ? "\r\n" : "\n"
  const block = missing.map((s) => s.line).join(eol)
  return {
    content: existing.slice(0, close) + block + eol + existing.slice(close),
    added: missing.map((s) => s.key),
  }
}

export type SyncStatus = "added" | "up-to-date" | "missing" | "invalid"

export interface SyncResult {
  status: SyncStatus
  added: string[]
}

/**
 * Run `/project sync`: top up the EXISTING project config with template
 * switch lines it does not have yet. Append-only (see above). A missing
 * config is `missing` (that is init's job); a malformed file (no closing
 * brace, or trailing content after it) is `invalid` and left untouched.
 */
export function runSync(): SyncResult {
  const absPath = resolveTarget(CONFIG_REL)
  if (!existsSync(absPath)) return { status: "missing", added: [] }
  const existing = readFileSync(absPath, "utf-8")
  const merged = mergeSwitchLines(existing, readTemplate(TEMPLATE_FILES[CONFIG_REL]))
  if (!merged) return { status: "invalid", added: [] }
  if (merged.added.length === 0) return { status: "up-to-date", added: [] }
  writeFileSync(absPath, merged.content, "utf-8")
  return { status: "added", added: merged.added }
}

