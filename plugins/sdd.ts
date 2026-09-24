/**
 * Barrel entry — re-exports the SDD plugin from the subdirectory.
 *
 * V2 loader contract: each root-level `plugins/*.ts` file must
 * DEFAULT-export `{ id, setup }` (Plugin.define). Helpers stay in the
 * submodule; tests import them from `plugins/sdd/*.ts` directly.
 *
 * See: plugins/sdd/sdd.ts
 */
export { SddPlugin, SddPlugin as default } from "./sdd/sdd"
