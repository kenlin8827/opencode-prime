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
  if (/^(?:\.tgrep|\.tgrep\/|\*\*\/\.tgrep\/)\s*$/m.test(existing)) return "present"
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
  autoAdvisorMode?: "off" | "lite" | "full" | "default"
  adrGuard?: "on" | "off" | "default"
  adrGuardDir?: string
  adrMode?: "auto" | "flat" | "hierarchical" | "default"
  envGuard?: "on" | "off" | "default"
  e2eGuard?: "on" | "off" | "default"
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
 * - active value ("lite", "on", etc.) → active line `"key": "value",`
 * - "default" → commented line `// "key": "...",`
 * - preserves indentation, comments, and remaining lines.
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
    defaultLine: string
  }> = [
      {
        key: "autoAdvisorMode",
        value: switches.autoAdvisorMode,
        defaultLine: '  // "autoAdvisorMode": "lite",  // off | lite | full — /auto-advisor <mode>',
      },
      {
        key: "adrGuard",
        value: switches.adrGuard,
        defaultLine: '  // "adrGuard": "on",           // on | off          — /adr-guard <state>',
      },
      {
        key: "adrGuardDir",
        value: switches.adrGuardDir,
        defaultLine: `  // "adrGuardDir": "${switches.adrGuardDir ?? "docs/adr"}",  // ADR directory`,
      },
      {
        key: "adrMode",
        value: switches.adrMode,
        defaultLine: '  // "adrMode": "auto",          // auto | flat | hierarchical — /adr mode <mode>',
      },
      {
        key: "envGuard",
        value: switches.envGuard,
        defaultLine: '  // "envGuard": "on",           // on | off — blocks agent access to secret .env* files (.env.example exempt)',
      },
      {
        key: "e2eGuard",
        value: switches.e2eGuard,
        defaultLine: '  // "e2eGuard": "on",           // on | off — E2E quality red line: prompts LLM to assess diff impact on feat/fix tasks and interactively confirm with user via ask',
      },
    ]

  for (const entry of switchEntries) {
    if (entry.value === undefined) continue
    const escaped = entry.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    // Match active or commented switch line: e.g. `  // "key": "val", ...` or `  "key": "val", ...`
    const lineRegex = new RegExp(`^(\\s*)(//\\s*)?("${escaped}"\\s*:\\s*)"([^"]*)"(.*)$`, "m")
    const match = lineRegex.exec(result)

    const isDefault = entry.value === "default"

    if (match) {
      const indent = match[1] || "  "
      const prefix = match[3]
      const suffix = match[5]
      const val = isDefault
        ? (entry.key === "autoAdvisorMode" ? "lite" : entry.key === "adrMode" ? "auto" : entry.key === "adrGuardDir" ? (switches.adrGuardDir ?? "docs/adr") : "on")
        : entry.value

      const newLine = isDefault
        ? `${indent}// ${prefix}"${val}"${suffix}`
        : `${indent}${prefix}"${val}"${suffix}`
      result = result.replace(match[0], newLine)
    } else {
      // Key absent in existing content: append before closing brace
      const close = result.lastIndexOf("}")
      if (close >= 0) {
        const val = isDefault
          ? (entry.key === "autoAdvisorMode" ? "lite" : entry.key === "adrMode" ? "auto" : entry.key === "adrGuardDir" ? (switches.adrGuardDir ?? "docs/adr") : "on")
          : entry.value
        const line = isDefault
          ? `  // "${entry.key}": "${val}",`
          : `  "${entry.key}": "${val}",`
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

    mkdirSync(dirname(absPath), { recursive: true })
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

