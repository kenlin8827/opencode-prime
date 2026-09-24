/**
 * Barrel entry — re-exports the ADR iron-law plugin from the subdirectory.
 *
 * V2 loader contract: each root-level `plugins/*.ts` file must
 * DEFAULT-export `{ id, setup }` (Plugin.define). Helpers stay in the
 * submodule; tests import them from `plugins/adr/*.ts` directly.
 *
 * See: plugins/adr/adr.ts
 */
export { AdrPlugin, AdrPlugin as default } from "./adr/adr"
