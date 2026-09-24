/**
 * Plugin entry — the v2 loader discovers standalone .ts files directly in
 * the plugins/ directory and loads this module's default export. The real
 * plugin lives in the subdirectory (one entry + one job per file).
 *
 * See: plugins/env-guard/env-guard.ts
 */
export { default } from "./env-guard/env-guard"
