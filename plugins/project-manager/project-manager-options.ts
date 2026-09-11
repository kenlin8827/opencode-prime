import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ProjectSwitches } from "./project-manager-scaffold"

export const PROJECT_SWITCH_DEFAULTS = {
  autoAdvisorMode: "lite",
  adrGuard: "on",
  adrLayout: "auto",
  adrDir: "docs/adr",
  envGuard: "on",
  e2eGuard: "on",
  projectMemory: "off",
} as const satisfies Required<ProjectSwitches>

export const PROJECT_SWITCH_OPTIONS = {
  autoAdvisorMode: [
    { value: "lite", label: "🟢 lite", description: "Advisory mode (recommended)" },
    { value: "full", label: "🔵 full", description: "Decisive review mode" },
    { value: "off", label: "🔴 off", description: "Disable advisor completely" },
  ],
  adrGuard: [
    { value: "on", label: "🟢 on", description: "Enforce ADR change check on feat/refactor" },
    { value: "off", label: "🔴 off", description: "Disable ADR guard check" },
  ],
  adrLayout: [
    { value: "auto", label: "🟢 auto", description: "Smart adaptive ADR layout" },
    { value: "flat", label: "📄 flat", description: "Single ADR directory" },
    { value: "hierarchical", label: "📦 hierarchy", description: "Domain subdirectories" },
  ],
  envGuard: [
    { value: "on", label: "🟢 on", description: "Protect secret .env file reads" },
    { value: "off", label: "🔴 off", description: "Disable env guard check" },
  ],
  e2eGuard: [
    { value: "on", label: "🟢 on", description: "Assess E2E before test execution" },
    { value: "off", label: "🔴 off", description: "Disable E2E guard check" },
  ],
  projectMemory: [
    { value: "on", label: "🟢 on", description: "Inject curated project memory into context" },
    { value: "off", label: "🔴 off", description: "Never inject project memory" },
  ],
  adrDir: [
    { value: "docs/adr", label: "📁 docs/adr", description: "Standard docs/adr/ folder" },
    { value: "docs/decisions", label: "📁 docs/decisions", description: "docs/decisions/ folder" },
    { value: "architecture/decisions", label: "📁 architecture/decisions", description: "architecture/decisions/ folder" },
  ],
} as const

export interface DetectedProjectState {
  readonly exists: boolean
  readonly configPath?: string
  readonly configRelPath?: string
  readonly switches: ProjectSwitches
}

function isOptionValue<T extends string>(value: string | undefined, options: readonly { readonly value: T }[]): value is T {
  return value !== undefined && options.some((option) => option.value === value)
}

function switchValue<T extends string>(
  value: string | undefined,
  options: readonly { readonly value: T }[],
  fallback: T,
): T {
  return isOptionValue(value, options) ? value : fallback
}

export function defaultProjectSwitches(): ProjectSwitches {
  return { ...PROJECT_SWITCH_DEFAULTS }
}

export function detectProjectSwitches(rootDir: string): DetectedProjectState {
  const candidatePaths = [
    { rel: ".opencode/opencode.jsonc", abs: join(rootDir, ".opencode", "opencode.jsonc") },
    { rel: "opencode.jsonc", abs: join(rootDir, "opencode.jsonc") },
  ]

  for (const candidate of candidatePaths) {
    if (!existsSync(candidate.abs)) continue
    try {
      const content = readFileSync(candidate.abs, "utf-8")
      const advisor = content.match(/^[^/\n\r]*"autoAdvisorMode"\s*:\s*"([^"]+)"/m)?.[1]
      const adrGuard = content.match(/^[^/\n\r]*"adrGuard"\s*:\s*"([^"]+)"/m)?.[1]
      const envGuard = content.match(/^[^/\n\r]*"envGuard"\s*:\s*"([^"]+)"/m)?.[1]
      const e2eGuard = content.match(/^[^/\n\r]*"e2eGuard"\s*:\s*"([^"]+)"/m)?.[1]
      const projectMemory = content.match(/^[^/\n\r]*"projectMemory"\s*:\s*"([^"]+)"/m)?.[1]
      const adrLayout = content.match(/^[^/\n\r]*"adrLayout"\s*:\s*"([^"]+)"/m)?.[1]
      const adrDir = content.match(/^\s*(?:\/\/)?\s*"adrDir"\s*:\s*"([^"]+)"/m)?.[1]

      return {
        exists: true,
        configPath: candidate.abs,
        configRelPath: candidate.rel,
        switches: {
          autoAdvisorMode: switchValue(advisor, PROJECT_SWITCH_OPTIONS.autoAdvisorMode, PROJECT_SWITCH_DEFAULTS.autoAdvisorMode),
          adrGuard: switchValue(adrGuard, PROJECT_SWITCH_OPTIONS.adrGuard, PROJECT_SWITCH_DEFAULTS.adrGuard),
          adrLayout: switchValue(adrLayout, PROJECT_SWITCH_OPTIONS.adrLayout, PROJECT_SWITCH_DEFAULTS.adrLayout),
          adrDir: adrDir ?? PROJECT_SWITCH_DEFAULTS.adrDir,
          envGuard: switchValue(envGuard, PROJECT_SWITCH_OPTIONS.envGuard, PROJECT_SWITCH_DEFAULTS.envGuard),
          e2eGuard: switchValue(e2eGuard, PROJECT_SWITCH_OPTIONS.e2eGuard, PROJECT_SWITCH_DEFAULTS.e2eGuard),
          projectMemory: switchValue(projectMemory, PROJECT_SWITCH_OPTIONS.projectMemory, PROJECT_SWITCH_DEFAULTS.projectMemory),
        },
      }
    } catch {
      continue
    }
  }

  return { exists: false, switches: defaultProjectSwitches() }
}