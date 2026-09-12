import { existsSync } from "node:fs"
import { OCP_CONFIG_REL, OCP_SWITCH_KEYS, ocpConfigFile, readProjectConfig } from "../shared/opencode-prime"
import type { ProjectSwitches } from "./project-manager-scaffold"

export const PROJECT_SWITCH_DEFAULTS = {
  autoAdvisorMode: "lite",
  adrGuard: "on",
  adrLayout: "auto",
  adrDir: "docs/adr",
  envGuard: "on",
  e2eGuard: "on",
  projectMemory: "on",
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

/**
 * Detect the project's effective switch state for the wizard. Single
 * runtime source (ADR 0004 v2): `.ocp/ocp.json` — legacy state must have
 * been migrated by init / the wizard save path / `/project sync` first.
 * The key set is shared with the migration (`OCP_SWITCH_KEYS`).
 */
export function detectProjectSwitches(rootDir: string): DetectedProjectState {
  const abs = ocpConfigFile(rootDir)
  if (!existsSync(abs)) {
    return { exists: false, switches: defaultProjectSwitches() }
  }

  const cfg = readProjectConfig(rootDir) ?? {}
  const found: Partial<Record<(typeof OCP_SWITCH_KEYS)[number], string>> = {}
  for (const key of OCP_SWITCH_KEYS) {
    const value = cfg[key]
    if (typeof value === "string") found[key] = value
  }

  return {
    exists: true,
    configPath: abs,
    configRelPath: OCP_CONFIG_REL,
    switches: {
      autoAdvisorMode: switchValue(found.autoAdvisorMode, PROJECT_SWITCH_OPTIONS.autoAdvisorMode, PROJECT_SWITCH_DEFAULTS.autoAdvisorMode),
      adrGuard: switchValue(found.adrGuard, PROJECT_SWITCH_OPTIONS.adrGuard, PROJECT_SWITCH_DEFAULTS.adrGuard),
      adrLayout: switchValue(found.adrLayout, PROJECT_SWITCH_OPTIONS.adrLayout, PROJECT_SWITCH_DEFAULTS.adrLayout),
      adrDir: found.adrDir ?? PROJECT_SWITCH_DEFAULTS.adrDir,
      envGuard: switchValue(found.envGuard, PROJECT_SWITCH_OPTIONS.envGuard, PROJECT_SWITCH_DEFAULTS.envGuard),
      e2eGuard: switchValue(found.e2eGuard, PROJECT_SWITCH_OPTIONS.e2eGuard, PROJECT_SWITCH_DEFAULTS.e2eGuard),
      projectMemory: switchValue(found.projectMemory, PROJECT_SWITCH_OPTIONS.projectMemory, PROJECT_SWITCH_DEFAULTS.projectMemory),
    },
  }
}