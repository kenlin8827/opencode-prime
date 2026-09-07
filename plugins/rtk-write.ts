/**
 * Barrel entry — re-exports the rtk-write plugin from the subdirectory.
 *
 * OpenCode auto-discovers plugins by scanning the `plugins/` root directory
 * for `.ts` files. Each file is loaded as a module and its exported plugin
 * functions are registered. This thin file ensures OpenCode picks it up.
 *
 * The plugin delegates every rewrite to `rtk rewrite`, RTK's authoritative
 * command-rewrite interface for the installed RTK version.
 */
export { RtkWritePlugin } from "./rtk-write/index";
