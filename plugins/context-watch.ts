/**
 * Barrel entry — re-exports the Context-Watch plugin from the subdirectory.
 *
 * V2 loader contract: each root-level `plugins/*.ts` file must
 * DEFAULT-export `{ id, setup }` (Plugin.define). Helper/named exports
 * stay in the submodule — tests import them from
 * `plugins/context-watch/context-watch.ts` directly.
 *
 * See: plugins/context-watch/context-watch.ts
 */
export { ContextWatchPlugin, ContextWatchPlugin as default } from "./context-watch/context-watch"
