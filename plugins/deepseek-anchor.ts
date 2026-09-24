/**
 * Barrel entry — re-exports the DeepSeek Anchor plugin.
 *
 * V2 loader contract: each root-level `plugins/*.ts` file must
 * DEFAULT-export `{ id, setup }` (Plugin.define).
 *
 * See: plugins/deepseek-anchor/deepseek-anchor.ts
 */
export { DeepSeekAnchorPlugin, DeepSeekAnchorPlugin as default } from "./deepseek-anchor/deepseek-anchor"
