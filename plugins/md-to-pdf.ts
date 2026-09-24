/**
 * Barrel entry — re-exports the md-to-pdf plugin from the subdirectory.
 *
 * OpenCode auto-discovers plugins by scanning the `plugins/` root directory
 * for `.ts` files. Each file is loaded as a module and its exported plugin
 * functions are registered.
 *
 * See: plugins/md-to-pdf/md-to-pdf.ts
 */
export { MdToPdfPlugin } from "./md-to-pdf/md-to-pdf"
export { MdToPdfPlugin as default } from "./md-to-pdf/md-to-pdf"
