import { existsSync } from "node:fs"
import { ocpConfigFile, type MigrationReport } from "../shared/opencode-prime"
import {
  getProjectDir,
  setProjectDir,
} from "./project-manager-config"
import {
  planIndexBackends,
  planInitBackends,
  probeBackends,
  runBackends,
  type BackendResult,
} from "./project-manager-index"
import { registerProjectHooks, type HookResult } from "./project-manager-hooks"
import {
  runInit,
  runInitWithSwitches,
  runSync,
  updateSwitchesOnly,
  ensureTgrepGitignore,
  type ProjectSwitches,
  type ScaffoldResult,
  type SyncResult,
} from "./project-manager-scaffold"

export interface ProjectInitOptions {
  readonly root?: string
  readonly switches?: ProjectSwitches
  readonly refreshExistingIndexes?: boolean
}

export interface ProjectInitResult {
  readonly root: string
  readonly configExisted: boolean
  readonly files: ScaffoldResult[]
  /** §3 one-shot legacy migration, run by the scaffold layer before targets. */
  readonly migration: MigrationReport
  readonly backends: BackendResult[]
  readonly hooks: HookResult[]
}

export interface UpdateSwitchesOptions {
  readonly root?: string
  readonly switches: ProjectSwitches
}

export interface UpdateSwitchesResult {
  readonly root: string
  readonly file: ScaffoldResult
  readonly migration: MigrationReport
}

async function inProjectDir<T>(root: string, operation: () => T | Promise<T>): Promise<T> {
  const previousDir = getProjectDir()
  setProjectDir(root)
  try {
    return await operation()
  } finally {
    setProjectDir(previousDir)
  }
}

/** Runtime single source (ADR 0004 v2): the project is "managed" exactly
 * while `.ocp/ocp.json` exists. */
function configExists(root: string): boolean {
  return existsSync(ocpConfigFile(root))
}

export async function initProject(options: ProjectInitOptions = {}): Promise<ProjectInitResult> {
  const root = options.root ?? getProjectDir()
  return inProjectDir(root, async () => {
    const existed = configExists(root)
    const { files, migration } = options.switches === undefined ? runInit() : runInitWithSwitches(options.switches)
    const probe = probeBackends(root)
    let backends = await runBackends(planInitBackends(probe), root)

    // The ignore rule is only an outcome of a successful, explicitly enabled
    // tgrep initialization; a disabled or absent binary never changes files.
    if (backends.some((result) => result.backend === "tgrep" && result.status === "ran")) {
      const ignore = ensureTgrepGitignore(root)
      if (ignore === "not-git") backends = backends.map((result) => result.backend === "tgrep"
        ? { ...result, detail: `${result.detail}; local cache (non-Git directory)` }
        : result)
    }

    if (options.refreshExistingIndexes === true && existed) {
      const indexBackends = await runBackends(planIndexBackends(probe), root)
      backends = backends.concat(indexBackends)
    }

    return {
      root,
      configExisted: existed,
      files,
      migration,
      backends,
      hooks: registerProjectHooks(root, probe),
    }
  })
}

export async function indexProject(root = getProjectDir()): Promise<BackendResult[]> {
  return inProjectDir(root, async () => {
    const probe = probeBackends(root)
    return runBackends(planIndexBackends(probe), root)
  })
}

/**
 * Write only the switch values to `.ocp/ocp.json` (created if absent).
 * Runs the §3 one-shot legacy migration first — that pass re-comments the
 * migrated OCP switch keys in legacy configs (the sanctioned move; platform
 * keys preserved). Does NOT touch AGENTS.md / docs/git-commits.md (that's
 * `initProject`'s skeleton job) and does NOT re-run backends or register
 * hooks (switches don't change that). Pair this with the sub-dialog Save
 * button; use `initProject` for the main-menu skeleton action.
 */
export async function updateSwitches(options: UpdateSwitchesOptions): Promise<UpdateSwitchesResult> {
  const root = options.root ?? getProjectDir()
  return inProjectDir(root, async () => {
    const { file, migration } = updateSwitchesOnly(options.switches)
    return { root, file, migration }
  })
}

export function syncProject(root = getProjectDir()): SyncResult {
  const previousDir = getProjectDir()
  setProjectDir(root)
  try {
    return runSync()
  } finally {
    setProjectDir(previousDir)
  }
}
