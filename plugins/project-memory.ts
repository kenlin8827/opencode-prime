/**
 * Barrel entry — re-exports the Project Memory plugin from the subdirectory.
 *
 * OpenCode auto-discovers plugins by scanning the `plugins/` root directory
 * for `.ts` files. This thin file ensures OpenCode picks it up.
 *
 * See: plugins/project-memory/project-memory.ts
 */
export { ProjectMemoryPlugin } from "./project-memory/project-memory"
