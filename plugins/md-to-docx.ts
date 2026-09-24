/**
 * Barrel entry — re-exports the md-to-docx plugin from the subdirectory.
 *
 * OpenCode auto-discovers plugins by scanning the `plugins/` root directory
 * for `.ts` files. Each file is loaded as a module and its exported plugin
 * functions are registered.
 *
 * See: plugins/md-to-docx/md-to-docx.ts
 */
export { MdToDocxPlugin } from "./md-to-docx/md-to-docx"
export { MdToDocxPlugin as default } from "./md-to-docx/md-to-docx"
