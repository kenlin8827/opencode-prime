import { existsSync } from "node:fs"
import { join } from "node:path"
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
  readonly backends: BackendResult[]
  readonly hooks: HookResult[]
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

function configExists(root: string): boolean {
  return existsSync(join(root, ".opencode", "opencode.jsonc")) ||
    existsSync(join(root, "opencode.jsonc"))
}

export async function initProject(options: ProjectInitOptions = {}): Promise<ProjectInitResult> {
  const root = options.root ?? getProjectDir()
  return inProjectDir(root, async () => {
    const existed = configExists(root)
    const files = options.switches === undefined ? runInit() : runInitWithSwitches(options.switches)
    const probe = probeBackends(root)
    let backends = await runBackends(planInitBackends(probe), root)

    if (options.refreshExistingIndexes === true && existed) {
      const indexBackends = await runBackends(planIndexBackends(probe), root)
      backends = backends.concat(indexBackends)
    }

    return {
      root,
      configExisted: existed,
      files,
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

export function syncProject(root = getProjectDir()): SyncResult {
  const previousDir = getProjectDir()
  setProjectDir(root)
  try {
    return runSync()
  } finally {
    setProjectDir(previousDir)
  }
}
