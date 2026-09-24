/**
 * Barrel entry — re-exports the Lite-Mode plugin from the subdirectory.
 *
 * V2 loader contract (N2 WORKING-EXAMPLE): every root-level `plugins/*.ts`
 * file is auto-discovered and must DEFAULT-export `{ id, setup }`
 * (Plugin.define). Named helper exports stay in the submodule; tests and
 * other modules import them from `plugins/<name>/<file>.ts` directly.
 *
 * See: plugins/lite-mode/lite-mode.ts
 */
export { LiteModePlugin, LiteModePlugin as default } from "./lite-mode/lite-mode"
