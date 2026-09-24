/**
 * Barrel entry — re-exports the project-manager plugin from the subdirectory.
 *
 * V2 loader contract: each root-level `plugins/*.ts` file must
 * DEFAULT-export `{ id, setup }` (Plugin.define). Helpers stay in the
 * submodule; tests import them from `plugins/project-manager/*.ts` directly.
 *
 * See: plugins/project-manager/project-manager.ts
 */
export { ProjectManagerPlugin, ProjectManagerPlugin as default } from "./project-manager/project-manager"
