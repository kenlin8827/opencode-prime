/**
 * Barrel entry — re-exports the Project Memory plugin from the subdirectory.
 *
 * V2 loader contract: each root-level `plugins/*.ts` file must
 * DEFAULT-export `{ id, setup }` (Plugin.define). Helpers stay in the
 * submodule; tests import them from `plugins/project-memory/*.ts` directly.
 *
 * See: plugins/project-memory/project-memory.ts
 */
export { ProjectMemoryPlugin, ProjectMemoryPlugin as default } from "./project-memory/project-memory"
