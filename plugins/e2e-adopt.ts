/**
 * Barrel entry — re-exports the E2E adopt plugin from the subdirectory.
 *
 * V2 loader contract: each root-level `plugins/*.ts` file must
 * DEFAULT-export `{ id, setup }` (Plugin.define). Helpers stay in the
 * submodule; tests import them from `plugins/e2e-adopt/*.ts` directly.
 *
 * See: plugins/e2e-adopt/e2e-adopt.ts
 */
export { E2eAdoptPlugin, E2eAdoptPlugin as default } from "./e2e-adopt/e2e-adopt"
