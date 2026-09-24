/**
 * Barrel entry — re-exports the project-profiler plugin from the subdirectory.
 *
 * OpenCode auto-discovers plugins by scanning the `plugins/` root directory
 * for `.ts` files. Each file is loaded as a module and its exported plugin
 * functions are registered. This thin file ensures OpenCode picks it up.
 *
 * See: plugins/project-profiler/project-profiler.ts
 */
export { ProjectProfilerPlugin, ProjectProfilerPlugin as default } from "./project-profiler/project-profiler"
