/**
 * Barrel entry — re-exports the E2E adopt plugin from the subdirectory.
 *
 * OpenCode auto-discovers plugins by scanning the `plugins/` root directory
 * for `.ts` files. This thin file ensures OpenCode picks it up.
 *
 * See: plugins/e2e-adopt/e2e-adopt.ts
 */
export { E2eAdoptPlugin } from "./e2e-adopt/e2e-adopt"
